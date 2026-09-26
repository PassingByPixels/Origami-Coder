// elasticParkPolicy.test.ts — t-w2txb2: WHEN an idle engine is parked (src/elastic/parkPolicy.ts) and the
// activity tracker acting on it (src/elastic/activityTracker.ts), against fake engines that speak the
// `_elastic_idle_report` wire (engine elastic/idle.ts, docs/ELASTIC_EXT_METHODS.md).
//
// Owner decisions under test: park only when the engine's report says parkable (every veto reason but an armed
// cache warm); t-z6ytkw (2026-09-26): at the user's Park-after time whatever the provider cache life (cacheColdAt
// no longer waits); a provider with no published window parks only after the long untimed delay; a chat on
// screen, on the phone, or holding work (a /loop) never parks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIET, type EngineSignals } from '../../../src/elastic/activityClass';
import { ActivityTracker, type ElasticSettings, type EngineView } from '../../../src/elastic/activityTracker';
import { parkVerdict } from '../../../src/elastic/parkPolicy';

const MIN = 60_000;
const S = { parkAfterMs: 60 * MIN, parkUntimedAfterMs: 120 * MIN };
const Q0 = 1_000_000;

/** Every reason the engine can report (engine elastic/idle.ts REASONS), in its order. */
const REASONS = ['turn-running', 'subagent-running', 'background-job', 'permission-pending', 'question-pending', 'task-result-pending', 'flock-lease', 'nest-lease', 'collab-run', 'warm-pending'];

describe('parkVerdict (pure)', () => {
  const clear = { parkable: true, reasons: [] };

  it('parks a parkable engine that has been quiet long enough and whose cache is cold', () => {
    expect(parkVerdict({ ...clear, cacheColdAt: Q0 }, Q0 + 60 * MIN, Q0, S)).toEqual({ park: true });
    expect(parkVerdict(clear, Q0 + 60 * MIN, Q0, S)).toEqual({ park: true }); // no request in this process: no cache to lose
  });

  for (const reason of REASONS.filter((r) => r !== 'warm-pending')) {
    it(`never parks while the engine reports ${reason}`, () => {
      const v = parkVerdict({ parkable: false, reasons: [reason] }, Q0 + 5 * 60 * MIN, Q0, S);
      expect(v.park).toBe(false);
      expect(v.park === false && v.why).toBe(reason);
      expect(v.park === false && v.retryAt).toBe(Q0 + 5 * 60 * MIN + S.parkAfterMs);
    });
  }

  it('the flock lease holder never parks, and a report with no reasons but parkable:false does not either', () => {
    expect(parkVerdict({ parkable: false, reasons: ['flock-lease'] }, Q0 + 999 * MIN, Q0, S).park).toBe(false);
    expect(parkVerdict({ parkable: false, reasons: [] }, Q0 + 999 * MIN, Q0, S).park).toBe(false);
  });

  it('no report (the engine did not answer) is not evidence of idleness', () => {
    expect(parkVerdict(undefined, Q0 + 999 * MIN, Q0, S).park).toBe(false);
  });

  it('t-z6ytkw: parks at the Park-after time even while the provider cache is alive (no cacheColdAt wait)', () => {
    const cold = Q0 + 108 * MIN; // Anthropic 1 h form: 108 min after the last real request
    expect(parkVerdict({ ...clear, cacheColdAt: cold }, Q0 + 30 * MIN, Q0, S)).toEqual({ park: false, why: 'not quiet long enough', retryAt: Q0 + 60 * MIN });
    expect(parkVerdict({ ...clear, cacheColdAt: cold }, Q0 + 60 * MIN, Q0, S)).toEqual({ park: true });
  });

  it('t-z6ytkw: an armed cache warm alone does not hold the park (the warm schedule goes with the park); with other work it does', () => {
    expect(parkVerdict({ parkable: false, reasons: ['warm-pending'], cacheColdAt: Q0 + 108 * MIN }, Q0 + 60 * MIN, Q0, S)).toEqual({ park: true });
    const v = parkVerdict({ parkable: false, reasons: ['warm-pending', 'background-job'] }, Q0 + 60 * MIN, Q0, S);
    expect(v.park === false && v.why).toBe('background-job');
  });

  it('a provider with no published window (local, DeepSeek) parks only after the untimed delay, never by time alone', () => {
    const untimed = { ...clear, cacheUntimed: true };
    expect(parkVerdict(untimed, Q0 + 60 * MIN, Q0, S)).toEqual({ park: false, why: 'the provider publishes no cache window', retryAt: Q0 + 120 * MIN });
    expect(parkVerdict(untimed, Q0 + 120 * MIN, Q0, S)).toEqual({ park: true });
    // both kinds in one engine: the untimed delay, and no cacheColdAt wait (t-z6ytkw)
    expect(parkVerdict({ ...untimed, cacheColdAt: Q0 + 24 * 60 * MIN }, Q0 + 60 * MIN, Q0, S).park).toBe(false);
    expect(parkVerdict({ ...untimed, cacheColdAt: Q0 + 24 * 60 * MIN }, Q0 + 120 * MIN, Q0, S).park).toBe(true);
  });

  it('parkAfterMinutes 0 turns parking off', () => {
    expect(parkVerdict(clear, Q0 + 9999 * MIN, Q0, { parkAfterMs: 0, parkUntimedAfterMs: 0 })).toEqual({ park: false, why: 'parking is off', retryAt: null });
  });
});

