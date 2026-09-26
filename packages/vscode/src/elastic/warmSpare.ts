// warmSpare.ts — t-w2u2ki (Elastic E6): ONE warm spare engine per window, so a new chat starts on an
// engine that is already running. No vscode here: the client factory, the settings, the clock and the
// log are injected (warmSpareWindow.ts has the real ones).
//
// Rules (owner, 2026-09-24; scope A D4, scope C 6.2):
//  - One spare, for the window's workspace folder, spawned with ORIGAMI_SPARE=1. Until a chat adopts it
//    the engine starts no MCP, no peer heartbeat and no Flock service (engine elastic/spare.ts), and it
//    waits at the `idle` class and trimmed.
//  - Only a NEW chat in the same folder and kind adopts it (not a history reopen, a fork or a headless
//    agent session), and only while the spawn-time values are the ones it was started with (S2):
//    otherwise it is dropped and replaced. On adoption it is raised to `active` and told it is adopted
//    (`_elastic_adopt`, t-y4x518) before any call of the chat.
//  - It replaces the window's boot throw-away chat (bootWindow below). A replacement is started only
//    after a chat's turn settles, so it never competes with the new chat for CPU.
//
// Handlers: an AcpClient reads `this.handlers.<name>` at every event, so the spare is built on a
// handler object whose target can be switched once, from a quiet sink to the adopting chat's handlers.

import * as path from 'node:path';
import type { AcpEventHandlers } from '../acpClient';

export interface SpareClient {
  connect(cwd: string, headless?: boolean, extraEnv?: Record<string, string>): Promise<void>;
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  dispose(): void;
  readonly pid?: number;
}

