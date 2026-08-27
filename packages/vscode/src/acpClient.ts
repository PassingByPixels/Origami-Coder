// Origami ACP client — wraps the canonical TypeScript SDK and
// spawns the `origami-acp` bridge binary as a child process.
//
// Communication is line-delimited JSON-RPC 2.0 over the child's
// stdin/stdout, framed by the SDK's `ndJsonStream` helper.
//
// Architecture:
//   VS Code Extension Host
//     └─ AcpClient (this file)
//          └─ child_process.spawn → origami-acp(.exe)
//               └─ core_loop::tool_loop
//
// The extension is a pure frontend. All agent execution happens
// inside origami-acp. We just render events and relay permissions.
//
// Wire contract (docs/WIRE-CONTRACT.md):
//   - Ext-methods travel `_`-prefixed (the JS SDK does NOT add the
//     `_`; this client does — `extMethod`). SCAR UI-S4.
//   - Domain events are FIRST-CLASS `origami/*` notifications, NOT
//     `_meta.lilinyx_kind` riders on a synthetic `Plan` (the donor's
//     deleted smuggling). The ONE legitimate `_meta` use the contract
//     keeps byte-for-byte is `_meta.lilinyx_tool_name` decorating a
//     REAL `ToolCall` (plain ACP clients ignore it).
//   - `SessionUpdate::Plan` is consumed ONLY for real plans.

import * as vscode from 'vscode';
import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EngineSpawn } from './dashboard/engineStale';
import * as fs from 'node:fs';

import type { RunStepsResult, RunStatsResult, InstructionSet, SubagentTranscriptResult, ToolCatalog } from './acpExtTypes';
import { engineSpawnEnv, codeModeEnabled } from './engineEnv';
import { agentNameSetting } from './peerName';
import { shutdownEngine } from './engineShutdown';
import { peerFromMeta, type PeerOrigin } from './acpPeerMeta';
import { modelOnlyContent } from './acpAudience';
import { todosFromUpdate } from './acpTodoWrite';
import { decodeToolContent } from './acpToolContent';
import { taskDone, taskRiders, type TaskDone, type TaskRiders } from './acpTaskMeta';
import { toolNameRider } from './acpToolMeta';
import { handleBrowserExtMethod, isBrowserMethod } from './browserBridge';
import { questionsFromMeta, replyMeta, type QuestionAsk, type QuestionAnswer } from './questionBatch';
import { planCandidatesFrom, taskShapeFrom, todoSnapshotFrom, arbiterDecisionFrom, type PlanCandidates, type TaskShape, type TodoSnapshot, type ArbiterDecision } from './acpNotify';
import { pageSessions } from './sessionPaging';

export type { RunStep, RunStepsResult, InstructionEntry, InstructionSet } from './acpExtTypes';

