import { isRecord } from "@/util/record"
import type { SessionV1 } from "@origami/core/v1/session"

/**
 * TOOL-RESULT AGING — the outgoing array only, never the database.
 *
 * Most prompt tokens this harness sends are tool results carried in history,
 * and a result is re-derivable: the file is still on disk, the command can run
 * again. So once a result is older than the last K it is replaced ON THE WIRE
 * by a one-line stub saying what it was and how to get it back. This module
 * decides; `message-v2.ts` renders, and the stored part is never touched.
 *
 * Unlike `compaction.ts`'s `prune`, which WRITES `state.time.compacted` to
 * SQLite, this is per-part and reversible. The two coexist: message-v2 checks
 * `time.compacted` first, so the prune only wins on parts aging left alone.
 *
 * MONOTONIC, AT BOUNDARIES ONLY. Every provider prefix cache is an exact match
 * from byte 0, so rewriting the middle of the array on every step would trade
 * tokens for cache misses. Decisions are taken at a turn's first step and when
 * the context passes half the usable window; between those points `plan`
 * answers with the map it already holds, so the aged region is byte-identical.
 *
 * IN BATCHES. A boundary that stubs a result the model was already sent moves
 * the prefix from that result on, so every commit costs one cache miss. A
 * boundary therefore commits only when it would rewrite at least `BATCH`
 * results, and otherwise decides nothing (t-v4r3lw: a resumed sub-agent lost
 * its prefix at every resume, because each turn start stubbed the one or two
 * results that had just left the tail).
 */

/**
 * How many of the most recent completed tool results are never aged. Raised
 * from 6 to 18 by a live replay gate: at 6 the aged run re-read stubbed,
 * not-superseded files sitting at tail depths 10, 15 and 18.
 */
export const K = 18

/**
 * The fewest rewrites a boundary commits; fewer wait for a later boundary. So
 * the unaged tail holds between K and K + BATCH - 1 results. Measured with
 * this `plan` on a growing session of 34 to 120 reads (t-v4r3lw): against a
 * batch of 1, 18 sends 14-21% more prompt tokens but 59-79% fewer uncached
 * ones, and fewer cache misses (0 instead of 7 over 34 reads, 5 instead of 50
 * over 120).
 */
export const BATCH = 18

/** How many sessions keep their decisions. Bounded like `prompt-capture.ts`. */
export const LIMIT = 16

/** Cap on ONE `edit` argument, in characters. */
export const EDIT_ARG_MAX_CHARS = 2048

/** Shortest output line that counts as "the assistant quoted this result". */
export const REFERENCE_MIN_LINE = 20

/** Characters of a shell command kept in its stub. */
export const COMMAND_PREVIEW_CHARS = 60

/** What to send INSTEAD of a stored tool part's own fields. Both are optional and
 *  independent: a `write` has its arguments rewritten, an aged `read` its output. */
export type Rewrite = {
  /** Replaces `state.output` on the wire. */
  readonly output?: string
  /** Replaces `state.input` on the wire. */
  readonly input?: Record<string, unknown>
}

/** What one boundary decided. Zero on a non-boundary step, which decides nothing. */
export type Counts = {
  /** Parts newly rewritten at this boundary. */
  readonly aged: number
  /** Of those, ones stubbed because a later call made them stale. */
  readonly superseded: number
  /** Candidates left intact — inside the tail, referenced, not ageable, or
   *  waiting because the boundary had fewer than `BATCH` rewrites to commit. */
  readonly kept: number
}

export type Plan = {
  /** Keyed by `part.id`. Grows at boundaries, never shrinks within a session. */
  readonly rewrites: ReadonlyMap<string, Rewrite>
  readonly counts: Counts
}

/** Tools whose result is re-derivable by calling them again, so the stub loses
 *  nothing but bytes. `wiki_*` is by prefix because the family grows. */
const AGEABLE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "shell",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "list",
  "session_search",
])

/**
 * Every tool id this engine defines itself, plus the two synthetic ones the
 * prompt layer adds. It exists for ONE question: is this part an MCP tool
 * result? A stored part carries no marker, and an MCP tool is named
 * `<client>_<tool>` — the same shape as `board_repos`. So the test is "not one
 * of ours", and the list must stay complete for that test to be safe. A plugin
 * tool is also not one of ours and is aged like an MCP one.
 */
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "apply_patch",
  "bash",
  "board_create",
  "board_register",
  "board_repos",
  "board_tickets",
  "board_update",
  "board_worktrees",
  "browser",
  "chart",
  "dream",
  "edit",
  "execute",
  "file",
  "flock_ask",
  "flock_reply",
  "flock_who",
  "git_diff",
  "glob",
  "goal",
  "grep",
  "invalid",
  "list_agents",
  "lsp",
  "plan_exit",
  "process",
  "read",
  "remember",
  "screenshot",
  "send_message",
  "session_search",
  "shell",
  "skill",
  "StructuredOutput",
  "task",
  "task_list",
  "task_stop",
  "todowrite",
  "vision_request",
  "webfetch",
  "webmcp_call",
  "webmcp_launch",
  "webmcp_list",
  "webmcp_note",
  "webmcp_tools",
  "websearch",
  "wiki_related",
  "wiki_search",
  "write",
  "question",
  // t-po041k. Shaped exactly like an MCP id (<client>_<tool>), so leaving it out
  // would age a question_reply result as a foreign tool's.
  "question_reply",
])

