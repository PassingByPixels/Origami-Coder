// The multi-model race: one task fires up to four (agentName, model) sibling agents at
// once, tied by a shared groupId so the board clusters them. Each is a plain runCreate; one
// failing never aborts the rest. Started variants launch without awaiting completion,
// staggered so several sessions don't stampede one provider; a queued race provisions with no
// stagger.

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
  // Dedupe identical (agentName, effective model) pairs — racing a model against itself is
  // pointless. Below two survivors, it's no longer a race.
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
    // Fired without awaiting completion — the variants must race, not serialize.
    void runCreate(ctx, root, `${rawName || 'agent'}-${i + 1}`, v.agentName, prompt, v.model, start, groupId);
    // Stagger only BETWEEN started launches (a queued race opens no sessions).
    if (start && i < unique.length - 1) await delay(STAGGER_MS);
  }
}
