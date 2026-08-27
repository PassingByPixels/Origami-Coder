// Response shapes for the fork's ACP ext methods (`run_steps`,
// `list_instructions`). These live outside acpClient.ts because they are pure
// declarations the webview panes and the host both consume, and acpClient.ts
// is under an architecture line-cap — types are the cheapest thing to lift out
// of it, and doing so keeps the cap doing its job instead of being raised.

/** One step of a past run, as projected by the engine's `run_steps`. */
export interface RunStep {
  /** 0-based position in the FULL run — stable even when the list is capped. */
  ordinal: number;
  kind: 'prompt' | 'reply' | 'tool' | 'thinking' | 'subagent' | 'error';
  /** Present for `tool`/`subagent` steps. */
  tool?: string;
  title: string;
  status?: 'completed' | 'error' | 'running' | 'pending';
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  /**
   * Usage for the assistant message this step belongs to — attached by the
   * engine to the LAST step that message produced, so a run totals by SUMMING
   * steps without counting one message once per part.
   *
   * `input`/`output` are the original pair and always arrive together.
   * `reasoning` and `cache` are ADDITIVE and OPTIONAL: the engine omits one it
   * has no value for rather than sending 0, so a consumer must render nothing
   * for an absent field and must NOT fold cache-read into input — a cached turn
   * routinely carries 100x its `input` in cache (real store: 636 in / 74,496
   * cache read), which is the entire difference between a cheap turn and an
   * expensive one.
   */
  tokens?: {
    input: number;
    output: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  /** The message's own cost. A genuine 0 (a local model) is a measurement — keep it. */
  cost?: number;
  /**
   * True when the assistant message behind this step recorded NO token usage.
   * Any total that spans this step is therefore an UNDERCOUNT and must be
   * presented as approximate. Emitted only when true (absent = usage is here),
   * so an older binary that never sends it reads as "nothing known to be
   * missing" — which is exactly what it means for a build with no such concept.
   */
  usageMissing?: true;
  model?: string;
  agent?: string;
  /** Short excerpt, hard-capped engine-side. Never the full text. */
  preview?: string;
  error?: string;
  /**
   * True when this subagent was spawned DETACHED, so it ran concurrently with
   * the steps that follow instead of blocking them.
   *
   * The engine emits it only when true (`run-steps.ts` toolStep:
   * `...(detached ? { background: true } : {})`), so ABSENT means "this build
   * did not say" — it does NOT mean foreground, and must never be rendered as
   * one. A background spawn's tool state settles ~10ms after launch while the
   * subagent runs on for minutes, so the engine reports it `running` and
   * stitches the true `endedAt` on from the completion it injected.
   */
  background?: boolean;
  /** Session the subagent ran in — the key linking a spawn to its own run. */
  childSessionId?: string;
  /**
   * Sub-agent nesting level: absent/0 on the reviewed run's OWN steps, 1 on a
   * subagent's steps, 2 on a subagent's subagent. OPTIONAL by contract — see
   * `packages/engine/src/acp/run-steps.ts`, which emits it only for depth > 0.
   */
  depth?: number;
  /**
   * `ordinal` of the subagent step that spawned this one. The engine sets it
   * alongside `depth` (run-steps.ts `collect`), but the contract marks it
   * optional, so a consumer must lay out sanely when only `depth` arrives.
   */
  parentOrdinal?: number;
}

export interface RunStepsResult {
  steps: RunStep[];
  /** True when `steps` is a prefix of the run — `total` is the real count. */
  truncated: boolean;
  total: number;
}

/**
 * Per-run counts for the run index (`run_stats`), BATCHED: the index lists
 * every past run at once, so it asks for the whole page in one call.
 *
 * Every member is OPTIONAL and a value that could not be computed is OMITTED,
 * never zeroed — a blank cell is honest, a fabricated `0 tool calls` is not.
 * `tokens.cacheRead` absent specifically means the PROVIDER never reported
 * cache tokens (most local servers do not), which is a different fact from a
 * cache that was never hit.
 */
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

/**
 * The shipped prompts a user can replace with a file of their own. Each gets a
 * pinned row carrying its effective text and the path that overrides it.
 * `collab-agent-base` reaches COLLAB turns only, not every prompt — never
 * present it as though it did.
 *
 * M4.1 dropped `collab-manual`: the room manual was MERGED into the one collab
 * base prompt engine-side, so the engine emits no such row any more. The kind
 * is gone rather than kept as a tolerated no-op — a pinned row nothing can
 * ever fill is a control that silently does nothing.
 */
export type OverrideSource = 'base-prompt' | 'collab-agent-base';

/** A single file (or URL) contributing to the system prompt. */
export interface InstructionEntry {
  path: string;
  source: 'global' | 'project' | 'config' | 'memory' | 'url' | OverrideSource;
  chars: number;
  bytes: number;
  /** Heuristic — see `InstructionSet.tokensApproxMethod`. */
  tokensApprox: number;
  /**
   * Only on an OVERRIDE entry: true when the user's own file supplies the
   * prompt, false when the shipped built-in does. On such a row with
   * `overridden: false`, `path` names where the file WOULD be written — it does
   * not exist yet, so never present that path as something already on disk.
   */
  overridden?: boolean;
}

/**
 * The EFFECTIVE text of one overridable prompt plus the path that overrides it.
 * The only TEXT in this response, because the built-in is compiled into the
 * engine binary: a shell seeding the override file has nowhere else to read it
 * from.
 */
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
  /** The base prompt every collab agent gets, above its own persona. M4.1
   *  folded the former room manual into this one prompt, so it is the only
   *  collab layer the engine reports. */
  collabAgentBase?: BasePromptInfo;
}