/** Tools whose call makes an earlier `read` of the same path stale. */
const SUPERSEDING_VERBS: ReadonlyMap<string, string> = new Map([
  ["edit", "edited"],
  ["write", "written"],
  ["apply_patch", "edited"],
  ["read", "re-read"],
])

const EMPTY_REWRITES: ReadonlyMap<string, Rewrite> = new Map()
const EMPTY_COUNTS: Counts = { aged: 0, superseded: 0, kept: 0 }
const EMPTY_PLAN: Plan = { rewrites: EMPTY_REWRITES, counts: EMPTY_COUNTS }

export function ageable(tool: string): boolean {
  if (AGEABLE_TOOLS.has(tool)) return true
  if (tool.startsWith("wiki_")) return true
  // Not an engine tool: MCP, or a plugin tool that behaves like one.
  return !BUILTIN_TOOLS.has(tool)
}

/** `342 B` / `8.1 KB`. UTF-8 bytes, so the number is the wire cost. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function utf8(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/** Case- and separator-insensitive, so `C:\a\B.ts` and `c:/a/b.ts` are one file. */
function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase()
}

function completed(part: SessionV1.ToolPart): SessionV1.ToolStateCompleted | undefined {
  return part.state.status === "completed" ? part.state : undefined
}

/** The files a call touched. `apply_patch` names them only in its metadata, so a
 *  failed patch supersedes nothing — correct, it changed no file. */
function touchedPaths(part: SessionV1.ToolPart): string[] {
  const state = completed(part)
  if (!state) return []
  if (part.tool === "apply_patch") {
    const files: unknown = (state.metadata as { files?: unknown }).files
    if (!Array.isArray(files)) return []
    const list = files as readonly unknown[]
    return list
      .map((file) => (isRecord(file) ? file.filePath : undefined))
      .filter((value): value is string => typeof value === "string")
  }
  const input = state.input as { filePath?: unknown; path?: unknown }
  const raw = input.filePath ?? input.path
  return typeof raw === "string" ? [raw] : []
}

/** Lines the file really has, from `read`'s own metadata when it recorded them. */
function readLines(state: SessionV1.ToolStateCompleted): number {
  const display = (state.metadata as { display?: { totalLines?: unknown } }).display
  const total = display?.totalLines
  if (typeof total === "number" && Number.isFinite(total)) return total
  return state.output.length === 0 ? 0 : state.output.split("\n").length
}

function commandPreview(command: string): string {
  return command.replaceAll(/\r?\n/g, " ").slice(0, COMMAND_PREVIEW_CHARS)
}

type Superseder = { readonly verb: string; readonly step: number }

/** The one line that replaces a result. `read` names the file and why it went,
 *  `bash` the command, everything else the tool; all three end by telling the
 *  model how to get the content back, which is what makes the stub safe. */
export function stubText(part: SessionV1.ToolPart, step: number, superseder?: Superseder): string | undefined {
  const state = completed(part)
  if (!state) return undefined
  const bytes = utf8(state.output)
  if (part.tool === "read") {
    const path = touchedPaths(part)[0] ?? "unknown"
    const head = `[read ${path} · ${formatSize(bytes)} · ${readLines(state)} lines`
    if (superseder) {
      // A later `read` changed nothing — say so, or the model re-reads to check.
      // `edit`/`write`/`apply_patch` did change it, so those say "superseded".
      if (superseder.verb === "re-read") {
        return `${head} · newer read at step ${superseder.step} — nothing to redo]`
      }
      return `${head} · superseded: ${superseder.verb} at step ${superseder.step}]`
    }
    return `${head} · aged out — read again if needed]`
  }
  if (part.tool === "bash" || part.tool === "shell") {
    const raw = (state.input as { command?: unknown }).command
    const command = typeof raw === "string" ? commandPreview(raw) : ""
    const code = (state.metadata as { exit?: unknown }).exit
    const exit = typeof code === "number" ? ` · exit ${code}` : ""
    return `[shell "${command}" · ${formatSize(bytes)}${exit} · aged out — run again if needed]`
  }
  // `step` is unused here but kept so every caller passes the same facts.
  void step
  return `[${part.tool} result · ${formatSize(bytes)} · aged out — call again if needed]`
}

