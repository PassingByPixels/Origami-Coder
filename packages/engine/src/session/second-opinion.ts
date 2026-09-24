import { SessionV1 } from "@origami/core/v1/session"

/**
 * The SECOND OPINION digest: one chat turn, rendered as a review brief for a
 * DIFFERENT model than the one that did the work. Pure — a projection of stored
 * session truth into a string, assertable with no engine, LLM or session store.
 *
 * NOT compaction: compaction summarises so the SAME model can keep working, so
 * the tool calls and diffs are the first thing it throws away. Here they are the
 * payload, because the reviewing model never saw the turn.
 */

/** The review instruction, with `{currentModelLabel}` the only substitution. A
 *  CONSTANT so it can be grepped in a built engine binary
 *  (docs/WORKING_ON_ORIGAMI_CODER.md Part 8); a `.replace` chain cannot be. */
export const PREAMBLE_TEMPLATE =
  "You are giving a second opinion for the user on work another AI model ({currentModelLabel}) just completed in this chat. Review that work critically: what is correct, what is wrong, what is missing, and what you would have done differently. Do not assume the work is right because it reads confidently. You cannot edit files or run tools — deliver your assessment as an answer to the user. End with a clear verdict line: AGREE (the work stands), CONCERNS (name them), or DISAGREE (say what should happen instead), plus the single next step you would take if this chat were handed to you."

export function preamble(currentModelLabel: string): string {
  const label = currentModelLabel.trim()
  return PREAMBLE_TEMPLATE.replace("{currentModelLabel}", label || "another model")
}

/** Per-section character caps. Chars, not tokens: the digest is assembled before
 *  any model is resolved, and a char cap needs no tokeniser to be exact. */
export const USER_CAP = 4_000
export const ASSISTANT_CAP = 6_000
export const DIFF_CAP = 8_000
export const PRIOR_CAP = 3_000
/** One tool line's input summary and result gist. Small on purpose: the LIST of
 *  what ran is the signal; a reviewer who wants the bytes asks for the file. */
const TOOL_INPUT_CAP = 200
const TOOL_RESULT_CAP = 240

/**
 * What is dropped to fit a context window, in order — what a reviewer loses
 * least by losing. `diffs` first (biggest by an order of magnitude, and the
 * paths survive it), then `toolResults` (gists go, names and inputs stay), then
 * `priorContext`, which is already the most compressed thing here and is what
 * stops the reviewer misreading the turn's intent.
 */
export type TrimStep = "diffs" | "toolResults" | "priorContext"

export type DigestInput = {
  /** The session's stored messages, oldest first — `session.messages` order. */
  readonly history: readonly SessionV1.WithParts[]
  readonly currentModelLabel: string
  /** Character ceiling for the whole prompt; omitted or 0 = no ceiling. The
   *  caller derives it from the reviewing model's context window, so this module
   *  stays pure. */
  readonly budget?: number
}

export type Digest = {
  readonly prompt: string
  /** Sections dropped to fit `budget`, empty when nothing had to go. Reported so
   *  the caller can say so rather than quietly shipping a thinner brief. */
  readonly trimmed: readonly TrimStep[]
}

type Assistant = SessionV1.WithParts & { info: SessionV1.Assistant }
type ToolPart = SessionV1.ToolPart

type Turn = {
  readonly index: number
  readonly user: SessionV1.WithParts
  readonly rest: readonly SessionV1.WithParts[]
}

/** Text a HUMAN or a model actually wrote. `synthetic` parts are engine
 *  bookkeeping and `ignored` ones were kept off the reader's screen — neither
 *  was said, so neither belongs in a transcript handed to a reviewer. */
function spokenText(message: SessionV1.WithParts): string {
  return message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

const TRUNCATED = "\n[…truncated]"
const OMITTED = "[…earlier context omitted]\n"

/**
 * Cut on code points so a truncation never splits a surrogate pair. The marker
 * is paid for OUT OF the limit, not added on top, which is what makes
 * `cap(x, n).length <= n` true for every input — the diff budget below is a
 * running sum of capped strings, so a marker charged on top would overrun the
 * bound once per file.
 */
function cap(text: string, limit: number): string {
  const points = Array.from(text)
  if (points.length <= limit) return text
  const keep = Math.max(0, limit - Array.from(TRUNCATED).length)
  return `${points.slice(0, keep).join("")}${TRUNCATED}`
}

/** The same cut for a value that must stay on ONE line, where a `\n[…truncated]`
 *  marker would break the line it was measured to fit. */
function capInline(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length <= limit ? text : `${points.slice(0, limit).join("")} …`
}

/** The TAIL of a long block, not its head: the end of a conversation is what
 *  bears on the turn being reviewed. Used for prior context only. */
function capTail(text: string, limit: number): string {
  const points = Array.from(text)
  if (points.length <= limit) return text
  const keep = Math.max(0, limit - Array.from(OMITTED).length)
  return `${OMITTED}${points.slice(points.length - keep).join("")}`
}

function firstLine(text: string, limit: number): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? ""
  return capInline(line.trim(), limit)
}

