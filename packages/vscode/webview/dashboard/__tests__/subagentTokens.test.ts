// subagentTokens — what a sub-agent's spend looks like on a 240px row, and the
// guard that keeps the field list the same on both sides of the wire.
//
// The failure this file is here to prevent is a QUIET one: against an engine
// that rides no token metadata the row must print NOTHING. A `0 / 0` there
// would be a claim — "this agent spent nothing" — about a figure nobody sent.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactCount, tokensText, tokensTitle, tokensTotalText } from '../panes/subagentTokens';
import { TASK_TOKEN_FIELDS, taskTokensOf } from '../../../src/acpTaskTokens';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('compactCount — three characters of number at most', () => {
  it('prints an exact count below a thousand, including zero', () => {
    expect(compactCount(0)).toBe('0');
    expect(compactCount(812)).toBe('812');
    expect(compactCount(999)).toBe('999');
  });

  it('switches to k at a thousand and drops a trailing .0', () => {
    expect(compactCount(1000)).toBe('1k');
    expect(compactCount(12_400)).toBe('12.4k');
    expect(compactCount(12_449)).toBe('12.4k');
  });

  it('rounds BEFORE choosing the unit, so 999_999 is 1M and not 1000.0k', () => {
    // The boundary the naive `n < 1e6 ? k : M` test gets wrong: 999_999 / 1e3
    // rounds to 1000.0, which must not print as a four-digit k.
    expect(compactCount(999_999)).toBe('1M');
    expect(compactCount(99_990)).toBe('100k');
    expect(compactCount(2_450_000)).toBe('2.5M');
  });

  it('refuses junk rather than printing NaN into the row', () => {
    expect(compactCount(Number.NaN)).toBe('');
    expect(compactCount(Number.POSITIVE_INFINITY)).toBe('');
    expect(compactCount(-5)).toBe('');
  });
});

describe('tokensText — the compact in/out, and when it says nothing at all', () => {
  it('prints in / out when both counts arrived', () => {
    expect(tokensText({ input: 12_400, output: 2_100 })).toBe('12.4k / 2.1k');
  });

  it('prints a real ZERO output — a child that has emitted nothing has spent input', () => {
    expect(tokensText({ input: 900, output: 0 })).toBe('900 / 0');
  });

  it('says NOTHING against an engine that rode no tokens', () => {
    // The fail-open case, and the reason the whole feature is safe to ship
    // ahead of the engine lane that writes the rider.
    expect(tokensText(undefined)).toBe('');
  });

  it('says nothing for a PARTIAL rider — there is no honest two-number form', () => {
    // A rider carrying only a cost, or only a cache figure, has no in/out to
    // print. The breakdown title below still shows what did arrive.
    expect(tokensText({ cost: 0.04 })).toBe('');
    expect(tokensText({ input: 100 })).toBe('');
    expect(tokensText({ output: 100 })).toBe('');
  });
});

describe('tokensTotalText — the three-row layout\'s single `<X> tokens` figure', () => {
  it('says nothing without BOTH halves — a partial rider has no honest total', () => {
    expect(tokensTotalText(undefined)).toBe('');
    expect(tokensTotalText({ input: 100 })).toBe('');
    expect(tokensTotalText({ output: 100 })).toBe('');
    expect(tokensTotalText({ cost: 0.04 })).toBe('');
  });

  it('prints a sub-1k total as an exact count with the word `tokens`', () => {
    expect(tokensTotalText({ input: 500, output: 499 })).toBe('999 tokens');
  });

  it('prints a k-scale total compacted the same way compactCount does', () => {
    expect(tokensTotalText({ input: 40_000, output: 14_305 })).toBe('54.3k tokens');
  });
});

describe('tokensTitle — the exact breakdown behind the rounded figure', () => {
  it('names only the fields that arrived, in order, with the cost in dollars', () => {
    expect(tokensTitle({ input: 12_431, output: 2_140, cacheRead: 1_000, cost: 0.0421 }))
      .toBe('Input 12,431 · Output 2,140 · Cache read 1,000 · Cost $0.0421');
  });

  it('is empty when there is no rider, so the row carries no empty tooltip', () => {
    expect(tokensTitle(undefined)).toBe('');
  });
});

describe('taskTokensOf — the decoder, fail-open on every kind of junk', () => {
  it('reads the six counters the engine rides', () => {
    expect(taskTokensOf({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, cost: 0.6 }))
      .toEqual({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, cost: 0.6 });
  });

  it('keeps a ZERO count — unlike a stamp, 0 tokens is a fact', () => {
    expect(taskTokensOf({ input: 0, output: 0 })).toEqual({ input: 0, output: 0 });
  });

  it('drops a junk field rather than the whole rider', () => {
    expect(taskTokensOf({ input: 'lots', output: 2, cost: Number.NaN, cacheRead: -1 })).toEqual({ output: 2 });
  });

  it('a rider of nothing but junk decodes to undefined, not an empty object', () => {
    // `{}` would make `tokensTitle` return '' but still set a title attribute,
    // and would make every "did any tokens arrive" check true.
    expect(taskTokensOf({ input: 'lots' })).toBeUndefined();
    expect(taskTokensOf({})).toBeUndefined();
    expect(taskTokensOf(null)).toBeUndefined();
    expect(taskTokensOf(undefined)).toBeUndefined();
    expect(taskTokensOf('12k')).toBeUndefined();
    expect(taskTokensOf([1, 2])).toBeUndefined();
  });
});

// The webview cannot import extension-host code (tsconfig.webview pins
// rootDir), so `SubagentTokens` is declared twice. House rule: every mirror is
// read by a test that fails when the two sides disagree.
describe('subagentTokens — the mirror guard against src/acpTaskTokens.ts', () => {
  it('the webview names exactly the six fields the host decodes', () => {
    const webviewSrc = readFileSync(path.resolve(here, '../panes/subagentTokens.ts'), 'utf8');
    const declared = webviewSrc.slice(webviewSrc.indexOf('interface SubagentTokens'));
    const fields = [...declared.slice(0, declared.indexOf('}')).matchAll(/^\s{2}(\w+)\?:/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual([...TASK_TOKEN_FIELDS].sort());
  });
});