function capArgument(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length <= EDIT_ARG_MAX_CHARS) return undefined
  return `${value.slice(0, EDIT_ARG_MAX_CHARS)}… [+${value.length - EDIT_ARG_MAX_CHARS} chars]`
}

/** Tool-call arguments, costly because `write` and `edit` carry file bodies. A
 *  successful `write` put its content on disk, so the wire copy is dead weight;
 *  `edit` keeps both strings, capped, because the model reads them. */
export function argumentRewrite(part: SessionV1.ToolPart): Record<string, unknown> | undefined {
  const state = completed(part)
  if (!state) return undefined
  const input = state.input as Record<string, unknown>
  if (part.tool === "write") {
    const content = input.content
    if (typeof content !== "string") return undefined
    const path = typeof input.filePath === "string" ? input.filePath : "unknown"
    return { ...input, content: `[wrote ${path} · ${utf8(content)} bytes]` }
  }
  if (part.tool === "edit") {
    const oldString = capArgument(input.oldString)
    const newString = capArgument(input.newString)
    if (oldString === undefined && newString === undefined) return undefined
    return {
      ...input,
      ...(oldString === undefined ? {} : { oldString }),
      ...(newString === undefined ? {} : { newString }),
    }
  }
  return undefined
}

type Entry = {
  readonly part: SessionV1.ToolPart
  /** 1-based ordinal among all tool parts of the session, in message order. */
  readonly step: number
  readonly messageIndex: number
  readonly partIndex: number
}

function flatten(messages: readonly SessionV1.WithParts[]): Entry[] {
  const entries: Entry[] = []
  let step = 0
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]
    if (message.info.role !== "assistant") continue
    for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
      const part = message.parts[partIndex]
      if (part.type !== "tool") continue
      step++
      entries.push({ part, step, messageIndex, partIndex })
    }
  }
  return entries
}

/** The assistant prose that FOLLOWS a result: the rest of its own message plus
 *  the whole next assistant message. That is the window in which a model quotes
 *  what it just read; later turns have already had a boundary. */
function followingText(messages: readonly SessionV1.WithParts[], entry: Entry): string {
  const chunks: string[] = []
  const own = messages[entry.messageIndex]
  for (let index = entry.partIndex + 1; index < own.parts.length; index++) {
    const part = own.parts[index]
    if (part.type === "text") chunks.push(part.text)
  }
  for (let index = entry.messageIndex + 1; index < messages.length; index++) {
    const message = messages[index]
    if (message.info.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type === "text") chunks.push(part.text)
    }
    break
  }
  return chunks.join("\n")
}

/** `read` numbers every output line `12: text`; a quote drops the number. */
function stripLineNumber(line: string): string {
  return line.replace(/^\s*\d+:\s?/, "")
}

/**
 * Did the assistant name the file, or copy a line out of the result? Either way
 * the content is load-bearing for prose already sent, so it survives one more
 * boundary. Line-for-line rather than substring, because a set membership test
 * is the only shape of this check that stays linear over a long output; a model
 * that quotes half a line is not caught and gets one fewer boundary.
 */
function referenced(messages: readonly SessionV1.WithParts[], entry: Entry): boolean {
  const state = completed(entry.part)
  if (!state) return false
  const text = followingText(messages, entry)
  if (text.length === 0) return false
  for (const path of touchedPaths(entry.part)) {
    if (text.includes(path)) return true
  }
  const quotable = new Set<string>()
  for (const raw of state.output.split("\n")) {
    const line = stripLineNumber(raw).trim()
    if (line.length >= REFERENCE_MIN_LINE) quotable.add(line)
  }
  if (quotable.size === 0) return false
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line.length >= REFERENCE_MIN_LINE && quotable.has(line)) return true
  }
  return false
}

type State = {
  /** Every decision this session has taken. Monotonic — entries never leave. */
  readonly rewrites: Map<string, Rewrite>
  /** Parts that spent their one referenced-reprieve. */
  readonly reprieved: Set<string>
}

const store = new Map<string, State>()

/** Re-insert so iteration order is write order, then trim the front. */
function sessionState(sessionID: string): State {
  const existing = store.get(sessionID)
  if (existing) {
    store.delete(sessionID)
    store.set(sessionID, existing)
    return existing
  }
  const created: State = { rewrites: new Map(), reprieved: new Set() }
  store.set(sessionID, created)
  for (const key of store.keys()) {
    if (store.size <= LIMIT) break
    store.delete(key)
  }
  return created
}

/**
 * What to send instead of what is stored, for one step of one session.
 *
 * `boundary` false answers with the decisions already taken and takes none, so
 * the outgoing array is byte-identical to the previous step's. `enabled` false
 * answers with nothing and leaves the store untouched, so the kill switch
 * restores the old wire exactly. `batch` is a test seam; production passes none
 * and gets `BATCH`.
 */