// ---------------------------------------------------------------------------
// Prompt capture (`prompt_capture`). Mirrors
// `packages/engine/src/session/prompt-capture.ts`; keep the two in step.
// Unlike the instruction inventory above, this carries TEXT — it reports what
// the engine really sent the model on the last turn, which sizes alone cannot.
// ---------------------------------------------------------------------------

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
  /**
   * WHERE this block was delivered. Not every captured part is in the system
   * prompt any more: the memory blocks ride the TAIL of the message list, so a
   * `remember` write no longer invalidates the cached prefix. Without this the
   * pane would list them under "Assembled parts" and they would be missing from
   * "Final assembled system", which reads as a dropped block rather than design.
   * Absent on a capture from an older engine — treat undefined as 'system'.
   */
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

/** One outbound message, measured rather than kept — the array itself is far
 *  too large to report. Mirrors `MessageDigest` in the engine file. */
export interface PromptCaptureMessageDigest {
  role: string;
  /** Bytes of this message's serialised form, UTF-8. */
  bytes: number;
  /** First 16 hex characters of the SHA-256 of that same serialised form. */
  hash: string;
}

/**
 * What ONE model step sent, and where it first differs from the step before it.
 * Mirrors `StepCapture` in the engine file.
 *
 * A prefix cache is an exact match from byte 0, so `prefixPreserved: true` is
 * the healthy reading: the step only appended, and everything before the new
 * bytes is read from the cache. False means already-sent content came back
 * different, and the provider re-bills every token from `divergenceOffset` on.
 */
export interface PromptCaptureStep {
  /** 1-based, counted per session over the life of the engine process. */
  step: number;
  capturedAt: string;
  /** Total bytes of the serialised outbound array. */
  bytes: number;
  messages: PromptCaptureMessageDigest[];
  /** Exact when `sample` is non-null; otherwise the offset at which the
   *  diverging message STARTS, which is a lower bound. Null on step 1. */
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
  /**
   * The last two model steps of this session, oldest first, so a reader can
   * always diff two CONSECUTIVE steps. Absent on a capture from an older
   * engine, and empty when the request layer sent no message array.
   */
  steps?: PromptCaptureStep[];
  /** Names the estimator so it is never mistaken for a real token count. */
  tokensApproxMethod: 'chars/4';
}

