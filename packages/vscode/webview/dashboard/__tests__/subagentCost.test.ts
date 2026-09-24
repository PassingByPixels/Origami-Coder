// The price maths, against a fixture catalogue CUT FROM THE REAL ONE: the rows below are
// the shapes `~/.local/share/origami/cache/provider-catalog-<key>.json` actually holds on
// this machine (anthropic priced, lmstudio all-zero, an openrouter id carrying its own
// slash). A fixture invented here would only prove this file agrees with itself.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  catalogPrices,
  costUsd,
  priceFor,
  pricedTokens,
  pricesFromCatalog,
  rememberChildModel,
  resetSubagentCost,
} from '../../../src/dashboard/subagentCost';
import { costText, tokensTitle } from '../panes/subagentTokensTitle';
import { tokensTotalText } from '../panes/subagentTokens';
import SubagentRow from '../components/SubagentRow.svelte';
import { mapTree } from '../panes/subagentMapNodes';
import { row, rowProps } from '../panes/subagentRowFixture';

const CATALOG = {
  format: 1,
  catalog: {
    providers: [
      {
        id: 'anthropic',
        models: {
          'claude-opus-5': { id: 'claude-opus-5', cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } } },
          'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } } },
        },
      },
      { id: 'lmstudio', models: { 'qwen/qwen3-coder-30b': { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } } } },
      { id: 'openrouter', models: { 'qwen/qwen3.7-max': { cost: { input: 1.475, output: 4.425, cache: { read: 0.295, write: 1.84375 } } } } },
      { id: 'broken', models: { 'no-cost-row': {} } },
    ],
  },
};

beforeEach(() => resetSubagentCost());
afterEach(() => cleanup());

