// What a run really cost, and on which models.
//
// A cached-input token bills at a fraction of a fresh one, so raw tokens
// are not the bill. This leaf owns that translation, the cache-hit ratio,
// and the per-model price table — keyed by the session's current `model`,
// not its history, since a provider switch mid-run bills at two rates.
// Nothing here invents a number: absent stays absent, no prices means no
// currency at all.

import { accumulateUsage, emptyUsage, type UsageStep, type UsageTotal } from './labyrinthUsage';

/** What one cached-input token bills as, relative to a fresh one (default 0.1). */
export const CACHED_INPUT_FACTOR = 0.1;

/** The headline count: input tokens plus cache reads discounted to what
 *  they bill as. Absent when the run recorded neither. */
export function inputEquivalents(total: UsageTotal, factor = CACHED_INPUT_FACTOR): number | undefined {
  if (total.input === undefined && total.cacheRead === undefined) return undefined;
  return (total.input ?? 0) + (total.cacheRead ?? 0) * factor;
}

/** The share of prefill from cache. Undefined when the provider never
 *  reported cache tokens; a reported 0 is a real measurement and kept. */
export function cacheHitRatio(total: UsageTotal): number | undefined {
  if (total.cacheRead === undefined) return undefined;
  const prefill = total.cacheRead + (total.input ?? 0);
  if (prefill <= 0) return undefined;
  return total.cacheRead / prefill;
}

/** 0.8137 -> "81%". Absent in, absent out — never "NaN%" and never "0%". */
export function formatPercent(ratio: number | undefined): string | undefined {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return undefined;
  return `${Math.round(ratio * 100)}%`;
}

/** A step is one billed request when its message recorded usage. Counts
 *  `usageMissing` too: the request happened, we just don't know its cost. */
const billed = (s: UsageStep): boolean =>
  s.tokens !== undefined || s.cost !== undefined || s.usageMissing === true;

/** One model's share of the run. `model` is the engine's own `providerID/modelID`. */
export interface ModelUsage {
  model: string;
  /** Billed requests, not steps. */
  requests: number;
  total: UsageTotal;
}

/** Where the model CHANGED mid-run, read off the billed steps in run order. */
export interface ModelCutover {
  /** The `ordinal` of the FIRST request on the new model. */
  at: number;
  from: string;
  to: string;
}

/** A step whose message never recorded which model produced it. Named, not dropped. */
const UNKNOWN_MODEL = 'unknown';

/** Every model that actually ran, biggest spender first. */
export function modelsUsed(steps: readonly UsageStep[]): ModelUsage[] {
  const byModel = new Map<string, { requests: number; total: UsageTotal }>();
  for (const step of steps) {
    if (!billed(step)) continue;
    const key = step.model || UNKNOWN_MODEL;
    const bucket = byModel.get(key) ?? { requests: 0, total: emptyUsage() };
    bucket.requests++;
    accumulateUsage(bucket.total, step);
    bucket.total.approximate = bucket.total.missing > 0;
    byModel.set(key, bucket);
  }
  return [...byModel.entries()]
    .map(([model, b]) => ({ model, requests: b.requests, total: b.total }))
    .sort((a, b) => (b.total.tokens ?? 0) - (a.total.tokens ?? 0) || a.model.localeCompare(b.model));
}

/** The switches, in run order. Only billed steps are read, since a tool
 *  step inherits its message's model and would report a false cutover. */
export function modelCutovers(steps: readonly UsageStep[]): ModelCutover[] {
  const out: ModelCutover[] = [];
  let previous: string | undefined;
  for (const step of [...steps].sort((a, b) => a.ordinal - b.ordinal)) {
    if (!billed(step)) continue;
    const model = step.model || UNKNOWN_MODEL;
    if (previous !== undefined && previous !== model) out.push({ at: step.ordinal, from: previous, to: model });
    previous = model;
  }
  return out;
}

/** One model's user-entered prices. Dollars per MILLION tokens; percent for cache. */
export interface ModelPrice {
  input?: number;
  output?: number;
  /** What a cache read bills as, in percent of input. Absent = the provider default. */
  cachedPercent?: number;
}
/** Keyed by the SAME `providerID/modelID` string the engine records on a step. */
export type PriceTable = Record<string, ModelPrice>;

/** An indicative figure and how much of the run it actually covers. */
export interface Indicative {
  amount: number;
  /** Models the table had a price for. */
  priced: number;
  /** Models that ran. `priced < models` means the figure is a floor. */
  models: number;
}

/** A dollar figure from the user's own numbers, indicative, never a bill.
 *  Undefined when no model that ran has a price in the table. */
export function indicativeCost(usage: readonly ModelUsage[], prices: PriceTable): Indicative | undefined {
  let amount = 0;
  let priced = 0;
  for (const m of usage) {
    const p = prices[m.model];
    if (!p || (p.input === undefined && p.output === undefined)) continue;
    priced++;
    const factor = p.cachedPercent === undefined ? CACHED_INPUT_FACTOR : p.cachedPercent / 100;
    const perInput = (p.input ?? 0) / 1_000_000;
    amount += (m.total.input ?? 0) * perInput;
    amount += (m.total.cacheRead ?? 0) * perInput * factor;
    // Reasoning tokens bill at the output rate, so they ride with output, not free.
    amount += ((m.total.output ?? 0) + (m.total.reasoning ?? 0)) * ((p.output ?? 0) / 1_000_000);
  }
  return priced > 0 ? { amount, priced, models: usage.length } : undefined;
}