export interface PromptCaptureResult {
  sessionId: string;
  /** Null until the session has sent a turn — not an error. */
  capture: PromptCapture | null;
}

// ---------------------------------------------------------------------------
// Cache stats (`cache_stats`). Mirrors `UsageService.SessionCacheTokens` /
// `CacheStatsResult` in `packages/engine/src/acp/{usage,service}.ts`; keep
// the two in step. Behind the Insights "cache hit ratio" card (t-kgtw47).
// ---------------------------------------------------------------------------

/** One session's (or a LIFETIME sum across many) token accounting. `input` is
 *  already NET of cache — never overlaps `cacheRead`/`cacheWrite` — so a
 *  consumer can sum all three for "every token this turn moved". */
export interface SessionCacheTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CacheStatsResult {
  sessionId: string;
  /** Null when this session's row was not in the listing (e.g. deleted
   *  mid-read) — the lifetime total below is still real either way. */
  current: SessionCacheTokens | null;
  lifetime: SessionCacheTokens;
  /** How many session rows fed the lifetime sum — context, not a headline. */
  sessionCount: number;
}

// ---------------------------------------------------------------------------
// Skills (`list_skills`). Mirrors `packages/engine/src/acp/skills.ts`; keep
// the two in step.
// ---------------------------------------------------------------------------

/** One discovered skill, as projected by the engine's `list_skills`. */
export interface SkillEntry {
  name: string;
  description: string;
  /**
   * Engine-side constants, not derived facts — this fork's registry has no
   * tiering, no per-skill agent ownership, no tags and no bundled skills, so
   * these arrive as `'base'` / `[]` / `[]` / `false` for every skill. Do not
   * present any of them as something the author chose.
   */
  tier: string;
  ownerAgents: string[];
  tags: string[];
  immutable: boolean;
  /**
   * The skill's own `category:` frontmatter — a REAL authored fact, unlike the
   * four constants above. FREE-FORM: the engine never validates it, so render
   * whatever arrives rather than switching on a closed set. ABSENT covers every
   * way a SKILL.md can fail to name one (no line, a bare `category:`, or an
   * empty string) — the engine never sends `''`, so there is no blank-chip case
   * to guard against here.
   */
  category?: string;
  /** The SKILL.md path it was discovered at — provenance a card can show. */
  location: string;
  /** Opening excerpt of the body, hard-capped engine-side. Absent when blank. */
  contentPreview?: string;
}

// ---------------------------------------------------------------------------
// Collabs (`collab_agents`, `collab_list`, `collab_create`, `collab_post`,
// `collab_state`, `collab_set_cap`). The M1 wire contract, mirrored VERBATIM —
// the engine lane builds to the same words, so a change here without a change
// there is a break, not a refactor.
//
// NAMING: every identifier is `collab*`. The user-facing label becomes "Flock"
// at M2, but the `flock_*` namespace belonged to the ROUTING ext methods (now
// deleted with the Routings view), and two unrelated features sharing one
// prefix on the wire is a collision waiting to happen. The label is
// presentation; these names are the protocol.
// ---------------------------------------------------------------------------

/** One collab-CAPABLE agent definition the engine discovered — an `Agent.Info`
 *  whose `options.collab` is truthy. (Unknown frontmatter keys are swept into
 *  `options` by the engine's own agent schema, so a def written with a bare
 *  `collab: true` line arrives here.) */
export interface CollabAgentInfo {
  /** The agent def's name — its filename minus `.md`. The @mention handle. */
  slug: string;
  /** The def's `description`, falling back to the slug when it has none. */
  displayName: string;
  /** The def's PINNED `provider/model` string, or null when it pins none (the
   *  agent then runs on whatever the session's model is). Never invent one. */
  model: string | null;
}

