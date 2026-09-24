// pickerHint.test.ts — the model list's explanation line (pickerHint.ts).
//
// The behaviour under test is the one the picker lacked (t-ry6ecn): a row a
// gateway pruned left NO trace, so a user who expected mimo-v2.6-flash-free on
// the Zen tab saw an ordinary short list and read it as a bug. These pin that
// a prune is always stated, that the free-tier case says WHY, and that a plain
// unpruned list still says nothing (a hint on every tab is noise).

import { describe, expect, it } from 'vitest';
import { hintLine } from './pickerHint';

const CAP = 60;

describe('hintLine — the gateway prune is stated, never silent', () => {
  it('says how many rows a key is not entitled to', () => {
    const line = hintLine({ shown: 20, total: 20, cap: CAP, note: { hidden: 12, hiddenFree: 0, keyed: true } });
    expect(line).toBe('12 models hidden: not entitled on this key.');
  });

  it('names the free tier when the hidden rows include one — the Zen case', () => {
    const line = hintLine({ shown: 20, total: 20, cap: CAP, note: { hidden: 12, hiddenFree: 6, keyed: true } });
    expect(line).toContain('12 models hidden');
    expect(line).toContain('only inside the OpenCode client');
  });

  it('counts one hidden model in the singular', () => {
    const line = hintLine({ shown: 20, total: 20, cap: CAP, note: { hidden: 1, hiddenFree: 0, keyed: true } });
    expect(line).toBe('1 model hidden: not entitled on this key.');
  });

  it('asks for a key when the provider block has none, and never also claims a prune', () => {
    const line = hintLine({ shown: 0, total: 0, cap: CAP, note: { hidden: 0, hiddenFree: 0, keyed: false } });
    expect(line).toContain('No API key set');
    expect(line).not.toContain('hidden');
  });
});

describe('hintLine — the render cap', () => {
  it('reports the cap when the filtered list is longer than it', () => {
    expect(hintLine({ shown: CAP, total: 310, cap: CAP })).toBe('Showing 60 of 310 — filter to narrow.');
  });

  it('reports the cap AND the prune together when both apply', () => {
    const line = hintLine({ shown: CAP, total: 310, cap: CAP, note: { hidden: 12, hiddenFree: 0, keyed: true } });
    expect(line).toBe('Showing 60 of 310 — filter to narrow. 12 models hidden: not entitled on this key.');
  });

  it('says nothing for a short, unpruned, keyed list', () => {
    expect(hintLine({ shown: 8, total: 8, cap: CAP, note: { hidden: 0, hiddenFree: 0, keyed: true } })).toBe('');
    expect(hintLine({ shown: 8, total: 8, cap: CAP })).toBe('');
  });
});
