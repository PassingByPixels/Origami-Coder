import { Semaphore } from "effect"

/**
 * The contract for the synthetic turn a finished BACKGROUND sub-agent injects
 * into its parent session (tool/task.ts `drain`) — the only thing that tells a
 * client "that child is done". The launcher `task` call returns when the child
 * is SPAWNED, so its tool card completes while the child still works; the real
 * completion arrives later as this turn, whose text is an XML-ish
 * `<task_result>` blob meant for the MODEL, and stamping the part keeps the
 * machine-readable answer out of that prose. A LIST, because the drainer folds
 * every sibling finishing in one turn into ONE injected turn.
 */

/** Key on the injected text part's `metadata`. */
export const TASK_RESULTS_KEY = "origami_task_results"

/**
 * t-dcl8fe. Key on the `task` tool call's own METADATA carrying what the child
 * has spent so far. The drawer and the map need a per-child figure and there
 * was none on the wire: the parent's message-level totals are the PARENT's, and
 * a child session's spend was only reachable by reading its whole transcript.
 *
 * Every member is a plain number, never null - a client rendering a pill
 * must not have to decide what a null member means. `steps` alone may be
 * ABSENT (t-ucndru): a child row the steps backfill has not reached yet.
 *
 * t-f6vig2. THE KEY ITSELF IS THE OPTIONAL PART. An all-zero object used to
 * ride the launcher call from the moment the child was SPAWNED, and the drawer
 * printed it as "0 / 0" for the whole run - a claim that the agent spent
 * nothing, which is a different fact from "nobody has told us yet". Nothing
 * measured means NO KEY: the client's reader is fail-open (vscode
 * acpTaskTokens.ts) and draws an absent rider as blank. Zeros also OVERWRITE a
 * real figure, because every later tool_call_update for the launcher re-sends
 * whatever the call's metadata holds.
 */
export const TASK_TOKENS_KEY = "origami_task_tokens"

/**
 * t-ffziaz. `steps` and `context` are what stop a SUM being read as a context
 * size. Every other member here is additive over the child's whole run, so
 * `input` of a 9-step child is ~180k while the window it filled never passed
 * 20k; `context` is that last step, and `steps` is what divides the two.
 */
export type TaskTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  /** Absent = not counted yet (the session row's `steps` is still NULL). */
  steps?: number
  /** Absent = not known: the child's newest message measured no step (t-ucndru). */
  context?: number
}

/** The fields of a session ROW a rider is built from: the engine's
 *  `Session.Info`, or the SDK's `Session`, whose type lags the `steps` column. */
export type TaskTokensRow = {
  readonly cost?: number
  readonly tokens?: {
    readonly input?: number
    readonly output?: number
    readonly reasoning?: number
    readonly cache?: { readonly read?: number; readonly write?: number }
  }
}

/**
 * t-ucndru. A child's rider from its session ROW, without its `context`.
 *
 * The row holds the running sums the projector keeps from the same
 * step-finish parts `RunStats.stat` adds up, and `steps` by the same rule, so
 * this is the old figure without a read of the child's transcript. `context`
 * is one step's figure, not a sum, and is not on the row: the caller adds it
 * (plan 5.3). `steps` is read structurally and left OUT while the row has no
 * count: 0 would claim one. `undefined` when nothing was measured yet, by the
 * `taskTokensMeasured` rule.
 */
export function taskTokensFromRow(row: TaskTokensRow): Omit<TaskTokens, "context"> | undefined {
  const steps = (row as { steps?: unknown }).steps
  const spend = {
    input: row.tokens?.input ?? 0,
    output: row.tokens?.output ?? 0,
    reasoning: row.tokens?.reasoning ?? 0,
    cacheRead: row.tokens?.cache?.read ?? 0,
    cacheWrite: row.tokens?.cache?.write ?? 0,
    cost: row.cost ?? 0,
    ...(typeof steps === "number" && Number.isFinite(steps) && steps >= 0 ? { steps } : {}),
  }
  return taskTokensMeasured(spend) ? spend : undefined
}

/** The rider, or NOTHING when the child has not been billed yet. Spread into a
 *  metadata object so the absent case is a missing key, not a null. */
export function taskTokensMetadata(tokens: TaskTokens | undefined) {
  return tokens === undefined ? {} : { [TASK_TOKENS_KEY]: tokens }
}

/**
 * t-f6vig2. Does this total say anything?
 *
 * "Summed over the stored messages" is NOT the same as "billed": an assistant
 * message is written with a ZEROED `tokens` object the moment the turn starts
 * (session/processor.ts), and every reader that sums those messages - the run
 * index, the launcher's own refresh, the live rider - therefore reports a
 * perfectly well-formed 0/0 for a child that has not been billed once. A real
 * round trip always costs input, so an all-zero total is "created, not billed",
 * and posting it prints "0 / 0" over whatever the client last had.
 */
export function taskTokensMeasured(tokens: Pick<TaskTokens, "input" | "output">) {
  return tokens.input > 0 || tokens.output > 0
}

export type TaskResultState = "completed" | "error"

export type TaskResultEntry = {
  /** The sub-agent SESSION id — the same id `_meta.origami_task_session` rides
   *  on the launcher's tool updates, which is how a client joins the two. */
  sessionId: string
  state: TaskResultState
}

