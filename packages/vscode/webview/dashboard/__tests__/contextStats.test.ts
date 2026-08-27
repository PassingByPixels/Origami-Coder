// Context manager — unit tests for the cross-session tracker's aggregation.
// The load-bearing behaviour is the MERGE across TWO payload shapes: usageUpdate
// (real token breakdown + current occupancy, size 0 for local) and contextUpdate
// (turns + probed window). A field absent from one shape must keep its prior
// value — else every frame would zero the other shape's numbers.

import { describe, it, expect } from 'vitest';
import {
  mergeContextStat,
  ctxPct,
  ctxLevel,
  fmtTokens,
  sumContext,
  EMPTY_CTX,
  type CtxStat,
} from '../../shared/contextStats';

describe('mergeContextStat', () => {
  it('folds a usageUpdate: real breakdown + used->contextUsed, size 0 does NOT set a window', () => {
    const s = mergeContextStat(undefined, { used: 1360, size: 0, prefill: 1200, read: 160, write: 240 });
    expect(s.contextUsed).toBe(1360);
    expect(s.prefill).toBe(1200);
    expect(s.read).toBe(160);
    expect(s.write).toBe(240);
    expect(s.contextTotal).toBe(0); // size 0 (local, no limit) must not become the window
  });

  it('folds a contextUpdate onto the same stat WITHOUT zeroing the token breakdown', () => {
    const prev: CtxStat = { contextUsed: 1360, contextTotal: 0, prefill: 1200, read: 160, write: 240, turns: 1 };
    // contextUpdate carries turns + probed window only — the token fields are absent.
    const next = mergeContextStat(prev, { turns: 2, contextWindow: 8000 });
    expect(next.prefill).toBe(1200);   // kept, NOT zeroed
    expect(next.read).toBe(160);       // kept
    expect(next.write).toBe(240);      // kept
    expect(next.contextTotal).toBe(8000);
    expect(next.turns).toBe(2);
  });

  it('accumulation is driven by the host; merge just carries the latest cumulative value', () => {
    let s = mergeContextStat(undefined, { used: 500, prefill: 450, read: 0, write: 50 });
    s = mergeContextStat(s, { used: 1400, prefill: 1300, read: 0, write: 100 });
    expect(s.prefill).toBe(1300); // host sends cumulative; merge takes it as-is
    expect(s.write).toBe(100);
    expect(s.contextUsed).toBe(1400);
  });

  it('a contextUpdate carrying contextUsed:0 (controller not tracking) does NOT wipe real occupancy', () => {
    const prev: CtxStat = { contextUsed: 1360, contextTotal: 8000, prefill: 1200, read: 0, write: 240, turns: 1 };
    // pollControllerState posts contextUsed:0 on a local model that doesn't
    // report it — must keep the real 1360 from the prior usageUpdate.
    const next = mergeContextStat(prev, { turns: 2, contextUsed: 0, contextTotal: 0, contextWindow: 8000 });
    expect(next.contextUsed).toBe(1360);
    expect(next.contextTotal).toBe(8000);
  });

  it('a positive size sets the window; contextTotal/contextWindow still win over it', () => {
    expect(mergeContextStat(undefined, { size: 4096 }).contextTotal).toBe(4096);
    expect(mergeContextStat(undefined, { size: 4096, contextWindow: 8000 }).contextTotal).toBe(8000);
  });

  it('ignores non-numeric / NaN fields rather than clobbering with them', () => {
    const prev: CtxStat = { contextUsed: 200, contextTotal: 8000, prefill: 150, read: 0, write: 50, turns: 2 };
    const next = mergeContextStat(prev, { prefill: 'lots' as unknown as number, write: NaN });
    expect(next.prefill).toBe(150);
    expect(next.write).toBe(50);
  });
});

describe('ctxPct', () => {
  it('is 0 when the window size or usage is unknown', () => {
    expect(ctxPct(EMPTY_CTX)).toBe(0);
    expect(ctxPct({ ...EMPTY_CTX, contextUsed: 500 })).toBe(0); // total 0
    expect(ctxPct(undefined)).toBe(0);
  });

  it('rounds the fill fraction and caps at 100', () => {
    expect(ctxPct({ ...EMPTY_CTX, contextUsed: 4000, contextTotal: 8000 })).toBe(50);
    expect(ctxPct({ ...EMPTY_CTX, contextUsed: 5001, contextTotal: 8000 })).toBe(63);
    expect(ctxPct({ ...EMPTY_CTX, contextUsed: 9000, contextTotal: 8000 })).toBe(100); // over-full clamps
  });
});

describe('ctxLevel', () => {
  it('bands at 60 and 80 like the InputBar gauge', () => {
    expect(ctxLevel(0)).toBe('low');
    expect(ctxLevel(59)).toBe('low');
    expect(ctxLevel(60)).toBe('mid');
    expect(ctxLevel(79)).toBe('mid');
    expect(ctxLevel(80)).toBe('high');
    expect(ctxLevel(100)).toBe('high');
  });
});

describe('fmtTokens', () => {
  it('formats plain / k / M with no trailing .0', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(-5)).toBe('0');
    expect(fmtTokens(940)).toBe('940');
    expect(fmtTokens(1200)).toBe('1.2k');
    expect(fmtTokens(12300)).toBe('12k');
    expect(fmtTokens(1_500_000)).toBe('1.5M');
  });
});

describe('sumContext', () => {
  it('sums prefill / read / write and turns across sessions', () => {
    const stats: Record<string, CtxStat> = {
      a: { contextUsed: 0, contextTotal: 8000, prefill: 1000, read: 200, write: 300, turns: 2 },
      b: { contextUsed: 0, contextTotal: 8000, prefill: 500, read: 0, write: 100, turns: 1 },
    };
    expect(sumContext(stats)).toEqual({ prefill: 1500, read: 200, write: 400, turns: 3, sessions: 2 });
  });

  it('is all-zero for an empty map', () => {
    expect(sumContext({})).toEqual({ prefill: 0, read: 0, write: 0, turns: 0, sessions: 0 });
  });
});