export interface WarmSpareDeps<C extends SpareClient> {
  make(handlers: AcpEventHandlers): C;
  /** `origamicoder.elastic.warmSpare`. */
  enabled(): boolean;
  /** t-xmulzj: a chat turn runs now. A spare never starts next to one; its replacement waits for turnSettled(). */
  turnRunning(): boolean;
  /** `origamicoder.elastic.enabled`: the spare waits at the idle class and is trimmed. */
  lower(): boolean;
  /** Everything fixed at spawn that a fresh chat engine would get NOW (binary, env overlay, cwd). */
  digest(cwd: string): string;
  retrimMs(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Lift the spare's OS priority from outside before the message that tells it (E3 raiseFromOutside). */
  raise(pid: number): void;
  log(line: string): void;
}

/** What createSession knows about the chat it is making. */
export interface AdoptRequest {
  cwd: string;
  kind?: 'chat' | 'agent';
  /** A history reopen (session/load). */
  load?: boolean;
  fork?: boolean;
}

export const SPARE_ENV: Readonly<Record<string, string>> = { ORIGAMI_SPARE: '1' };
/** The first trim waits out the engine's own start work. */
export const FIRST_TRIM_MS = 30_000;
/** After a turn settles, the replacement waits this long (the turn's tail work: step-finish writes, warm arm). */
export const REPLACE_DELAY_MS = 3_000;
/** Spares that failed to start or died while waiting, in a row, before the window stops making them. */
export const MAX_FAILURES = 3;

const noop = () => undefined;

/** A handler object whose target is switched once, from the spare's sink to the adopting chat. Before the
 *  switch every event the sink does not name is dropped; after it, the chat's handlers answer exactly as
 *  if the client had been built with them (a handler the chat does not have reads as undefined). */
export function switchableHandlers(sink: Partial<AcpEventHandlers>): { handlers: AcpEventHandlers; to(next: AcpEventHandlers): void } {
  let target: Partial<AcpEventHandlers> | null = null;
  const handlers = new Proxy({} as AcpEventHandlers, {
    get: (_t, prop) => {
      if (target) return (target as Record<PropertyKey, unknown>)[prop];
      return (sink as Record<PropertyKey, unknown>)[prop] ?? noop;
    },
    has: (_t, prop) => (target ? prop in target : true),
  });
  return { handlers, to: (next) => { target = next; } };
}

interface Spare<C> {
  client: C;
  cwd: string;
  digest: string;
  ready: boolean;
  lowered: boolean;
  route: ReturnType<typeof switchableHandlers>;
  trimTimer: unknown;
}

const sameFolder = (a: string, b: string) => {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

export class WarmSpare<C extends SpareClient> {
  private spare: Spare<C> | null = null;
  private starting: Promise<C | undefined> | null = null;
  private replaceTimer: unknown = null;
  /** The window's workspace folder: where a replacement is started. */
  private folder: string | undefined;
  /** The engine did not wait as a spare (an older binary), or spares kept failing: no more in this window. */
  private unsupported = false;
  private failures = 0;
  /** t-xmulzj: the setting at the last refresh(), so turning it back on is seen as a change. */
  private wasOn: boolean;

  constructor(private readonly deps: WarmSpareDeps<C>) {
    this.wasOn = deps.enabled();
  }

  /** The spare that waits now (ready or not), for a test or a log. */
  public current(): C | undefined {
    return this.spare?.client;
  }

  /** The window's workspace folder, where a replacement starts. Starts nothing. */
  public setFolder(cwd: string): void {
    this.folder = cwd;
  }

  /** Start the spare for `cwd` now (the window boot). Resolves the ready client, or undefined when the
   *  setting is off, the start failed or the engine is too old. Idempotent while one is starting. */
  public start(cwd: string): Promise<C | undefined> {
    this.folder = cwd;
    if (!this.deps.enabled() || this.unsupported) return Promise.resolve(undefined);
    const sp = this.spare;
    if (sp && sameFolder(sp.cwd, cwd)) return sp.ready ? Promise.resolve(sp.client) : (this.starting ?? Promise.resolve(undefined));
    if (sp) this.drop('the window folder changed');
    return this.spawn(cwd);
  }

  /** createSession: the spare's client when this chat may adopt it, else undefined (spawn fresh). */
  public take(req: AdoptRequest, handlers: AcpEventHandlers): C | undefined {
    const sp = this.spare;
    if (!sp || !sp.ready) return undefined;
    if (req.kind === 'agent' || req.load || req.fork || !sameFolder(req.cwd, sp.cwd)) return undefined;
    if (!this.deps.enabled()) {
      this.drop('the warm spare setting is off');
      return undefined;
    }
    if (this.deps.digest(sp.cwd) !== sp.digest) {
      // S2: a fresh engine would start with other values now. Not adopted; replaced after a turn settles.
      this.drop('a spawn-time setting changed since it started: not adopted');
      return undefined;
    }
    this.spare = null;
    this.failures = 0;
    this.stopTrims(sp);
    sp.route.to(handlers);
    if (sp.lowered) {
      if (sp.client.pid !== undefined) this.deps.raise(sp.client.pid);
      void sp.client.extMethod('_elastic_class', { class: 'active' }).catch(noop);
    }
    // t-y4x518: the adoption starts NOW, before any call of the chat reaches the engine; the engine holds the chat's
    // calls until it ends, so they boot the chat's instance once (a pane call that arrived first booted one that the
    // adoption disposed). An older engine answers -32601 and adopts at session/new as before.
    void sp.client.extMethod('_elastic_adopt', {}).catch(noop);
    this.deps.log(`[spare] pid ${sp.client.pid ?? '?'} adopted by a new chat`);
    return sp.client;
  }

  /** A chat's turn ended (busy -> idle). Start a replacement if none waits. */
  public turnSettled(): void {
    if (this.spare || this.starting || this.replaceTimer !== null || !this.folder || this.unsupported || !this.deps.enabled()) return;
    const cwd = this.folder;
    this.replaceTimer = this.deps.setTimer(() => {
      this.replaceTimer = null;
      if (!this.spare && !this.starting) void this.start(cwd);
    }, REPLACE_DELAY_MS);
  }

  /** A setting changed: drop a spare the new values no longer match, or all of it when the setting is off; start one
   *  when the setting is turned back on (t-xmulzj). */
  public refresh(): void {
    const sp = this.spare;
    const turnedOn = !this.wasOn;
    this.wasOn = this.deps.enabled();
    if (!this.wasOn) {
      if (sp) this.drop('the warm spare setting is off');
      this.cancelReplace();
      return;
    }
    if (sp && sp.ready && this.deps.digest(sp.cwd) !== sp.digest) {
      this.drop('a spawn-time setting changed');
      this.turnSettled(); // it was waiting idle: replace it soon, nothing competes now
      return;
    }
    // t-xmulzj: turned back on. With no chat turn running, start the spare the way a settled turn does; while a turn
    // runs, the turnSettled() at its end starts it (a spare never competes with a working chat).
    if (turnedOn && !this.deps.turnRunning()) this.turnSettled();
  }

  /** Window close. */
  public dispose(): void {
    this.cancelReplace();
    if (this.spare) this.drop('the window closed');
  }

  private spawn(cwd: string): Promise<C | undefined> {
    const route = switchableHandlers({
      onClose: (reason) => { if (this.spare === sp) this.fail(`its engine exited while it waited (${reason})`, false); },
      onError: (message) => this.deps.log(`[spare] ${message}`),
    });
    const sp: Spare<C> = { client: this.deps.make(route.handlers), cwd, digest: this.deps.digest(cwd), ready: false, lowered: false, route, trimTimer: null };
    this.spare = sp;
    const run = (async (): Promise<C | undefined> => {
      try {
        await sp.client.connect(cwd, false, { ...SPARE_ENV });
      } catch (e) {
        if (this.spare === sp) this.fail(`start failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
      let waits = false;
      try {
        waits = (await sp.client.extMethod('_elastic_spare', {}))['spare'] === true;
      } catch {
        waits = false;
      }
      if (this.spare !== sp) return undefined; // dropped while it started
      if (!waits) {
        // An engine that ignores ORIGAMI_SPARE has already registered as a peer: never keep it.
        this.unsupported = true;
        this.drop('the engine does not wait as a spare (older build); no spares in this window');
        return undefined;
      }
      sp.ready = true;
      this.deps.log(`[spare] pid ${sp.client.pid ?? '?'} waits for a new chat in ${cwd}`);
      if (this.deps.lower()) {
        sp.lowered = true;
        void sp.client.extMethod('_elastic_class', { class: 'idle' }).catch(noop);
        this.trimAt(sp, FIRST_TRIM_MS); // t-y9kq60: an untrimmed spare was just as slow at takeover (UAT 0.4.181), so it is trimmed again
      }
      return sp.client;
    })();
    const tracked = run.finally(() => { if (this.starting === tracked) this.starting = null; });
    this.starting = tracked;
    return tracked;
  }

  private trimAt(sp: Spare<C>, ms: number): void {
    sp.trimTimer = this.deps.setTimer(() => {
      sp.trimTimer = null;
      if (this.spare !== sp) return;
      void sp.client.extMethod('_elastic_trim', {}).then(
        (r) => this.deps.log(`[spare] trim: ${r['trimmed'] === true ? 'done' : `refused (${String(r['reason'] ?? '?')})`}`),
        noop,
      );
      this.trimAt(sp, this.deps.retrimMs());
    }, ms);
  }

  private stopTrims(sp: Spare<C>): void {
    if (sp.trimTimer !== null) this.deps.clearTimer(sp.trimTimer);
    sp.trimTimer = null;
  }

  private cancelReplace(): void {
    if (this.replaceTimer !== null) this.deps.clearTimer(this.replaceTimer);
    this.replaceTimer = null;
  }

  /** A spare that could not do its job. After MAX_FAILURES in a row the window stops making them. */
  private fail(why: string, stop = true): void {
    this.drop(why, stop);
    if (++this.failures < MAX_FAILURES) return;
    this.unsupported = true;
    this.deps.log(`[spare] ${MAX_FAILURES} spares in a row failed: no more spares in this window`);
  }

  private drop(why: string, stop = true): void {
    const sp = this.spare;
    if (!sp) return;
    this.spare = null;
    this.stopTrims(sp);
    const pid = sp.client.pid; // t-xmulzj: before dispose(), which takes the process (and its pid) away
    if (stop) sp.client.dispose();
    this.deps.log(`[spare] pid ${pid ?? '?'} dropped: ${why}`);
  }
}

/** The window boot (DashboardPanel.initialize). Today's code spawned a throw-away chat to probe which
 *  persisted chats still exist, then closed it. With a persisted open set the spare is that probe (it
 *  answers `session/list` without becoming a peer) and stays for the next new chat. With no open set the
 *  first chat is a real one, and the spare follows its first turn. Returns the probe's verdict. */
export async function bootWindow<C extends SpareClient>(input: {
  spare: WarmSpare<C>;
  cwd: string;
  hasOpenSet: boolean;
  /** createSession() for a new chat; returns its local id. */
  newChat(): Promise<string>;
  clientOf(localId: string): C | undefined;
  /** restoreOpenSet with this probe client. */
  restore(probe: C | undefined): Promise<boolean>;
  close(localId: string): void;
}): Promise<boolean> {
  input.spare.setFolder(input.cwd); // where the spare after the first turn starts
  const probe = input.hasOpenSet ? await input.spare.start(input.cwd) : undefined;
  if (probe) {
    if (await input.restore(probe)) return true;
    await input.newChat(); // nothing to restore: this chat adopts the spare
    return false;
  }
  // No spare (setting off, no open set, or it failed): the boot chat is the probe, as before.
  const boot = await input.newChat();
  const restored = await input.restore(input.clientOf(boot));
  if (restored) input.close(boot);
  return restored;
}