/** The part `metadata` object carrying these entries. */
export function taskResultsMetadata(entries: readonly TaskResultEntry[]) {
  return { [TASK_RESULTS_KEY]: entries.map((entry) => ({ sessionId: entry.sessionId, state: entry.state })) }
}

/** The entries carried by a part's metadata, or `[]` for every other part.
 *  Fail-closed: a malformed entry is dropped rather than guessed at, because
 *  guessing would retire a live row and stop anybody watching that child. */
export function taskResults(metadata: unknown): TaskResultEntry[] {
  if (!metadata || typeof metadata !== "object") return []
  const raw = (metadata as Record<string, unknown>)[TASK_RESULTS_KEY]
  if (!Array.isArray(raw)) return []
  const entries: TaskResultEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const { sessionId, state } = item as { sessionId?: unknown; state?: unknown }
    if (typeof sessionId !== "string" || !sessionId) continue
    if (state !== "completed" && state !== "error") continue
    entries.push({ sessionId, state })
  }
  return entries
}

// --- the queue of finished results waiting for their parent's next turn ---
//
// State, not schema, but it lives HERE with the contract it serves: it is
// PROCESS-GLOBAL (one map for every parent session in the instance) and
// session/session.ts must be able to clear a deleted session's entries
// (`forget`) without importing tool/task.ts, which imports session.ts.

/** One finished child's result, waiting to be written into its parent.
 *  `redelivered` marks a result already written once and re-queued because no
 *  turn read it; a re-delivery never arms another. */
export type PendingResult = { text: string; entry: TaskResultEntry; redelivered?: boolean }

// Serializes background-result injections per PARENT session: sub-agents
// finishing in the same window would otherwise append their <task_result> user
// turns in a racy order and coalesce into one scrambled parent turn.
const injectLocks = new Map<string, Semaphore.Semaphore>()

const pendingResults = new Map<string, PendingResult[]>()
const draining = new Set<string>()

export function injectLock(parentSessionID: string) {
  const hit = injectLocks.get(parentSessionID)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  injectLocks.set(parentSessionID, next)
  return next
}

export function enqueueResult(parentSessionID: string, result: PendingResult) {
  const queue = pendingResults.get(parentSessionID)
  if (queue) queue.push(result)
  else pendingResults.set(parentSessionID, [result])
}

/** Put a batch that was written but never READ back at the FRONT of the queue:
 *  it is older than anything queued since, and the drainer writes in order. */
export function requeueResults(parentSessionID: string, batch: PendingResult[]) {
  const queue = pendingResults.get(parentSessionID)
  if (queue) queue.unshift(...batch)
  else pendingResults.set(parentSessionID, batch.slice())
}

export function claimDrainer(parentSessionID: string) {
  if (draining.has(parentSessionID)) return false
  draining.add(parentSessionID)
  return true
}

/** The batch to write next, as a SNAPSHOT. Peek, not take: nothing leaves the
 *  queue until a write has actually landed (`dropResults`). The copy matters
 *  because siblings keep pushing onto the SAME array while the write is in
 *  flight; it holds the same object references, which is what lets
 *  `dropResults` find them again. */
export function peekResults(parentSessionID: string): PendingResult[] {
  return (pendingResults.get(parentSessionID) ?? []).slice()
}

/** Remove exactly the results just written, BY IDENTITY. `requeueResults` puts
 *  an unread batch back at the FRONT, so a positional drop would let one
 *  drainer splice off a batch another had re-queued and never written. */
export function dropResults(parentSessionID: string, batch: PendingResult[]) {
  const queue = pendingResults.get(parentSessionID)
  if (!queue) return
  for (const item of batch) {
    const at = queue.indexOf(item)
    if (at >= 0) queue.splice(at, 1)
  }
  if (queue.length === 0) pendingResults.delete(parentSessionID)
}

/** Give up the drainer claim. It must NOT drop queued results: it runs from
 *  `Effect.ensuring`, so a defect in the drain loop would take every waiting
 *  result with it, and left in place the next sibling picks them up. The
 *  parent's inject lock goes when nothing is left to serialize - one semaphore
 *  per parent kept for the life of the process is a leak, not a cache. */
export function releaseDrainer(parentSessionID: string) {
  draining.delete(parentSessionID)
  if (pendingResults.get(parentSessionID)?.length) return
  pendingResults.delete(parentSessionID)
  injectLocks.delete(parentSessionID)
}

/**
 * t-dcl8fe. Drop everything held for a parent session that no longer exists.
 *
 * Nothing used to clear these three maps on a session DELETE. A result queued
 * for a parent that was removed can never be written - `ops.prompt` has no
 * session to write into - so after the bounded delivery retries it sat in the
 * map for the life of the process, with the drainer claim and the semaphore
 * beside it. Called from Session.remove, which also removes the children.
 */
export function forget(parentSessionID: string) {
  pendingResults.delete(parentSessionID)
  draining.delete(parentSessionID)
  injectLocks.delete(parentSessionID)
}

/** How many results are queued for a parent. For tests and diagnostics. */
export function queuedResults(parentSessionID: string) {
  return pendingResults.get(parentSessionID)?.length ?? 0
}

/** origami_change (t-w2qlop): the parent sessions with a finished result still
 *  waiting to be written. Read by the elastic idle report: stopping the engine
 *  now would lose these, because the queue lives only in this process. */
export function parentsWithResults(): string[] {
  return [...pendingResults.entries()].filter(([, queue]) => queue.length > 0).map(([parent]) => parent)
}