describe('pricesFromCatalog', () => {
  it('flattens priced rows to provider/model and drops the unpriced ones', () => {
    const prices = pricesFromCatalog(CATALOG);
    expect([...prices.keys()].sort()).toEqual([
      'anthropic/claude-opus-5',
      'anthropic/claude-sonnet-4-6',
      'openrouter/qwen/qwen3.7-max',
    ]);
    expect(prices.get('anthropic/claude-opus-5')).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  it('reads an all-zero local row as UNPRICED, not as free', () => {
    expect(pricesFromCatalog(CATALOG).has('lmstudio/qwen/qwen3-coder-30b')).toBe(false);
  });

  it('answers an empty map for junk rather than throwing', () => {
    for (const junk of [undefined, null, 42, {}, { catalog: {} }, { catalog: { providers: 'no' } }]) {
      expect(pricesFromCatalog(junk).size).toBe(0);
    }
  });
});

describe('priceFor', () => {
  const prices = pricesFromCatalog(CATALOG);

  it('matches provider/model, whatever the case', () => {
    expect(priceFor(prices, 'Anthropic/Claude-Opus-5')?.output).toBe(25);
  });

  it('matches an OpenRouter id that carries its own slash', () => {
    expect(priceFor(prices, 'openrouter/qwen/qwen3.7-max')?.input).toBe(1.475);
  });

  it('falls back to the bare model id when the rider carries no provider', () => {
    expect(priceFor(prices, 'claude-sonnet-4-6')?.input).toBe(3);
  });

  it('answers undefined for an unknown or empty model', () => {
    expect(priceFor(prices, 'some/model-nobody-priced')).toBeUndefined();
    expect(priceFor(prices, '')).toBeUndefined();
    expect(priceFor(prices, undefined)).toBeUndefined();
  });
});

describe('costUsd', () => {
  const opus = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

  it('charges input, output+reasoning, and each cache line at its own rate', () => {
    // 1M in @5 + (1M out + 1M reasoning) @25 + 1M cacheRead @0.5 + 1M cacheWrite @6.25
    expect(costUsd({ input: 1_000_000, output: 1_000_000, reasoning: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, opus))
      .toBeCloseTo(5 + 50 + 0.5 + 6.25, 6);
  });

  it('prices a realistic child to four decimals', () => {
    expect(costUsd({ input: 12_000, output: 3_400 }, opus)).toBeCloseTo(12_000 * 5e-6 + 3_400 * 25e-6, 9);
  });

  it('is undefined — never 0 — with no price, no rider, or nothing spent', () => {
    expect(costUsd({ input: 1000, output: 100 }, undefined)).toBeUndefined();
    expect(costUsd(undefined, opus)).toBeUndefined();
    expect(costUsd({ input: 0, output: 0 }, opus)).toBeUndefined();
  });
});

describe('pricedTokens — the field the host stamps on the rider', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-catalog-'));
  fs.writeFileSync(path.join(dir, 'provider-catalog-abc.json'), JSON.stringify(CATALOG));

  it('adds costUsd once the child’s model is known', () => {
    rememberChildModel('child-1', 'anthropic/claude-opus-5');
    const out = pricedTokens('child-1', { input: 12_000, output: 3_400 }, dir);
    expect(out?.costUsd).toBeCloseTo(0.145, 6);
    expect(out?.input).toBe(12_000); // the rider is not otherwise touched
  });

  it('leaves the rider alone when the model is unknown or unpriced', () => {
    expect(pricedTokens('never-seen', { input: 12_000, output: 3_400 }, dir)).toEqual({ input: 12_000, output: 3_400 });
    rememberChildModel('child-local', 'lmstudio/qwen/qwen3-coder-30b');
    expect(pricedTokens('child-local', { input: 12_000, output: 3_400 }, dir)?.costUsd).toBeUndefined();
  });

  it('passes an absent rider straight through, so "did any tokens arrive" still works', () => {
    expect(pricedTokens('child-1', undefined, dir)).toBeUndefined();
  });

  it('reads the newest catalogue file in the directory, and an empty map when there is none', () => {
    expect(catalogPrices(dir, 1).size).toBe(3);
    resetSubagentCost();
    expect(catalogPrices(path.join(dir, 'nope'), 2).size).toBe(0);
  });
});

describe('what the row and the map card print', () => {
  it('four decimals under a dollar, two over it, nothing for no figure', () => {
    expect(costText(0.1449)).toBe('$0.1449');
    expect(costText(12.3456)).toBe('$12.35');
    expect(costText(undefined)).toBe('');
    expect(costText(0)).toBe('');
  });

  it('puts the cost SECOND, ahead of steps and context — the 240px row clips the tail', () => {
    expect(tokensTotalText({ input: 12_000, output: 3_400, steps: 14, context: 61_200, costUsd: 0.145 }))
      .toBe('15.4k tokens · $0.1450 · 14 steps · 61.2k context');
  });

  it('prints only the tokens with no cost', () => {
    expect(tokensTotalText({ input: 12_000, output: 3_400, costUsd: 0.145 })).toBe('15.4k tokens · $0.1450');
    expect(tokensTotalText({ input: 12_000, output: 3_400 })).toBe('15.4k tokens');
  });

  it('names the derived figure "Est. cost" in the breakdown, beside the provider’s own "Cost"', () => {
    expect(tokensTitle({ input: 12_000, output: 3_400, cost: 0.2, costUsd: 0.145 }))
      .toBe('Input 12,000 · Output 3,400 · Cost $0.2000 · Est. cost $0.1450');
  });

  it('the drawer row shows the cost beside the tokens', () => {
    const view = render(SubagentRow, rowProps({ row: row({ tokens: { input: 12_000, output: 3_400, costUsd: 0.145 } }) }));
    expect(view.container.querySelector('.sa-tokens')?.textContent).toContain('$0.1450');
  });

  it('an old host sends no costUsd — the row renders the tokens and no figure, and does not throw', () => {
    const view = render(SubagentRow, rowProps({ row: row({ tokens: { input: 12_000, output: 3_400 } }) }));
    const text = view.container.querySelector('.sa-tokens')?.textContent ?? '';
    expect(text).toContain('15.4k tokens');
    expect(text).not.toContain('$');
  });

  it('the map card carries the same string', () => {
    const tree = mapTree([row({ tokens: { input: 12_000, output: 3_400, costUsd: 0.145 } })]);
    expect(tree.nodes.some((n) => n.tokens.includes('$0.1450'))).toBe(true);
  });
});