export interface AcpEventHandlers {
  /** `messageId` is the engine's assistant-message id (present live + on
   *  replay) — the anchor a "rewind to here" control reverts to. */
  onAgentMessageChunk(text: string, messageId?: string): void;
  onAgentImageChunk(data: string, mimeType: string): void;
  /**
   * Replayed/streamed USER turn text (`user_message_chunk`). The engine
   * emits it on history replay (`loadSession`); the donor had no case so
   * resumed transcripts silently lost every user turn. Optional — a
   * fresh-only client may ignore it.
   */
  onUserMessageChunk?(text: string): void;
  /** A handoff from ANOTHER agent session, not this window's human — see
   *  acpPeerMeta.ts. Split off from `onUserMessageChunk` so it can never be
   *  rendered as the user speaking. Optional. */
  onPeerMessage?(args: PeerOrigin & { text: string }): void;
  /**
   * Streamed reasoning/thinking text (`agent_thought_chunk`). Optional —
   * the dashboard renders it as a dim "thinking" stream, or drops it.
   */
  onAgentThoughtChunk?(text: string): void;
  /**
   * Streamed /compact summary text, tagged by the engine with
   * `_meta.origami_compaction`. Rendered as a collapsed "Compaction Completed"
   * marker (expand to see what was carried forward) rather than a live assistant
   * turn. Optional — a client may drop it.
   */
  onCompactionChunk?(text: string): void;
  /**
   * A SUB-AGENT's live output, forwarded by the engine under this (the
   * registered ancestor) session and tagged `_meta.origami_child_session`. The
   * child's own session id is never one the client opened, so without this the
   * only sign a sub-agent existed was its task card and, minutes later, the
   * final result. `childSessionId` matches the `taskSessionId` on the task tool
   * call that spawned it, which is how the UI parks the stream under that card.
   * Optional — a client may drop it.
   */
  onSubagentChunk?(args: { childSessionId: string; text: string }): void;
  /** A BACKGROUND sub-agent FINISHED — the launcher card completed at SPAWN, so
   *  only this says the child itself is done (acpTaskMeta.ts). Optional. */
  onSubagentDone?(args: TaskDone): void;
  onToolCallStart(args: TaskRiders & {
    toolCallId: string;
    title: string;
    kind: string;
    status: string;
    /**
     * Actual tool name surfaced via `_meta.origami_tool_name` on a
     * REAL `ToolCall` variant (a legitimate decoration the WIRE
     * CONTRACT keeps). Dashboard uses this to dispatch to per-tool
     * specialised cards (grep, bash, read_file, etc.) even though the
     * broad ACP `kind` collapses many tools into one bucket. Empty
     * string when the bridge didn't set it (plain ACP servers).
     */
    toolName: string;
    /** First file path from the ACP ToolCall `locations` (read/write/edit set
     *  it from the tool's filePath) — so the card can show WHERE it wrote. */
    path?: string;
    /** Tool arguments off the wire (bash: command/cwd/timeout) — shaped web-side. */
    rawInput?: unknown;
  }): void;
  // TaskRiders again: the child's id only exists AFTER the pending call went out.
  onToolCallUpdate(args: TaskRiders & {
    toolCallId: string;
    status: string;
    contentText?: string;
    /** Self-heals card identity on a replayed/unmatched update (acpToolMeta.ts). */
    toolName?: string;
    /** The tool's resolved title + file path, which only arrive on the
     *  running/completed update — the initial `tool_call` fires before the
     *  engine has them (write's pending title is literally "write", no
     *  locations). Forward them so the card can show WHERE it wrote. */
    title?: string;
    path?: string;
    rawInput?: unknown;
    /**
     * Structured diff carried on an edit-kind `tool_call_update` as an
     * ACP `{ type: 'diff', path, oldText, newText }` content block (the
     * engine's `acp/tool.ts:diffContent`). Present only for edit tools
     * that supplied an `oldString`; the dashboard renders a real
     * before/after diff from it instead of a `<pre>` of the summary.
     */
    diff?: { path: string; oldText: string; newText: string };
    /** Image blocks off the same content array as data: URIs — the `browser`
     *  tool's screenshots. Absent for every other tool. */
    images?: string[];
    /** `rawOutput.metadata` off the wire (bash: exit/truncated/outputPath) — shaped web-side. */
    rawOutputMeta?: unknown;
  }): void;
  onPermissionRequest(args: {
    toolCallId: string;
    title: string;
    kind: string;
    /** The tool's raw metadata ({ filepath, parentDir } for an external-directory
     *  prompt, or the tool arguments) — ground-truth context the permission bar
     *  surfaces so the user isn't approving blind. */
    rawInput?: unknown;
    /** ACP file locations attached to the call (read/write/edit set `path`). */
    locations?: ReadonlyArray<{ path?: string; line?: number }>;
    options: ReadonlyArray<{ optionId: string; name: string; kind: string }>;
    /** Every question this ONE ask carries; absent = fall back to title+options,
     *  which always describe the first question (questionBatch.ts). */
    questions?: ReadonlyArray<QuestionAsk>;
    /** `answerText` = free text from a question's "Other" option, on `_meta`.
     *  `answers` = one per question when a BATCH was answered (questionBatch.ts). */
    respond: (optionId: string | null, answerText?: string, answers?: ReadonlyArray<QuestionAnswer>) => void;
  }): void;
  onAvailableCommands(commands: Array<{ name: string; description: string }>): void;
  /** `usage_update` — the engine's per-turn token/context accounting.
   *  `used` = input + cache-read; `size` = context limit; `cost` = running
   *  session total. Omitted when no context limit resolves. */
  onUsageUpdate?(args: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string };
    subagents?: { cost: number; tokensInput: number; tokensOutput: number };
    /** This turn's raw usage breakdown: prefill = prompt/input tokens,
     *  read = cache-read, write = generated/output. Absent without usage. */
    promptTokens?: number;
    cacheReadTokens?: number;
    outputTokens?: number;
    /** Cache-WRITE tokens — distinct from generated `outputTokens` above. */
    cacheWriteTokens?: number;
  }): void;
  /**
   * Last-turn generation throughput: this turn's real OUTPUT tokens (from the
   * prompt-response usage) over the turn's wall-clock. The prompt-response
   * usage (and `onUsageUpdate` above) is the ONLY source of real token
   * accounting — the engine implements no ext-methods at all, so the panel's
   * context gauge is driven purely by these frames plus a local turn count
   * until the first frame lands. Fired once per turn; the sessionId is
   * supplied by the host's handler closure.
   */
  onTurnStats?(args: { tokensPerSec: number }): void;
  /**
   * `session_info_update` — the engine pushes the session's generated title
   * the instant it's set (replaces the racy listSessions re-query). Each
   * AcpClient is bound to one session, so the title applies to this client's
   * session; the sessionId is supplied by the host's handler closure.
   */
  onSessionTitle?(args: { title: string }): void;
  /**
   * ACP `current_mode_update` — the engine switched this session's agent on
   * its own (e.g. plan_exit approving a plan writes a synthetic `agent:build`
   * message, so the next turn runs as build). Mirror it into the selector +
   * status bar so the UI matches the engine's real mode; without this the
   * panel would still read "plan" after the user approved.
   */
  onModeChanged?(args: { modeId: string }): void;
  onPlanStatus(args: { planId: string; status: string; revisionCount: number; message?: string }): void;
  /**
   * First-class `origami/turnEnd` — the loop reached a terminal for THIS
   * ACP turn. `stopReason` is the real taxonomy label carried verbatim
   * on the wire (`success` | `asked_user` | `error_max_turns` |
   * `error_max_budget` | `error_no_progress` | `error_during_execution`
   * | `park_infra`). The dashboard renders an honest per-turn verdict
   * from it (verified-done vs incomplete:<reason> vs parked) — the F4
   * fix for the discarded-stop_reason blind instrument. Distinct from
   * `onPlanStatus(turn_end)`, which only clears the plan banner.
   */
  onTurnEnd?(args: { stopReason: string }): void;
  onPlanReady(args: {
    planId: string;
    title: string;
    filePath: string;
    status: string;
    revisionCount: number;
  }): void;
  /**
   * First-class `origami/planCandidates` — best-of-N critic round
   * complete. Client renders the alternatives carousel with scores +
   * winner star. `fallback=true` means the critic response was
   * unparseable and candidate 0 was defaulted to.
   */
  onBestOfNComplete(args: PlanCandidates): void;
  /**
   * First-class `origami/taskShape` — task decomposition landed.
   * Client renders the TodoWrite-style checklist with per-sub-task
   * status. `source` distinguishes heuristic / model-declared /
   * merged origins.
   */
  onTaskShape(args: TaskShape): void;
  /**
   * First-class `origami/todoSnapshot` — live todo snapshot mirroring
   * the harness-owned TODO tracker (SPEC §7.2). `source` distinguishes
   * model-driven writes from harness auto-seed and session-restore.
   * The webview renders a sticky strip at the top of the chat pane.
   */
  onTodoUpdate(args: TodoSnapshot): void;
  /**
   * First-class `origami/arbiterDecision` (NEW) — the single per-turn
   * arbiter verdict (`Done | Continue | AskUser`). The dashboard
   * renders ONE coherent decision per turn — the opposite of the
   * donor's "10 gates firing into one turn" (F3). Additive callback;
   * existing handlers are unaffected.
   */
  onArbiterDecision?(args: ArbiterDecision): void;
  /**
   * First-class `origami/assessmentUpdate` (donor's assessment-update
   * notification, renamed for the new brand) — the dashboard's open
   * permission modal should refresh its title in place to show the
   * resolved assessment that arrived after `requestPermission` was sent.
   *
   * Ignored if no modal is open with the matching `toolCallId` (stale
   * — the user already approved/denied and moved on).
   */
  onAssessmentUpdate?(args: { toolCallId: string; text: string }): void;
  /**
   * First-class `origami/feedMessage` (donor's custodian-message feed,
   * renamed for the new brand) — cron + ambient observability. The
   * bridge forwards every `BusMessage` here. The dashboard renders these in a
   * plain (unbranded) activity feed so Passing can see autonomous
   * activity (cron job ticks, model load/unload events).
   *
   * Implementations should narrow on `busKind` and ignore unknown
   * variants.
   */
  onFeedMessage?(args: { busKind: string; payload: Record<string, unknown> }): void;
  /** `origami/mcpAuthUrl` — the sign-in page for an MCP server, pushed the
   *  moment the flow produces it. The `mcp_authenticate` REQUEST cannot carry
   *  it: that answer only arrives after the user has finished with the URL. */
  onMcpAuthUrl?(args: { name: string; url: string }): void;
  onClose(reason: string): void;
  onError(message: string): void;
}

/**
 * Resolve the path to the user-facing `origami` CLI binary using the
 * same search order as `resolveOrigamiAcpBinary`. Used to spawn the
 * engine, and by the Crons view to bake an absolute `origami run …`
 * path into each scheduled task (a task runs with no inherited PATH
 * assumptions, so the bare name would not do).
 */
