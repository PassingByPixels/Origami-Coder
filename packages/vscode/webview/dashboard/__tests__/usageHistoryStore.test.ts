// usageHistoryStore — the four decisions every sample forces.
//
// What is worth catching here is all of one kind: a store that quietly says
// something the readings do not support. A cycle that swallows the previous
// one's samples makes a 7-day window look like a 14-day window. A sample
// recorded every second makes a front-load warning out of a burst of triggers.
// A truncated list deletes exactly the start of the window the front-load
// warning is computed from.

import { describe, expect, it } from 'vitest';
import {
  CYCLE_DRIFT_MS,
  EMPTY_STORE,
  MAX_SAMPLES,
  MIN_SAMPLE_GAP_MS,
  applySample,
  readStore,
  thin,
  type UsageHistoryStore,
} from '../../../src/dashboard/usageHistoryStore';

const T0 = 1_786_874_400_000;
const WEEK = 7 * 86_400_000;
const win = (pct: number, resetsAt: number) => ({ label: 'Weekly', usedPercent: pct, resetsAt });
const lane = (s: UsageHistoryStore) => s.providers['openai']!.windows['Weekly']!;

describe('applySample — recording one reading', () => {
  it('starts a window with the first reading it can place', () => {
    const s = applySample(EMPTY_STORE, 'openai', win(4, T0 + WEEK), T0);
    expect(lane(s).resetsAt).toBe(T0 + WEEK);
    expect(lane(s).samples).toEqual([{ t: T0, pct: 4 }]);
    expect(lane(s).previous).toBeUndefined();
  });

  it('refuses a window with no reset time rather than storing it at epoch 0', () => {
    // Without a window end there is no length, no fair pace and no projection.
    // The percentage alone has nothing to be measured against.
    const s = applySample(EMPTY_STORE, 'openai', { label: 'Credits', usedPercent: 40 }, T0);
    expect(s).toBe(EMPTY_STORE);
  });

  it('keeps windows of the same provider apart', () => {
    let s = applySample(EMPTY_STORE, 'openai', win(4, T0 + WEEK), T0);
    s = applySample(s, 'openai', { label: '5-hour', usedPercent: 60, resetsAt: T0 + 3_600_000 }, T0);
    expect(Object.keys(s.providers['openai']!.windows)).toEqual(['Weekly', '5-hour']);
    expect(s.providers['openai']!.windows['5-hour']!.samples).toEqual([{ t: T0, pct: 60 }]);
  });
});