/**
 * Every turn boundary in the history. A user message with a `compaction` part is
 * NOT a turn — it is the engine asking for a summary, not the user asking for
 * work, and leaving it in would offer a compaction run as "the last thing you
 * did". Same exclusion session/compaction.ts's own `turns()` makes.
 */
function turns(history: readonly SessionV1.WithParts[]): Turn[] {
  const starts: number[] = []
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    starts.push(i)
  }
  return starts.map((start, n) => ({
    index: start,
    user: history[start]!,
    rest: history.slice(start + 1, starts[n + 1] ?? history.length),
  }))
}

function assistants(turn: Turn): Assistant[] {
  return turn.rest.filter((m): m is Assistant => m.info.role === "assistant")
}

/**
 * Has this turn STOPPED? `time.completed` on the last assistant message is the
 * engine's own test — session/prompt.ts stamps it on every exit including failed
 * ones. An error counts as settled: a turn that died to a rate limit is finished
 * work with a bad outcome, and exactly the kind a user asks about. Ambiguous
 * cases resolve toward "still running", so a live turn is never handed out.
 */
function settled(turn: Turn): boolean {
  const list = assistants(turn)
  const last = list[list.length - 1]
  if (!last) return false
  if (last.info.error) return true
  return last.info.time.completed !== undefined
}

/** The most recent turn that has stopped. Walked BACKWARDS: with a turn in
 *  flight the one before it is still worth reviewing, and refusing there would
 *  make the feature unavailable exactly when a user distrusts a turn. */
function lastCompletedTurn(history: readonly SessionV1.WithParts[]): Turn | undefined {
  const all = turns(history)
  for (let i = all.length - 1; i >= 0; i--) if (settled(all[i]!)) return all[i]
  return undefined
}

function toolParts(turn: Turn): ToolPart[] {
  return assistants(turn).flatMap((m) => m.parts.filter((p): p is ToolPart => p.type === "tool"))
}

/** The tool's arguments as ONE line. JSON rather than a per-tool pretty printer,
 *  which would be a second, drifting copy of acp/tool.ts's titles. */
function inputSummary(input: unknown): string {
  if (input === undefined || input === null) return ""
  let text: string
  try {
    text = typeof input === "string" ? input : JSON.stringify(input)
  } catch {
    text = String(input)
  }
  return capInline((text ?? "").replace(/\s+/g, " ").trim(), TOOL_INPUT_CAP)
}

function resultGist(part: ToolPart): string {
  const state = part.state
  if (state.status === "completed") {
    const gist = firstLine(state.output ?? "", TOOL_RESULT_CAP)
    return gist || state.title || "(no output)"
  }
  if (state.status === "error") return `ERROR: ${firstLine(state.error ?? "", TOOL_RESULT_CAP)}`
  return "(did not finish)"
}

type FileChange = { readonly path: string; readonly diff: string }

/** A completed edit/write tool carries its unified diff on the part's metadata
 *  (`filediff.patch`, or the older `metadata.diff`). PatchPart carries PATHS
 *  ONLY, so a path can appear here with no diff and the renderer must survive
 *  that rather than print an empty fence. */
function fileChanges(turn: Turn): FileChange[] {
  const out: FileChange[] = []
  // NO dedupe across tool calls: two edits to the SAME file in one turn are two
  // real changes and a reviewer needs both. Only a PatchPart path already
  // covered by a diff is skipped below — that one really is counted twice.
  const add = (path: string, diff: string) => out.push({ path, diff })
  for (const part of toolParts(turn)) {
    if (part.state.status !== "completed") continue
    const metadata = (part.state.metadata ?? {}) as {
      diff?: unknown
      filediff?: { file?: unknown; patch?: unknown }
    }
    const patch = typeof metadata.filediff?.patch === "string" ? metadata.filediff.patch : undefined
    const diff = patch ?? (typeof metadata.diff === "string" ? metadata.diff : undefined)
    if (!diff) continue
    const named = typeof metadata.filediff?.file === "string" ? metadata.filediff.file : undefined
    const input = part.state.input as { filePath?: unknown; path?: unknown }
    const path =
      named ??
      (typeof input?.filePath === "string" ? input.filePath : undefined) ??
      (typeof input?.path === "string" ? input.path : undefined) ??
      part.state.title ??
      part.tool
    add(path, diff)
  }
  for (const message of assistants(turn)) {
    for (const part of message.parts) {
      if (part.type !== "patch") continue
      for (const file of part.files) if (!out.some((c) => c.path === file)) add(file, "")
    }
  }
  return out
}

/** Everything the reviewer should know that is NOT this turn: the latest
 *  compaction SUMMARY when there is one, since that is already the engine's
 *  carried-forward digest; otherwise the earlier turns, TAIL first. */
function priorContext(history: readonly SessionV1.WithParts[], turn: Turn): string {
  const summary = latestCompactionSummary(history, turn.index)
  if (summary) return capTail(summary, PRIOR_CAP)
  const lines: string[] = []
  for (const message of history.slice(0, turn.index)) {
    const text = spokenText(message)
    if (!text) continue
    lines.push(`[${message.info.role === "user" ? "User" : "Assistant"}]: ${text}`)
  }
  return capTail(lines.join("\n"), PRIOR_CAP)
}