/** A collab's identity row, as `collab_list` and `collab_create` project it. */
export interface CollabSummary {
  id: string;
  title: string;
  createdAt: string;
  /** Present only on an archived collab. Absent = live. */
  archivedAt?: string;
  /**
   * The loop breaker: how many consecutive agent-to-agent turns may pass with
   * no human message before the collab SUSPENDS itself.
   *
   * Three distinct values, none of them interchangeable:
   *   null — not set; the engine's default (6) applies.
   *   0    — OFF. Overnight mode; nothing will ever stop the agents.
   *   N>0  — that cap.
   * So a consumer must NOT coalesce `null` and `0` (`cap ?? 6` is right,
   * `cap || 6` turns "off" into "6" and is the bug this comment exists for).
   */
  loopBreakerCap: number | null;
  /**
   * Flock M4 (C16-C28): the collab's lead agent, or null when unset. ABSENT on
   * an older engine that predates the field — a consumer must read that the
   * same as null (no lead), never as an error.
   */
  lead?: string | null;
  /** Flock M4: the collab's standing objective. ABSENT on an older engine,
   *  same as null. */
  objective?: string | null;
  /**
   * W5: how many participant turns the room dispatches AT ONCE.
   *
   * null — never configured, which is SERIAL (one turn at a time), the shape
   *        every room shipped with.
   * N>1  — that many turns run side by side.
   * ABSENT on an engine that predates the field, and read the same as null.
   *
   * NOT spelled like `loopBreakerCap`: there is no "0 means off" here, because
   * an off concurrency would be a room with no ceiling on parallel turns.
   * Raising it is GATED engine-side on every member being read-only for files,
   * so a shell must render the engine's refusal rather than assume it applied.
   */
  concurrency?: number | null;
  /**
   * W5-L2: what KIND of room this is.
   *
   * 'discuss' — the chain every room has always run: one speaker at a time,
   *             each reading the last.
   * 'council' — one question to EVERY member at once, each blind to the others,
   *             then one of them reconciles the round.
   *
   * ABSENT on an engine that predates the mode. The engine sends the RESOLVED
   * flavor rather than the raw stored value, so a shell never has to know the
   * "anything unrecognised is discuss" rule — but it must still read an absent
   * or unknown value as 'discuss', which is the only safe reading.
   *
   * Becoming a council is never refused on permissions: a council's round
   * turns are sealed read-only engine-side (CollabSeal.COUNCIL_SEAL) for the
   * turn only, so its side-by-side opinions cannot write however open the
   * members' own tools are. Only raising `concurrency` keeps the write gate.
   */
  flavor?: 'discuss' | 'council';
}

/** A roster entry — an agent that is (or was) in this collab. */
export interface CollabParticipant {
  agentSlug: string;
  displayName: string;
  model: string | null;
  /** Present only once the agent left the roster. Absent = still a member. */
  removedAt?: string;
  /**
   * M2: the ENGINE session this participant's turns run in, once it has taken
   * one. OPTIONAL by contract and OMITTED (not null) when there is none, so a
   * consumer must read "absent" as "this agent has not taken a turn yet" —
   * never as an error, and never as a session id it may go and ask about.
   */
  sessionId?: string;
}

/**
 * Flock M4 (C16-C28): a message's protocol role. `'say'` is the plain-chat
 * default the DB migration backfills onto every existing row — an ABSENT
 * `kind` (an older engine that has not adopted the field at all) must be read
 * the same way, never as an error or an unknown state.
 */
export type CollabMessageKind =
  | 'say' | 'ask' | 'answer' | 'handoff'
  | 'task_open' | 'task_claim' | 'task_done' | 'task_accept' | 'task_reopen'
  | 'system'
  // W5-L2 — COUNCIL rooms. Absent on an engine that predates the mode, which a
  // discuss room never produces anyway.
  // `opinion`         one member's INDEPENDENT answer in a round; it read the
  //                   room cut at the question and saw no sibling's answer.
  // `round`           the round's own record: n of m answered, and who is not
  //                   in the n. Authored by the ROOM (`collab`), not a member.
  // `synthesis`       one member reconciling the round it just read.
  // `council_question` the synthesizer's follow-up, which opens the next round.
  | 'opinion' | 'round' | 'synthesis' | 'council_question';