// ------------------------------------------------------------------------------------------ the tracker

class FakeEngine {
  calls: string[] = [];
  report: Record<string, unknown> = { parkable: true, reasons: [] };
  async extMethod(method: string): Promise<Record<string, unknown>> {
    this.calls.push(method);
    if (method === '_elastic_idle_report') return this.report;
    if (method === '_elastic_trim') return { trimmed: true };
    return {};
  }
  count(method: string) { return this.calls.filter((m) => m === method).length; }
}

let settings: ElasticSettings;
const log: string[] = [];

function setup(e: FakeEngine, signals: () => Partial<EngineSignals>, park?: () => Promise<string | null>) {
  const tracker = new ActivityTracker({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    settings: () => settings,
    log: (l) => void log.push(l),
  });
  let parked = false;
  const views = (): EngineView[] => (parked ? [] : [{ key: e, client: e, label: 'chat 1', ready: true, signals: { ...QUIET, ...signals() }, ...(park ? { park: async () => { const why = await park(); if (why === null) parked = true; return why; } } : {}) }]);
  tracker.attach({ engines: views });
  return tracker;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  settings = { enabled: true, idleAfterMs: 5 * MIN, trimAfterMs: 0, retrimMs: 10 * MIN, parkAfterMs: 60 * MIN, parkUntimedAfterMs: 120 * MIN };
  log.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('the tracker parks an idle engine per the policy', () => {
  it('parks once, after parkAfterMinutes hidden and quiet, with a FRESH report', async () => {
    const e = new FakeEngine();
    const park = vi.fn(async () => null);
    setup(e, () => ({}), park);
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(park).not.toHaveBeenCalled();
    const reportsBefore = e.count('_elastic_idle_report');
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(park).toHaveBeenCalledTimes(1);
    expect(e.count('_elastic_idle_report')).toBe(reportsBefore + 1);
    await vi.advanceTimersByTimeAsync(300 * MIN);
    expect(park).toHaveBeenCalledTimes(1);
  });

  it('t-z6ytkw: parks at parkAfterMinutes while the provider cache is alive and a warm is armed', async () => {
    const e = new FakeEngine();
    e.report = { parkable: false, reasons: ['warm-pending'], cacheColdAt: 108 * MIN };
    const park = vi.fn(async () => null);
    setup(e, () => ({}), park);
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(park).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(park).toHaveBeenCalledTimes(1);
  });

  it('an engine that holds work (e.g. a warm armed, or the flock lease) is asked again one period later, not in a loop', async () => {
    const e = new FakeEngine();
    e.report = { parkable: false, reasons: ['flock-lease'] };
    const park = vi.fn(async () => null);
    setup(e, () => ({}), park);
    await vi.advanceTimersByTimeAsync(200 * MIN);
    expect(park).not.toHaveBeenCalled();
    // idle confirmation + park attempts at ~60, ~120, ~180 min: a handful, never a loop
    expect(e.count('_elastic_idle_report')).toBeLessThan(8);
    e.report = { parkable: true, reasons: [] };
    await vi.advanceTimersByTimeAsync(61 * MIN);
    expect(park).toHaveBeenCalledTimes(1);
  });

  it('a chat on screen or on the phone never parks', async () => {
    for (const s of [{ onScreen: true }, { phone: true }]) {
      const e = new FakeEngine();
      const park = vi.fn(async () => null);
      const t = setup(e, () => s, park);
      await vi.advanceTimersByTimeAsync(500 * MIN);
      expect(park).not.toHaveBeenCalled();
      t.dispose();
    }
  });

  it('a chat holding work (an armed /loop, a pending ask, a running turn) never parks', async () => {
    for (const s of [{ loopArmed: true }, { pendingAsk: true }, { turnBusy: true }, { runningChildren: true }]) {
      const e = new FakeEngine();
      const park = vi.fn(async () => null);
      const t = setup(e, () => s, park);
      await vi.advanceTimersByTimeAsync(500 * MIN);
      expect(park).not.toHaveBeenCalled();
      t.dispose();
    }
  });

  it('a chat that comes back on screen before the park is not parked', async () => {
    const e = new FakeEngine();
    let s: Partial<EngineSignals> = {};
    const park = vi.fn(async () => null);
    const t = setup(e, () => s, park);
    await vi.advanceTimersByTimeAsync(50 * MIN);
    s = { onScreen: true };
    t.poke();
    await vi.advanceTimersByTimeAsync(200 * MIN);
    expect(park).not.toHaveBeenCalled();
  });

  it('an engine with no park hook (the host engine) is never parked; parking off parks nothing', async () => {
    const e = new FakeEngine();
    setup(e, () => ({}));
    await vi.advanceTimersByTimeAsync(500 * MIN);
    expect(log.some((l) => /parked/.test(l))).toBe(false);
    settings = { ...settings, parkAfterMs: 0 };
    const e2 = new FakeEngine();
    const park = vi.fn(async () => null);
    setup(e2, () => ({}), park);
    await vi.advanceTimersByTimeAsync(500 * MIN);
    expect(park).not.toHaveBeenCalled();
  });

  it('a refused park (the engine\'s own last check) is tried again one period later', async () => {
    const e = new FakeEngine();
    const answers: Array<string | null> = ['the engine refused: permission-pending', null];
    const park = vi.fn(async () => answers.shift() ?? null);
    setup(e, () => ({}), park);
    await vi.advanceTimersByTimeAsync(61 * MIN);
    expect(park).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61 * MIN);
    expect(park).toHaveBeenCalledTimes(2);
  });
});

