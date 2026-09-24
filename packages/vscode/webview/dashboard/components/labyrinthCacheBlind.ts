// WHICH PROVIDERS THIS RUN CANNOT SPEAK FOR.
//
// The defect this leaf exists to kill: a local server bills a prefill and
// reports cache read 0 and write 0 on EVERY call — the token-burn survey found
// 26.9% of turns on lmstudio/sglang doing exactly that. labyrinthCache.ts read
// those zeros as measurements, so every step became a "cache loss" and the
// owner saw seven of them one second apart, each blamed on nothing.
//
// A zero nobody measured is not a zero. This file is the one place that
// difference is decided, extracted out of labyrinthCache.ts (which was at its
// cap after the policy table left) so the LOSS rules stay one readable pass.
//
// Pure — no DOM.

import type { UsageStep } from './labyrinthUsage';

/** A step that carried a billed prefill — the only kind a loss can happen on. */
export const prefilled = (s: UsageStep): boolean => !!s.tokens && s.tokens.input > 0;

/** The `providerID` half of the engine's `providerID/modelID`, lower-cased.
 *  Moved here from the deleted labyrinthCachePolicy.ts (t-rylq3t): this is the
 *  only rule left that needs it, to tell a local-server miss from any other. */
export function providerOf(model: string | undefined): string | undefined {
  const provider = model?.split('/')[0]?.toLowerCase();
  return provider || undefined;
}

/** Which `providerID/modelID` in a run never reported a cache at all. */
export interface CacheBlindness {
  /** The `providerID/modelID` keys. A step on one of these is not evidence. */
  models: ReadonlySet<string>;
  /** Their provider halves, de-duplicated, in first-seen order — for a label. */
  providers: string[];
  /** True when EVERY billed step in the run belongs to one of them. */
  all: boolean;
}

/**
 * The providers this run cannot say anything about.
 *
 * A provider/model is CACHE-BLIND when every billed request it served in this
 * run reported cache read 0 AND cache write 0. One request reporting either is
 * enough to disqualify it: that provider does measure caching, so a zero from
 * it later is a measured zero and the ordinary rules apply.
 *
 * WHY THE UNIT IS provider/model AND NOT provider. One provider commonly serves
 * both a caching model and a non-caching one, and a run that used both would
 * otherwise be judged by whichever came first.
 *
 * `(x ?? 0) === 0` on purpose: a provider that reports the field as 0 and one
 * that omits it entirely are the same fact — no measurement — and splitting
 * them would leave the second class exactly as broken as before.
 *
 * A billed step with NO model is never blind. Nothing says which provider it
 * came from, so nothing here can excuse it.
 */
export function cacheBlindness(steps: readonly UsageStep[]): CacheBlindness {
  const reported = new Set<string>();
  const seen: string[] = [];
  let billed = 0;
  for (const step of steps) {
    if (!prefilled(step)) continue;
    billed++;
    if (!step.model) continue;
    if (!seen.includes(step.model)) seen.push(step.model);
    const cache = step.tokens?.cache;
    if ((cache?.read ?? 0) > 0 || (cache?.write ?? 0) > 0) reported.add(step.model);
  }
  const models = new Set(seen.filter((model) => !reported.has(model)));
  const providers: string[] = [];
  for (const model of models) {
    const provider = providerOf(model);
    if (provider && !providers.includes(provider)) providers.push(provider);
  }
  const dark = steps.filter((s) => prefilled(s) && !!s.model && models.has(s.model)).length;
  return { models, providers, all: billed > 0 && dark === billed };
}

/** True when this step's own provider never reported a cache in this run. */
export function isCacheBlind(step: UsageStep, blind: ReadonlySet<string>): boolean {
  return !!step.model && blind.has(step.model);
}