/** One tool call folded into a turn's compact trace (C27) — max 20 entries
 *  engine-side, `summary` capped at 120 chars, with a synthetic overflow row
 *  (`tool: '…', summary: '+N more', status: 'ok'`) when it truncates. */
export interface TraceEntry {
  tool: string;
  summary: string;
  status: 'ok' | 'error';
}

/** One message in the shared stream. `authorId` is `'user'` for a human and the
 *  agent's slug for an agent; `authorKind` is the field to SWITCH on, so a
 *  future non-`user` human id cannot silently render as an agent. */
export interface CollabMessage {
  /** Stable row id (flock M4). ABSENT on an older engine that predates it. */
  id?: string;
  /** Monotonic per collab, and the incremental-render key (`sinceSeq`). */
  seq: number;
  authorId: string;
  authorKind: 'human' | 'agent';
  /** The message's protocol role (flock M4, C16). ABSENT on an older engine
   *  — read a missing kind as `'say'`, never crash or mis-route on it. */
  kind?: CollabMessageKind;
  text: string;
  replyToSeq?: number | null;
  /** @slug tokens this message targets (flock M4, wake rule C17). ABSENT on
   *  an older engine — read as no mentions, never as an error. */
  mentions?: string[];
  /** The task this message concerns, when it concerns one. ABSENT on an
   *  older engine, same as null. */
  taskId?: string | null;
  /** Compact tool trace for the turn that produced this message (C27).
   *  ABSENT on an older engine, same as null. */
  trace?: TraceEntry[] | null;
  /** The images the HUMAN attached to this message, as `data:` URLs. OMITTED
   *  when there are none (the engine sends no key at all), so a surface tests
   *  presence rather than length. Max 4 per message, ~2MB each — the engine
   *  refuses the whole post for one over the line and names the limit. */
  images?: string[];
  createdAt: string;
}

/** What an agent is doing RIGHT NOW in this collab. */
export type CollabAgentActivity = 'idle' | 'queued' | 'running';

/**
 * The one line a RUNNING agent is currently on — its latest reasoning burst
 * (`thought`) or the tool it just called (`tool`).
 *
 * PRESENT ONLY WHILE THAT AGENT'S TURN IS RUNNING, and bounded server-side at
 * 200 chars. Absent means "nothing to show yet", never "it stopped": an older
 * engine sends no such field at all, and the surface must fall back to saying
 * only that the agent is thinking, never invent a line it was never given.
 */
export interface CollabLiveActivity {
  kind: 'thought' | 'tool';
  text: string;
}

/**
 * One thing an agent DID or thought, retained across turns — the extension-side
 * mirror of the engine's `CollabActivity.ActivityEntry` (wave 1,
 * `packages/engine/src/collab/activity.ts`). Keep the two in step.
 *
 * `messageId` is the TURN's identity, not the signal's: it is what lets a
 * re-read of the same in-progress message replace what that message contributed
 * rather than pile a second copy on top of it, and what lets a surface group the
 * log into turns. It is carried through rather than dropped for exactly that
 * reason, even though today's drawer only prints the line.
 */
export interface CollabActivityEntry {
  kind: 'thought' | 'tool';
  /** Bounded engine-side at LIVE_ACTIVITY_MAX_CHARS (200). */
  text: string;
  messageId: string;
}

export interface CollabAgentStatus {
  slug: string;
  state: CollabAgentActivity;
  /**
   * The last turn's failure for this agent, when it had one. OPTIONAL by
   * contract — absent means "nothing known to have failed", never "it
   * succeeded", so a consumer must render nothing rather than a green tick.
   */
  lastError?: string;
  /** See CollabLiveActivity — absent on an older engine and whenever idle. */
  liveActivity?: CollabLiveActivity;
  /**
   * The WHOLE reasoning of the turn in flight, for a surface that renders it as
   * an expanding block that grows as polls land.
   *
   * Present on exactly the same terms as `liveActivity` — only while that
   * agent's turn is RUNNING, absent rather than stale — and bounded
   * server-side at 4000 chars. Far larger than `liveActivity` because it is a
   * different thing: the chip shows the newest line, this is the reasoning a
   * human reads. ABSENT on an older engine, which keeps today's one-line pill.
   */
  liveThought?: string;
  /**
   * The last few things this agent did or thought, OLDEST FIRST, kept across
   * turns (engine cap: 20).
   *
   * Present for an IDLE agent too, which is the whole point: `liveActivity`
   * answers "what is it doing", and a room between turns answers that with
   * nothing at all. OMITTED rather than empty — an older engine sends no such
   * field, so a surface tests presence and says "no log" rather than "nothing
   * happened".
   */
  activity?: CollabActivityEntry[];
}

