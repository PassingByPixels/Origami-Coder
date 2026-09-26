// Origami ACP client — wraps the ACP TypeScript SDK and spawns the `origami-acp`
// bridge as a child process; line-delimited JSON-RPC 2.0 over its stdin/stdout.
// The extension is a pure frontend: all agent execution happens in origami-acp.
//
// Wire contract (docs/WIRE-CONTRACT.md): ext-methods travel `_`-prefixed (this
// client adds the `_`, the JS SDK does not); domain events are FIRST-CLASS
// `origami/*` notifications, not `_meta` riders on a synthetic `Plan`; the one
// kept `_meta` use is `_meta.lilinyx_tool_name` on a REAL `ToolCall`; and
// `SessionUpdate::Plan` is consumed ONLY for real plans.

import * as vscode from 'vscode';
import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EngineSpawn } from './dashboard/engineStale';
import * as fs from 'node:fs';

import type { RunStepsResult, RunStatsResult, InstructionSet, SubagentTranscriptResult, SubagentTodosResult, SubagentChangesResult, ToolCatalog } from './acpExtTypes';
import { engineSpawnEnv, codeModeEnabled } from './engineEnv';
import { subagentLimitHours } from './subagentLimit'; // the sub-agent cap is read at SPAWN, like every other value in the overlay
import { agentNameSetting, AGENT_NAME_VAR } from './peerName';
import { pinnedSpawnEnv } from './elastic/spawnPin'; // t-w2u2ki: TZ pinned for every spawn
import { shutdownEngine } from './engineShutdown';
import { peerFromMeta, type PeerOrigin } from './acpPeerMeta';
import { modelOnlyContent } from './acpAudience';
import { todosFromUpdate } from './acpTodoWrite';
import { decodeToolContent } from './acpToolContent';
import { taskDone, taskPart, taskRiders, type TaskDone, type TaskRiders, type TaskTokens } from './acpTaskMeta';
import { streamDropNotice, type StreamDropNotice } from './acpStreamDrop';
import { toolNameRider } from './acpToolMeta';
import { handleBrowserExtMethod, isBrowserMethod, type BrowserSnapshot } from './browserBridge';
import { questionsFromMeta, replyMeta, type QuestionAsk, type QuestionAnswer } from './questionBatch';
import { planCandidatesFrom, taskShapeFrom, todoSnapshotFrom, arbiterDecisionFrom, flockMailboxFrom, cacheStateFrom, type PlanCandidates, type TaskShape, type TodoSnapshot, type ArbiterDecision, type FlockMailboxPush, type CacheStatePush } from './acpNotify';
import { artifactsChangedFrom, type ArtifactDiffResult, type ArtifactListResult, type ArtifactOpenResult, type ArtifactRestoreResult, type ArtifactVersionsResult, type ArtifactsChangedPush } from './dashboard/artifactAcp';
import { listWorkspaceSessions } from './sessionPaging';
import { forwardStderr } from './acpStderr';
import { establishSession, type SessionConnection } from './acpFork';
import { backgroundTaskFrom, type BackgroundTask } from './dashboard/agentTreeHost';
import { historyPageReplyFrom, historySearchReplyFrom, historyWindowFrom, pageTag, subagentRosterFrom, type HistoryPageReply, type HistorySearchReply, type HistoryWindow, type SubagentRoster } from './acpHistory';

export type { RunStep, RunStepsResult, InstructionEntry, InstructionSet } from './acpExtTypes';

/**
 * The engine's split of one prompt's tokens, off `usage_update._meta.composition`.
 * The three parts sum to `used`; `estimated` is always true, because the provider
 * reports the total alone and the split is attributed from the engine's capture.
 *
 * MIRRORED in `webview/dashboard/components/contextComposition.ts` — a webview
 * `.ts` file cannot import from `src/` (tsconfig.webview rootDir). The drift test in
 * `webview/dashboard/__tests__/contextComposition.test.ts` reads both files.
 */
export type ContextComposition = {
  systemPrompt: number;
  tools: number;
  conversation: number;
  estimated: true;
  method: string;
};

/** Parse `_meta.composition`. Every part must be a finite, non-negative number, or the
 *  whole object is dropped: a half-read breakdown would draw a bar that lies. */
