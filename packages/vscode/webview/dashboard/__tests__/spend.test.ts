// spend.test.ts — the monthly cap's OAuth exclusion (oauth-cost finding, ext
// half). `readSpend`/`accrueSessionSpend`/`readBudget` touch the REAL
// ~/.origami/spend.json and budget.json, so `fs`/`os` are mocked to an
// in-memory fake the same way toolsPane.test.ts fakes node:fs/node:os for
// firstFold.ts's config writers — this suite must never touch the real home
// directory. `budgetBlocks` itself stays pure (overBudget is passed in, not
// read), so most of these tests need no fs mock at all; only the
// accrueSessionSpendUnlessOAuth tests exercise the real ledger read/write.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const files = new Map<string, string>();
const key = (p: unknown) => String(p);

vi.mock('os', () => ({ homedir: () => 'C:/fakehome-spend' }));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: ((p: string, enc?: unknown) => {
      const v = files.get(key(p));
      if (v !== undefined) return v;
      return actual.readFileSync(p, enc as never);
    }) as typeof actual.readFileSync,
    writeFileSync: (p: string, data: string) => void files.set(key(p), String(data)),
    mkdirSync: (() => {}) as unknown as typeof actual.mkdirSync,
  };
});

import { isOAuthExcluded, budgetBlocks, accrueSessionSpendUnlessOAuth, readSpend } from '../../../src/dashboard/spend';

beforeEach(() => files.clear());

describe('isOAuthExcluded', () => {
  it('is true for a provider holding an OAuth credential', () => {
    expect(isOAuthExcluded('xai', new Set(['xai']))).toBe(true);
  });
  it('is false with no OAuth credential for that provider, or an empty id', () => {
    expect(isOAuthExcluded('xai', new Set())).toBe(false);
    expect(isOAuthExcluded('', new Set(['xai']))).toBe(false);
  });
  it("is false for openrouter even when SOME other provider is OAuth-connected — OpenRouter's own accounting is untouched", () => {
    expect(isOAuthExcluded('openrouter', new Set(['xai']))).toBe(false);
  });
});

describe('budgetBlocks — the "Cloud turns are blocked" gate', () => {
  it('blocks a capped openrouter turn (regression: OpenRouter accounting stays exactly as-is)', () => {
    expect(budgetBlocks('openrouter', new Set(), true)).toBe(true);
  });
  it('does NOT block an OAuth-connected xai turn even when over cap', () => {
    expect(budgetBlocks('xai', new Set(['xai']), true)).toBe(false);
  });
  it('still blocks a real pay-per-token xai turn (no OAuth credential) when over cap', () => {
    expect(budgetBlocks('xai', new Set(), true)).toBe(true);
  });
  it('never blocks under cap, OAuth-connected or not', () => {
    expect(budgetBlocks('openrouter', new Set(), false)).toBe(false);
    expect(budgetBlocks('xai', new Set(), false)).toBe(false);
  });
});

describe('accrueSessionSpendUnlessOAuth — monthly ledger accumulation', () => {
  it('an OAuth-connected provider turn does NOT increment monthSpend', () => {
    const before = readSpend().total;
    const after = accrueSessionSpendUnlessOAuth('s-oauth', 3.26, 'xai', new Set(['xai']));
    expect(after.total).toBe(before);
    expect(readSpend().total).toBe(before);
  });
  it('an openrouter turn still increments monthSpend', () => {
    const before = readSpend().total;
    const after = accrueSessionSpendUnlessOAuth('s-or', 1.5, 'openrouter', new Set(['xai']));
    expect(after.total).toBeCloseTo(before + 1.5);
  });
  it('a real (non-OAuth) xai turn still increments monthSpend', () => {
    const before = readSpend().total;
    const after = accrueSessionSpendUnlessOAuth('s-xai-key', 2, 'xai', new Set());
    expect(after.total).toBeCloseTo(before + 2);
  });
});
