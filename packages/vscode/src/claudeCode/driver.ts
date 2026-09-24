// driver.ts — one passthrough chat cell's Claude Code child process. Owns spawn, the stdout pump,
// stdin writes, the permission round-trip, interrupt, idle park and respawn-with-resume; testable
// against a fake child. A sibling of acpClient.start, never a modification of it — an engine
// session and a passthrough session share no state.

import { needsShell } from './discoveryProbes';
import {
  StderrTail, exitInfoOf, looksPlanLimited, planLimitOf, type ExitInfo, type PlanLimitNotice,
} from './childFailure';
import {
  LineSplitter, allowResponse, assertNoBypass, buildArgs, childEnv, controlAck, controlCancelOf,
  controlRequestOf, denyResponse, initializeRequest, interruptRequest, parseLine, permissionAskOf,
  userMessage,
  type ClaudeEvent, type ImagePart, type PassthroughMode, type ToolPermissionAsk,
} from './protocol';

/** The slice of a child process this driver uses. Declared structurally so a
 *  test can hand in a scripted stand-in without a real process — the whole
 *  reason the driver's rules are testable at all. */
export interface ChildStream {
  on(event: string, listener: (chunk: string) => void): unknown;
  setEncoding?(encoding: string): unknown;
}
export interface ChildHandle {
  pid?: number | undefined;
  stdout: ChildStream | null;
  stderr: ChildStream | null;
  stdin: { write(data: string): unknown; end(): unknown; on(event: string, listener: (err: Error) => void): unknown } | null;
  on(event: string, listener: (...args: never[]) => void): unknown;
  kill(signal?: string): unknown;
}
export type SpawnChild = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string>; windowsHide: boolean },
) => ChildHandle;

export interface DriverHandlers {
  /** Every decoded stdout event, in order. The manager runs it through the
   *  translator; the driver stays ignorant of the webview. */
  onEvent(ev: ClaudeEvent): void;
  /** A tool the CLI is BLOCKED on. Answer with `answerPermission`. */
  onPermissionAsk(ask: ToolPermissionAsk): void;
  /** The child went away. `expected` is true for a park/dispose we asked for; `info` is present
   *  only for an UNEXPECTED exit and carries the exit code, the stderr tail, any plan refusal, the
   *  asks that died with it, and whether the driver has already resumed. */
  onExit(reason: string, expected: boolean, info?: ExitInfo): void;
  /** An ask the CHILD retired (its own timeout, or a turn torn down under it). The UI must be told:
   *  the bar on screen can no longer be answered by anybody. */
  onPermissionCancel(requestId: string): void;
  /** stderr and driver notes, for the extension's output channel. */
  onLog(line: string): void;
}

export interface DriverOptions {
  binary: string;
  cwd: string;
  mode: PassthroughMode;
  model?: string;
  /** Provider session id to resume. Only valid while `cwd` is unchanged — the
   *  manager owns that rule; the driver just passes it to `--resume`. */
  resumeSessionId?: string;
  /** Test/smoke lever. Production chat never sets it; a REVIEW sets it to 1. */
  maxTurns?: number;
  /** One-shot reviewer spawn — protocol.ISOLATION_FLAGS. */
  isolated?: boolean;
  /** Kill an idle child after this long; the next prompt respawns it with
   *  `--resume`, so the conversation survives. 0 disables. */
  idleParkMs?: number;
  env?: Record<string, string | undefined>;
  spawn?: SpawnChild;
}

const DEFAULT_IDLE_PARK_MS = 5 * 60 * 1000;

export class ClaudeCodeDriver {
  private child: ChildHandle | null = null;
  private splitter = new LineSplitter();
  private controlSeq = 0;
  private pendingAsks = new Set<string>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private expectedExit = false;
  private disposed = false;
  private turnOpen = false;
  private stderrTail = new StderrTail();
  /** The turn's own prompt, so ONE respawn-with-resume can re-send it. */
  private lastPrompt: { text: string; images: readonly ImagePart[] } | null = null;
  private resumeTried = false;
  /** A refusal seen on this turn - on the wire (`rate_limit_event`) or in stderr. */
  private planLimit: PlanLimitNotice | undefined;
  /** A settings change that arrived MID-TURN. The CLI reads mode and model at spawn, so parking
   *  the child there would kill a running turn to apply something that could not have applied to
   *  it anyway; the park is deferred to the turn's own `result`. */
  private parkWhenIdle: string | null = null;
  /** Adopted from the child's own events — the id `--resume` takes. */
  private providerSessionId: string | undefined;
  private mode: PassthroughMode;
  private model: string | undefined;

  constructor(private readonly opts: DriverOptions, private readonly handlers: DriverHandlers) {
    this.mode = opts.mode;
    this.model = opts.model;
    this.providerSessionId = opts.resumeSessionId;
  }

  get sessionId(): string | undefined { return this.providerSessionId; }
  get running(): boolean { return this.child !== null; }