// ------------------------------------------------------------------------------------------ t-wdyi2t
// review_extension-lifecycle.md #1 (a park leaves no tracker timer behind), #5 (the host engine parks after
// its own shorter delay), #9 (a finished fold parks as soon as it is hidden, never while shown).

describe('review fixes: the tracker around a park', () => {
  /** A chat engine the tracker can park and that can be started again. While parked it is no view (as
   *  engineViews does) and any call to it fails fast (as AcpClient does for `_elastic_*`), marked "(parked)". */
  function parkable(extra: Partial<EngineView> = {}, why: () => string | null = () => null) {
    const e = new FakeEngine();
    let up = true;
    let s: Partial<EngineSignals> = {};
    const real = e.extMethod.bind(e);
    e.extMethod = async (m: string) => {
      if (!up) { e.calls.push(`${m} (parked)`); throw new Error('AcpClient.extMethod called before start()'); }
      return real(m);
    };
    const park = vi.fn(async () => { const w = why(); if (w === null) up = false; return w; });
    const tracker = new ActivityTracker({
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      settings: () => settings,
      log: (l) => void log.push(l),
    });
    tracker.attach({ engines: () => (up ? [{ key: e, client: e, label: 'chat 1', ready: true, signals: { ...QUIET, ...s }, park, ...extra }] : []) });
    return {
      e, tracker, park,
      restore: () => { up = true; tracker.poke(); },
      show: (v: Partial<EngineSignals>) => { s = v; tracker.poke(); },
    };
  }

  it('#1 after a park no trim, report or class reaches the parked engine, and its restored engine gets its class again', async () => {
    const c = parkable();
    await vi.advanceTimersByTimeAsync(61 * MIN);
    expect(c.park).toHaveBeenCalledTimes(1);
    const n = c.e.calls.length;
    await vi.advanceTimersByTimeAsync(60 * MIN); // a quiet window: nothing pokes the tracker
    expect(c.e.calls.slice(n)).toEqual([]);
    c.restore();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.e.calls.slice(n)).toContain('_elastic_class');
  });

  it('#5 an engine view with its own park delay (the host engine: 10 min) parks after that delay, and not when parking is off', async () => {
    const c = parkable({ label: 'host engine', parkAfterMs: 10 * MIN });
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(c.park).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(c.park).toHaveBeenCalledTimes(1);
    settings = { ...settings, parkAfterMs: 0 };
    const off = parkable({ label: 'host engine', parkAfterMs: 10 * MIN });
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(off.park).not.toHaveBeenCalled();
  });

  it('#9 a finished fold (parkSoon) is not parked while a view shows it, and is parked as soon as it is hidden', async () => {
    const c = parkable({ parkSoon: true });
    c.show({ onScreen: true });
    await vi.advanceTimersByTimeAsync(90 * MIN);
    expect(c.park).not.toHaveBeenCalled();
    c.show({});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.park).toHaveBeenCalledTimes(1);
  });

  it('#9 ... but not while it holds work, and a refused park is not retried in a loop', async () => {
    const c = parkable({ parkSoon: true }, () => 'the engine refused: background-job');
    c.show({ runningChildren: true });
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(c.park).not.toHaveBeenCalled();
    c.show({});
    for (let i = 0; i < 100; i++) { c.tracker.poke(); await vi.advanceTimersByTimeAsync(300); }
    expect(c.park.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(c.park.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
