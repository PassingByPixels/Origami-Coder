// What a run REALLY cost, and on which models. The failures worth catching are
// the ones that would put a wrong number in front of a reader who then believes
// it:
//  - a raw token count presented as the bill, when 81% of it billed at a tenth,
//  - a "0% cached" printed for a provider that never reported cache at all,
//  - a run's spend attributed to the model the chat is set to TODAY,
//  - a dollar figure conjured out of an empty price table.
// Pure — no DOM — so every rule is checked as arithmetic.

import { describe, it, expect } from 'vitest';
import {
  CACHED_INPUT_FACTOR, cacheHitRatio, formatPercent, indicativeCost, inputEquivalents,
  modelCutovers, modelsUsed, type PriceTable,
} from '../components/labyrinthCost';
import { usageBreakdown, type UsageStep } from '../components/labyrinthUsage';

const step = (ordinal: number, over: Partial<UsageStep> = {}): UsageStep => ({
  ordinal, kind: 'reply', title: `step ${ordinal}`, ...over,
} as UsageStep);

/** The shape the audit found in the store: an OpenAI run with six xAI requests
 *  in the middle of it — the only reasoning tokens in the whole session. */
const TWO_PROVIDERS: UsageStep[] = [
  step(0, { kind: 'prompt', title: 'go', agent: 'build', model: 'openai/gpt-5.6-sol' }),
  step(1, { agent: 'build', model: 'openai/gpt-5.6-sol', tokens: { input: 1_000, output: 100, cache: { read: 9_000 } } }),
  step(2, { agent: 'build', model: 'xai/grok-4.5', tokens: { input: 200, output: 20, reasoning: 143, cache: { read: 800 } } }),
  step(3, { agent: 'build', model: 'openai/gpt-5.6-sol', tokens: { input: 300, output: 30, cache: { read: 700 } } }),
];

describe('labyrinthCost — the headline is what BILLED, not what was counted', () => {
  it('discounts cache reads to a tenth, and says so with a named constant', () => {
    expect(CACHED_INPUT_FACTOR).toBe(0.1);
    const { run } = usageBreakdown(TWO_PROVIDERS);
    // input 1,500 + cache read 10,500 -> 1,500 + 1,050.
    expect(run.input).toBe(1_500);
    expect(run.cacheRead).toBe(10_500);
    expect(inputEquivalents(run)).toBe(2_550);
  });

  it('takes an override factor, so a per-model rate can replace the default', () => {
    const { run } = usageBreakdown(TWO_PROVIDERS);
    expect(inputEquivalents(run, 0.25)).toBe(1_500 + 10_500 * 0.25);
  });

  it('reports NOTHING when the run recorded neither input nor cache', () => {
    const { run } = usageBreakdown([step(0, { kind: 'prompt', title: 'hi' })]);
    expect(inputEquivalents(run)).toBeUndefined();
    expect(cacheHitRatio(run)).toBeUndefined();
    expect(formatPercent(undefined)).toBeUndefined();
  });

  it('a provider that never reports cache gets NO hit rate — 0% would be a lie', () => {
    // A local server records input and output and no cache fields at all. The
    // engine omits what it never saw, so `cacheRead` is absent, not zero.
    const { run } = usageBreakdown([step(0, { agent: 'build', tokens: { input: 900, output: 90 } })]);
    expect(run.cacheRead).toBeUndefined();
    expect(cacheHitRatio(run)).toBeUndefined();
    // ...but the input equivalents still stand: input alone is a measurement.
    expect(inputEquivalents(run)).toBe(900);
  });

  it('a REPORTED zero is kept — that provider measured, and cached nothing', () => {
    const { run } = usageBreakdown([step(0, { agent: 'build', tokens: { input: 900, output: 9, cache: { read: 0 } } })]);
    expect(cacheHitRatio(run)).toBe(0);
    expect(formatPercent(cacheHitRatio(run))).toBe('0%');
  });

  it('the hit rate is cache over PREFILL, rounded for reading', () => {
    const { run } = usageBreakdown(TWO_PROVIDERS);
    expect(cacheHitRatio(run)).toBeCloseTo(10_500 / 12_000, 10);
    expect(formatPercent(cacheHitRatio(run))).toBe('88%');
  });
});