export function parseComposition(raw: unknown): ContextComposition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const part = (key: string): number | undefined => {
    const value = c[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const systemPrompt = part('systemPrompt');
  const tools = part('tools');
  const conversation = part('conversation');
  if (systemPrompt === undefined || tools === undefined || conversation === undefined) return undefined;
  return {
    systemPrompt, tools, conversation,
    estimated: true,
    method: typeof c['method'] === 'string' ? c['method'] : '',
  };
}

export interface AcpEventHandlers {
  /** `messageId` is the engine's assistant-message id (live + on replay) — the anchor a "rewind to
   *  here" reverts to. */
  onAgentMessageChunk(text: string, messageId?: string): void;
  onAgentImageChunk(data: string, mimeType: string): void;
  /** Replayed/streamed USER turn text (`user_message_chunk`), emitted by the
   *  engine on history replay (`loadSession`). Optional. */
  onUserMessageChunk?(text: string): void;
  /** A handoff from ANOTHER agent session, not this window's human (acpPeerMeta.ts).
   *  Split off from `onUserMessageChunk` so it can never render as the user. */
  onPeerMessage?(args: PeerOrigin & { text: string }): void;
  /** A dropped provider stream, as DATA (acpStreamDrop.ts) — retrying, or the
   *  ladder spent. Its own handler because it is the SYSTEM speaking: routed to
   *  `onAgentMessageChunk` it would wear the agent's name, which is the whole
   *  defect this replaced. Optional. */
  onStreamDrop?(notice: StreamDropNotice): void;
  /** Streamed reasoning text (`agent_thought_chunk`). Optional — rendered dim, or
   *  dropped. */
  onAgentThoughtChunk?(text: string): void;
  /** Streamed /compact summary text, tagged `_meta.origami_compaction`. Rendered
   *  as a collapsed "Compaction Completed" marker, not a live assistant turn. */
  onCompactionChunk?(text: string): void;
  /** A SUB-AGENT's live output, forwarded by the engine under this (ancestor)
   *  session and tagged `_meta.origami_child_session`. `childSessionId` matches
   *  the `taskSessionId` on the spawning task tool call, which is how the UI parks
   *  the stream under that card. Optional. */
  onSubagentChunk?(args: { childSessionId: string; text: string }): void;
  /** A SUB-AGENT's live REASONING, on the same channel as its output but marked
   *  `_meta.origami_task_part: 'reasoning'` (t-gvz8t0). Its own handler because
   *  it is thought, not the child's reply: a thinking model can spend two
   *  minutes and 7k tokens here before its first tool call, and with nothing on
   *  the row that reads as a stalled agent. Optional. */
  onSubagentThought?(args: { childSessionId: string; text: string }): void;
  /** A BACKGROUND sub-agent FINISHED — the launcher card completed at SPAWN, so
   *  only this says the child itself is done (acpTaskMeta.ts). `tokens` is the
   *  FINAL total, riding the same settling chunk: the marker is the only frame
   *  the host logs, so without it a reloaded card comes back with no spend at
   *  all (t-fdvr2a). Absent against an engine that rides no counters. Optional. */
  onSubagentDone?(args: TaskDone & { tokens?: TaskTokens }): void;
  /** A running sub-agent's TOKEN COUNTERS, re-sent per child step on the same
   *  side channel as its output (t-dkkd2o). They cannot ride the launcher's
   *  tool call: a background task's call completes at SPAWN and the engine can
   *  no longer write its metadata. Latest wins. Optional. */
  onSubagentTokens?(args: { childSessionId: string; tokens: TaskTokens }): void;
  onToolCallStart(args: TaskRiders & {
    toolCallId: string;
    title: string;
    kind: string;
    status: string;
    /** Actual tool name via `_meta.origami_tool_name` on a REAL `ToolCall` — a
     *  decoration the wire contract keeps. Lets the dashboard dispatch per-tool
     *  cards even though ACP `kind` collapses many tools into one bucket. Empty
     *  string when the bridge did not set it (plain ACP servers). */
    toolName: string;
    /** First file path from the ACP ToolCall `locations`, so the card can show WHERE it wrote. */
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
     *  running/completed update — the initial `tool_call` fires before the engine
     *  has them (write's pending title is literally "write", no locations). */
    title?: string;
    path?: string;
    rawInput?: unknown;
    /** Structured diff on an edit-kind `tool_call_update`, as an ACP
     *  `{ type:'diff', path, oldText, newText }` block. Present only for edit tools
     *  that supplied an `oldString`. */
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
    /** The tool's raw metadata ({ filepath, parentDir } for an external-directory prompt,
     *  or the arguments) — the context the permission bar shows so nobody approves blind. */
    rawInput?: unknown;
    /** ACP file locations attached to the call (read/write/edit set `path`). */
    locations?: ReadonlyArray<{ path?: string; line?: number }>;
    options: ReadonlyArray<{ optionId: string; name: string; kind: string }>;
    /** Every question this ONE ask carries; absent = fall back to title+options, which always
     *  describe the first (questionBatch.ts). */
    questions?: ReadonlyArray<QuestionAsk>;
    /** `answerText` = free text from a question's "Other" option, on `_meta`; `answers` = one per
     *  question in a BATCH. */
    respond: (optionId: string | null, answerText?: string, answers?: ReadonlyArray<QuestionAnswer>) => void;
  }): void;
  onAvailableCommands(commands: Array<{ name: string; description: string }>): void;
  /** `usage_update` — the per-turn token/context accounting. `used` = input +
   *  cache-read, `size` = context limit, `cost` = session total; omitted with no limit. */
  onUsageUpdate?(args: {
    used: number;
    size: number;
    /** What `used` is made of, from the engine's own prompt capture. Absent on an
     *  engine that does not report it and on a session that has sent no turn — the
     *  gauge then keeps its plain title rather than drawing an invented card. */
    composition?: ContextComposition;
    cost?: { amount: number; currency: string };
    subagents?: { cost: number; tokensInput: number; tokensOutput: number };
    /** This turn's raw usage: prefill = prompt/input, read = cache-read, write = generated. Absent
     *  without usage. */
    promptTokens?: number;
    cacheReadTokens?: number;
    outputTokens?: number;
    /** Cache-WRITE tokens — distinct from generated `outputTokens` above. */
    cacheWriteTokens?: number;
  }): void;
  /** `session_info_update` — the engine pushes this session's generated title the
   *  instant it is set. Each AcpClient is bound to one session. */
  onSessionTitle?(args: { title: string }): void;
  /** ACP `current_mode_update` — the engine switched this session's agent on its
   *  own (approving a plan runs the next turn as build). Mirror it into the
   *  selector + status bar so the UI matches the engine's real mode. */
  onModeChanged?(args: { modeId: string }): void;
  onPlanStatus(args: { planId: string; status: string; revisionCount: number; message?: string }): void;
  /** First-class `origami/turnEnd` — the loop reached a terminal for THIS ACP
   *  turn. `stopReason` is the wire taxonomy label verbatim (`success` |
   *  `asked_user` | `error_max_turns` | `error_max_budget` | `error_no_progress` |
   *  `error_during_execution` | `park_infra`). Distinct from
   *  `onPlanStatus(turn_end)`, which only clears the plan banner. */
  onTurnEnd?(args: { stopReason: string }): void;
  /** First-class `origami/sessionStatus` — is the ENGINE running a turn for this
   *  session right now. `status` is the SessionStatus label (`idle` | `busy` |
   *  `retry`, plus later additions); the reading rule lives in
   *  webview/shared/engineStatus.ts. It covers turns the engine starts by itself,
   *  which have no ACP `prompt()` in flight to settle; an engine that does not send
   *  it falls back to `echoUser` / `turnDone`. */
  onSessionStatus?(args: { sessionId: string; status: string }): void;
  /** First-class `origami/flockMailbox` — `flock.json` moved on disk, in ANY engine
   *  here. The same object `flock_mailbox` returns; the poll stays as fallback. */
  onFlockMailbox?(args: FlockMailboxPush): void;
  /** `origami/artifactsChanged` (also accepted as `origami/artifacts`) — an
   *  artifact was published, pulled or restored on some device in the group.
   *  The host re-reads the list rather than patching a row: the list is the
   *  only copy that can be complete. The decoded change is passed anyway, and
   *  is OPTIONAL to receive — a handler that only refreshes takes no argument,
   *  and a later caller (a toast naming the artifact) needs one. */
  onArtifactsChanged?(args?: ArtifactsChangedPush): void;
  /** First-class `origami/cacheState` — the engine measured whether this session's
   *  prompt prefix is still cached. Pushed on a real step, a successful warm, a
   *  compaction, a model change, and when the provider's window runs out. The badge
   *  NEVER derives this itself: only the engine sees the cache-read token count. */
  onCacheState?(args: CacheStatePush): void;
  onPlanReady(args: {
    planId: string;
    title: string;
    filePath: string;
    status: string;
    revisionCount: number;
  }): void;
  /** First-class `origami/planCandidates` — best-of-N critic round complete.
   *  `fallback=true` means the critic response was unparseable and candidate 0 was
   *  defaulted to. */
  onBestOfNComplete(args: PlanCandidates): void;
  /** First-class `origami/taskShape` — task decomposition landed. `source`
   *  distinguishes heuristic / model-declared / merged origins. */
  onTaskShape(args: TaskShape): void;
  /** First-class `origami/todoSnapshot` — live todo snapshot mirroring the
   *  harness-owned TODO tracker. `source` distinguishes model-driven writes from
   *  harness auto-seed and session-restore. */
  onTodoUpdate(args: TodoSnapshot): void;
  /** A page the agent just looked at, as a picture. Fired off the answered
   *  `origami/browser` ext request (the engine emits no notification for the
   *  browser), so the sessionId is the host handler's. Optional. */
  onBrowserSnapshot?(args: BrowserSnapshot): void;
  /** First-class `origami/arbiterDecision` — the single per-turn arbiter verdict
   *  (`Done | Continue | AskUser`). */
  onArbiterDecision?(args: ArbiterDecision): void;
  /** First-class `origami/assessmentUpdate` — the open permission modal should
   *  refresh its title in place with the assessment that arrived after
   *  `requestPermission` was sent. Ignored when no modal matches `toolCallId`. */
  onAssessmentUpdate?(args: { toolCallId: string; text: string }): void;
  /** First-class `origami/feedMessage` — cron + ambient observability; the bridge
   *  forwards every `BusMessage` here. Narrow on `busKind` and ignore unknown
   *  variants. */
  onFeedMessage?(args: { busKind: string; payload: Record<string, unknown> }): void;
  /** `origami/mcpAuthUrl` — an MCP server's sign-in page, pushed the moment the flow
   *  produces it. The `mcp_authenticate` REQUEST answers only after the user is done. */
  onMcpAuthUrl?(args: { name: string; url: string }): void;
  /** `origami/historyWindow` (t-ucnp7t, wire_contract.md 1.3): the restore replayed only this page. */
  onHistoryWindow?(win: HistoryWindow): void;
  /** `origami/subagentRoster` (wire_contract.md 4): every descendant, from session rows. */
  onSubagentRoster?(roster: SubagentRoster): void;
  onBackgroundTask?(task: BackgroundTask): void; // t-z1xlfy `origami/backgroundTask`: a sub-agent's background shell (agentTreeHost.ts)
  onClose(reason: string): void;
  onError(message: string): void;
}

/** Resolve the user-facing `origami` CLI binary, same search order as
 *  `resolveOrigamiAcpBinary`. Used to spawn the engine, and by the Crons view to
 *  bake an absolute path into each scheduled task (no inherited PATH). */
export function resolveOrigamiBinary(): string {
  const exeName = os.platform() === 'win32' ? 'origami.exe' : 'origami';

  // The `origami` CLI lives next to `origami-acp` in every install layout, so when the
  // bridge is pinned via ORIGAMI_ACP_PATH, derive `origami` from that same directory.
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

/** The MERGED-VSIX engine: a binary packaged INSIDE the extension at
 *  `<packageRoot>/engine/`. Present only in a merged build, so a dev install
 *  misses this candidate and falls through to resolveOrigamiBinary's order.
 *  `__dirname` is `out/` at runtime and `src/` under vitest — `..` lands on the
 *  package root either way. */
export function bundledEngineCandidate(): string {
  const exeName = os.platform() === 'win32' ? 'origami.exe' : 'origami';
  return path.resolve(__dirname, '..', 'engine', exeName);
}

/** The ripgrep the merged VSIX stages beside the engine binary. The engine's
 *  grep/skill tooling hard-requires rg and auto-download is off, so when this
 *  file exists the spawn env points the engine at it (ORIGAMI_RG_PATH). */
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

/** What the ENGINE SPAWN runs, and only the spawn. Cron baking stays on
 *  resolveOrigamiBinary: this path lives in a VERSIONED extension folder, while
 *  a scheduled task must keep working across updates. Bundled-first is the
 *  merged product's contract. */
export function resolveEngineBinary(): string {
  const bundled = bundledEngineCandidate();
  if (fs.existsSync(bundled)) {
    // A VSIX is a zip and unzipping loses the execute bit, so on POSIX the bundled
    // binary arrives mode 644 and the spawn would fail EACCES. Chmod is idempotent.
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

/** Where a `bun` executable can live, most likely first. PURE (platform + home
 *  in, paths out). macOS/Linux name Homebrew's prefixes explicitly because a VS
 *  Code launched from the Dock inherits a minimal PATH, so the bare-name fallback
 *  would simply not find `bun`. */
export function bunCandidates(platform: string, home: string): string[] {
  if (platform === 'win32') return [path.join(home, '.bun', 'bin', 'bun.exe')];
  return [path.join(home, '.bun', 'bin', 'bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'];
}

/** t-w2u2ki: the env one engine spawn adds to the host env. The warm spare's spawn digest reads the same. */
export function engineOverlay(headless?: boolean): Record<string, string> {
  const rg = bundledRgCandidate(); // ORIGAMI_RG_PATH is set only when the merged install shipped an rg
  return { ...engineSpawnEnv({ codeMode: codeModeEnabled(), agentName: agentNameSetting(), headless, subagentLimitHours: subagentLimitHours() }), ...(rg ? { ORIGAMI_RG_PATH: rg } : {}), ...pinnedSpawnEnv() };
}

/** Live-source dev mode: when `origami.devEngineSource` points at a checked-out
 *  `packages/engine`, run the engine from source via Bun so edits take effect on
 *  a window reload. Returns the Bun executable + arg prefix, or null. */
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

/** Locate the `origami-acp` bridge binary. Order: ORIGAMI_ACP_PATH env var,
 *  ~/.origami/bin/, sibling origami repo target/release/, then PATH. */
export function resolveOrigamiAcpBinary(): string {
  const explicit = process.env.ORIGAMI_ACP_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const exeName = os.platform() === 'win32' ? 'origami-acp.exe' : 'origami-acp';

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

type PendingPermission = {
  resolve: (response: acp.RequestPermissionResponse) => void;
};


export class AcpClient {
  private child: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private pendingPermissions: PendingPermission[] = [];
  /** Path + mtime of the origami-acp binary this client spawned, so a
   *  rebuild-while-running (a newer binary on disk) can prompt a reload. */
  private spawnedBinary: string | null = null;
  private spawnedBinaryMtimeMs = 0;
  /** `agentInfo.version` from THIS session's ACP handshake — without it a
   *  stale-engine warning is a claim the user cannot check. Empty when none sent. */
  private engineVersionReported = ''; private peerAgentName = ''; // agentInfo._meta.peerName: send_message/list_agents `to` address.
  /** Working directory this session was started against. The session-scoped ACP calls
   *  (listSessions / loadSession) resolve config + history relative to it. */
  private cwd = '';
  /** The `configOptions` (model / effort / mode selects) from the last newSession
   *  / loadSession / setSessionConfigOption. Source of truth for the picker. */
  private configOptions: Array<Record<string, unknown>> = [];
  /** toolCallIds recognised as `todowrite`, so EVERY later frame for that call
   *  (including the completed frame, whose title is the tool's own summary, and
   *  status-only frames) routes to the todo strip and never leaks a card. */
  private readonly todoToolCallIds = new Set<string>();
  /** t-ucnp7t: the handler set each in-flight `history_page` collects its frames into, by pageId.
   *  A tagged frame goes ONLY here: old history never reaches the live handlers (contract 2.4). */
  private readonly pageSinks = new Map<string, AcpEventHandlers>();
  /** The load/fork response's `_meta.origami_history`; null on an old engine or a new session. */
  public restoredHistory: HistoryWindow | null = null;
  /** t-w2qv3o: when the host last asked this engine something (ms epoch, 0 = never), for the elastic tracker. */
  public lastExtAt = 0;
  /** t-w2txb2 (elastic/park.ts): set while this chat's engine is parked — a call that needs the engine runs it
   *  first, through the chat's gate. The spawn env is the one the chat started with; `sets` = the config values set. */
  public wake: (() => Promise<void>) | null = null; private spawnEnv: Record<string, string> | null = null; private parking: Promise<void> | null = null; public readonly sets = new Map<string, string>(); private resumedOn: unknown = null; // t-wdyi2t: the connection the session is open on

  constructor(private readonly handlers: AcpEventHandlers) {}

  /** Which build this session's engine came from; the verdict lives in
   *  dashboard/engineStale.ts. */
  public engineSpawn(): EngineSpawn {
    return {
      binary: this.spawnedBinary,
      spawnedMtimeMs: this.spawnedBinaryMtimeMs,
      runningVersion: this.engineVersionReported || undefined,
    };
  }
  get peerName(): string | undefined { return this.peerAgentName || undefined; } get pid(): number | undefined { return this.child?.pid; } // peerAgentName / this session's spawned engine's OS pid, or undefined either way if unregistered/not running.
  /** Start the bridge. `engineUrl` is retained on the signature but unused — the
   *  endpoint comes from config (origami.json). The child otherwise inherits the
   *  parent env unchanged. */
  async start(cwd: string, engineUrl?: string, loadSessionId?: string, headless?: boolean, agent?: string, forkFromSessionId?: string): Promise<string> {
    if (this.sessionId !== null && !this.deferredLoad) {
      return this.sessionId;
    }
    void engineUrl;
    await this.connect(cwd, headless);
    // Fork / recall / fresh — the branch itself lives in acpFork.ts.
    const established = await establishSession(this.connection as unknown as SessionConnection, { cwd, loadSessionId, forkFromSessionId, agent });
    this.sessionId = established.sessionId; this.resumedOn = this.connection; if (this.deferredLoad) { this.deferredLoad = false; this.wake = null; } // t-wypna7: the deferred load ran
    this.configOptions = established.configOptions;
    this.restoredHistory = established.history ?? null;
    console.log(`[origami] ACP session ${established.how}: ${this.sessionId}`);
    return this.sessionId;
  }

  /** Spawn the engine and run the ACP handshake, with NO session. A chat's start()
   *  runs this first; the window's host connection (hostEngine.ts, t-sh7cog) runs
   *  only this, so it writes no stored session and builds no model catalog. */
  async connect(cwd: string, headless?: boolean, extraEnv?: Record<string, string>): Promise<void> { // extraEnv: the warm spare's ORIGAMI_SPARE (elastic/warmSpare.ts)
    this.cwd = cwd; // t-wdyi2t: before the early return, so a chat on the adopted spare keeps ITS cwd string (a restore resumes with it)
    if (this.connection) return;

    // Live-source dev mode (opt-in via origami.devEngineSource) runs the engine from
    // source via Bun; otherwise the compiled binary.
    const dev = resolveDevEngine();
    const exec = dev ? dev.bun : resolveEngineBinary();
    const argPrefix = dev ? dev.argPrefix : [];
    console.log(`[origami] engine: ${dev ? `LIVE SOURCE via ${dev.entry}` : `binary ${exec}`}`);
    // Snapshot the mtime of what we spawned (binary, or the src entry in dev mode) so a rebuild can
    // prompt a reload.
    this.spawnedBinary = dev ? dev.entry : exec;
    try {
      this.spawnedBinaryMtimeMs = fs.statSync(this.spawnedBinary).mtimeMs;
    } catch {
      this.spawnedBinaryMtimeMs = 0;
    }
    let child: ChildProcess;
    try {
      // Pipe stderr to the output channel and pin windowsHide so the bridge never gets
      // a visible console window. The engine endpoint comes from config (origami.json),
      // NOT from ORIGAMI_API_BASE; start()'s `engineUrl` is unused.
      child = spawn(exec, [...argPrefix, 'acp', '--cwd', cwd], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        windowsHide: true,
        // Which engine flags this shell turns on, and why, lives in engineEnv.ts.
        // t-w2txb2: the overlay is read once per CHAT, not per process — a restore (park.ts) spawns with the env this chat
        // started with. t-w2u2ki: `extraEnv` (the warm spare's ORIGAMI_SPARE) is never recorded, so a restore never respawns as a spare.
        env: { ...process.env, ...(this.spawnEnv ??= engineOverlay(headless)), ...extraEnv },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.handlers.onError(`Failed to spawn origami engine (${exec}): ${msg}`);
      throw e;
    }
    this.child = child;

    child.on('exit', (code, signal) => {
      const reason = `origami-acp exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      this.handlers.onClose(this.parking ? `${reason} (parked: a planned stop)` : reason);
      this.connection = null;
      if (!this.parking && !this.wake) this.sessionId = null; // a parked chat keeps its engine session (t-w2txb2), also through an exit mid-park or mid-restore (t-wdyi2t)
      this.child = null;
    });
    child.on('error', (err) => {
      this.handlers.onError(`origami-acp child error: ${err.message}`);
    });
    forwardStderr(child.stderr); // per line, to the extension host log (acpStderr.ts)

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
    // The session's own answer to "which build am I talking to".
    const agentInfo = (initResp as { agentInfo?: { version?: unknown; _meta?: { peerName?: unknown } } }).agentInfo;
    this.engineVersionReported = typeof agentInfo?.version === 'string' ? agentInfo.version : ''; this.peerAgentName = typeof agentInfo?._meta?.peerName === 'string' ? agentInfo._meta.peerName : '';
    console.log(
      `[origami] ACP initialized (protocolVersion=${initResp.protocolVersion}, engine=${this.engineVersionReported || 'unreported'})`,
    );
  }

  async prompt(text: string, images?: Array<{ data: string; mimeType: string }>): Promise<acp.StopReason> {
    await this.live();
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
    const resp = await this.connection.prompt({
      sessionId: this.sessionId,
      prompt: prompt as any,
    });
    // The prompt response carries token usage. LM Studio reports token counts with no
    // context *limit*, so the engine's usage_update never fires for local models —
    // surface it here. `used` = input + cached-read; `size` stays 0 (no limit) so the
    // shell falls back to the probed context window as the gauge denominator.
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
    return resp.stopReason;
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.sessionId) {
      return;
    }
    await this.connection.cancel({ sessionId: this.sessionId });
  }

  /** Call an ACP ext_method (e.g. get_vram_state, list_skills). The Rust ACP SDK
   *  requires a leading `_` on the wire for extension methods and the JS SDK does
   *  not add it; drop it and every ext-method `method_not_found`s. */
  async extMethod(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const wireMethod = method.startsWith('_') ? method : `_${method}`;
    // t-w2qv3o: the activity tracker's quiet clock (elastic/). Its own `_elastic_*` calls do not count, and (t-wdyi2t) never wake a parked engine: they fail fast.
    const stamp = !wireMethod.startsWith('_elastic_');
    if (stamp) await this.live();
    if (!this.connection) {
      throw new Error('AcpClient.extMethod called before start()');
    }
    if (stamp) this.lastExtAt = Date.now();
    try { return await this.connection.extMethod(wireMethod, params); } finally { if (stamp) this.lastExtAt = Date.now(); }
  }

  /** `run_steps` — an ordered, read-only projection of a PAST run's steps. Safe
   *  for a session not open in this connection: the engine only reads stored
   *  messages. The list is capped; check `truncated`/`total`. */
  async getRunSteps(sessionId: string, cwd?: string): Promise<RunStepsResult> {
    const result = await this.extMethod('run_steps', {
      sessionId,
      ...(cwd ? { cwd } : {}),
    });
    return result as unknown as RunStepsResult;
  }

  /** `run_stats` — per-run counts for a PAGE of the run index, in one call. Each id
   *  costs the engine a `session.messages` read, so it caps the batch; never per row. */
  async getRunStats(sessionIds: string[], cwd?: string): Promise<RunStatsResult> {
    const result = await this.extMethod('run_stats', { sessionIds, ...(cwd ? { cwd } : {}) });
    return result as unknown as RunStatsResult;
  }

  /** `session_delete` — remove ONE stored session permanently: the engine cascades and
   *  THROWS when the store refuses, so a resolved promise means the row is gone. */
  async deleteSession(sessionId: string, cwd?: string): Promise<void> {
    await this.extMethod('session_delete', { sessionId, ...(cwd ? { cwd } : {}) });
  }

  /** `subagent_transcript` — ONE sub-agent's stored session as chat rows.
   *  Read-only, and tolerant of a child that is gone: an unknown id comes back
   *  `found: false`, never a throw. */
  async getSubagentTranscript(
    sessionId: string,
    cwd?: string,
    /** t-krxap7. `limit` asks for the newest N stored messages instead of the whole
     *  run; `before` walks back from a previous answer's `cursor`. The engine
     *  REFUSES a `before` with no `limit`, so the two travel together or not at all. */
    page?: { limit?: number; before?: string },
  ): Promise<SubagentTranscriptResult> {
    const limit = typeof page?.limit === 'number' && page.limit > 0 ? Math.floor(page.limit) : 0;
    const result = await this.extMethod('subagent_transcript', {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(limit > 0 ? { limit } : {}),
      ...(limit > 0 && page?.before ? { before: page.before } : {}),
    });
    return result as unknown as SubagentTranscriptResult;
  }

  /** `subagent_todos` (t-qd2riw) — the child's latest todowrite call, found by a
   *  bounded backward walk over its stored session on the engine side, instead
   *  of the whole-transcript read `subagent_transcript` still makes for the
   *  drawer's ↗. Read-only, tolerant of a gone child the same way. */
  async getSubagentTodos(sessionId: string, cwd?: string): Promise<SubagentTodosResult> {
    const result = await this.extMethod('subagent_todos', { sessionId, ...(cwd ? { cwd } : {}) });
    return result as unknown as SubagentTodosResult;
  }

  /** `subagent_changes` (t-ru0by6, same family as `subagent_todos`) — the
   *  child's diff-bearing tool parts, found by a bounded backward walk over
   *  its stored session on the engine side, instead of the whole-transcript
   *  read the changed-files pill used to make for the same job. */
  async getSubagentChanges(sessionId: string, cwd?: string): Promise<SubagentChangesResult> {
    const result = await this.extMethod('subagent_changes', { sessionId, ...(cwd ? { cwd } : {}) });
    return result as unknown as SubagentChangesResult;
  }

  /** `history_page` (t-ucnp7t, contract 2): one OLDER page. Its frames arrive before the reply on
   *  the one ordered stream, each tagged `_meta.origami_page = pageId`; they are routed to `sink`
   *  alone, so the reply is also the page's end marker. The sink is dropped either way. */
  async historyPage(params: { sessionId: string; before?: string; pageId: string; limit?: number }, sink: AcpEventHandlers): Promise<HistoryPageReply> {
    this.pageSinks.set(params.pageId, sink);
    try {
      return historyPageReplyFrom(await this.extMethod('history_page', { ...params, ...(this.cwd ? { cwd: this.cwd } : {}) }), params.pageId);
    } finally {
      this.pageSinks.delete(params.pageId);
    }
  }

  /** `history_search` (contract 5): engine-side find over the WHOLE stored chat. */
  async historySearch(params: { sessionId: string; query: string; cursor?: string; limit?: number }): Promise<HistorySearchReply> {
    return historySearchReplyFrom(await this.extMethod('history_search', { ...params, ...(this.cwd ? { cwd: this.cwd } : {}) }));
  }

  /** `subagent_roster` (contract 4.1): the same rows the restore notification carries. */
  async subagentRoster(sessionId: string): Promise<SubagentRoster | null> {
    return subagentRosterFrom(await this.extMethod('subagent_roster', { sessionId, ...(this.cwd ? { cwd: this.cwd } : {}) }));
  }

  /** `list_instructions` — every file/URL feeding the system prompt, with sizes.
   *  Paths only; contents are never sent. `tokensApproxMethod` names the estimator
   *  — the counts are a heuristic, not a tokenisation. */
  async listInstructions(cwd?: string): Promise<InstructionSet> {
    const result = await this.extMethod('list_instructions', {
      ...(cwd ? { cwd } : {}),
    });
    return result as unknown as InstructionSet;
  }

  /** `artifact_list` — the artifacts pane's rows. GLOBAL, not per project:
   *  `projectPath` narrows it to one repo, and `all` ignores that narrowing. */
  async listArtifacts(options: { all?: boolean; projectPath?: string } = {}): Promise<ArtifactListResult> {
    const result = await this.extMethod('artifact_list', {
      ...(options.all ? { all: true } : {}),
      ...(options.projectPath ? { projectPath: options.projectPath } : {}),
    });
    return result as unknown as ArtifactListResult;
  }

  /** `artifact_versions` — v1..vN of one artifact, newest first. */
  async listArtifactVersions(artifactId: string): Promise<ArtifactVersionsResult> {
    const result = await this.extMethod('artifact_versions', { artifactId });
    return result as unknown as ArtifactVersionsResult;
  }

  /** `artifact_open` — the loopback url of a version's entry file. No `version`
   *  means the latest, which is what the Open button sends. The url is the
   *  ENGINE's to build: only it knows the port its server listened on. */
  async openArtifact(artifactId: string, version?: number): Promise<ArtifactOpenResult> {
    const result = await this.extMethod('artifact_open', {
      artifactId,
      ...(typeof version === 'number' ? { version } : {}),
    });
    return result as unknown as ArtifactOpenResult;
  }

  /** `artifact_restore` — copy an old version FORWARD as a new one. The only
   *  write in this group; it answers with the version number it minted. */
  async restoreArtifact(artifactId: string, version: number): Promise<ArtifactRestoreResult> {
    const result = await this.extMethod('artifact_restore', { artifactId, version });
    return result as unknown as ArtifactRestoreResult;
  }

  /** `artifact_diff` — which files changed between two versions, as paths. */
  async diffArtifact(artifactId: string, from: number, to: number): Promise<ArtifactDiffResult> {
    const result = await this.extMethod('artifact_diff', { artifactId, from, to });
    return result as unknown as ArtifactDiffResult;
  }

  /** `list_tools` — the base tool list plus which of them the deferred-tool catalog hides.
   *  Read-only. */
  async listTools(cwd?: string): Promise<ToolCatalog> {
    return (await this.extMethod('list_tools', { ...(cwd ? { cwd } : {}) })) as unknown as ToolCatalog;
  }

  /** The model picker source — the ACP `configOptions` `model` select returned at
   *  session start. The switchable models are the providers/models configured in
   *  `origami.json`; `current` is what the session resolved to. Null if absent. */
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

  /** Shared reader for a `select` config-option (mode / effort). Null when the
   *  engine did not send that option — effort is omitted for a model with no
   *  variants, so the selector hides instead of showing an empty menu. */
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

  /** The session-mode picker source — the `mode` select (build / plan / custom
   *  primary agents). `current` is the live `session.modeId`. Switch via
   *  `setConfigOption('mode', id)`; `plan` enters the read-only plan agent. */
  getModeOption() {
    return this.getSelectOption('mode');
  }

  /** The effort picker source — the `effort` select, the model's REAL reasoning
   *  variants named by the model. Null when it declares none; hardcoded
   *  think/quick produced "effort not found: think". */
  getEffortOption() {
    return this.getSelectOption('effort');
  }
  /** Live approve-mode off configOptions' scalar `permission` entry (yolo-permissions; not a `select`, so getSelectOption doesn't fit) — null on an older engine. */
  getPermissionOption(): string | null { const o = this.configOptions.find((x) => x['id'] === 'permission'); const v = o?.['currentValue'] ?? o?.['value']; return typeof v === 'string' ? v : null; }

  /** Switch the session model (`setSessionConfigOption configId='model'`). The
   *  server validates the id and returns the refreshed `configOptions`, which is
   *  cached. Returns the resolved model id; throws on an invalid model. */
  async setModel(modelId: string): Promise<string> {
    await this.live();
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
    this.sets.set('model', modelId);
    return this.getModelOption()?.current ?? modelId;
  }

  /** Set any session config option (`model` / `effort` / `mode`). The server
   *  validates the value against the session's snapshot and throws an honest error
   *  when it is not valid for the current model — never a silent no-op. */
  async setConfigOption(configId: string, value: string): Promise<void> {
    await this.live();
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
    this.sets.set(configId, value);
  }

  /** Deterministic rollback. `revert(messageID)` restores the working tree to the
   *  snapshot from before that message's turn and marks it (and everything after)
   *  for removal; `unrevert()` undoes it until the next prompt finalises it. */
  async revert(messageID: string): Promise<void> {
    await this.setConfigOption('revert', messageID);
  }
  async unrevert(): Promise<void> {
    await this.setConfigOption('unrevert', '');
  }

  /** List prior sessions for the current workspace (ACP `listSessions`) — the one
   *  recall surface. Recall one by passing its id to `start(cwd, _, sessionId)`. */
  async listSessions(): Promise<Array<{ sessionId: string; cwd: string; title: string; updatedAt: string }>> {
    await this.live();
    if (!this.connection) {
      throw new Error('AcpClient.listSessions called before start()');
    }
    // EVERY page, not just the first, and the cwd fallback — sessionPaging.ts owns the loop and why.
    return listWorkspaceSessions((p) => this.connection!.listSessions(p), this.cwd, this.sessionId);
  }

  /** Switch the ACP permission mode (default / plan / auto / bypass). */
  async setSessionMode(modeId: string): Promise<Record<string, unknown>> {
    await this.live();
    if (!this.connection || !this.sessionId) {
      throw new Error('AcpClient.setSessionMode called before start()');
    }
    const resp = await this.connection.setSessionMode({ sessionId: this.sessionId, modeId });
    this.cacheMode(modeId); // t-wdyi2t: the engine sends no current_mode_update for it; a restore (park.ts) sets it again from here
    return resp as unknown as Record<string, unknown>;
  }
  /** Keep the cached `mode` select in step, so getModeOption() reflects the new mode rather than the stale pre-switch currentValue. */
  private cacheMode(modeId: string): void { const opt = this.configOptions.find((o) => o['id'] === 'mode' && o['type'] === 'select'); if (opt) opt['currentValue'] = modeId; }

  /** t-w2txb2: a parked chat's engine is started again (through its gate) before a call that needs it. */
  private async live(): Promise<void> { if (this.wake) await this.wake(); } // t-wdyi2t: also while the park is asked or a restore failed: the gate decides

  /** t-w2txb2: stop this chat's engine ON PURPOSE (elastic/park.ts). The engine session id and the spawn env
   *  stay; `restore()` brings the engine back for the same session. Resolves once the process has exited. */
  park(): Promise<void> {
    const child = this.child;
    if (!child || !this.sessionId) return Promise.resolve();
    this.parking = new Promise<void>((done) => { child.once('exit', () => done()); shutdownEngine(child); }).finally(() => { this.parking = null; });
    return this.parking;
  }

  /** t-x3a89j: kill an engine that did not answer its start or restore in time (elastic/park.ts startWithin), so Retry
   *  spawns a fresh one. Resolves once it has exited. A parked chat keeps its session id through it (the exit handler). */
  stopStart(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((done) => { child.once('exit', () => done()); try { child.kill(); } catch { done(); } });
  }

  /** t-w2txb2: spawn the engine again (the recorded env) and reopen the kept session with `session/resume`,
   *  which replays NO history into the live handlers, so the transcript is not doubled. */
  async restore(): Promise<boolean> { // t-wdyi2t: false = the engine never stopped (nothing to set again); a failed resume is sent again on Retry
    await this.parking;
    const id = this.sessionId;
    if (!id) throw new Error('the chat has no engine session to start again'); // closed meanwhile: start nothing
    if (this.connection && this.resumedOn === this.connection) return false;
    if (this.spawnEnv && this.peerAgentName && !this.spawnEnv[AGENT_NAME_VAR]) this.spawnEnv[AGENT_NAME_VAR] = this.peerAgentName; // the same peer name, so replies to it still arrive (engine name defaults to cwd + pid)
    if (!this.connection) await this.connect(this.cwd);
    const conn = this.connection as unknown as { resumeSession(p: object): Promise<unknown> } | null;
    if (!conn) throw new Error('the engine stopped while it was starting again');
    const resp = await conn.resumeSession({ sessionId: id, cwd: this.cwd, mcpServers: [] });
    this.configOptions = ((resp as { configOptions?: unknown[] } | null)?.configOptions ?? []) as Array<Record<string, unknown>>;
    this.resumedOn = conn; return true;
  }

  /** t-wypna7 (elastic/reloadDefer.ts): a chat reopened at a reload with no engine yet holds its engine session id (open set, /loop,
   *  mail read it); `wake` runs before a call that needs the engine. The next start() loads that session, then clears both. */
  defer(sessionId: string, cwd: string, wake: () => Promise<void>): void { this.sessionId = sessionId; this.cwd = cwd; this.wake = wake; this.deferredLoad = true; }
  private deferredLoad = false;

  /** Get the current session ID (null if not started). */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  dispose(): void {
    // Not a kill: the engine has a heartbeat file to remove before it goes, and only
    // its own finalizer can do that (engineShutdown.ts).
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

  /** If `u` is a `todowrite` tool_call / tool_call_update, decode its todo list,
   *  dispatch `onTodoUpdate` and return true so the caller suppresses the generic
   *  tool card. Sources in priority order: the structured `rawInput.todos`, then a
   *  JSON-parse of the completed update's text content. The wire item shape is
   *  `{content, status, priority}` — no `activeForm`, so it reuses `content`. */
  private tryHandleTodoWrite(u: unknown, h: AcpEventHandlers = this.handlers, old = false): boolean {
    const upd = u as {
      toolCallId?: unknown;
      title?: unknown;
      rawInput?: { todos?: unknown };
      content?: unknown;
    };
    const id = typeof upd.toolCallId === 'string' ? upd.toolCallId : '';
    const title = typeof upd.title === 'string' ? upd.title.toLowerCase() : '';
    const hasTodos = !!(upd.rawInput && Array.isArray(upd.rawInput.todos));
    // Recognise todowrite by ANY of: the title 'todowrite' (pending / running / error
    // frames); a structured rawInput.todos payload (the COMPLETED frame's title is
    // the tool's own summary, e.g. "3 todos"); or a remembered toolCallId, since a
    // status-only frame carries neither.
    const recognised =
      title === 'todowrite' || hasTodos || (id !== '' && this.todoToolCallIds.has(id));
    if (!recognised) return false;
    if (id && !old) this.todoToolCallIds.add(id); // a page frame leaves live state alone

    // The list this frame carries — structured rawInput.todos preferred, else the completed frame's
    // JSON text (acpTodoWrite.ts).
    const todos = todosFromUpdate(upd);
    if (todos) h.onTodoUpdate({ source: 'model_write', todos });
    // Always suppress the generic card once recognised — even a status-only frame with no payload
    // must not leak one.
    return true;
  }

  private buildClientImpl(): acp.Client {
    return {
      sessionUpdate: async (params) => {
        // Every session's stream flows over this one connection, tagged with its owning
        // sessionId, and this client represents ONE session. A background sub-agent runs
        // in a CHILD session whose stream must NOT render here, or two sub-agents
        // streaming at once garble the parent transcript. The sub-agent's RESULT is
        // injected onto the parent session and still arrives with our sessionId.
        const updSessionId = (params as { sessionId?: string }).sessionId;
        if (updSessionId && this.sessionId && updSessionId !== this.sessionId) return;
        const u = params.update;
        // t-ucnp7t: a frame tagged `_meta.origami_page` is OLD history for the page that asked
        // for it, decoded by the same switch but into that page's own handlers. A tag nobody
        // asked for is dropped, never shown live (wire_contract.md 2.4).
        const page = pageTag(u);
        const h = page === undefined ? this.handlers : this.pageSinks.get(page);
        if (!h) return;
        switch (u.sessionUpdate) {
          case 'agent_message_chunk': {
            // The engine tags the /compact summary turn with `_meta.origami_compaction` so it
            // collapses into a marker instead of dumping the scratchpad into the transcript.
            // Plain ACP servers never set it -> normal render.
            const cmeta = (u as { _meta?: { origami_compaction?: unknown; origami_child_session?: unknown } })._meta;
            if (u.content.type === 'text' && cmeta?.origami_compaction === true) {
              h.onCompactionChunk?.(u.content.text);
              break;
            }
            // A sub-agent's running total, on an empty chunk tagged with the child's id
            // (t-dkkd2o). Read BEFORE the terminal marker, because the settling chunk
            // carries both and the final figure is the one the row must keep.
            const spend = taskRiders(u);
            if (spend.taskSessionId && spend.taskTokens) {
              h.onSubagentTokens?.({
                childSessionId: spend.taskSessionId,
                tokens: spend.taskTokens,
              });
            }
            // A dropped stream, as a structured rider on an EMPTY chunk. Read
            // BEFORE anything that renders text: there IS none, and falling
            // through would append a nameless agent bubble.
            const dropped = streamDropNotice(u);
            if (dropped) {
              h.onStreamDrop?.(dropped);
              break;
            }
            // A BACKGROUND sub-agent settled — an empty chunk carrying only the marker, since the
            // launcher card completed at spawn.
            const done = taskDone(u);
            if (done) {
              // The settling chunk's OWN counters ride the marker: the marker is
              // the only sub-agent frame the host writes to the message log, so a
              // total left on the live channel alone dies with the window (t-fdvr2a).
              h.onSubagentDone?.({ ...done, ...(spend.taskTokens ? { tokens: spend.taskTokens } : {}) });
              break;
            }
            // A counters-only chunk has no text to render; without this it would append
            // an empty assistant bubble to the parent transcript.
            if (spend.taskSessionId && spend.taskTokens && u.content.type === 'text' && !u.content.text) break;
            // A SUB-AGENT's output, forwarded under this session. Route it to the task card
            // that spawned it; appending to the parent transcript would interleave children.
            if (u.content.type === 'text' && typeof cmeta?.origami_child_session === 'string') {
              // t-gvz8t0. The SAME channel carries the child's thought, marked
              // `origami_task_part: reasoning`. Routed to its own handler so it
              // can never reach `taskStream` — that string is the row's activity
              // tail and the transcript card's reply text, and thought in it is
              // thought presented as the child's answer.
              if (taskPart(u) === 'reasoning') {
                h.onSubagentThought?.({
                  childSessionId: cmeta.origami_child_session,
                  text: u.content.text,
                });
                break;
              }
              h.onSubagentChunk?.({
                childSessionId: cmeta.origami_child_session,
                text: u.content.text,
              });
              break;
            }
            // Same replay filter as the user slot: a synthetic assistant part (a `<task_result>`
            // blob, compaction scratch) is model-only.
            if (u.content.type === 'text' && !modelOnlyContent(u.content)) {
              h.onAgentMessageChunk(u.content.text, (u as { messageId?: string }).messageId);
            } else if (u.content.type === 'image') {
              const img = u.content as { data?: string; mimeType?: string };
              if (img.data && img.mimeType) {
                h.onAgentImageChunk(img.data, img.mimeType);
              }
            }
            break;
          }
          case 'user_message_chunk': {
            // Emitted on history replay (loadSession), which carries the model-only parts the live
            // stream drops — filter them or the interject envelope renders as the human
            // (acpAudience.ts).
            if (u.content.type !== 'text' || modelOnlyContent(u.content)) break;
            // A PEER agent's handoff arrives in this same slot but nobody here typed it
            // (acpPeerMeta.ts).
            const peer = peerFromMeta(u);
            if (peer) h.onPeerMessage?.({ ...peer, text: u.content.text });
            else h.onUserMessageChunk?.(u.content.text);
            break;
          }
          case 'agent_thought_chunk':
            if (u.content.type === 'text') {
              h.onAgentThoughtChunk?.(u.content.text);
            }
            break;
          case 'tool_call': {
            // `todowrite` is the live task list: route it to the strip (onTodoUpdate) and do
            // not render a generic card — the model calls it many times per turn.
            if (this.tryHandleTodoWrite(u, h, page !== undefined)) break;
            // The engine stamps this on every tool event (acpToolMeta.ts); absent/plain-ACP reads
            // as '' -> GenericCard.
            const toolName = toolNameRider(u);
            const locs = (u as { locations?: Array<{ path?: unknown }> }).locations;
            const path = Array.isArray(locs) && typeof locs[0]?.path === 'string' ? locs[0].path : undefined;
            h.onToolCallStart({
              toolCallId: u.toolCallId,
              title: u.title ?? '',
              kind: u.kind ?? 'other',
              status: u.status ?? 'in_progress',
              toolName,
              path,
              rawInput: (u as { rawInput?: unknown }).rawInput,
              // Sibling decorations of origami_tool_name — for a `task` call: its child session,
              // whether it detached, its model.
              ...taskRiders(u),
            });
            break;
          }
          case 'tool_call_update': {
            if (this.tryHandleTodoWrite(u, h, page !== undefined)) break;
            // The whole content ARRAY is scanned (text + diff + image blocks) by acpToolContent.ts.
            const { contentText, diff, images } = decodeToolContent(u.content);
            // The resolved title (write's is the relative file path) and the ACP `locations`
            // path only land on the update, not the pending tool_call.
            const uTitle = typeof (u as { title?: unknown }).title === 'string'
              ? (u as { title: string }).title
              : undefined;
            const uLocs = (u as { locations?: Array<{ path?: unknown }> }).locations;
            const uPath = Array.isArray(uLocs) && typeof uLocs[0]?.path === 'string'
              ? uLocs[0].path
              : undefined;
            // Same rider, same reader — it heals a card whose initial tool_call never matched.
            const uToolName = toolNameRider(u);
            h.onToolCallUpdate({
              toolCallId: u.toolCallId,
              ...taskRiders(u),
              // The engine always sets an explicit status (in_progress/completed/failed); pass
              // it through verbatim — the webview renders `failed` as a red card. The `??` is a
              // defensive last resort and must NOT mask a real `failed` as green.
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
              h.onAvailableCommands(
                cmds.map((c: any) => ({ name: String(c.name || ''), description: String(c.description || '') }))
              );
            }
            break;
          }
          case 'session_info_update': {
            // The engine pushes the generated session title here; forward it so the tab/history
            // rename at once.
            const si = u as { title?: string | null };
            const title = typeof si.title === 'string' ? si.title.trim() : '';
            if (title) h.onSessionTitle?.({ title });
            break;
          }
          case 'current_mode_update': {
            // Engine-driven mode switch (e.g. plan_exit -> build). The next turn already runs as
            // this mode.
            const cm = u as { currentModeId?: string };
            const modeId = typeof cm.currentModeId === 'string' ? cm.currentModeId : '';
            if (modeId) {
              // Keep the cached `mode` select in sync so getModeOption() reflects the new mode
              // rather than the stale pre-switch currentValue.
              this.cacheMode(modeId);
              h.onModeChanged?.({ modeId });
            }
            break;
          }
          case 'usage_update': {
            // Subagent rollup rides `_meta.subagents` (ACP's extension bag — a top-level field
            // fails the SDK check).
            const uu = u as { used?: number; size?: number; cost?: { amount?: number; currency?: string };
              _meta?: { subagents?: { cost?: number; tokensInput?: number; tokensOutput?: number }; composition?: unknown } };
            const sub = uu._meta?.subagents;
            // The context breakdown rides the same extension bag as the rollup.
            const composition = parseComposition(uu._meta?.composition);
            h.onUsageUpdate?.({
              used: Number(uu.used ?? 0),
              size: Number(uu.size ?? 0),
              cost: uu.cost && typeof uu.cost.amount === 'number'
                ? { amount: uu.cost.amount, currency: String(uu.cost.currency ?? 'USD') }
                : undefined,
              ...(sub && typeof sub.cost === 'number'
                ? { subagents: { cost: sub.cost, tokensInput: Number(sub.tokensInput ?? 0), tokensOutput: Number(sub.tokensOutput ?? 0) } }
                : {}),
              ...(composition ? { composition } : {}),
            });
            break;
          }
          case 'plan': {
            // REAL plans only. The synthetic uses of `Plan` (turn_end, todo, task_shape,
            // best_of_n, question) arrive as first-class `origami/*` notifications instead.
            const meta = (u as any)._meta ?? {};
            const status = (meta.status as string) ?? '';
            if (status === 'awaiting_user') {
              h.onPlanReady({
                planId: meta.planId ?? '',
                title: meta.title ?? '',
                filePath: meta.filePath ?? '',
                status: 'awaiting_user',
                revisionCount: meta.revisionCount ?? 0,
              });
            } else if (status) {
              h.onPlanStatus({
                planId: meta.planId ?? '',
                status,
                revisionCount: meta.revisionCount ?? 0,
              });
            }
            break;
          }
          default:
            // Surface anything the engine emits that we don't handle — a silent drop is how
            // usage_update + thought chunks went missing.
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
              // Cancelled RESOLVES the call rather than dropping it, so the engine stops waiting
              // and the turn continues.
              if (optionId === null) { resolve({ outcome: { outcome: 'cancelled' } }); return; }
              // Free text and batch answers ride the SELECTED outcome's `_meta` (ACP reserves it);
              // omitted when there are none.
              const meta = replyMeta(answerText, answers);
              resolve({ outcome: meta ? { outcome: 'selected', optionId, _meta: meta } : { outcome: 'selected', optionId } });
            },
          });
        });
      },

      // Ext REQUESTS from the engine. Only `origami/browser` is answered here
      // (browserBridge.ts owns every VS Code call it makes); anything else must say it
      // is not implemented rather than return a shape read as a half-success.
      extMethod: async (method, params) => {
        const snapshot = this.handlers.onBrowserSnapshot;
        if (isBrowserMethod(method)) {
          return await handleBrowserExtMethod(params, snapshot ? (s) => snapshot.call(this.handlers, s) : undefined);
        }
        // Same rejection the SDK gave before this member existed, so adding it changed nothing for
        // callers.
        throw acp.RequestError.methodNotFound(method);
      },

      // First-class `origami/*` notifications. The Rust SDK prefixes ext_method names
      // with `_` on the wire, so `origami/todoSnapshot` arrives as
      // `_origami/todoSnapshot` — strip the prefix and dispatch by bare name. Unknown
      // methods are ignored, for forward compatibility.
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
            // The bridge's end-of-turn signal carrying the real `stop_reason`. Two consumers:
            // clear any in-progress plan banner, and forward the stop_reason so the dashboard
            // can render the per-turn terminal verdict.
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
          case 'origami/sessionStatus': {
            // Carries its own session id (unlike `turnEnd`, which relies on the host's
            // closure): the engine sends it for every session this connection registered.
            if (typeof p.sessionId === 'string' && typeof p.status === 'string') {
              this.handlers.onSessionStatus?.({ sessionId: p.sessionId, status: p.status });
            }
            break;
          }
          case 'origami/cacheState': {
            // Carries its own session id, like `sessionStatus`: a fan-out's children
            // are measured too, and only the id says which composer is being told.
            const push = cacheStateFrom(p);
            if (push.sessionId) this.handlers.onCacheState?.(push);
            break;
          }
          case 'origami/arbiterDecision':
            this.handlers.onArbiterDecision?.(arbiterDecisionFrom(p));
            break;
          case 'origami/flockMailbox':
            this.handlers.onFlockMailbox?.(flockMailboxFrom(p));
            break;
          // Both spellings of the artifacts event: the ticket body wrote one,
          // the lane brief the other, and a stale pane is the cost of picking
          // wrong. See src/dashboard/artifactAcp.ts for the contract. The
          // engine sends `origami/artifactsChanged` (acp/artifacts.ts).
          case 'origami/artifactsChanged':
          case 'origami/artifacts':
            this.handlers.onArtifactsChanged?.(artifactsChangedFrom(p));
            break;
          case 'origami/assessmentUpdate': {
            if (typeof p.toolCallId === 'string' && typeof p.text === 'string') {
              this.handlers.onAssessmentUpdate?.({ toolCallId: p.toolCallId, text: p.text });
            }
            break;
          }
          case 'origami/mcpAuthUrl': {
            if (typeof p.name === 'string' && typeof p.url === 'string') {
              this.handlers.onMcpAuthUrl?.({ name: p.name, url: p.url });
            }
            break;
          }
          case 'origami/historyWindow': {
            const win = historyWindowFrom(p);
            if (win) this.handlers.onHistoryWindow?.(win);
            break;
          }
          case 'origami/backgroundTask': { const task = backgroundTaskFrom(p); if (task) this.handlers.onBackgroundTask?.(task); break; }
          case 'origami/subagentRoster': {
            const roster = subagentRosterFrom(p);
            if (roster) this.handlers.onSubagentRoster?.(roster);
            break;
          }
          case 'origami/feedMessage': {
            // Cron + ambient bus messages forwarded by the bridge. Shape: { bus_kind, <variant
            // fields> }.
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
