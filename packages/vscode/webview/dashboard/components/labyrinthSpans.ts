// When a delegated run actually happened: the timing truth a branch is
// drawn from. Extracted from labyrinthBranches.ts once the thread rails and
// flight strip both needed the same three answers: did this sub-agent
// detach, did it come back, and when.
//
// Background sub-agents are the default now: the parent's turn ends, the
// user keeps talking, and the child reports back minutes later. `run_steps`
// still expands a child's steps inline immediately after its spawn, so list
// order alone says every branch finished the instant it was spawned, which
// for a detached run is false. Only the clock can correct it.
//
// So every rule here is gated on a finite timestamp and degrades to list
// order without one. A span is never inferred from `background` alone: that
// flag says a task detached, not when it returned, and absent means "this
// build didn't say", not "foreground".

/** The part of a step the span rules read. `LayoutStep` satisfies it. */
export interface SpanStep {
  kind: 'prompt' | 'reply' | 'tool' | 'thinking' | 'subagent' | 'compaction' | 'error';
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

/** Tri-state on purpose: true/false/undefined = "the engine did not say".
 *  Absent covers both an older engine and a foreground spawn; reading it as
 *  "foreground" would put a fact on screen the run never recorded. */
export function spanBackground(head: SpanStep | undefined): boolean | undefined {
  if (!head || head.kind !== 'subagent') return undefined;
  return typeof head.background === 'boolean' ? head.background : undefined;
}

/** A sub-agent that hadn't reported back when the run was captured.
 *  `status: 'running'` says so outright; a background spawn with no
 *  `endedAt` says it by omission, the fallback for a build that reports the
 *  flag but not the status. A settled status outranks that omission. */
export function spanIsOpen(head: SpanStep | undefined): boolean {
  if (!head || head.kind !== 'subagent') return false;
  if (head.status === 'running') return true;
  if (head.status === 'completed' || head.status === 'error') return false;
  return head.background === true && finiteTime(head.endedAt) === undefined;
}

/** The step index the branch opened at `first` should merge back at.
 *  Defaults to `last`, moving later only when the spawn carries a real
 *  `endedAt` and the following steps carry real `startedAt`s proving they
 *  began before the child returned — those then read as running alongside
 *  the branch. Driven by the clock, not `background`. The walk stops at the
 *  first step it can't place in time rather than skipping it, since a gap
 *  is not evidence of overlap. */
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