describe('labyrinthCost — which models RAN, not which one is selected', () => {
  it('splits the run per model, counting REQUESTS rather than steps', () => {
    const used = modelsUsed(TWO_PROVIDERS);
    expect(used.map((m) => [m.model, m.requests])).toEqual([
      ['openai/gpt-5.6-sol', 2],
      ['xai/grok-4.5', 1],
    ]);
    // The prompt step carries a model but no usage: it is not a request.
    expect(used[0]!.total.input).toBe(1_300);
    expect(used[1]!.total.reasoning).toBe(143);
  });

  it('the per-model split adds up to the run — nothing counted twice, none dropped', () => {
    const { run } = usageBreakdown(TWO_PROVIDERS);
    const used = modelsUsed(TWO_PROVIDERS);
    expect(used.reduce((n, m) => n + (m.total.tokens ?? 0), 0)).toBe(run.tokens);
    expect(used.reduce((n, m) => n + m.total.counted, 0)).toBe(run.counted);
  });

  it('names the CUTOVERS — where the run changed hands, and at which step', () => {
    expect(modelCutovers(TWO_PROVIDERS)).toEqual([
      { at: 2, from: 'openai/gpt-5.6-sol', to: 'xai/grok-4.5' },
      { at: 3, from: 'xai/grok-4.5', to: 'openai/gpt-5.6-sol' },
    ]);
  });

  it('a run on ONE model reports no cutover at all', () => {
    const same = TWO_PROVIDERS.filter((s) => s.model !== 'xai/grok-4.5');
    expect(modelCutovers(same)).toEqual([]);
    expect(modelsUsed(same)).toHaveLength(1);
  });

  it('an old payload with no model is named `unknown`, never silently dropped', () => {
    const used = modelsUsed([step(0, { tokens: { input: 5, output: 5 } })]);
    expect(used).toHaveLength(1);
    expect(used[0]!.model).toBe('unknown');
    expect(used[0]!.total.tokens).toBe(10);
  });

  it('a request that recorded NO usage is still a request — the model ran', () => {
    const used = modelsUsed([step(0, { model: 'x/y', usageMissing: true })]);
    expect(used[0]!.requests).toBe(1);
    expect(used[0]!.total.approximate).toBe(true);
    expect(used[0]!.total.tokens).toBeUndefined();
  });
});

describe('labyrinthCost — an indicative figure, only ever from the user\'s own prices', () => {
  const PRICES: PriceTable = {
    'openai/gpt-5.6-sol': { input: 1.25, output: 10 },
    'xai/grok-4.5': { input: 3, output: 15, cachedPercent: 25 },
  };

  it('produces NOTHING when the table is empty — never $0, which reads as free', () => {
    expect(indicativeCost(modelsUsed(TWO_PROVIDERS), {})).toBeUndefined();
  });

  it('prices input, discounted cache, and output+reasoning per model', () => {
    const quote = indicativeCost(modelsUsed(TWO_PROVIDERS), PRICES)!;
    const openai = (1_300 * 1.25 + 9_700 * 1.25 * 0.1 + 130 * 10) / 1_000_000;
    const xai = (200 * 3 + 800 * 3 * 0.25 + (20 + 143) * 15) / 1_000_000;
    expect(quote.amount).toBeCloseTo(openai + xai, 12);
    expect(quote.priced).toBe(2);
    expect(quote.models).toBe(2);
  });

  it('a per-model cached percent OVERRIDES the provider default', () => {
    const dear = indicativeCost(modelsUsed(TWO_PROVIDERS), {
      'xai/grok-4.5': { input: 3, output: 15, cachedPercent: 100 },
    })!;
    const cheap = indicativeCost(modelsUsed(TWO_PROVIDERS), {
      'xai/grok-4.5': { input: 3, output: 15 },
    })!;
    expect(dear.amount).toBeGreaterThan(cheap.amount);
    expect(dear.amount - cheap.amount).toBeCloseTo((800 * 3 * 0.9) / 1_000_000, 12);
  });

  it('says the figure is PARTIAL when a model that ran has no price', () => {
    const quote = indicativeCost(modelsUsed(TWO_PROVIDERS), { 'openai/gpt-5.6-sol': { input: 1.25 } })!;
    expect(quote.priced).toBe(1);
    expect(quote.models).toBe(2);
    // Priced for input only: no output rate means no output charge invented.
    expect(quote.amount).toBeCloseTo((1_300 * 1.25 + 9_700 * 1.25 * 0.1) / 1_000_000, 12);
  });

  it('an entry with no usable number does not count as priced', () => {
    expect(indicativeCost(modelsUsed(TWO_PROVIDERS), { 'openai/gpt-5.6-sol': {} })).toBeUndefined();
  });
});
