// Which part of the map one spend chip is about.
//
// Chips and the map are two views of one step list: a delegated chip is
// keyed by its branch's first step index, an agent chip by the bucket
// labyrinthUsage.ts sorted steps into.
// The answer is what to fade, not light: an empty answer means nothing
// is hovered. Pure, no DOM: jsdom has no opacity to read, so render
// tests assert membership and the owner's eye judges the fade itself.

import { branchModel, type BranchStep } from './labyrinthBranches';
import { toolCategory, type Category } from './labyrinthCategory';
import { isThreshold } from './labyrinthLanes';

/** The part of a step this reads. `LayoutStep` and `UsageStep` satisfy it. */
export interface HighlightStep extends BranchStep {
  agent?: string;
  /** Read only by the `category` target; absent is a category of its own. */
  tool?: string;
}

/**
 * What the pointer is on. `first` is a step index, mirroring BranchUsage.
 * `category`/`errors` target the analytics Flight view's bars and pills,
 * which point at the same chart the spend chips point at — a second
 * highlight model there would let two models of one run disagree.
 */
export type HighlightTarget =
  | { kind: 'branch'; first: number }
  | { kind: 'agent'; agent: string }
  | { kind: 'category'; category: Category }
  | { kind: 'errors' };

export interface MapFade {
  /** Ordinals of the MARKERS to fade — thread, flight and corridor alike. */
  steps: ReadonlySet<number>;
  /**
   * `first` indices of branch rails (thread) and swimlanes (flight) to
   * fade. Not read off the spawn's own marker: a `task` call is the step
   * of the thread that made it, so a rail keyed on the spawn would stay
   * bright while the branch below it fades. A rail follows the work on it.
   */
  branches: ReadonlySet<number>;
}

const NOTHING: MapFade = { steps: new Set<number>(), branches: new Set<number>() };

/**
 * What to fade so the target's own work stands out. Two cases fade
 * nothing rather than something: a target no step matches (its branch
 * left the map), where fading everything would read as "did none of
 * this work" instead of "different lists"; and a target matching every
 * step, where highlighting everything says nothing and costs contrast.
 */
export function mapFade(steps: readonly HighlightStep[], target: HighlightTarget | null): MapFade {
  if (!target || steps.length === 0) return NOTHING;
  const { host, spans } = branchModel(steps);
  // The spawn is the head of the branch it opened, so a BRANCH chip lights it
  // even though `host` attributes its usage to the thread that made the call.
  const mine = (step: HighlightStep, i: number): boolean => {
    if (target.kind === 'branch') return host[i] === target.first || i === target.first;
    if (target.kind === 'agent') return (step.agent || 'unknown') === target.agent;
    if (target.kind === 'category') return toolCategory(step) === target.category;
    return isThreshold(step);
  };
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
