// Agent Manager - fanout.ts (S5): the multi-model race. One task is fired at up
// to four (agentName, model) VARIANTS at once - each an ordinary sibling agent
// in its own worktree, tied together by a shared groupId so the board clusters
// them under a race header. The per-variant shape carries agentName+model (a
// typed agent can vary per sibling). Each variant is a plain runCreate; a failure of one never
// aborts the rest (runCreate catches internally). Started variants launch
// WITHOUT awaiting their run to completion (a race must run concurrently) with a
// small stagger between launches so several sessions/model-pins don't stampede
// one provider; a QUEUED race (start:false) provisions all siblings with no
// stagger (it opens no sessions). createWorktree serializes per repo, so the
// concurrent provisioning is race-free.

import { newWorktreeRecordId } from './state';
import { runCreate, effectiveModel, type RunContext } from './run';

export interface Variant { agentName: string; model: string }

/** Between two STARTED launches: avoids a thundering herd on one provider. */
const STAGGER_MS = 300;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runFanout(
  ctx: RunContext, root: string, rawName: string, prompt: string, variants: Variant[], start: boolean,
): Promise<void> {
  const amError = (message: string) => ctx.host.post({ type: 'amError', message });
  if (!Array.isArray(variants) || variants.length < 2 || variants.length > 4) {
    amError('A race needs 2-4 variants.');
    return;
  }
  // Dedupe identical (agentName, EFFECTIVE model) pairs - racing a model against
  // itself is pointless. Resolve the repo default FIRST so a blank variant that
  // lands on the same model as an explicit pick collapses too (run.ts pins the
  // same resolved value). Below two survivors -> it is no longer a race.
  const seen = new Set<string>();
  const unique: Variant[] = [];
  for (const v of variants) {
    const key = `${v.agentName} ${effectiveModel(root, v.model)}`;
    if (!seen.has(key)) { seen.add(key); unique.push(v); }
  }
  if (unique.length < 2) { amError('A race needs 2-4 variants.'); return; }

  const groupId = newWorktreeRecordId();
  for (let i = 0; i < unique.length; i++) {
    const v = unique[i];
    // Fire the run WITHOUT awaiting completion (runCreate awaits the whole prompt
    // on start:true) - the variants must race, not serialize. runCreate owns its
    // own record + broadcast and never throws, so the void is safe.
    void runCreate(ctx, root, `${rawName || 'agent'}-${i + 1}`, v.agentName, prompt, v.model, start, groupId);
    // Stagger only BETWEEN started launches (a queued race opens no sessions).
    if (start && i < unique.length - 1) await delay(STAGGER_MS);
  }
}