  /** The vector this driver WOULD spawn with right now — the manager shows it
   *  in the connection card, and the bypass guard runs over it. */
  args(): string[] {
    return buildArgs({
      mode: this.mode,
      ...(this.model ? { model: this.model } : {}),
      ...(this.providerSessionId ? { resumeSessionId: this.providerSessionId } : {}),
      ...(this.opts.maxTurns !== undefined ? { maxTurns: this.opts.maxTurns } : {}),
      ...(this.opts.isolated ? { isolated: true } : {}),
    });
  }

  /** Model/mode change. Nothing is mutated live: the CLI reads both at spawn,
   *  so a change parks the child and the next prompt respawns it — resumed, so
   *  the conversation is unbroken. */
  applySettings(next: { mode?: PassthroughMode; model?: string }): void {
    const changed = (next.mode !== undefined && next.mode !== this.mode)
      || (next.model !== undefined && next.model !== this.model);
    if (next.mode !== undefined) this.mode = next.mode;
    if (next.model !== undefined) this.model = next.model;
    if (!changed || !this.child) return;
    if (this.turnOpen) { this.parkWhenIdle = 'settings changed'; return; }
    this.park('settings changed');
  }

  start(): void {
    if (this.disposed || this.child) return;
    const args = this.args();
    assertNoBypass(args);
    const spawnFn = this.opts.spawn ?? defaultSpawn;
    this.splitter = new LineSplitter();
    this.stderrTail.clear();
    this.expectedExit = false;
    let child: ChildHandle;
    try {
      child = spawnFn(this.opts.binary, args, {
        cwd: this.opts.cwd,
        env: childEnv(this.opts.env ?? process.env),
        windowsHide: true,
      });
    } catch (e) {
      this.handlers.onExit(`Could not start Claude Code (${this.opts.binary}): ${msgOf(e)}`, false);
      return;
    }
    this.child = child;
    this.handlers.onLog(`[claude-code] spawned pid=${child.pid ?? '?'} args=${JSON.stringify(args)}`);
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of this.splitter.push(String(chunk))) this.onLine(line);
    });
    child.stderr?.on('data', (chunk: string) => {
      for (const line of this.stderrTail.push(String(chunk))) {
        this.handlers.onLog(`[claude-code] ${line}`);
        // A CLI that dies on a refusal says so here and nowhere else; without this the crash card
        // would blame the exit code for what the plan window actually did.
        if (!this.planLimit && looksPlanLimited(line)) this.planLimit = { window: '', resetsAt: 0, pct: -1 };
      }
    });
    child.stdin?.on('error', (err: Error) => this.handlers.onLog(`[claude-code] stdin: ${err.message}`));
    child.on('error', ((err: Error) => this.handlers.onLog(`[claude-code] child error: ${err.message}`)) as never);
    child.on('exit', ((code: number | null, signal: string | null) => {
      const expected = this.expectedExit;
      const asks = [...this.pendingAsks];
      this.child = null;
      this.pendingAsks.clear();
      for (const line of this.splitter.flush()) this.onLine(line);
      const turnOpen = this.turnOpen;
      this.turnOpen = false;
      const reason = `Claude Code exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      if (expected) { this.handlers.onExit(reason, true); return; }
      const info = exitInfoOf({
        code, signal, stderr: [...this.stderrTail.tail()], pendingAsks: asks,
        turnOpen, tried: this.resumeTried, sessionId: this.providerSessionId, planLimit: this.planLimit,
        // A REVIEW (`isolated`/`maxTurns`) is one shot by construction: resending its prompt would
        // spend a second turn of the user's plan on a run nobody is watching any more.
        oneShot: !!this.opts.isolated || this.opts.maxTurns !== undefined,
      });
      // Brought back BEFORE the handler runs, so the cell can leave the turn open rather than
      // settle cards a resumed child is about to finish.
      if (info.recovery === 'resumed') this.resumeTurn();
      this.handlers.onExit(reason, false, info);
    }) as never);
    this.send(initializeRequest(this.nextControlId()));
  }

  /** Send one user turn, starting (or restarting) the child if needed.
   *  `images` are already-decoded base64 parts; an empty list emits exactly the
   *  frame phase 1 emitted (protocol.userMessage). */
  prompt(text: string, images: readonly ImagePart[] = []): void {
    if (this.disposed) throw new Error('ClaudeCodeDriver.prompt after dispose');
    this.clearIdle();
    // A settings change that landed mid-turn parks HERE if the turn never closed - a prompt that
    // arrives first must still run under the mode and model the user asked for.
    if (this.parkWhenIdle) { const why = this.parkWhenIdle; this.parkWhenIdle = null; this.park(why); }
    if (!this.child) this.start();
    this.turnOpen = true;
    this.resumeTried = false;
    this.planLimit = undefined;
    this.lastPrompt = { text, images };
    this.send(userMessage(text, this.providerSessionId ?? '', images));
  }

  /**
   * Answer a `can_use_tool` the UI just resolved. An id we are not waiting on is ignored, not
   *  written — a stale click must not push an unsolicited frame at the child.
   *
   * Returns whether the answer reached a child; false means the turn was interrupted or the child
   *  died while the bar was still on screen, so a permission audit does not record an approval
   *  nobody received.
   */
  answerPermission(requestId: string, allow: boolean, input: Record<string, unknown>, denyMessage?: string): boolean {
    if (!this.pendingAsks.delete(requestId)) return false;
    this.send(allow ? allowResponse(requestId, input) : denyResponse(requestId, denyMessage));
    return true;
  }

  /** Stop the running turn: ask the child to abort AND seal locally, because a
   *  child that ignores the request must not leave the UI spinning. */
  interrupt(): void {
    if (!this.child) return;
    this.send(interruptRequest(this.nextControlId()));
    for (const id of [...this.pendingAsks]) this.answerPermission(id, false, {}, 'Interrupted by the user.');
    this.turnOpen = false;
  }

  /** Kill the child but KEEP the resume id — the next prompt continues the
   *  same conversation. */
  park(reason: string): void {
    if (!this.child) return;
    this.handlers.onLog(`[claude-code] parking child: ${reason}`);
    this.expectedExit = true;
    this.clearIdle();
    try { this.child.kill(); } catch { /* already gone */ }
  }

  dispose(): void {
    this.disposed = true;
    this.clearIdle();
    this.park('session closed');
  }

  private onLine(line: string): void {
    const ev = parseLine(line);
    if (!ev) {
      if (line.trim()) this.handlers.onLog(`[claude-code] non-JSON stdout: ${line.slice(0, 200)}`);
      return;
    }
    const adopted = typeof ev.session_id === 'string' && ev.session_id ? ev.session_id : '';
    if (adopted && adopted !== this.providerSessionId) this.providerSessionId = adopted;
    const ask = permissionAskOf(ev);
    if (ask) {
      this.pendingAsks.add(ask.requestId);
      // 'auto' answers here rather than in the UI. It is NOT bypassPermissions:
      // the CLI has already applied the user's own allow/deny rules and hooks,
      // and only asks about what those left open.
      if (this.mode === 'auto') this.answerPermission(ask.requestId, true, ask.input);
      else this.handlers.onPermissionAsk(ask);
      return;
    }
    const cancelled = controlCancelOf(ev);
    if (cancelled) {
      // Only an ask we are actually holding: a cancel for something already answered is the child
      // tidying up, not news.
      if (this.pendingAsks.delete(cancelled)) this.handlers.onPermissionCancel(cancelled);
      return;
    }
    const limit = planLimitOf(ev);
    if (limit) this.planLimit = limit;
    const ctl = controlRequestOf(ev);
    if (ctl && ctl.subtype !== 'can_use_tool') {
      // Unknown control subtype: ack it EMPTY. An unanswered control request is
      // a permanently blocked child.
      this.send(controlAck(ctl.requestId));
      return;
    }
    if (ev.type === 'result') {
      this.turnOpen = false;
      // A settings change that landed mid-turn parks HERE, not where it arrived.
      if (this.parkWhenIdle) {
        const why = this.parkWhenIdle;
        this.parkWhenIdle = null;
        this.handlers.onEvent(ev);
        this.park(why);
        return;
      }
      this.armIdle();
    }
    this.handlers.onEvent(ev);
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.child?.stdin) return;
    try { this.child.stdin.write(`${JSON.stringify(frame)}\n`); }
    catch (e) { this.handlers.onLog(`[claude-code] write failed: ${msgOf(e)}`); }
  }

  /** The one automatic recovery: respawn with `--resume` and re-send the turn's own prompt. Once
   *  per turn (`resumeTried`), and never into a spent plan window - `recoveryFor` owns that rule. */
  private resumeTurn(): void {
    this.resumeTried = true;
    const again = this.lastPrompt;
    this.start();
    if (!this.child || !again) return;
    this.turnOpen = true;
    this.send(userMessage(again.text, this.providerSessionId ?? '', again.images));
  }

  private nextControlId(): string { return `o_${++this.controlSeq}`; }

  private armIdle(): void {
    const ms = this.opts.idleParkMs ?? DEFAULT_IDLE_PARK_MS;
    this.clearIdle();
    if (ms <= 0 || this.disposed) return;
    this.idleTimer = setTimeout(() => { if (!this.turnOpen) this.park('idle'); }, ms);
    // Never hold the extension host alive for a parked timer.
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function msgOf(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/**
 * The one impure line, behind an injectable seam. A real executable is spawned directly; a
 *  .cmd/.bat shim is the exception — Node throws EINVAL on a batch file with no shell since the
 *  CVE-2024-27980 fix, and an npm -g install has no other entry point. Quoted because `%APPDATA%`
 *  can contain spaces.
 */
const defaultSpawn: SpawnChild = (command, args, opts) => {
  // Required lazily so the pure-ish top of this module stays importable in a
  // DOM test environment.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const shell = needsShell(command);
  return spawn(shell ? `"${command}"` : command, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: opts.windowsHide,
    ...(shell ? { shell: true } : {}),
  }) as unknown as ChildHandle;
};
