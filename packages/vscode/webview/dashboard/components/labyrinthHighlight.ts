// WHICH PART OF THE MAP one spend chip is about.
//
// The strip's chips and the map are two views of ONE step list: a delegated
// chip is keyed by its branch's first step INDEX (`BranchUsage.first`), and an
// agent chip by the bucket name labyrinthUsage.ts sorted the same steps into.
// So "show me where this chip's work happened" needs no second model — it is
// the branch ledger and the `agent` field the totals were already summed from.
// A parallel one here is how a chip and the region it lights end up disagreeing
// about the run they are both describing.
//
// The answer is what to FADE, not what to light. An empty answer then means
// "nothing is hovered", which is exactly the ordinary map, so every caller asks
// one question — `has(...)` — with no null check and no inverted flag to get
// the wrong way round.
//
// Pure — no DOM. jsdom has no opacity to read, so the render tests assert this
// membership and the owner's eye judges the fade itself.

import { branchModel, type BranchStep } from './labyrinthBranches';

/** The part of a step this reads. `LayoutStep` and `UsageStep` satisfy it. */
export interface HighlightStep extends BranchStep {
  agent?: string;
}

/** What the pointer is on. `first` is a step INDEX, mirroring BranchUsage. */
export type HighlightTarget =
  | { kind: 'branch'; first: number }
  | { kind: 'agent'; agent: string };

export interface MapFade {
  /** Ordinals of the MARKERS to fade — thread, flight and corridor alike. */
  steps: ReadonlySet<number>;
  /**
   * `first` indices of the branch RAILS (thread) and SWIMLANES (flight) to
   * fade. Deliberately not read off the spawn's own marker: a `task` call is
   * the step of the thread that MADE it, so hovering that thread's agent chip
   * leaves the spawn lit while every step on the branch below it fades — and a
   * rail keyed on the spawn would then stay bright around faded work. A rail
   * follows the work ON it.
   */
  branches: ReadonlySet<number>;
}

const NOTHING: MapFade = { steps: new Set<number>(), branches: new Set<number>() };

/**
 * What to fade so the target's own work stands out.
 *
 * Two cases deliberately fade NOTHING rather than something:
 *  - a target no step matches (a chip whose branch the thresholds toggle took
 *    off the map). A map with every marker faded and none lit reads as "this
 *    run did none of that work", when the truth is that the chip and the drawn
 *    steps are looking at different lists.
 *  - a target that matches EVERY step — one agent that ran the whole run. A
 *    highlight that highlights everything says nothing, and paying for it in
 *    contrast is worse than not drawing it.
 */
export function mapFade(steps: readonly HighlightStep[], target: HighlightTarget | null): MapFade {
  if (!target || steps.length === 0) return NOTHING;
  const { host, spans } = branchModel(steps);
  // The spawn is the head of the branch it opened, so a BRANCH chip lights it
  // even though `host` attributes its usage to the thread that made the call.
  const branch = target.kind === 'branch' ? target.first : null;
  const agent = target.kind === 'agent' ? target.agent : null;
  const mine = (step: HighlightStep, i: number): boolean =>
    branch === null ? (step.agent || 'unknown') === agent : host[i] === branch || i === branch;
  const lit = new Set(steps.filter(mine).map((s) => s.ordinal));
  if (lit.size === 0 || lit.size === steps.length) return NOTHING;

  // One pass: which branches still have a LIT step of their own on them.
  const litHosts = new Set<number>();
  const hasOwn = new Set<number>();
  steps.forEach((s, i) => {
    const h = host[i]!;
    if (h < 0) return;
    hasOwn.add(h);
    if (lit.has(s.ordinal)) litHosts.add(h);
  });
  const branches = new Set<number>();
  for (const span of spans) {
    // A branch with no steps of its own (a delegated run nobody expanded) has
    // only its spawn to go on, which is the honest best available.
    const anyLit = hasOwn.has(span.first)
      ? litHosts.has(span.first)
      : lit.has(steps[span.first]?.ordinal ?? -1);
    if (!anyLit) branches.add(span.first);
  }
  return { steps: new Set(steps.filter((s) => !lit.has(s.ordinal)).map((s) => s.ordinal)), branches };
}
