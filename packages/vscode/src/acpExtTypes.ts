// Response shapes for the fork's ACP ext methods. They live outside acpClient.ts
// because they are pure declarations both the webview panes and the host consume,
// and that file is under an architecture line-cap.

/** One step of a past run, as projected by the engine's `run_steps`. */
export interface RunStep {
  /** 0-based position in the FULL run — stable even when the list is capped. */
  ordinal: number;
  kind: 'prompt' | 'reply' | 'tool' | 'thinking' | 'subagent' | 'compaction' | 'error';
  /** Present for `tool`/`subagent` steps. */
  tool?: string;
  title: string;
  status?: 'completed' | 'error' | 'running' | 'pending';
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  /** Usage for the assistant message this step belongs to — attached to the LAST
   *  step that message produced, so a run totals by SUMMING steps. `input`/`output`
   *  always arrive together; `reasoning` and `cache` are ADDITIVE and OPTIONAL, so
   *  render nothing for an absent field and do NOT fold cache-read into input (a
   *  cached turn routinely carries 100x its `input` in cache). */
  tokens?: {
    input: number;
    output: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  /** The message's own cost. A genuine 0 (a local model) is a measurement — keep it. */
  cost?: number;
  /** Why THIS step read nothing from the provider's prefix cache, as the ENGINE
   *  recorded it on the step-finish part (session/cache-policy.ts). A viewer no
   *  longer derives a cause: absent means the engine measured none, and the
   *  reason is either a cache-blind provider or a run recorded before 0.4.160.
   *  A hit carries the facts with NO `cause`. */
  cache?: RunStepCache;
  /** The prefix digests this step was sent, as stored. `history` is absent on a
   *  run recorded before the digest existed. */
  prefix?: { system: string; tools: string; history?: string };
  /** True when the assistant message behind this step recorded NO token usage, so
   *  any total spanning it is an UNDERCOUNT and must read as approximate. Emitted
   *  only when true; absent = nothing known to be missing. */
  usageMissing?: true;
  model?: string;
  agent?: string;
  /** Short excerpt, hard-capped engine-side. Never the full text. */
  preview?: string;
  error?: string;
  /** Only on a `compaction` step — the event that throws the prompt cache away and
   *  rewrites the context. `trigger` always arrives; the two numbers do not (the
   *  engine omits a fact the store does not hold). No `compaction` step at all means
   *  this build never projected one, never "the run never compacted". */
  compaction?: {
    trigger: 'auto' | 'manual' | 'overflow' | 'unknown';
    /** The last billed prompt before it — how big the run had actually got. */
    contextBefore?: number;
    /** Output tokens the summary message itself cost. */
    summaryTokens?: number;
  };
  /** True when this subagent was spawned DETACHED, so it ran concurrently with the
   *  steps that follow. Emitted only when true, so ABSENT means "this build did not
   *  say" and must never render as foreground. A background spawn's tool state
   *  settles ~10ms after launch while the subagent runs on, so the engine reports it
   *  `running` and stitches the true `endedAt` on afterwards. */
  background?: boolean;
  /** Session the subagent ran in — the key linking a spawn to its own run. */
  childSessionId?: string;
  /** Sub-agent nesting level: absent/0 on the reviewed run's OWN steps, 1 on a
   *  subagent's steps, 2 on a subagent's subagent. Optional by contract — the engine
   *  emits it only for depth > 0. */
  depth?: number;
  /** `ordinal` of the subagent step that spawned this one. Set alongside `depth` but
   *  optional by contract, so lay out sanely when only `depth` arrives. */
  parentOrdinal?: number;
}

/** One cause per miss, in the engine's fixed precedence — see
 *  `packages/engine/src/session/cache-policy.ts`, which is where it is derived. */
export type RunStepCacheCause =
  | 'cold'
  | 'model'
  | 'compaction'
  | 'stopped'
  | 'idle'
  | 'system'
  | 'tools'
  | 'history'
  | 'provider'
  | 'small';

export interface RunStepCache {
  /** Present only on a MISS, and then exactly one: the precedence is fixed at
   *  cold > compaction > model > stopped > system > tools > history > idle >
   *  small > provider. `provider` is the residue — the prefix was byte-identical, inside
   *  the window, on the same model, and the provider missed anyway. */
  cause?: RunStepCacheCause;
  /** Whether the previous request's whole array survived as a byte-identical
   *  prefix of this one. Absent on a session's first measured request. */
  preserved?: boolean;
  /** Where the outbound array first differed from the previous request's. */
  divergence?: {
    message: number;
    role: string;
    offset: number;
    source?: 'tool-aging' | 'reminder' | 'plugin' | 'unknown';
  };
  /** Milliseconds since the previous request of this session. */
  idleMs?: number;
  /** The window the engine believes for this provider, and the one `idle` was
   *  judged against. ABSENT where the provider publishes none, and no `idle` is
   *  then claimed. */
  ttlSeconds?: number;
  /** A cache warm succeeded inside the gap before this request. */
  warmed?: boolean;
  /** Only on the first request after an engine restart: the halves of the
   *  prefix that changed against the last request stored before it. */
  stopped?: Array<'system' | 'tools' | 'history'>;
}

export interface RunStepsResult {
  steps: RunStep[];
  /** True when `steps` is a prefix of the run — `total` is the real count. */
  truncated: boolean;
  total: number;
}

/** What a Claude Code history scan looked for and what it saw, so an EMPTY
 *  popup can say why (claudeHistory.ts writes it, claudeScanNote.ts reads it).
 *  Declared HERE because it crosses the wire. The webview leaf restates it
 *  (rootDir keeps it from importing this file); claudeScanNote.test.ts reads
 *  both and fails when they drift. */
export interface ClaudeScanFacts {
  /** The projects root actually read, `CLAUDE_CONFIG_DIR` included. */
  root: string;
  /** Directories in that root, matching or not. 0 with a real root = wrong root. */
  seen: number;
  /** The key each open folder was looked for under — every open folder, since
   *  two that share a folded key are both still scanned. */
  keys: string[];
}

/** Per-run counts for the run index (`run_stats`), BATCHED: the index asks for a
 *  whole page in one call. Every member is OPTIONAL and a value that could not be
 *  computed is OMITTED, never zeroed. `tokens.cacheRead` absent means the PROVIDER
 *  never reported cache tokens, which is not a cache that was never hit. */
export interface RunStat {
  sessionId: string;
  messages?: number;
  toolCalls?: number;
  failures?: number;
  durationMs?: number;
  /** Assistant messages — requests, not steps and not parts. */
  requests?: number;
  tokens?: { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
  cost?: number;
}

export interface RunStatsResult {
  stats: RunStat[];
  /** True when the caller named more sessions than the engine's batch cap. */
  truncated: boolean;
  requested: number;
}

/** The shipped prompts a user can replace with a file of their own. Each gets a
 *  pinned row carrying its effective text and the path that overrides it.
 *  `collab-agent-base` reaches COLLAB turns only, not every prompt. */
export type OverrideSource = 'base-prompt' | 'collab-agent-base';

/** A single file (or URL) contributing to the system prompt. */
export interface InstructionEntry {
  path: string;
  source: 'global' | 'project' | 'config' | 'memory' | 'url' | OverrideSource;
  chars: number;
  bytes: number;
  /** Heuristic — see `InstructionSet.tokensApproxMethod`. */
  tokensApprox: number;
  /** Only on an OVERRIDE entry: true when the user's own file supplies the prompt,
   *  false when the shipped built-in does. With `overridden: false`, `path` names
   *  where the file WOULD be written — it does not exist yet. */
  overridden?: boolean;
}

/** The EFFECTIVE text of one overridable prompt plus the path that overrides it.
 *  The only TEXT in this response, because the built-in is compiled into the engine
 *  binary and a shell seeding the override has nowhere else to read it from. */
export interface BasePromptInfo {
  path: string;
  overridden: boolean;
  text: string;
}

export interface InstructionSet {
  entries: InstructionEntry[];
  totalChars: number;
  totalBytes: number;
  totalTokensApprox: number;
  /** Names the estimator so it is never mistaken for a real token count. */
  tokensApproxMethod: 'chars/4';
  /** Absent on an older engine build that has no base-prompt override. */
  basePrompt?: BasePromptInfo;
  /** The base prompt every collab agent gets, above its own persona — the only
   *  collab layer the engine reports. */
  collabAgentBase?: BasePromptInfo;
}

// Prompt capture (`prompt_capture`). Mirrors
// `packages/engine/src/session/prompt-capture.ts`; keep the two in step. Unlike
// the instruction inventory above, this carries TEXT.

/** One labelled block of what the engine sent, beyond the user's own messages. */
export interface PromptCapturePart {
  label:
    | 'base-or-agent-prompt'
    | 'collab-agent-base'
    | 'collab-state'
    | 'env'
    | 'instructions'
    | 'mcp'
    | 'skills'
    | 'memory'
    | 'bot-memory'
    | 'flock'
    | 'vision'
    | 'structured-output'
    | 'user-system';
  /** WHERE this block was delivered. The memory blocks ride the TAIL of the message
   *  list, so a `remember` write no longer invalidates the cached prefix; without
   *  this they would be listed under "Assembled parts" and missing from "Final
   *  assembled system". Absent on an older engine — treat as 'system'. */
  delivery?: 'system' | 'tail';
  chars: number;
  /** Heuristic — see `PromptCapture.tokensApproxMethod`. */
  tokensApprox: number;
  text: string;
}

/** One entry of the FINAL system array, after any plugin reshaped it. */
export interface PromptCaptureBlock {
  chars: number;
  tokensApprox: number;
  text: string;
}

export interface PromptCaptureTool {
  name: string;
  descriptionChars: number;
  /** 0 means NOT MEASURED — an empty schema still serialises to `{}`. */
  schemaBytes: number;
  description: string;
}

/** One outbound message, measured rather than kept — the array itself is far too large to report.
 */
export interface PromptCaptureMessageDigest {
  role: string;
  /** Bytes of this message's serialised form, UTF-8. */
  bytes: number;
  /** First 16 hex characters of the SHA-256 of that same serialised form. */
  hash: string;
}

/** What ONE model step sent, and where it first differs from the step before it.
 *  A prefix cache is an exact match from byte 0, so `prefixPreserved: true` is the
 *  healthy reading; false means already-sent content came back different and the
 *  provider re-bills every token from `divergenceOffset` on. */
export interface PromptCaptureStep {
  /** 1-based, counted per session over the life of the engine process. */
  step: number;
  capturedAt: string;
  /** Total bytes of the serialised outbound array. */
  bytes: number;
  messages: PromptCaptureMessageDigest[];
  /** Exact when `sample` is non-null; otherwise the offset the diverging message STARTS at, a lower
   *  bound. Null on step 1. */
  divergenceOffset: number | null;
  divergenceMessage: number | null;
  prefixPreserved: boolean | null;
  sample: { previous: string; current: string } | null;
}

export interface PromptCapture {
  /** ISO timestamp of the send this describes. */
  capturedAt: string;
  /** `providerID/modelID` this exact prompt went to. */
  model: string;
  labeledParts: PromptCapturePart[];
  finalSystem: PromptCaptureBlock[];
  tools: PromptCaptureTool[];
  /** The last two model steps of this session, oldest first, so a reader can always
   *  diff two CONSECUTIVE steps. Absent on an older engine, and empty when the
   *  request layer sent no message array. */
  steps?: PromptCaptureStep[];
  /** Names the estimator so it is never mistaken for a real token count. */
  tokensApproxMethod: 'chars/4';
}

export interface PromptCaptureResult {
  sessionId: string;
  /** Null until the session has sent a turn — not an error. */
  capture: PromptCapture | null;
}

// Cache stats (`cache_stats`). Mirrors `UsageService.SessionCacheTokens` /
// `CacheStatsResult` in `packages/engine/src/acp/{usage,service}.ts`.

/** One session's (or a LIFETIME sum's) token accounting. `input` is already NET of
 *  cache and never overlaps `cacheRead`/`cacheWrite`, so all three can be summed. */
export interface SessionCacheTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CacheStatsResult {
  sessionId: string;
  /** Null when this session's row was not in the listing (deleted mid-read); the lifetime total is
   *  still real. */
  current: SessionCacheTokens | null;
  lifetime: SessionCacheTokens;
  /** How many session rows fed the lifetime sum — context, not a headline. */
  sessionCount: number;
}

// Skills (`list_skills`). Mirrors `packages/engine/src/acp/skills.ts`; keep the
// two in step.

/** One discovered skill, as projected by the engine's `list_skills`. */
export interface SkillEntry {
  name: string;
  description: string;
  /** Engine-side constants, not derived facts — this fork's registry has no tiering,
   *  per-skill agent ownership, tags or bundled skills, so these arrive as `'base'` /
   *  `[]` / `[]` / `false` for every skill. Never present them as authored. */
  tier: string;
  ownerAgents: string[];
  tags: string[];
  immutable: boolean;
  /** The skill's own `category:` frontmatter — a REAL authored fact, unlike the four
   *  constants above. FREE-FORM: the engine never validates it, so render whatever
   *  arrives. ABSENT covers every way a SKILL.md can fail to name one; the engine
   *  never sends `''`. */
  category?: string;
  /** The SKILL.md path it was discovered at — provenance a card can show. */
  location: string;
  /** Opening excerpt of the body, hard-capped engine-side. Absent when blank. */
  contentPreview?: string;
}

// Collabs (`collab_agents`, `collab_list`, `collab_create`, `collab_post`,
// `collab_state`, `collab_set_cap`). The wire contract, mirrored VERBATIM — a
// change here without a change engine-side is a break, not a refactor. Every
// identifier is `collab*`: the user-facing label "Flock" is presentation, and the
// `flock_*` namespace belonged to the deleted routing ext methods.

/** One collab-CAPABLE agent definition the engine discovered — an `Agent.Info`
 *  whose `options.collab` is truthy. Unknown frontmatter keys are swept into
 *  `options`, so a def written with a bare `collab: true` line arrives here. */
export interface CollabAgentInfo {
  /** The agent def's name — its filename minus `.md`. The @mention handle. */
  slug: string;
  /** The def's `description`, falling back to the slug when it has none. */
  displayName: string;
  /** The def's PINNED `provider/model`, or null when it pins none (the agent then runs on the
   *  session's model). */
  model: string | null;
}

/** A collab's identity row, as `collab_list` and `collab_create` project it. */
export interface CollabSummary {
  id: string;
  title: string;
  createdAt: string;
  /** Present only on an archived collab. Absent = live. */
  archivedAt?: string;
  /** The loop breaker: how many consecutive agent-to-agent turns may pass with no
   *  human message before the collab SUSPENDS itself. Three distinct values — null
   *  (not set; the engine's default 6 applies), 0 (OFF), N>0 (that cap). Never
   *  coalesce null and 0: `cap ?? 6` is right, `cap || 6` turns "off" into "6". */
  loopBreakerCap: number | null;
  /** The collab's lead agent, or null when unset. ABSENT on an older engine — read
   *  that the same as null (no lead), never as an error. */
  lead?: string | null;
  /** Flock M4: the collab's standing objective. ABSENT on an older engine,
   *  same as null. */
  objective?: string | null;
  /** How many participant turns the room dispatches AT ONCE. null (and ABSENT) =
   *  never configured, which is SERIAL, the shape every room shipped with; N>1 = that
   *  many turns run side by side. There is no "0 means off" here. Raising it is GATED
   *  engine-side on every member being read-only for files, so a shell must render the
   *  engine's refusal rather than assume it applied. */
  concurrency?: number | null;
  /** What KIND of room this is. 'discuss' — one speaker at a time, each reading the
   *  last. 'council' — one question to EVERY member at once, each blind to the others,
   *  then one of them reconciles the round. The engine sends the RESOLVED flavor; an
   *  absent or unknown value must still read as 'discuss'. A council is never refused
   *  on permissions: its round turns are sealed read-only engine-side
   *  (CollabSeal.COUNCIL_SEAL) for the turn only. Only raising `concurrency` keeps the
   *  write gate. */
  flavor?: 'discuss' | 'council';
}

/** A roster entry — an agent that is (or was) in this collab. */
export interface CollabParticipant {
  agentSlug: string;
  displayName: string;
  model: string | null;
  /** Present only once the agent left the roster. Absent = still a member. */
  removedAt?: string;
  /** The ENGINE session this participant's turns run in, once it has taken one.
   *  OPTIONAL and OMITTED (not null) when there is none — read absent as "has not
   *  taken a turn yet", never as an error or a session id it may go and ask about. */
  sessionId?: string;
}

/** A message's protocol role. `'say'` is the plain-chat default the DB migration
 *  backfills onto every existing row — an ABSENT `kind` must be read the same way,
 *  never as an error or an unknown state. */
export type CollabMessageKind =
  | 'say' | 'ask' | 'answer' | 'handoff'
  | 'task_open' | 'task_claim' | 'task_done' | 'task_accept' | 'task_reopen'
  | 'system'
  // COUNCIL rooms; absent on an engine that predates the mode.
  // `opinion`          one member's INDEPENDENT answer in a round, blind to siblings.
  // `round`            the round's own record (n of m answered), authored by the ROOM.
  // `synthesis`        one member reconciling the round it just read.
  // `council_question` the synthesizer's follow-up, which opens the next round.
  | 'opinion' | 'round' | 'synthesis' | 'council_question';

/** One tool call folded into a turn's compact trace — max 20 entries engine-side,
 *  `summary` capped at 120 chars, with a synthetic overflow row when it truncates. */
export interface TraceEntry {
  tool: string;
  summary: string;
  status: 'ok' | 'error';
}

/** One message in the shared stream. `authorId` is `'user'` for a human and the agent's
 *  slug otherwise, but SWITCH on `authorKind` so a future human id cannot read as an agent. */
export interface CollabMessage {
  /** Stable row id (flock M4). ABSENT on an older engine that predates it. */
  id?: string;
  /** Monotonic per collab, and the incremental-render key (`sinceSeq`). */
  seq: number;
  authorId: string;
  authorKind: 'human' | 'agent';
  /** The message's protocol role. ABSENT on an older engine — read a missing kind as `'say'`, never
   *  crash on it. */
  kind?: CollabMessageKind;
  text: string;
  replyToSeq?: number | null;
  /** @slug tokens this message targets (wake rule C17). ABSENT on an older engine — read as no
   *  mentions. */
  mentions?: string[];
  /** The task this message concerns, when it concerns one. ABSENT on an
   *  older engine, same as null. */
  taskId?: string | null;
  /** Compact tool trace for the turn that produced this message (C27).
   *  ABSENT on an older engine, same as null. */
  trace?: TraceEntry[] | null;
  /** The images the HUMAN attached, as `data:` URLs. OMITTED when there are none, so
   *  test presence rather than length. Max 4 per message, ~2MB each — the engine
   *  refuses the whole post for one over the line and names the limit. */
  images?: string[];
  createdAt: string;
}

/** What an agent is doing RIGHT NOW in this collab. */
export type CollabAgentActivity = 'idle' | 'queued' | 'running';

/** The one line a RUNNING agent is currently on — its latest reasoning burst
 *  (`thought`) or the tool it just called (`tool`). PRESENT ONLY WHILE THAT
 *  AGENT'S TURN IS RUNNING, bounded server-side at 200 chars. Absent means
 *  "nothing to show yet", never "it stopped"; never invent a line. */
export interface CollabLiveActivity {
  kind: 'thought' | 'tool';
  text: string;
}

/** One thing an agent DID or thought, retained across turns — mirrors the engine's
 *  `CollabActivity.ActivityEntry`; keep the two in step. `messageId` is the TURN's
 *  identity: it lets a re-read of the same in-progress message replace what that
 *  message contributed rather than pile a second copy on top of it. */
export interface CollabActivityEntry {
  kind: 'thought' | 'tool';
  /** Bounded engine-side at LIVE_ACTIVITY_MAX_CHARS (200). */
  text: string;
  messageId: string;
}

export interface CollabAgentStatus {
  slug: string;
  state: CollabAgentActivity;
  /** The last turn's failure for this agent, when it had one. OPTIONAL — absent
   *  means "nothing known to have failed", never "it succeeded", so render nothing
   *  rather than a green tick. */
  lastError?: string;
  /** See CollabLiveActivity — absent on an older engine and whenever idle. */
  liveActivity?: CollabLiveActivity;
  /** The WHOLE reasoning of the turn in flight, for a surface that renders it as a
   *  growing block. Same terms as `liveActivity` — only while that agent's turn is
   *  RUNNING, absent rather than stale — bounded server-side at 4000 chars. ABSENT
   *  on an older engine, which keeps the one-line pill. */
  liveThought?: string;
  /** The last few things this agent did or thought, OLDEST FIRST, kept across turns
   *  (engine cap: 20). Present for an IDLE agent too, which is the point. OMITTED
   *  rather than empty — test presence and say "no log", not "nothing happened". */
  activity?: CollabActivityEntry[];
}

/** One entry on a collab's task board, as the engine's `collab_task` table
 *  projects it. Once a task exists the engine populates every field — the
 *  optionality that matters is `tasks` being absent from `collab_state`. */
export interface TaskEntry {
  id: string;
  title: string;
  owner: string | null;
  state: 'open' | 'claimed' | 'done' | 'accepted';
  createdBy: string;
  result: string | null;
  /** Set on a reopen — why the claim was sent back. */
  note: string | null;
  /** The message seq this task originated from, when it did. */
  originSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Flock M4: one row of the per-turn cost ledger (`collab_turn_cost`). */
export interface LedgerEntry {
  id: string;
  agentSlug: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  cost: number;
  /** The asking agent's slug, on a nested `ask` turn. Null on a top-level one. */
  askedBy: string | null;
  createdAt: string;
}

/** One agent's summed spend, as `collab_state`/`collab_ledger` total it. */
export interface CollabCostTotal {
  agentSlug: string;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
}

/** The collab's hop budget. `remaining: null` means the budget is OFF — never coalesce it with a
 *  number. */
export interface CollabHopState {
  remaining: number | null;
  cap: number | null;
}

/** `collab_state`'s reply. `messages` carries only those with `seq > sinceSeq`, ascending. */
export interface CollabStateResult {
  collab: CollabSummary;
  participants: CollabParticipant[];
  messages: CollabMessage[];
  agents: CollabAgentStatus[];
  /** True when the loop breaker tripped: the collab waits on a human and no agent speaks
   *  again until one posts. Distinct from "every agent is idle", which is just a lull. */
  suspended: boolean;
  /** Flock M4 fields, ABSENT wholesale on an older engine that predates them — a
   *  consumer must degrade to today's rendering, never error, when they are missing. */
  lead?: string | null;
  objective?: string | null;
  /** Open+claimed+done first, accepted last, max 50. */
  tasks?: TaskEntry[];
  costTotals?: CollabCostTotal[];
  hopState?: CollabHopState;
}

export interface CollabAgentsResult {
  agents: CollabAgentInfo[];
}

export interface CollabListResult {
  collabs: CollabSummary[];
}

export interface CollabCreateResult {
  collab: CollabSummary;
}

export interface CollabPostResult {
  /** The seq the human message landed at. */
  seq: number;
  /** Why a message that LANDED still reached nobody. `no-lead` is the engine's
   *  answer to an unaddressed post into a collab with no lead: stored and visible,
   *  but no agent was woken. Absent = the routing did its ordinary job. */
  notice?: 'no-lead';
}

export interface CollabSetCapResult {
  ok: true;
}

/** The four M2 mutations (`collab_archive`, `collab_rename`,
 *  `collab_add_participant`, `collab_remove_participant`) all answer with the same
 *  acknowledgement; a refusal arrives as a JSON-RPC error, never `ok: false`. A
 *  soft-removed participant and an archived collab stay LISTABLE — the tombstone
 *  fields are how a consumer tells them apart. */
export interface CollabOkResult {
  ok: true;
}

/** `collab_task_add` / `collab_task_update` both answer with the task exactly as it
 *  now stands — never a partial patch, so replace the row wholesale. */
export interface CollabTaskResult {
  task: TaskEntry;
}

/** `collab_ledger`'s reply — `entries` newest-first, `totals` the same per-agent summary
 *  `collab_state` carries. */
export interface CollabLedgerResult {
  entries: LedgerEntry[];
  totals: CollabCostTotal[];
}

/** `list_tools` — the base tool list, with the deferred-catalog verdict per tool
 *  and the `experimental.tool_search` settings behind it. `deferred` is the
 *  SESSION-START verdict: this method answers about the workspace, not a session. */
export interface ToolCatalogEntry {
  id: string;
  description: string;
  deferred: boolean;
  /** Where the tool's definition lives. 'mcp' is valid for forward compat but the
   *  engine does not populate it — MCP tools are not rows in this list. */
  source: 'builtin' | 'mcp' | 'user-file' | 'plugin';
  /** Absolute path, only ever present alongside source: 'user-file'. */
  location?: string;
  /** OFF — `tools: { <id>: false }` in origami.json. Outranks `deferred`: the engine
   *  drops a disabled tool BEFORE deciding what to defer, so it is neither sent nor
   *  catalogued. The row is still listed, so the state can be left again. */
  disabled: boolean;
  /** True when the row has no state to set. No ENGINE row sets this any more; it
   *  survives for the synthetic `tool_search` row the shell appends. */
  hardRequired: boolean;
}

export interface ToolSearchSettings {
  enabled: boolean;
  mcp: boolean;
  defer: string[];
  always: string[];
}

/** A user tool FILE the engine found under `.origami/tool/` but could not load. A
 *  sibling of `tools`, never a row: the file produced no tool, so it has no id and
 *  no state to set — only a path (the user's own, shown verbatim) and a reason. */
export interface ToolProblem {
  file: string;
  message: string;
}

/** One SUB-AGENT TYPE's row in the Tools pane matrix: the state every listed tool would have when
 *  `task` spawns this agent right now. Mirrors `SubagentRow` in
 *  packages/engine/src/acp/subagent-tools.ts (not imported: cross-package). */
export interface SubagentToolRow {
  agent: string;
  /** An engine archetype rather than a file/config definition. */
  native: boolean;
  description?: string;
  /** Tool id -> 'loaded' | 'deferred' | 'off'. One entry per tool in `tools`. */
  states: Record<string, string>;
  /** Tool id -> why that cell is off and cannot be set — the engine's own
   *  reason, not a reading of the state (t-h8s3xg). Absent on an older engine
   *  and on a row with nothing to explain. */
  unavailable?: Record<string, string>;
}

export interface ToolCatalog {
  tools: ToolCatalogEntry[];
  settings: ToolSearchSettings;
  problems: ToolProblem[];
  /** Empty on an older engine, and empty when the agent registry could not be read. */
  subagents?: SubagentToolRow[];
}

/** `list_agent_plugins` — installed agent-plugins.org plugins from the
 *  `agentPlugins` config plus loader state. Mirrors `PluginEntry`/`PluginsResult`
 *  in `packages/engine/src/acp/agent-plugins.ts` (not imported: cross-tree). */
export interface AgentPluginMcpStatus {
  status: 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'needs_client_registration';
  era?: 'modern' | 'legacy';
  error?: string;
}

export interface AgentPluginMcpServer {
  name: string;
  type: 'local' | 'remote';
  status: AgentPluginMcpStatus;
}

export interface AgentPluginEntry {
  name: string;
  version?: string;
  mode: 'strict' | 'lenient';
  /** The plugin's resolved root directory on disk. */
  root: string;
  /** The `agentPlugins` config entry verbatim — what a write action targets. */
  spec: string;
  enabled: boolean;
  skillFiles: string[];
  mcp: AgentPluginMcpServer[];
  warnings: string[];
}

/** A configured spec that failed to resolve or parse — no `name` exists yet. */
export interface AgentPluginProblem {
  spec: string;
  message: string;
}

export interface AgentPluginsResult {
  plugins: AgentPluginEntry[];
  problems: AgentPluginProblem[];
}

/** `agent_plugin_add` / `agent_plugin_set_enabled` write results. */
export type AgentPluginWriteResult = { ok: true; path: string; name: string } | { ok: false; message: string };
export type AgentPluginSetEnabledResult = { ok: true; path: string } | { ok: false; message: string };

/** `mcp_list` — every MCP server the engine knows, config-declared AND
 *  plugin-provided. Mirrors `ServerEntry`/`ListResult` in
 *  `packages/engine/src/acp/mcp.ts`; `mcpWireShape.test.ts` reads BOTH files and
 *  fails when they disagree. `source`/`shadowed` matter because the engine merges
 *  `{ ...pluginServers, ...cfg.mcp }`, so a config entry silently overrides a
 *  plugin's server of the same name. `type: 'unknown'` is the bare
 *  `{ enabled: false }` marker — the only way to turn off a plugin's server. */
export interface McpServerEntry {
  name: string;
  source: 'config' | 'plugin';
  shadowed: boolean;
  type: 'local' | 'remote' | 'unknown';
  enabled: boolean;
  url?: string;
  command?: string[];
  /** The same union `AgentPluginMcpStatus` carries — one engine `MCP.Status`. */
  status: AgentPluginMcpStatus;
  supportsOAuth: boolean;
  /** Credential state, remote servers only. Never a token. */
  auth?: 'authenticated' | 'expired' | 'not_authenticated';
}

export interface McpListResult {
  servers: McpServerEntry[];
}

/** Every `mcp_*` write answers in this shape — never throws, always a reason. */
export type McpWriteResult =
  | { ok: true; path?: string; status?: AgentPluginMcpStatus }
  | { ok: false; message: string };

/** `subagent_transcript` — ONE sub-agent's stored session, projected into the
 *  shapes the live chat already renders. Read-only: the engine reads stored
 *  messages, it never loads or resumes the child. */
export type SubagentEntry =
  | { type: 'text'; role: 'user' | 'assistant'; messageId: string; text: string; truncated?: true }
  /** The child's THOUGHT (t-gvz8t0). Its own type, so this panel can only ever
   *  draw it as a thought block and never as the child's reply. */
  | { type: 'reasoning'; messageId: string; text: string; truncated?: true }
  | { type: 'tool'; messageId: string; toolCall: Record<string, unknown>; truncated?: true }
  | { type: 'error'; messageId: string; name: string; message: string };

export interface SubagentTranscriptResult {
  sessionId: string;
  /** False when the child's messages could not be read AT ALL — an id that never
   *  existed, a session deleted since, a store that refused. Returned instead of a
   *  throw, because the caller is a panel that has to draw something. */
  found: boolean;
  /** The child has not settled. The entries present are still real. */
  running: boolean;
  entries: SubagentEntry[];
  /** At least one string was cut at the engine's per-string cap. */
  truncated: boolean;
  /** t-krxap7. Paged reads only: stored messages OLDER than this page exist. */
  hasMore?: boolean;
  /** t-krxap7. Paged reads only: the opaque `before` cursor for the block
   *  preceding this page. Absent once the head of the transcript is reached. */
  cursor?: string;
}

/** `subagent_todos` (t-qd2riw) — the CHILD's latest todowrite call, found by a
 *  bounded backward walk over its stored session, not a whole-transcript read. */
export interface SubagentTodosResult {
  sessionId: string;
  /** False when the child's messages could not be read at all. Same meaning
   *  as `SubagentTranscriptResult.found`. */
  found: boolean;
  /** The latest todowrite's raw input — `{ todos: [...] }` — absent when the
   *  child wrote none, or none was found within the walk. */
  rawInput?: unknown;
}

/** `subagent_changes` (t-ru0by6, same family as `subagent_todos`) — the
 *  CHILD's diff-bearing tool parts, found by a bounded backward walk over its
 *  stored session, not a whole-transcript read. */
export interface SubagentChangesResult {
  sessionId: string;
  /** False when the child's messages could not be read at all. Same meaning
   *  as `SubagentTranscriptResult.found`. */
  found: boolean;
  /** Newest-first, capped on the engine side. */
  diffs: Array<{ path: string; oldText: string; newText: string }>;
  /** True when the walk stopped before reaching the head of the child's
   *  history — there may be older diffs this answer does not carry. */
  hasMore: boolean;
  cursor?: string;
}