/** The summary of the newest compaction BEFORE this turn: an assistant message
 *  flagged `summary` whose `parentID` is the compaction user message — the same
 *  join session/compaction.ts's `completedCompactions` makes. */
function latestCompactionSummary(history: readonly SessionV1.WithParts[], before: number): string {
  const compactionIds = new Set(
    history
      .slice(0, before)
      .filter((m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"))
      .map((m) => m.info.id),
  )
  if (compactionIds.size === 0) return ""
  for (let i = before - 1; i >= 0; i--) {
    const message = history[i]!
    if (message.info.role !== "assistant") continue
    if (!message.info.summary) continue
    if (!compactionIds.has(message.info.parentID)) continue
    const text = spokenText(message)
    if (text) return text
  }
  return ""
}

type Sections = {
  readonly preamble: string
  readonly prior: string
  readonly request: string
  readonly answer: string
  readonly tools: ReadonlyArray<{ readonly head: string; readonly gist: string }>
  readonly changes: readonly FileChange[]
}

type Flags = { readonly diffs: boolean; readonly toolResults: boolean; readonly prior: boolean }

/** Render the assembled sections at one trim level. Re-rendering rather than
 *  string-surgery is what makes the trim ORDER testable. */
function render(sections: Sections, flags: Flags): string {
  const out: string[] = [sections.preamble]
  if (flags.prior && sections.prior) out.push(`## Earlier in this chat\n${sections.prior}`)
  out.push(`## What the user asked for\n${sections.request || "(the user's message carried no text)"}`)
  out.push(`## What the other model answered\n${sections.answer || "(it produced no prose, only tool calls)"}`)
  if (sections.tools.length > 0) {
    const lines = sections.tools.map((t) => (flags.toolResults ? `${t.head}\n    -> ${t.gist}` : t.head))
    out.push(`## Tools it ran (${sections.tools.length})\n${lines.join("\n")}`)
  }
  if (sections.changes.length > 0) {
    out.push(`## Files it changed (${sections.changes.length})\n${renderChanges(sections.changes, flags.diffs)}`)
  }
  return out.join("\n\n")
}

/** Paths always; diffs only while there is room, up to DIFF_CAP characters IN
 *  TOTAL — a per-file cap would let ten files past a bound written for one. */
function renderChanges(changes: readonly FileChange[], withDiffs: boolean): string {
  if (!withDiffs) return changes.map((c) => `- ${c.path}`).join("\n")
  const out: string[] = []
  let spent = 0
  for (const change of changes) {
    if (!change.diff) {
      out.push(`- ${change.path}`)
      continue
    }
    const room = DIFF_CAP - spent
    if (room <= 0) {
      out.push(`- ${change.path}\n  (diff omitted — the ${DIFF_CAP}-character diff budget was already spent)`)
      continue
    }
    const body = cap(change.diff, room)
    spent += Array.from(body).length
    out.push(`- ${change.path}\n\`\`\`diff\n${body}\n\`\`\``)
  }
  return out.join("\n")
}

/**
 * The review brief for the last completed turn, or `undefined` when the session
 * has none. `undefined` rather than an empty brief on purpose: a reviewer handed
 * "here is the work" with no work in it answers anyway, and that answer reads as
 * a verdict on the session. The caller must refuse instead.
 */
export function buildDigest(input: DigestInput): Digest | undefined {
  const turn = lastCompletedTurn(input.history)
  if (!turn) return undefined

  const tools = toolParts(turn).map((part) => ({
    head: `- ${part.tool}(${inputSummary(part.state.input)})`,
    gist: resultGist(part),
  }))
  const sections: Sections = {
    preamble: preamble(input.currentModelLabel),
    prior: priorContext(input.history, turn),
    request: cap(spokenText(turn.user), USER_CAP),
    answer: cap(assistants(turn).map(spokenText).filter(Boolean).join("\n\n"), ASSISTANT_CAP),
    tools,
    changes: fileChanges(turn),
  }

  const budget = input.budget ?? 0
  const ladder: ReadonlyArray<{ flags: Flags; dropped: TrimStep[] }> = [
    { flags: { diffs: true, toolResults: true, prior: true }, dropped: [] },
    { flags: { diffs: false, toolResults: true, prior: true }, dropped: ["diffs"] },
    { flags: { diffs: false, toolResults: false, prior: true }, dropped: ["diffs", "toolResults"] },
    { flags: { diffs: false, toolResults: false, prior: false }, dropped: ["diffs", "toolResults", "priorContext"] },
  ]
  let last = ladder[0]!
  for (const step of ladder) {
    last = step
    const prompt = render(sections, step.flags)
    if (budget <= 0 || prompt.length <= budget) return { prompt, trimmed: step.dropped }
  }
  // Every section dropped and still over: request and answer alone exceed the
  // budget. They are what this feature exists to show, so ship them anyway — the
  // model's own context error beats a brief with the work cut out of it.
  return { prompt: render(sections, last.flags), trimmed: last.dropped }
}

export * as SecondOpinion from "./second-opinion"