export function resolveOrigamiBinary(): string {
  const exeName = os.platform() === 'win32' ? 'origami.exe' : 'origami';

  // The `origami` CLI lives next to `origami-acp` in every install
  // layout. When the user pins the ACP bridge via ORIGAMI_ACP_PATH
  // (the common dev setup), derive `origami` from the SAME directory.
  const acpEnv = process.env.ORIGAMI_ACP_PATH;
  if (acpEnv) {
    const sibling = path.join(path.dirname(acpEnv), exeName);
    if (fs.existsSync(sibling)) {
      return sibling;
    }
  }

  const userBin = path.join(os.homedir(), '.origami', 'bin', exeName);
  if (fs.existsSync(userBin)) {
    return userBin;
  }

  const devCandidates = [
    path.resolve(__dirname, '..', '..', 'origami', 'target', 'release', exeName),
    path.resolve(__dirname, '..', '..', 'origami', 'target', 'debug', exeName),
  ];
  for (const c of devCandidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  return exeName;
}

/**
 * The MERGED-VSIX engine: a binary packaged INSIDE the extension at
 * `<packageRoot>/engine/`. Present only in a merged build (scripts/
 * package-merged.ps1 stages it there; the dev VSIX never carries one), so on
 * a dev install this candidate simply misses and resolution falls through to
 * resolveOrigamiBinary's stable order.
 *
 * `__dirname` is `out/` at runtime and `src/` under vitest — `..` lands on
 * the package root either way, which is exactly where the packaging step
 * stages the binary.
 */
export function bundledEngineCandidate(): string {
  const exeName = os.platform() === 'win32' ? 'origami.exe' : 'origami';
  return path.resolve(__dirname, '..', 'engine', exeName);
}

/** The ripgrep the merged VSIX stages beside the engine binary. The engine's
 *  grep/skill tooling hard-requires rg and the fork keeps its auto-download
 *  gated off (zero-network), so a fresh machine with no rg on PATH bricked the
 *  skill tool — first hit on the macOS new-user UAT. When this file exists the
 *  spawn env points the engine straight at it (ORIGAMI_RG_PATH); when it does
 *  not (dev unmerged install), the engine's PATH/cache rungs behave as before. */
export function bundledRgCandidate(): string | undefined {
  const rgName = os.platform() === 'win32' ? 'rg.exe' : 'rg';
  const candidate = path.resolve(__dirname, '..', 'engine', rgName);
  if (!fs.existsSync(candidate)) return undefined;
  if (os.platform() !== 'win32') {
    // Same zip-loses-the-execute-bit story as the engine binary above.
    try { fs.chmodSync(candidate, 0o755); } catch { /* fall through — spawn will surface it */ }
  }
  return candidate;
}

/**
 * What the ENGINE SPAWN runs — and only the spawn. Cron baking stays on
 * resolveOrigamiBinary: this path lives inside a VERSIONED extension folder
 * that changes on every update, while a scheduled task must keep working
 * across updates, so tasks bake the stable ~/.origami/bin path instead.
 *
 * Bundled-first is the merged product's contract: the extension runs the
 * engine it shipped with, whatever else this machine has installed.
 */
export function resolveEngineBinary(): string {
  const bundled = bundledEngineCandidate();
  if (fs.existsSync(bundled)) {
    // A VSIX is a zip and unzipping loses the execute bit, so on POSIX the
    // bundled binary arrives mode 644 and the spawn would fail EACCES. Chmod
    // on every resolve (idempotent); a failure here falls through to the
    // spawn's own error surface, which names the path.
    if (os.platform() !== 'win32') {
      try {
        fs.chmodSync(bundled, 0o755);
      } catch {
        /* surfaced at spawn */
      }
    }
    return bundled;
  }
  return resolveOrigamiBinary();
}

/**
 * Where a `bun` executable can live, most likely first. PURE (platform + home in,
 * paths out) so the per-OS rule is asserted without a filesystem.
 *
 * Windows has one install route, so one candidate. On macOS/Linux the official
 * installer uses `~/.bun/bin`, but Homebrew — the common mac route — uses
 * `/opt/homebrew/bin` (Apple Silicon) or `/usr/local/bin` (Intel). Naming them
 * explicitly matters because the bare-name fallback below is NOT equivalent: a
 * VS Code launched from the Dock inherits a minimal PATH with no Homebrew in it,
 * so `bun` would simply not be found and dev mode would fail with no clue why.
 */
export function bunCandidates(platform: string, home: string): string[] {
  if (platform === 'win32') return [path.join(home, '.bun', 'bin', 'bun.exe')];
  return [path.join(home, '.bun', 'bin', 'bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'];
}

/**
 * Live-source dev mode. When the `origami.devEngineSource` setting points at a
 * checked-out `packages/engine`, run the engine straight from source via Bun
 * (`bun run --conditions=browser <src>/src/index.ts acp …`) so engine edits take
 * effect on a window reload — no 165 MB binary rebuild. Returns the Bun
 * executable + the arg prefix, or null to fall back to the compiled binary.
 */
export function resolveDevEngine(): { bun: string; argPrefix: string[]; entry: string } | null {
  let src: string | undefined;
  try {
    src = vscode.workspace.getConfiguration('origami').get<string>('devEngineSource')?.trim() || undefined;
  } catch {
    return null;
  }
  if (!src) return null;
  const entry = path.join(src, 'src', 'index.ts');
  if (!fs.existsSync(entry)) return null;
  const bun = bunCandidates(os.platform(), os.homedir()).find((c) => fs.existsSync(c)) ?? 'bun';
  return { bun, argPrefix: ['run', '--conditions=browser', entry], entry };
}

/**
 * Locate the `origami-acp` bridge binary.
 *
 * Resolution order:
 *   1. ORIGAMI_ACP_PATH env var (explicit override for dev)
 *   2. ~/.origami/bin/ (user install)
 *   3. Sibling origami repo target/release/ (dev layout)
 *   4. Plain `origami-acp` (PATH lookup)
 */
export function resolveOrigamiAcpBinary(): string {
  const explicit = process.env.ORIGAMI_ACP_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const exeName = os.platform() === 'win32' ? 'origami-acp.exe' : 'origami-acp';

  // ~/.origami/bin/
  const userBin = path.join(os.homedir(), '.origami', 'bin', exeName);
  if (fs.existsSync(userBin)) {
    return userBin;
  }

  // Sibling repo (dev layout: Desktop/origami/target/release/)
  const devCandidates = [
    path.resolve(__dirname, '..', '..', 'origami', 'target', 'release', exeName),
    path.resolve(__dirname, '..', '..', 'origami', 'target', 'debug', exeName),
  ];
  for (const c of devCandidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  // PATH lookup fallback
  return exeName;
}

type PendingPermission = {
  resolve: (response: acp.RequestPermissionResponse) => void;
};


export class AcpClient {
  private child: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private pendingPermissions: PendingPermission[] = [];
  /** Path + mtime of the origami-acp binary this client actually
   * spawned. Used to detect a rebuild-while-running: if the on-disk
   * binary is newer, the window is running stale code and must reload. */
  private spawnedBinary: string | null = null;
  private spawnedBinaryMtimeMs = 0;
  /** `agentInfo.version` from THIS session's ACP handshake. Without it a
   * stale-engine warning is a claim the user cannot check. Empty when the
   * agent sent no agentInfo. */
  private engineVersionReported = ''; private peerAgentName = ''; // agentInfo._meta.peerName: send_message/list_agents `to` address.
  /** Working directory this session was started against. Needed for the
   *  session-scoped ACP calls (listSessions / loadSession) which resolve
   *  config + history relative to it. */
  private cwd = '';
  /** The `configOptions` (model / effort / mode selects) returned by the
   *  last newSession / loadSession / setSessionConfigOption. Source of
   *  truth for the model picker — replaces the dead `list_models`
   *  ext-method. */
  private configOptions: Array<Record<string, unknown>> = [];
  /** toolCallIds recognised as `todowrite`, so EVERY later frame for that
   *  call (incl. the completed frame whose title is the tool's own summary
   *  like "3 todos", and status-only frames that omit title) is routed to
   *  the todo strip and never leaks a generic card. */
  private readonly todoToolCallIds = new Set<string>();

  constructor(private readonly handlers: AcpEventHandlers) {}

  /** Which build this session's engine came from. The stat-now and the
   * verdict live in dashboard/engineStale.ts — a sibling module, not more
   * surface here, because this file sits within a few lines of its cap. */
  public engineSpawn(): EngineSpawn {
    return {
      binary: this.spawnedBinary,
      spawnedMtimeMs: this.spawnedBinaryMtimeMs,
      runningVersion: this.engineVersionReported || undefined,
    };
  }
  get peerName(): string | undefined { return this.peerAgentName || undefined; } // peerAgentName, or undefined if unregistered.
  /**
   * Start the bridge.
   *
   * `engineUrl` (optional) is the resolved inference endpoint. When
   * provided it is passed to the spawned `origami-acp` as the
   * `ORIGAMI_API_BASE` env var — the SAME boundary the Rust bridge
   * already reads at startup, so no Rust change is needed. The env is
   * read once at spawn, which is why changing the endpoint requires a
   * respawn (dispose + new AcpClient) rather than a live mutation.
   *
   * When `engineUrl` is undefined the child simply inherits the parent
   * env unchanged — preserving the existing behaviour (an
   * ORIGAMI_API_BASE set via `setx` keeps working, else the bridge's own
   * localhost default applies).
   */
  async start(cwd: string, engineUrl?: string, loadSessionId?: string, headless?: boolean, agent?: string): Promise<string> {
    if (this.sessionId !== null) {
      return this.sessionId;
    }
    this.cwd = cwd;

    // Live-source dev mode (opt-in via origami.devEngineSource) runs the engine
    // from source via Bun so edits deploy on reload; otherwise the compiled
    // binary. The arg prefix is empty for the binary, or `bun run … src/index.ts`
    // for dev.
    const dev = resolveDevEngine();
    const exec = dev ? dev.bun : resolveEngineBinary();
    const argPrefix = dev ? dev.argPrefix : [];
    console.log(`[origami] engine: ${dev ? `LIVE SOURCE via ${dev.entry}` : `binary ${exec}`}`);
    // Snapshot the mtime of what we spawned (binary, or the src entry in dev
    // mode) so a rebuild/edit can later prompt a reload.
    this.spawnedBinary = dev ? dev.entry : exec;
    try {
      this.spawnedBinaryMtimeMs = fs.statSync(this.spawnedBinary).mtimeMs;
    } catch {
      this.spawnedBinaryMtimeMs = 0;
    }
    let child: ChildProcess;
    try {
      // Pipe stderr (forward to the extension's output channel) and pin
      // windowsHide so the spawned bridge never gets a visible console
      // window even if a future Node toolchain regresses the default.
      // The engine endpoint comes from config (origami.json), NOT from
      // ORIGAMI_API_BASE. `engineUrl` is retained on the signature but unused.
      void engineUrl;
      child = spawn(exec, [...argPrefix, 'acp', '--cwd', cwd], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        windowsHide: true,
        // Which engine flags this shell turns on, and why, lives in engineEnv.ts.
        // ORIGAMI_RG_PATH: see bundledRgCandidate — only set when the merged
        // install actually shipped an rg, so dev spawns are byte-identical.
        env: {
          ...process.env,
          ...engineSpawnEnv({ codeMode: codeModeEnabled(), agentName: agentNameSetting(), headless }),
          ...(() => { const rg = bundledRgCandidate(); return rg ? { ORIGAMI_RG_PATH: rg } : {}; })(),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.handlers.onError(`Failed to spawn origami engine (${exec}): ${msg}`);
      throw e;
    }
    this.child = child;

    child.on('exit', (code, signal) => {
      const reason = `origami-acp exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      this.handlers.onClose(reason);
      this.connection = null;
      this.sessionId = null;
      this.child = null;
    });
    child.on('error', (err) => {
      this.handlers.onError(`origami-acp child error: ${err.message}`);
    });
    // Forward piped stderr to the extension host log so the bridge
    // doesn't go silent. Per-line so multi-line panics don't get
    // truncated.
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      let buf = '';
      child.stderr.on('data', (chunk: string) => {
        buf += chunk;
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl).trimEnd();
          if (line.length > 0) {
            console.error(`[origami-acp] ${line}`);
          }
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
        }
      });
      child.stderr.on('end', () => {
        if (buf.trim().length > 0) {
          console.error(`[origami-acp] ${buf.trim()}`);
        }
      });
    }

    if (!child.stdin || !child.stdout) {
      throw new Error('origami-acp child has no stdio');
    }

    const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(writable, readable);

    const self = this;
    this.connection = new acp.ClientSideConnection(
      (_agent) => self.buildClientImpl(),
      stream,
    );

    const initResp = await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
      },
    });
    // The engine already tells us what it is; nothing read it. This is the
    // session's own answer to "which build am I talking to" — the question a
    // deploy that left old processes alive makes unanswerable.
    const agentInfo = (initResp as { agentInfo?: { version?: unknown; _meta?: { peerName?: unknown } } }).agentInfo;
    this.engineVersionReported = typeof agentInfo?.version === 'string' ? agentInfo.version : ''; this.peerAgentName = typeof agentInfo?._meta?.peerName === 'string' ? agentInfo._meta.peerName : '';
    console.log(
      `[origami] ACP initialized (protocolVersion=${initResp.protocolVersion}, engine=${this.engineVersionReported || 'unreported'})`,
    );

    if (loadSessionId) {
      // History recall: load an existing engine session. The server
      // restores context AND replays the full transcript back as
      // `sessionUpdate` events (agent/user message chunks, tool calls),
      // which land in the normal handlers below → the webview re-renders
      // the conversation. The user can then continue it with full context.
      const loadResp = await this.connection.loadSession({
        sessionId: loadSessionId,
        cwd,
        mcpServers: [],
      });
      this.sessionId = loadSessionId;
      this.configOptions = ((loadResp as { configOptions?: unknown[] }).configOptions ?? []) as Array<
        Record<string, unknown>
      >;
      console.log(`[origami] ACP session loaded: ${this.sessionId}`);
      return this.sessionId;
    }

    // `_meta.agent` = the agent this session is created AS (engine acp/service.ts
    // `requestedAgent`): it seeds the engine session row AND `modeId`, so the FIRST
    // turn speaks as that def — pointing `mode` at it afterwards was one turn late.
    const sessionResp = await this.connection.newSession({ cwd, mcpServers: [], ...(agent ? { _meta: { agent } } : {}) });
    this.sessionId = sessionResp.sessionId;
    this.configOptions = ((sessionResp as { configOptions?: unknown[] }).configOptions ?? []) as Array<
      Record<string, unknown>
    >;
    console.log(`[origami] ACP session created: ${this.sessionId}`);
    return this.sessionId;
  }

  async prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<acp.StopReason> {
    if (!this.connection || !this.sessionId) {
      throw new Error('AcpClient.prompt called before start()');
    }
    const prompt: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
      { type: 'text', text },
    ];
    if (images) {
      for (const img of images) {
        prompt.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      }
    }
    const t0 = Date.now();
    const resp = await this.connection.prompt({
      sessionId: this.sessionId,
      prompt: prompt as any,
    });
    const elapsedSec = (Date.now() - t0) / 1000;
    // The prompt response carries token usage (the engine's promptResponse
    // attaches `usage`). LM Studio reports token counts even when it exposes
    // no context *limit* — so the engine's separate usage_update never fires
    // for local models. Surface it here so the per-chat context gauge has real
    // data. `used` = tokens sitting in context (input + cached-read), matching
    // usage_update's `used`; `size` is left 0 (no limit) — the shell falls back
    // to the probed context window as the gauge denominator. `outputTokens` is
    // this turn's real generated count → last-turn tokens/sec over the wall-clock.
    const usage = (resp as {
      usage?: { inputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number; outputTokens?: number };
    }).usage;
    if (usage && typeof usage.inputTokens === 'number') {
      this.handlers.onUsageUpdate?.({
        used: usage.inputTokens + (usage.cachedReadTokens ?? 0),
        size: 0,
        promptTokens: usage.inputTokens,
        cacheReadTokens: usage.cachedReadTokens ?? 0,
        cacheWriteTokens: usage.cachedWriteTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      });
    }
    if (usage && typeof usage.outputTokens === 'number' && usage.outputTokens > 0 && elapsedSec >= 0.3) {
      this.handlers.onTurnStats?.({ tokensPerSec: Math.round(usage.outputTokens / elapsedSec) });
    }
    return resp.stopReason;
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.sessionId) {
      return;
    }
    await this.connection.cancel({ sessionId: this.sessionId });
  }

  /** Call an ACP ext_method (e.g. get_vram_state, list_skills).
   *  The Rust ACP SDK requires a leading `_` prefix on the wire for
   *  extension methods; the JS SDK does not add it automatically.
   *  (SCAR UI-S4 — drop this and every ext-method `method_not_found`s.) */
  async extMethod(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.connection) {
      throw new Error('AcpClient.extMethod called before start()');
    }
    // ACP protocol: extension methods use a `_` prefix on the wire.
    // The Rust SDK strips it before delivering to the Agent::ext_method handler.
    const wireMethod = method.startsWith('_') ? method : `_${method}`;
    return this.connection.extMethod(wireMethod, params);
  }

  /**
   * `run_steps` — an ordered, read-only projection of a PAST run's steps.
   * Safe for a session that is not open in this connection: the engine only
   * reads stored messages, it never loads or resumes the session.
   *
   * The engine caps the list; check `truncated`/`total` before claiming the
   * view is complete.
   */
  async getRunSteps(sessionId: string, cwd?: string): Promise<RunStepsResult> {
    const result = await this.extMethod('run_steps', {
      sessionId,
      ...(cwd ? { cwd } : {}),
    });
    return result as unknown as RunStepsResult;
  }

  /** `run_stats` — per-run counts for a PAGE of the run index, in one call.
   *  Each id costs the engine a `session.messages` read, so the engine caps the
   *  batch and says so; never call this per row. */
  async getRunStats(sessionIds: string[], cwd?: string): Promise<RunStatsResult> {
    const result = await this.extMethod('run_stats', { sessionIds, ...(cwd ? { cwd } : {}) });
    return result as unknown as RunStatsResult;
  }

  /**
   * `subagent_transcript` — ONE sub-agent's stored session as chat rows. Same
   * read-only guarantee as `getRunSteps` above, and the same tolerance for a
   * child that is gone: an unknown id comes back `found: false`, never a
   * throw, because the caller is a panel that must still draw something.
   */
  async getSubagentTranscript(sessionId: string, cwd?: string): Promise<SubagentTranscriptResult> {
    const result = await this.extMethod('subagent_transcript', {
      sessionId,
      ...(cwd ? { cwd } : {}),
    });
    return result as unknown as SubagentTranscriptResult;
  }

  /**
   * `list_instructions` — every file/URL feeding the system prompt, with
   * sizes. Paths only; contents are never sent, so open the file to read it.
   * `tokensApproxMethod` names the estimator — the token counts are a
   * heuristic, not a tokenisation.
   */
  async listInstructions(cwd?: string): Promise<InstructionSet> {
    const result = await this.extMethod('list_instructions', {
      ...(cwd ? { cwd } : {}),
    });
    return result as unknown as InstructionSet;
  }

  /** `list_tools` — the base tool list plus which of them the deferred-tool
   *  catalog hides from the model. Read-only. */
  async listTools(cwd?: string): Promise<ToolCatalog> {
    return (await this.extMethod('list_tools', { ...(cwd ? { cwd } : {}) })) as unknown as ToolCatalog;
  }

  /**
   * The model picker source — derived from the ACP `configOptions` the
   * server returned at session start (the `model` select). Replaces the
   * dead `list_models` ext-method: the switchable models are exactly the
   * providers/models configured in `origami.json`, and `current` is what
   * the session resolved to. Returns null if no model option was sent.
   */
  getModelOption(): { current: string; options: Array<{ value: string; name: string }> } | null {
    const opt = this.configOptions.find((o) => o['id'] === 'model' && o['type'] === 'select');
    if (!opt) return null;
    const rawOptions = Array.isArray(opt['options'])
      ? (opt['options'] as Array<Record<string, unknown>>)
      : [];
    return {
      current: String(opt['currentValue'] ?? ''),
      options: rawOptions.map((o) => ({ value: String(o['value'] ?? ''), name: String(o['name'] ?? '') })),
    };
  }

  /** Shared reader for a `select` config-option (mode / effort). Mirrors
   *  getModelOption but generic — returns null when the engine didn't send
   *  that option (e.g. effort is omitted for a model with no variants, so the
   *  selector hides instead of showing an empty menu). */
  private getSelectOption(
    id: string,
  ): { current: string; options: Array<{ value: string; name: string; description?: string }> } | null {
    const opt = this.configOptions.find((o) => o['id'] === id && o['type'] === 'select');
    if (!opt) return null;
    const rawOptions = Array.isArray(opt['options'])
      ? (opt['options'] as Array<Record<string, unknown>>)
      : [];
    return {
      current: String(opt['currentValue'] ?? ''),
      options: rawOptions.map((o) => ({
        value: String(o['value'] ?? ''),
        name: String(o['name'] ?? ''),
        ...(o['description'] ? { description: String(o['description']) } : {}),
      })),
    };
  }

  /** The session-mode picker source — the ACP `configOptions` `mode` select
   *  (build / plan / any custom primary agents). `current` is the live
   *  `session.modeId`, so the selector reflects the engine's real state (no
   *  fire-and-forget). Switch via `setConfigOption('mode', id)` — picking
   *  `plan` enters the read-only plan agent. */
  getModeOption() {
    return this.getSelectOption('mode');
  }

  /** The effort picker source — the ACP `configOptions` `effort` select (the
   *  model's REAL reasoning variants, named by the model). Null when the model
   *  declares none. The shell drives its reasoning control from this instead of
   *  hardcoded think/quick, which produced "effort not found: think". */
  getEffortOption() {
    return this.getSelectOption('effort');
  }
  /** Live approve-mode off configOptions' scalar `permission` entry (yolo-permissions; not a `select`, so getSelectOption doesn't fit) — null on an older engine. */
  getPermissionOption(): string | null { const o = this.configOptions.find((x) => x['id'] === 'permission'); const v = o?.['currentValue'] ?? o?.['value']; return typeof v === 'string' ? v : null; }

  /**
   * Switch the session model via the ACP config-option surface
   * (`setSessionConfigOption configId='model'`). The server validates the
   * id against the configured providers and returns the full refreshed
   * `configOptions`, which we cache so `getModelOption()` reflects the new
   * current value. Returns the resolved current model id. Throws on an
   * invalid model (the honest failure — never a silent no-op).
   */
  async setModel(modelId: string): Promise<string> {
    if (!this.connection || !this.sessionId) {
      throw new Error('AcpClient.setModel called before start()');
    }
    const resp = await this.connection.setSessionConfigOption({
      sessionId: this.sessionId,
      configId: 'model',
      value: modelId,
    } as unknown as acp.SetSessionConfigOptionRequest);
    this.configOptions = ((resp as { configOptions?: unknown[] }).configOptions ?? []) as Array<
      Record<string, unknown>
    >;
    return this.getModelOption()?.current ?? modelId;
  }

  /**
   * Set any session config option (`model` / `effort` / `mode`) via the ACP
   * config-option surface. The server validates the value against the
   * session's snapshot and throws an honest error (e.g. InvalidEffortError)
   * when the value isn't valid for the current model — never a silent no-op.
   * Caches the refreshed `configOptions` so `getModelOption()` stays current.
   */
  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.connection || !this.sessionId) {
      throw new Error('AcpClient.setConfigOption called before start()');
    }
    const resp = await this.connection.setSessionConfigOption({
      sessionId: this.sessionId,
      configId,
      value,
    } as unknown as acp.SetSessionConfigOptionRequest);
    this.configOptions = ((resp as { configOptions?: unknown[] }).configOptions ?? []) as Array<
      Record<string, unknown>
    >;
  }

  /**
   * Deterministic rollback. `revert(messageID)` restores the working tree to the
   * snapshot from before that assistant message's turn and marks that turn (and
   * everything after) for removal; `unrevert()` undoes it — valid until the next
   * prompt finalises the deletion. Both ride the string config channel (mirroring
   * the `title` action); the engine does the file + snapshot + message work.
   */
  async revert(messageID: string): Promise<void> {
    await this.setConfigOption('revert', messageID);
  }
  async unrevert(): Promise<void> {
    await this.setConfigOption('unrevert', '');
  }

  /**
   * List prior sessions for the current workspace (standard ACP
   * `listSessions`) — the ONE real recall surface. Recall one by passing
   * its id to `start(cwd, _, sessionId)`.
   */
  async listSessions(): Promise<Array<{ sessionId: string; cwd: string; title: string; updatedAt: string }>> {
    if (!this.connection) {
      throw new Error('AcpClient.listSessions called before start()');
    }
    // EVERY page, not just the first — sessionPaging.ts owns the loop and why.
    const pageAll = (params: { cwd?: string }) =>
      pageSessions((p) => this.connection!.listSessions(p), params);

    // Primary: scope to this workspace's cwd.
    let sessions = await pageAll(this.cwd ? { cwd: this.cwd } : {});

    // Fallback: fire when the cwd-scoped query surfaced no chats OTHER than
    // the CURRENT session — i.e. a fresh/just-created session in this
    // workspace (returns exactly 1 row: itself) or a cwd-key mismatch (loose
    // files / C:\ vs C:/). The old `=== 0` test missed the common
    // one-row-is-the-current-session case, so a brand-new workspace showed
    // "no past chats" even though history exists under other cwds. Retry
    // unfiltered and adopt it only if it actually surfaces past chats.
    const others = (rows: Array<Record<string, unknown>>) =>
      rows.filter(s => String(s['sessionId'] ?? '') !== (this.sessionId ?? ''));
    if (this.cwd && others(sessions).length === 0) {
      const all = await pageAll({});
      if (others(all).length > 0) sessions = all;
    }

    return sessions.map((s) => ({
      sessionId: String(s['sessionId'] ?? ''),
      cwd: String(s['cwd'] ?? ''),
      title: String(s['title'] ?? ''),
      updatedAt: String(s['updatedAt'] ?? ''),
    }));
  }

  /** Switch the ACP permission mode (default / plan / auto / bypass). */
  async setSessionMode(modeId: string): Promise<Record<string, unknown>> {
    if (!this.connection || !this.sessionId) {
      throw new Error('AcpClient.setSessionMode called before start()');
    }
    const resp = await this.connection.setSessionMode({
      sessionId: this.sessionId,
      modeId,
    });
    return resp as unknown as Record<string, unknown>;
  }

  /** Get the current session ID (null if not started). */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  dispose(): void {
    // Not a kill: the engine has a heartbeat file to remove before it goes, and
    // only its own finalizer can do that. Why, and what the grace buys, is in
    // engineShutdown.ts.
    if (this.child) shutdownEngine(this.child);
    this.child = null;
    this.connection = null;
    this.sessionId = null;
    this.todoToolCallIds.clear();
    while (this.pendingPermissions.length > 0) {
      const p = this.pendingPermissions.shift()!;
      p.resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  /**
   * If `u` is a `todowrite` tool_call / tool_call_update, decode its todo
   * list and dispatch `onTodoUpdate` (feeding the live strip), returning
   * true so the caller suppresses the generic tool card. Returns false for
   * any other tool.
   *
   * Source of truth (in priority order): the structured `rawInput.todos`
   * (present on pending + running + completed updates — needed for live
   * ticking), then a JSON-parse of the completed update's text content
   * (the engine emits `JSON.stringify(todos)` there). The wire item shape
   * is `{content, status, priority}` (no `activeForm`), so activeForm is
   * reused from content. Discriminated by `title === 'todowrite'` (the
   * engine's toolTitle fallback) — the only reliable signal, since the
   * tool name is not carried on the wire.
   */
  private tryHandleTodoWrite(u: unknown): boolean {
    const upd = u as {
      toolCallId?: unknown;
      title?: unknown;
      rawInput?: { todos?: unknown };
      content?: unknown;
    };
    const id = typeof upd.toolCallId === 'string' ? upd.toolCallId : '';
    const title = typeof upd.title === 'string' ? upd.title.toLowerCase() : '';
    const hasTodos = !!(upd.rawInput && Array.isArray(upd.rawInput.todos));
    // Recognise todowrite by ANY of: the title 'todowrite' (pending /
    // running / error frames); a structured rawInput.todos payload (the
    // COMPLETED frame's title is the tool's own summary, e.g. "3 todos",
    // NOT 'todowrite'); or a remembered toolCallId (a status-only frame
    // may carry neither title nor payload). Title-only gating was the bug:
    // it leaked the completed frame as a generic JSON card AND starved the
    // strip of the final snapshot.
    const recognised =
      title === 'todowrite' || hasTodos || (id !== '' && this.todoToolCallIds.has(id));
    if (!recognised) return false;
    if (id) this.todoToolCallIds.add(id);

    // The list this frame carries — structured rawInput.todos preferred, else
    // the completed frame's JSON text content. Shaping rules: acpTodoWrite.ts.
    const todos = todosFromUpdate(upd);
    if (todos) this.handlers.onTodoUpdate({ source: 'model_write', todos });
    // Always suppress the generic card once recognised — even a status-only
    // frame with no todos payload must not leak a card.
    return true;
  }

  private buildClientImpl(): acp.Client {
    return {
      sessionUpdate: async (params) => {
        // Every session's stream flows over this one connection, each tagged
        // with its owning sessionId. This client represents ONE session; a
        // background sub-agent runs in a CHILD session and its inner stream
        // (a different sessionId) must NOT render here — otherwise two
        // sub-agents streaming at once interleave and garble the parent
        // transcript. Drop anything that isn't ours. (The sub-agent's RESULT
        // is injected back onto the parent session, so it still arrives with
        // our sessionId and renders normally.)
        const updSessionId = (params as { sessionId?: string }).sessionId;
        if (updSessionId && this.sessionId && updSessionId !== this.sessionId) return;
        const u = params.update;
        switch (u.sessionUpdate) {
          case 'agent_message_chunk': {
            // The engine tags the /compact summary turn with
            // `_meta.origami_compaction` so we collapse it into a "Compaction
            // Completed" marker instead of dumping the summary + scratchpad into
            // the transcript. Plain ACP servers never set it -> normal render.
            const cmeta = (u as { _meta?: { origami_compaction?: unknown; origami_child_session?: unknown } })._meta;
            if (u.content.type === 'text' && cmeta?.origami_compaction === true) {
              this.handlers.onCompactionChunk?.(u.content.text);
              break;
            }
            // A BACKGROUND sub-agent settled — an empty chunk carrying only the
            // marker, since the launcher card completed back at spawn time.
            const done = taskDone(u);
            if (done) {
              this.handlers.onSubagentDone?.(done);
              break;
            }
            // A SUB-AGENT's output, forwarded under this session by the engine
            // (the child's own session is never registered here). Route it to the
            // task card that spawned it — appending it to the parent's transcript
            // would interleave ten fan-out children into one garbled turn.
            if (u.content.type === 'text' && typeof cmeta?.origami_child_session === 'string') {
              this.handlers.onSubagentChunk?.({
                childSessionId: cmeta.origami_child_session,
                text: u.content.text,
              });
              break;
            }
            // Same replay filter as the user slot: a synthetic assistant part (a sub-agent's
            // `<task_result>` blob, compaction scratch) is for the model, not the reader.
            if (u.content.type === 'text' && !modelOnlyContent(u.content)) {
              this.handlers.onAgentMessageChunk(u.content.text, (u as { messageId?: string }).messageId);
            } else if (u.content.type === 'image') {
              const img = u.content as { data?: string; mimeType?: string };
              if (img.data && img.mimeType) {
                this.handlers.onAgentImageChunk(img.data, img.mimeType);
              }
            }
            break;
          }
          case 'user_message_chunk': {
            // Emitted on history replay (loadSession) — without this case the donor lost every user turn from a
            // resumed transcript. Replay carries the model-only parts the live stream drops, so filter them here
            // or the interject envelope renders under the human's name (acpAudience.ts).
            if (u.content.type !== 'text' || modelOnlyContent(u.content)) break;
            // A PEER agent's handoff arrives in this same slot but nobody here
            // typed it, so it is routed away from the human's row (acpPeerMeta.ts).
            const peer = peerFromMeta(u);
            if (peer) this.handlers.onPeerMessage?.({ ...peer, text: u.content.text });
            else this.handlers.onUserMessageChunk?.(u.content.text);
            break;
          }
          case 'agent_thought_chunk':
            // Streamed reasoning. Optional surface — rendered dim or dropped.
            if (u.content.type === 'text') {
              this.handlers.onAgentThoughtChunk?.(u.content.text);
            }
            break;
          case 'tool_call': {
            // `todowrite` is the live task list: route it to the todo strip
            // (onTodoUpdate) and DON'T render a generic tool card. The
            // model calls it many times per turn — stacking JSON cards is
            // noise; the strip shows the same data, evolving in place.
            if (this.tryHandleTodoWrite(u)) break;
            // The engine stamps this on every tool event (acpToolMeta.ts);
            // absent/plain-ACP reads as '' → GenericCard.
            const toolName = toolNameRider(u);
            const locs = (u as { locations?: Array<{ path?: unknown }> }).locations;
            const path = Array.isArray(locs) && typeof locs[0]?.path === 'string' ? locs[0].path : undefined;
            this.handlers.onToolCallStart({
              toolCallId: u.toolCallId,
              title: u.title ?? '',
              kind: u.kind ?? 'other',
              status: u.status ?? 'in_progress',
              toolName,
              path,
              rawInput: (u as { rawInput?: unknown }).rawInput,
              // Sibling decorations of origami_tool_name — for a `task` call: its
              // child session, whether it detached, its model (acpTaskMeta.ts).
              ...taskRiders(u),
            });
            break;
          }
          case 'tool_call_update': {
            // todowrite updates also feed the strip, not a card (see above).
            if (this.tryHandleTodoWrite(u)) break;
            // The whole content ARRAY is scanned (text + diff + image blocks)
            // by acpToolContent.ts, extracted when this file hit its cap.
            const { contentText, diff, images } = decodeToolContent(u.content);
            // The resolved title (write's is the relative file path) and the
            // ACP `locations` path only land on the update, not the initial
            // pending tool_call — extract them here so the card can show the
            // file it wrote instead of a bare "write".
            const uTitle = typeof (u as { title?: unknown }).title === 'string'
              ? (u as { title: string }).title
              : undefined;
            const uLocs = (u as { locations?: Array<{ path?: unknown }> }).locations;
            const uPath = Array.isArray(uLocs) && typeof uLocs[0]?.path === 'string'
              ? uLocs[0].path
              : undefined;
            // Same rider, same reader (replay-toolcards: heals a card whose
            // initial tool_call never matched).
            const uToolName = toolNameRider(u);
            this.handlers.onToolCallUpdate({
              toolCallId: u.toolCallId,
              ...taskRiders(u),
              // The engine always sets an explicit status
              // (in_progress/completed/failed). Pass it through verbatim —
              // the webview renders `failed` as a red card. The `??` is a
              // defensive last resort only; it must NOT mask a real
              // `failed` as green.
              status: (u.status as string | undefined) ?? 'completed',
              contentText,
              diff,
              images,
              title: uTitle,
              path: uPath,
              rawInput: (u as { rawInput?: unknown }).rawInput,
              rawOutputMeta: (u as { rawOutput?: { metadata?: unknown } }).rawOutput?.metadata,
              ...(uToolName ? { toolName: uToolName } : {}),
            });
            break;
          }
          case 'available_commands_update': {
            const cmds = (u as any).availableCommands;
            if (Array.isArray(cmds)) {
              this.handlers.onAvailableCommands(
                cmds.map((c: any) => ({ name: String(c.name || ''), description: String(c.description || '') }))
              );
            }
            break;
          }
          case 'session_info_update': {
            // The engine pushes the generated session title here. Forward it
            // so the tab/history rename the moment the title lands.
            const si = u as { title?: string | null };
            const title = typeof si.title === 'string' ? si.title.trim() : '';
            if (title) this.handlers.onSessionTitle?.({ title });
            break;
          }
          case 'current_mode_update': {
            // Engine-driven mode switch (e.g. plan_exit -> build). Reflect it in
            // the selector/status bar; the next turn already runs as this mode.
            const cm = u as { currentModeId?: string };
            const modeId = typeof cm.currentModeId === 'string' ? cm.currentModeId : '';
            if (modeId) {
              // Keep the cached `mode` select in sync so getModeOption() (and the
              // broadcastConfigSelectors re-read) reflect the new mode rather than
              // the stale pre-switch currentValue.
              const opt = this.configOptions.find((o) => o['id'] === 'mode' && o['type'] === 'select');
              if (opt) opt['currentValue'] = modeId;
              this.handlers.onModeChanged?.({ modeId });
            }
            break;
          }
          case 'usage_update': {
            // Subagent rollup rides `_meta.subagents` (ACP's extension bag —
            // a top-level field fails the SDK check); absent = no children ran.
            const uu = u as { used?: number; size?: number; cost?: { amount?: number; currency?: string };
              _meta?: { subagents?: { cost?: number; tokensInput?: number; tokensOutput?: number } } };
            const sub = uu._meta?.subagents;
            this.handlers.onUsageUpdate?.({
              used: Number(uu.used ?? 0),
              size: Number(uu.size ?? 0),
              cost: uu.cost && typeof uu.cost.amount === 'number'
                ? { amount: uu.cost.amount, currency: String(uu.cost.currency ?? 'USD') }
                : undefined,
              ...(sub && typeof sub.cost === 'number'
                ? { subagents: { cost: sub.cost, tokensInput: Number(sub.tokensInput ?? 0), tokensOutput: Number(sub.tokensOutput ?? 0) } }
                : {}),
            });
            break;
          }
          case 'plan': {
            // REAL plans only. The synthetic uses of `Plan` (turn_end,
            // todo, task_shape, best_of_n, question) are GONE — they
            // arrive as first-class `origami/*` notifications via
            // `extNotification` below. No `_meta.lilinyx_kind` sniffer,
            // no `turn_end`-defaults-to-`self_review` fall-through, so
            // no phantom "Self-reviewing plan…" banner.
            const meta = (u as any)._meta ?? {};
            const status = (meta.status as string) ?? '';
            if (status === 'awaiting_user') {
              this.handlers.onPlanReady({
                planId: meta.planId ?? '',
                title: meta.title ?? '',
                filePath: meta.filePath ?? '',
                status: 'awaiting_user',
                revisionCount: meta.revisionCount ?? 0,
              });
            } else if (status) {
              this.handlers.onPlanStatus({
                planId: meta.planId ?? '',
                status,
                revisionCount: meta.revisionCount ?? 0,
              });
            }
            break;
          }
          default:
            // Surface anything the engine emits that we don't handle — a
            // silent drop here is exactly how usage_update + thought chunks
            // went missing. A warn keeps future additions from slipping by.
            console.warn(`[origami] unhandled sessionUpdate: ${String((u as { sessionUpdate?: unknown }).sessionUpdate ?? '(unknown)')}`);
            break;
        }
      },

      requestPermission: async (params) => {
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          const pending: PendingPermission = { resolve };
          this.pendingPermissions.push(pending);
          this.handlers.onPermissionRequest({
            toolCallId: params.toolCall.toolCallId,
            title: params.toolCall.title ?? '',
            kind: (params.toolCall.kind as string | undefined) ?? 'other',
            rawInput: (params.toolCall as { rawInput?: unknown }).rawInput,
            locations: (params.toolCall as { locations?: ReadonlyArray<{ path?: string; line?: number }> }).locations,
            options: params.options.map((o) => ({
              optionId: o.optionId,
              name: o.name,
              kind: o.kind,
            })),
            questions: questionsFromMeta((params as { _meta?: unknown })._meta),
            respond: (optionId: string | null, answerText?: string, answers?: ReadonlyArray<QuestionAnswer>) => {
              const idx = this.pendingPermissions.indexOf(pending);
              if (idx >= 0) this.pendingPermissions.splice(idx, 1);
              // Cancelled RESOLVES the call rather than dropping it, so the
              // engine stops waiting for an answer and the turn continues.
              if (optionId === null) { resolve({ outcome: { outcome: 'cancelled' } }); return; }
              // M4.4 — free text and batch answers ride the SELECTED outcome's
              // `_meta` (ACP reserves it); omitted when there are none.
              const meta = replyMeta(answerText, answers);
              resolve({ outcome: meta ? { outcome: 'selected', optionId, _meta: meta } : { outcome: 'selected', optionId } });
            },
          });
        });
      },

      // Ext REQUESTS from the engine. Only `origami/browser` is answered here
      // (browserBridge.ts owns every VS Code call it makes); anything else is
      // a method this client does not implement and must say so rather than
      // return a shape the caller would read as a half-success.
      extMethod: async (method, params) => {
        if (isBrowserMethod(method)) return await handleBrowserExtMethod(params);
        // Same rejection the SDK gave before this member existed, so adding it
        // did not turn "not implemented" into a different failure for callers.
        throw acp.RequestError.methodNotFound(method);
      },

      // First-class `origami/*` notifications. The Rust SDK prefixes
      // ext_method names with `_` on the wire, so a server emit of
      // `origami/todoSnapshot` arrives here as `_origami/todoSnapshot`.
      // Strip the prefix and dispatch by bare method name. Unknown
      // methods are silently ignored — forward-compatible with the
      // reserved-but-stubbed notifications (origami/steerAccepted,
      // origami/inputQueued).
      extNotification: async (method, params) => {
        const bare = method.startsWith('_') ? method.slice(1) : method;
        const p = (params ?? {}) as Record<string, unknown>;

        switch (bare) {
          case 'origami/planCandidates':
            this.handlers.onBestOfNComplete(planCandidatesFrom(p));
            break;
          case 'origami/taskShape':
            this.handlers.onTaskShape(taskShapeFrom(p));
            break;
          case 'origami/todoSnapshot':
            this.handlers.onTodoUpdate(todoSnapshotFrom(p));
            break;
          case 'origami/turnEnd': {
            // The bridge's end-of-turn signal carrying the real
            // `stop_reason`. Two consumers, both honest:
            //   1) clear any in-progress plan banner (NEVER `self_review`).
            //   2) forward the real `stop_reason` so the dashboard can
            //      render the per-turn TERMINAL verdict (verified-done /
            //      incomplete:<reason> / parked). Previously the payload
            //      was discarded here (the F4 blind-instrument bug): a
            //      budget-walled FAILURE looked like healthy progress.
            this.handlers.onPlanStatus({
              planId: '',
              status: 'turn_end',
              revisionCount: 0,
            });
            this.handlers.onTurnEnd?.({
              stopReason: String(p.stop_reason ?? ''),
            });
            break;
          }
          case 'origami/arbiterDecision':
            this.handlers.onArbiterDecision?.(arbiterDecisionFrom(p));
            break;
          case 'origami/assessmentUpdate': {
            if (
              typeof p.toolCallId === 'string' &&
              typeof p.text === 'string' &&
              this.handlers.onAssessmentUpdate
            ) {
              this.handlers.onAssessmentUpdate({
                toolCallId: p.toolCallId,
                text: p.text,
              });
            }
            break;
          }
          case 'origami/mcpAuthUrl': {
            if (typeof p.name === 'string' && typeof p.url === 'string') {
              this.handlers.onMcpAuthUrl?.({ name: p.name, url: p.url });
            }
            break;
          }
          case 'origami/feedMessage': {
            // Cron + ambient bus messages forwarded by the bridge.
            // Shape: { bus_kind: "...", <variant-specific fields> }.
            const busKind = typeof p['bus_kind'] === 'string'
              ? (p['bus_kind'] as string)
              : 'unknown';
            this.handlers.onFeedMessage?.({ busKind, payload: p });
            break;
          }
          default: break;
        }
      },
    };
  }
}
