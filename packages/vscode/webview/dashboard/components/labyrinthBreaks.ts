// WHERE THE RUN CHANGED MODEL, along the thread it is drawn on.
//
// LabyrinthSpendModels.svelte already says HOW MANY times a run changed hands.
// What a count cannot say is where: which half of the map is the old model's
// work and which is the new one's. That is what a break is — a rule across the
// run's own axis, labelled with the model that starts at it.
//
// TRUNK ONLY, and this is the whole honesty rule of the file. `run_steps`
// inlines a delegated child's steps straight after the spawn that made them,
// and a sub-agent commonly runs on a different model from its parent. Walking
// every step would therefore report a change into every delegation and another
// back out of it — churn that says nothing about the session being read, and
// that a reader has no way to check from the map. The steps the trunk itself
// produced are the ones whose model is this run's, and labyrinthBranches.ts
// already names them: host === -1. A sub-agent's own switches belong to that
// sub-agent's own map, which its spend chip opens.
//
// A step whose message recorded NO model is SKIPPED rather than read as a
// model of its own: an older payload carries none at all, and treating absent
// as a value reports a change into "unknown" and another back out — the same
// invented pair, from the other direction.
//
// List order is run order (`run_steps` sends it that way and every filter above
// preserves it), and it is read as given rather than re-sorted, because the
// branch ledger this rides on is indexed by position.
//
// Pure — no DOM — like labyrinthCost.ts beside it, whose `modelCutovers` counts
// the same switches for the STRIP. The two differ deliberately: a count over
// billed requests is right for a total, and this is right for a picture.

import { branchModel, type BranchStep } from './labyrinthBranches';
import { parseModelId } from './modelLabel';

/** The part of a step a break reads. `LayoutStep` satisfies it. */
export interface BreakStep extends BranchStep {
  /** `providerID/modelID`, as the engine recorded it on the owning message. */
  model?: string;
}

export interface ModelBreak {
  /** Index of the FIRST step on the new model, into the same list the map drew. */
  index: number;
  ordinal: number;
  from: string;
  to: string;
  /** The incoming model's short id — `xai/grok-4.5` -> `grok-4.5`. */
  label: string;
}

/** `xai/grok-4.5` -> `grok-4.5`; an id with no provider prefix is its own label.
 *  Reuses the picker's own parser so one id cannot read two ways on one board. */
export function shortModel(id: string): string {
  return parseModelId(id).name || id;
}

export function modelBreaks(steps: readonly BreakStep[]): ModelBreak[] {
  const { host } = branchModel(steps);
  const out: ModelBreak[] = [];
  let previous: string | undefined;
  steps.forEach((step, i) => {
    if (host[i] !== -1 || !step.model) return;
    if (previous !== undefined && previous !== step.model) {
      out.push({ index: i, ordinal: step.ordinal, from: previous, to: step.model, label: shortModel(step.model) });
    }
    previous = step.model;
  });
  return out;
}