describe('applySample — what the PROVIDER stated about the window', () => {
  // THE BUG THIS ROUND FIXED. Grok states a period start and end; the parser read
  // only the end, so the view had a reset with no length, assumed thirty days and
  // drew a weekly window at 78% of a month. The store now carries whichever of
  // the two the provider actually said.
  const stated = (over: Record<string, number>) => ({ label: 'Weekly', usedPercent: 14, resetsAt: T0 + WEEK, ...over });

  it('records a stated start and a stated length beside the reset', () => {
    const s = applySample(EMPTY_STORE, 'openai', stated({ startsAt: T0, lengthMs: WEEK }), T0);
    expect(lane(s).startsAt).toBe(T0);
    expect(lane(s).lengthMs).toBe(WEEK);
  });

  it('OMITS them when the engine sent nothing, rather than writing zeroes', () => {
    // An engine that predates the fields simply leaves them off. A stored 0
    // would be a length the view's ladder then has to defend itself against.
    const s = applySample(EMPTY_STORE, 'openai', win(4, T0 + WEEK), T0);
    expect('startsAt' in lane(s)).toBe(false);
    expect('lengthMs' in lane(s)).toBe(false);
    const zeroed = applySample(EMPTY_STORE, 'openai', stated({ startsAt: 0, lengthMs: 0 }), T0);
    expect('startsAt' in lane(zeroed)).toBe(false);
    expect('lengthMs' in lane(zeroed)).toBe(false);
  });

  it('refreshes them on a same-cycle sample, as `resetsAt` already is', () => {
    // A rolling window's start moves with its end; the newest read is the one
    // the view should use.
    let s = applySample(EMPTY_STORE, 'openai', stated({ startsAt: T0 }), T0);
    s = applySample(s, 'openai', stated({ startsAt: T0 + 30_000 }), T0 + MIN_SAMPLE_GAP_MS);
    expect(lane(s).startsAt).toBe(T0 + 30_000);
    expect(lane(s).samples).toHaveLength(2);
  });

  it('carries them onto the NEW cycle at a roll-over', () => {
    let s = applySample(EMPTY_STORE, 'openai', stated({ startsAt: T0, lengthMs: WEEK }), T0);
    s = applySample(s, 'openai', { label: 'Weekly', usedPercent: 2, resetsAt: T0 + 2 * WEEK, startsAt: T0 + WEEK, lengthMs: WEEK }, T0 + WEEK + 60_000);
    expect(lane(s).startsAt).toBe(T0 + WEEK);
    expect(lane(s).previous!.resetsAt).toBe(T0 + WEEK);
  });

  it('survives a round trip through readStore', () => {
    const s = applySample(EMPTY_STORE, 'openai', stated({ startsAt: T0, lengthMs: WEEK }), T0);
    const back = readStore(JSON.parse(JSON.stringify(s)));
    expect(back.providers['openai']!.windows['Weekly']!.startsAt).toBe(T0);
    expect(back.providers['openai']!.windows['Weekly']!.lengthMs).toBe(WEEK);
    // A garbage value written by some other build is dropped, not trusted.
    const dirty = JSON.parse(JSON.stringify(s));
    dirty.providers.openai.windows.Weekly.lengthMs = 'a week';
    expect(readStore(dirty).providers['openai']!.windows['Weekly']!.lengthMs).toBeUndefined();
  });
});

describe('applySample — the 2-minute floor', () => {
  it('ignores a second reading taken inside two minutes', () => {
    // Panel-open, view-open and the timer can land together. Three points one
    // second apart describe nothing the first point does not.
    const first = applySample(EMPTY_STORE, 'openai', win(4, T0 + WEEK), T0);
    const again = applySample(first, 'openai', win(9, T0 + WEEK), T0 + MIN_SAMPLE_GAP_MS - 1);
    expect(again).toBe(first);
    expect(lane(again).samples).toHaveLength(1);
  });

  it('records one taken exactly on the floor', () => {
    const first = applySample(EMPTY_STORE, 'openai', win(4, T0 + WEEK), T0);
    const s = applySample(first, 'openai', win(9, T0 + WEEK), T0 + MIN_SAMPLE_GAP_MS);
    expect(lane(s).samples).toEqual([{ t: T0, pct: 4 }, { t: T0 + MIN_SAMPLE_GAP_MS, pct: 9 }]);
  });

  it('a rolling end that drifts a few seconds is the SAME cycle, not a new one', () => {
    // A rolling window's end is computed from the moment of the request, so it
    // moves every read. Treating that as a reset would restart the series
    // several times an hour and erase every line on the chart.
    let s = applySample(EMPTY_STORE, 'openai', win(4, T0 + WEEK), T0);
    s = applySample(s, 'openai', win(9, T0 + WEEK + CYCLE_DRIFT_MS - 1), T0 + 600_000);
    expect(lane(s).samples).toHaveLength(2);
    expect(lane(s).previous).toBeUndefined();
    // The newest reported end wins — that is where the projection should aim.
    expect(lane(s).resetsAt).toBe(T0 + WEEK + CYCLE_DRIFT_MS - 1);
  });
});