/**
 * Flock M4 (C16-C28): one entry on a collab's task board, exactly as the
 * engine's `collab_task` table projects it. Once a task exists at all, the
 * engine populates every field — the OPTIONALITY that matters is `tasks`
 * being absent from `collab_state` wholesale on an older engine, not any
 * field within one of these.
 */
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

/** Flock M4: one agent's summed spend, as `collab_state`/`collab_ledger`
 *  total it. */
export interface CollabCostTotal {
  agentSlug: string;
  cost: number;
  tokensInput: number;
  tokensOutput: number;
}

/** Flock M4 (C21): the collab's hop budget. `remaining: null` means the
 *  budget is OFF (`loop_breaker_cap` 0) — never coalesce it with a number. */
export interface CollabHopState {
  remaining: number | null;
  cap: number | null;
}

/** `collab_state`'s reply. `messages` carries only those with `seq > sinceSeq`
 *  (all of them when `sinceSeq` was absent), ascending. */
export interface CollabStateResult {
  collab: CollabSummary;
  participants: CollabParticipant[];
  messages: CollabMessage[];
  agents: CollabAgentStatus[];
  /** True when the loop breaker tripped: the collab is waiting on a human and
   *  no agent will speak again until one posts (or the cap is raised/turned
   *  off). Distinct from "every agent is idle" — that is just a lull. */
  suspended: boolean;
  /** Flock M4 fields (C16-C28). ABSENT wholesale on an older engine that
   *  predates them — a consumer must degrade to today's rendering, never
   *  error, when any of these are missing. */
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
   *  answer to an unaddressed post into a collab with no lead: it is stored and
   *  it is visible, but no agent was woken by it. Absent means the routing did
   *  its ordinary job — never a failure, so it is not an `error`. */
  notice?: 'no-lead';
}

export interface CollabSetCapResult {
  ok: true;
}

/** M2's four mutations (`collab_archive`, `collab_rename`,
 *  `collab_add_participant`, `collab_remove_participant`) all answer with the
 *  same acknowledgement and nothing else — a refusal arrives as a JSON-RPC
 *  error, never as `ok: false`. Both a soft-removed participant and an archived
 *  collab stay LISTABLE; the tombstone fields (`removedAt` / `archivedAt`) are
 *  how a consumer tells them apart, so nothing ever vanishes from a roster or
 *  a list without a reason on screen. */
export interface CollabOkResult {
  ok: true;
}

/**
 * Flock M4: `collab_task_add` / `collab_task_update` both answer with the
 * task exactly as it now stands — never a partial patch, so a consumer can
 * always replace its copy of the row wholesale rather than merge one.
 */
export interface CollabTaskResult {
  task: TaskEntry;
}

/** Flock M4: `collab_ledger`'s reply — `entries` newest-first, `totals`
 *  the same per-agent summary `collab_state` carries. */
export interface CollabLedgerResult {
  entries: LedgerEntry[];
  totals: CollabCostTotal[];
}

/**
 * `list_tools` — the base tool list the engine would offer a turn, with the
 * deferred-catalog verdict per tool and the `experimental.tool_search` settings
 * that produced it. `deferred` is the SESSION-START verdict: a tool a running
 * chat has already pulled in with `tool_search` still reads as deferred here,
 * because this method answers about the workspace, not about one session.
 */