export function plan(input: {
  readonly sessionID: string
  readonly messages: readonly SessionV1.WithParts[]
  readonly boundary: boolean
  readonly enabled?: boolean
  readonly batch?: number
}): Plan {
  if (input.enabled === false) return EMPTY_PLAN
  if (!input.boundary) {
    const held = store.get(input.sessionID)
    if (!held) return EMPTY_PLAN
    return { rewrites: held.rewrites, counts: EMPTY_COUNTS }
  }

  const state = sessionState(input.sessionID)
  const entries = flatten(input.messages)
  const results = entries.filter((entry) => entry.part.state.status === "completed")
  const tail = new Set(results.slice(-K).map((entry) => entry.part.id))

  // Later calls that make an earlier read stale, by file.
  const touches = new Map<string, { readonly verb: string; readonly step: number }[]>()
  for (const entry of results) {
    const verb = SUPERSEDING_VERBS.get(entry.part.tool)
    if (!verb) continue
    for (const path of touchedPaths(entry.part)) {
      const key = normalizePath(path)
      const list = touches.get(key)
      if (list) list.push({ verb, step: entry.step })
      else touches.set(key, [{ verb, step: entry.step }])
    }
  }

  /**
   * The LATEST call that made this read stale, not the first. The stub names a
   * step so the model finds the content there instead of re-reading, which only
   * works if that step still carries content: repeated reads supersede each
   * other in a chain, so naming the immediate successor points a stub at another
   * stub. The newest toucher is the only one nothing supersedes.
   */
  const supersederFor = (entry: Entry): Superseder | undefined => {
    if (entry.part.tool !== "read") return undefined
    let latest: Superseder | undefined
    for (const path of touchedPaths(entry.part)) {
      const list = touches.get(normalizePath(path))
      if (!list) continue
      for (const touch of list) {
        if (touch.step <= entry.step) continue
        if (latest === undefined || touch.step > latest.step) latest = touch
      }
    }
    return latest
  }

  // Taken into these first, and committed only if the batch is big enough.
  const fresh = new Map<string, Rewrite>()
  const reprieves: string[] = []
  let superseded = 0
  let kept = 0

  for (const entry of results) {
    // Monotonic: a decision taken is never re-taken, so its text cannot move.
    if (state.rewrites.has(entry.part.id)) continue

    // Stale by definition, so the tail does not protect it and neither does a
    // mention in the prose: what the prose refers to is not what is stored.
    const superseder = supersederFor(entry)
    if (!superseder && tail.has(entry.part.id)) {
      kept++
      continue
    }

    // A result carrying an image or a PDF is never aged: the stub replaces the
    // text and the attachments would go with it.
    const result = entry.part.state
    const carriesMedia = result.status === "completed" && (result.attachments?.length ?? 0) > 0
    const stub = ageable(entry.part.tool) && !carriesMedia ? stubText(entry.part, entry.step, superseder) : undefined

    // A stub that is not smaller loses twice: the wire grows, and it invites a
    // call for content that never existed (an empty `read`, a `grep` that
    // matched nothing), so the part is left alone. A superseded read is exempt
    // whatever it costs — those bytes are not redundant, they are wrong.
    const grew = stub !== undefined && result.status === "completed" && utf8(stub) >= utf8(result.output)
    const output = stub !== undefined && !superseder && grew ? undefined : stub
    const args = argumentRewrite(entry.part)
    if (output === undefined && args === undefined) {
      kept++
      continue
    }

    if (!superseder && !state.reprieved.has(entry.part.id) && referenced(input.messages, entry)) {
      reprieves.push(entry.part.id)
      kept++
      continue
    }

    fresh.set(entry.part.id, {
      ...(output === undefined ? {} : { output }),
      ...(args === undefined ? {} : { input: args }),
    })
    if (superseder) superseded++
  }

  // Too few to pay for the cache miss: send what was sent before. Nothing is
  // recorded, so a waiting result is decided again, from scratch, next time.
  // A boundary that rewrites nothing moves no byte, so it still spends its
  // reprieves as before.
  if (fresh.size > 0 && fresh.size < (input.batch ?? BATCH))
    return { rewrites: state.rewrites, counts: { aged: 0, superseded: 0, kept: kept + fresh.size } }

  for (const [id, rewrite] of fresh) state.rewrites.set(id, rewrite)
  for (const id of reprieves) state.reprieved.add(id)
  return { rewrites: state.rewrites, counts: { aged: fresh.size, superseded, kept } }
}

/** Test seam — the store is module state, so a test must be able to empty it. */
export function reset(): void {
  store.clear()
}

export * as SessionToolAging from "./tool-aging"
