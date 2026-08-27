// What a run REALLY cost, and on WHICH models.
//
// The raw token total is not the bill. A cached-input token is charged at a
// fraction of a fresh one, so a 189M-token run that was 81% cache reads is
// nearer 50M in what it actually billed for — and a headline that prints the
// raw number is off by that whole factor. This leaf owns the translation, the
// cache-hit ratio it comes from, and the per-model price table the user can
// supply to turn either into currency.
//
// It also owns WHICH MODELS RAN, for two reasons. The price table is keyed by
// model, so the two questions are one question. And the session record's own
// `model` field is the CURRENT SELECTION, not the history: a run that switched
// provider mid-way billed at two rates, and presenting the selection as "what
// ran" is the same class of lie as printing the raw total as the cost.
//
// Pure — no DOM — like labyrinthUsage beside it, and it SUMS THROUGH that
// module's own accumulator rather than keeping a second copy of the arithmetic.
// Nothing here invents a number: an absent measurement stays absent, and with
// no prices entered there is no currency figure at all.

import { accumulateUsage, emptyUsage, type UsageStep, type UsageTotal } from './labyrinthUsage';

/**
 * What one cached-input token bills as, relative to a fresh one. A tenth is the
 * PROVIDER DEFAULT (the rate Anthropic, OpenAI and xAI all publish for a cache
 * read); a per-model `cachedPercent` in the price table overrides it. Named
 * rather than inlined because a bare 0.1 inside a headline is a claim the
 * reader cannot check.
 */
export const CACHED_INPUT_FACTOR = 0.1;

/**
 * The headline count: input tokens plus cache reads DISCOUNTED to what they
 * bill as — "input equivalents". Output and reasoning are excluded on purpose;
 * they are priced on a different axis, and folding them in would make one
 * number mean two things.
 *
 * Absent when the run recorded neither input nor cache reads, so an unmeasured
 * run prints nothing rather than a confident 0.
 */
export function inputEquivalents(total: UsageTotal, factor = CACHED_INPUT_FACTOR): number | undefined {
  if (total.input === undefined && total.cacheRead === undefined) return undefined;
  return (total.input ?? 0) + (total.cacheRead ?? 0) * factor;
}

/**
 * The share of PREFILL that came from cache: `cacheRead / (cacheRead + input)`.
 *
 * Undefined when the provider never reported cache tokens at all — most local
 * servers do not — because 0% would read as "caching is broken here" when the
 * truth is that nobody measured. A reported 0 IS a measurement and is kept.
 */
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

/**
 * A step is one BILLED REQUEST when its message recorded usage — the engine
 * attaches a message's usage to exactly one of the steps it produced, so this
 * counts assistant messages and never their parts. `usageMissing` counts too:
 * that request happened, we just do not know what it cost.
 */
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

/** A step whose message never recorded which model produced it. Named, not dropped —
 *  the same rule labyrinthUsage's `unknown` agent bucket follows. */
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

/**
 * The switches, in run order. Only BILLED steps are read: a tool step inherits
 * its message's model, so walking every step would report a "cutover" each time
 * one message ended and the next began on the same model.
 */
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

/**
 * A dollar figure from the user's own numbers — INDICATIVE, never a bill. It is
 * undefined when no model that ran has a price, so an empty table shows no
 * currency at all rather than "$0.00", which would read as a free run.
 *
 * A model priced for input but not output still contributes its input: a
 * partial price is a real constraint, and `priced`/`models` says how partial.
 */
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
    // Reasoning tokens are billed at the OUTPUT rate by every provider that
    // reports them separately, so they ride with output rather than free.
    amount += ((m.total.output ?? 0) + (m.total.reasoning ?? 0)) * ((p.output ?? 0) / 1_000_000);
  }
  return priced > 0 ? { amount, priced, models: usage.length } : undefined;
}