export interface ToolCatalogEntry {
  id: string;
  description: string;
  deferred: boolean;
  /** Where the tool's definition lives. 'mcp' is a valid value for forward
   *  compat, but the engine does not populate it yet — MCP tools are not
   *  represented as rows in this list (see acp/tools.ts's doc comment). */
  source: 'builtin' | 'mcp' | 'user-file' | 'plugin';
  /** Absolute path, only ever present alongside source: 'user-file'. */
  location?: string;
  /** OFF — `tools: { <id>: false }` in origami.json. Outranks `deferred`:
   *  the engine drops a disabled tool BEFORE deciding what to defer
   *  (engine/src/session/tools.ts), so it is neither sent nor catalogued.
   *  The row is still listed, so the state can be left again. */
  disabled: boolean;
  /** True when the row has no state to set. No ENGINE row sets this any more
   *  (the only set that did — repair-only tools — is no longer listed at all);
   *  it survives for the synthetic `tool_search` row the shell appends. */
  hardRequired: boolean;
}

export interface ToolSearchSettings {
  enabled: boolean;
  mcp: boolean;
  defer: string[];
  always: string[];
}

/** A user tool FILE the engine found under `.origami/tool/` but could not load.
 *  A sibling of `tools`, never a row: the file produced no tool, so it has no
 *  id and no state to set — only a path and a reason. Mirrors the engine's
 *  `ToolProblem` (engine/src/acp/tools.ts) and the Plugins pane's
 *  `AgentPluginProblem`. `file` is the user's own path and is shown verbatim. */
export interface ToolProblem {
  file: string;
  message: string;
}

export interface ToolCatalog {
  tools: ToolCatalogEntry[];
  settings: ToolSearchSettings;
  problems: ToolProblem[];
}

/**
 * `list_agent_plugins` — installed agent-plugins.org plugins from the
 * `agentPlugins` config plus loader state, for the Plugins pane (t-kgtolm
 * round 3). Mirrors `PluginEntry`/`PluginsResult` in
 * `packages/engine/src/acp/agent-plugins.ts` (not imported: cross-tree,
 * the same rule `ToolCatalogEntry`/`SkillEntry` already follow).
 */
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

/**
 * `mcp_list` — every MCP server the engine knows, config-declared AND
 * plugin-provided, for the MCP pane. Mirrors `ServerEntry`/`ListResult` in
 * `packages/engine/src/acp/mcp.ts` (not imported: cross-tree, the same rule
 * `AgentPluginEntry` above follows). `mcpWireShape.test.ts` reads BOTH files
 * and fails when they stop agreeing.
 *
 * `source`/`shadowed` are not decoration: the engine merges
 * `{ ...pluginServers, ...cfg.mcp }`, so a config entry silently overrides a
 * plugin's server of the same name. `type: 'unknown'` is the bare
 * `{ enabled: false }` marker — legal config with no server definition, and
 * the only way to turn off a plugin's server.
 */
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

/**
 * `subagent_transcript` — ONE sub-agent's stored session, projected into the
 * shapes the live chat already renders (packages/engine/src/acp/
 * subagent-transcript.ts). Read-only: the engine reads stored messages, it
 * never loads or resumes the child.
 */
export type SubagentEntry =
  | { type: 'text'; role: 'user' | 'assistant'; messageId: string; text: string; truncated?: true }
  | { type: 'tool'; messageId: string; toolCall: Record<string, unknown>; truncated?: true }
  | { type: 'error'; messageId: string; name: string; message: string };

export interface SubagentTranscriptResult {
  sessionId: string;
  /** False when the child's messages could not be read AT ALL — an id that
   *  never existed, a session deleted since, a store that refused. The engine
   *  returns this instead of throwing, because the caller is a panel that has
   *  to draw something and an hour-old child is the one most likely to be gone. */
  found: boolean;
  /** The child has not settled. The entries present are still real. */
  running: boolean;
  entries: SubagentEntry[];
  /** At least one string was cut at the engine's per-string cap. */
  truncated: boolean;
}