describe('applySample — the roll-over', () => {
  it('moves the finished cycle to previous and starts a new one', () => {
    let s = applySample(EMPTY_STORE, 'openai', win(4, T0 + WEEK), T0);
    s = applySample(s, 'openai', win(61, T0 + WEEK), T0 + 3 * 86_400_000);
    s = applySample(s, 'openai', win(2, T0 + 2 * WEEK), T0 + WEEK + 60_000);

    expect(lane(s).resetsAt).toBe(T0 + 2 * WEEK);
    expect(lane(s).samples).toEqual([{ t: T0 + WEEK + 60_000, pct: 2 }]);
    // The whole closed cycle is kept: reset-to-reset IS the window length, and
    // that is what the next cycle's length is measured from.
    expect(lane(s).previous!.resetsAt).toBe(T0 + WEEK);
    expect(lane(s).previous!.samples).toHaveLength(2);
  });

  it('keeps ONE previous cycle, not a chain', () => {
    let s = applySample(EMPTY_STORE, 'openai', win(4, T0 + WEEK), T0);
    s = applySample(s, 'openai', win(4, T0 + 2 * WEEK), T0 + WEEK);
    s = applySample(s, 'openai', win(4, T0 + 3 * WEEK), T0 + 2 * WEEK);
    expect(lane(s).previous!.resetsAt).toBe(T0 + 2 * WEEK);
    expect((lane(s).previous as { previous?: unknown }).previous).toBeUndefined();
  });

  it('a roll-over is not blocked by the 2-minute floor', () => {
    // A 5-hour window can reset between two reads taken a minute apart. Losing
    // that sample would leave the new cycle empty until the next pass.
    const first = applySample(EMPTY_STORE, 'openai', win(98, T0 + 60_000), T0);
    const s = applySample(first, 'openai', win(1, T0 + 60_000 + 5 * 3_600_000), T0 + 30_000);
    expect(s).not.toBe(first);
    expect(lane(s).samples).toEqual([{ t: T0 + 30_000, pct: 1 }]);
    expect(lane(s).previous!.samples).toEqual([{ t: T0, pct: 98 }]);
  });
});

describe('applySample — the cap', () => {
  it('thins past MAX_SAMPLES instead of growing without bound', () => {
    let s = EMPTY_STORE;
    for (let i = 0; i <= MAX_SAMPLES; i += 1) {
      s = applySample(s, 'openai', win(i / 10, T0 + WEEK), T0 + i * MIN_SAMPLE_GAP_MS);
    }
    expect(lane(s).samples.length).toBeLessThan(MAX_SAMPLES);
    // The SPAN survives the thinning — the start of the window is what a
    // front-load warning is computed from, so it must not be the part dropped.
    expect(lane(s).samples[0]!.t).toBe(T0);
    expect(lane(s).samples[lane(s).samples.length - 1]!.t).toBe(T0 + MAX_SAMPLES * MIN_SAMPLE_GAP_MS);
  });

  it('thin() halves the oldest half and keeps the newest half whole', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ t: i, pct: i }));
    // 5 oldest -> indices 0, 2, 4; 5 newest kept entire.
    expect(thin(samples).map((s) => s.t)).toEqual([0, 2, 4, 5, 6, 7, 8, 9]);
  });
});

describe('readStore — anything on disk becomes something drawable', () => {
  it('rejects a shape from another build rather than half-reading it', () => {
    expect(readStore(undefined)).toEqual(EMPTY_STORE);
    expect(readStore({ version: 2, providers: {} })).toEqual(EMPTY_STORE);
    expect(readStore('nonsense')).toEqual(EMPTY_STORE);
  });

  it('drops the unreadable parts and keeps the rest', () => {
    const raw = {
      version: 1,
      providers: {
        openai: {
          windows: {
            Weekly: { resetsAt: T0 + WEEK, samples: [{ t: T0, pct: 4 }, { t: 'x' }, { pct: 9 }] },
            Broken: { samples: [] },
          },
        },
        empty: { windows: { Bad: {} } },
      },
    };
    const s = readStore(raw);
    expect(Object.keys(s.providers)).toEqual(['openai']);
    expect(Object.keys(s.providers['openai']!.windows)).toEqual(['Weekly']);
    expect(s.providers['openai']!.windows['Weekly']!.samples).toEqual([{ t: T0, pct: 4 }]);
  });

  it('a round trip through JSON is the same store', () => {
    let s = applySample(EMPTY_STORE, 'openai', win(4, T0 + WEEK), T0);
    s = applySample(s, 'openai', win(40, T0 + 2 * WEEK), T0 + WEEK);
    expect(readStore(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});
