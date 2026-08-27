// WHEN a delegated run actually happened — the timing truth a branch is drawn
// from. Extracted from labyrinthBranches.ts (at its architecture cap) once the
// thread rails and the flight strip both needed the same three answers: did
// this sub-agent detach, did it come back, and when.
//
// Background sub-agents are the DEFAULT now. The parent's turn ends, the user
// keeps talking, and the child reports back minutes later. `run_steps` still
// expands a child's steps inline immediately after its spawn (engine
// `collect`), and that ordering is not changing — so LIST ORDER on its own
// says every branch finished the instant it was spawned, which for a detached
// run is simply false. Only the clock can correct it.
//
// So every rule here is gated on a finite timestamp and degrades to list order
// without one. A span is NEVER inferred from `background` alone: that flag says
// a task detached, not when it returned. The engine emits it only when true
// (run-steps.ts `toolStep`: `...(detached ? { background: true } : {})`), so
// ABSENT means "this build did not say" — it does not mean foreground.

/** The part of a step the span rules read. `LayoutStep` satisfies it. */
export interface SpanStep {
  kind: 'prompt' | 'reply' | 'tool' | 'thinking' | 'subagent' | 'error';
  status?: 'completed' | 'error' | 'running' | 'pending';
  /** OPTIONAL — true when the spawn DETACHED instead of blocking the turn. */
  background?: boolean;
  startedAt?: number;
  endedAt?: number;
}

/** A timestamp we can actually place on an axis; anything else is unusable. */
export function finiteTime(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * TRI-STATE on purpose: true / false / undefined = "the engine did not say".
 *
 * An older engine binary sends no `background` at all, and this engine omits it
 * on a foreground spawn, so absent covers BOTH. Reading absent as "foreground"
 * would put a fact on screen the run never recorded, which is the exact class
 * of lie this view exists to avoid — callers must render nothing for undefined.
 */
export function spanBackground(head: SpanStep | undefined): boolean | undefined {
  if (!head || head.kind !== 'subagent') return undefined;
  return typeof head.background === 'boolean' ? head.background : undefined;
}

/**
 * A sub-agent that had NOT reported back when the run was captured.
 *
 * `status: 'running'` says so outright — and the engine sets exactly that for a
 * detached spawn it found no completion for (run-steps.ts `project` only
 * stitches `endedAt` on from an injected `<task_result>`). A background spawn
 * with no `endedAt` says the same thing by omission, which is the fallback for
 * a build that reports the flag but not the status. A SETTLED status outranks
 * that omission: a completed step that merely carries no clock is finished, not
 * in flight.
 */
export function spanIsOpen(head: SpanStep | undefined): boolean {
  if (!head || head.kind !== 'subagent') return false;
  if (head.status === 'running') return true;
  if (head.status === 'completed' || head.status === 'error') return false;
  return head.background === true && finiteTime(head.endedAt) === undefined;
}

/**
 * The step index the branch opened at `first` should MERGE back at.
 *
 * Defaults to `last` — today's behaviour, closing straight after the branch's
 * own final step. It moves LATER only when the spawn carries a real `endedAt`
 * and the steps that follow carry real `startedAt`s proving they began before
 * the child returned. Those steps then read as running ALONGSIDE the branch
 * rather than after it, which is the whole point.
 *
 * Note this is driven by the clock, not by `background`: a blocking sub-agent's
 * end necessarily precedes the next step's start, so the same rule merges it
 * immediately. That is why span truth still works on a build that sends no
 * `background` flag at all.
 *
 * The walk STOPS at the first step it cannot place in time instead of skipping
 * it. A gap in the clock is not evidence of overlap, and stepping over one to
 * reach a later timestamp would claim a span the run never proved.
 */
export function mergeIndex(steps: readonly SpanStep[], first: number, last: number): number {
  const head = steps[first];
  const end = head?.kind === 'subagent' ? finiteTime(head.endedAt) : undefined;
  if (end === undefined) return last;
  let merge = last;
  for (let i = last + 1; i < steps.length; i++) {
    const started = finiteTime(steps[i]!.startedAt);
    if (started === undefined || started >= end) break;
    merge = i;
  }
  return merge;
}
