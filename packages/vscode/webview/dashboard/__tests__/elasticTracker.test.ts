// t-w2qv3o — the activity tracker (src/elastic/activityTracker.ts) against FAKE engines that speak
// the t-w2qlop wire (`_elastic_class`, `_elastic_trim`, `_elastic_idle_report`). The bugs each block
// catches:
//
// - a class sent on every poke (a streaming turn pokes many times a second) instead of once per change;
// - a trim sent to an engine that is not idle, or a refused trim retried in a tight loop;
// - an idle class given to an engine that still runs a background job (only the engine knows);
// - an OLD engine binary ("method not found") asked again and again;
// - a slow or stuck engine that blocks poke() / the extension host, or blocks the next change;
// - turning the setting off leaving engines at a lowered class.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIET, type EngineSignals } from '../../../src/elastic/activityClass';
import { ActivityTracker, EVALUATE_DEBOUNCE_MS, isMissingMethod, reportVetoesIdle, type ElasticSettings, type EngineView } from '../../../src/elastic/activityTracker';

const MIN = 60_000;

type Reply = Record<string, unknown> | Error | 'hang';

class FakeEngine {
  public calls: Array<[string, Record<string, unknown> | undefined]> = [];
  /** Per method, the replies to give in order; the last one repeats. */
  public replies: Record<string, Reply[]> = {};
  public delayMs = 0;
  async extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push([method, params]);
    const list = this.replies[method] ?? [];
    const reply = list.length > 1 ? list.shift()! : list[0] ?? {};
    if (reply === 'hang') return new Promise(() => undefined);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (reply instanceof Error) throw reply;
    return reply;
  }
  classes(): unknown[] { return this.calls.filter(([m]) => m === '_elastic_class').map(([, p]) => p?.['class']); }
  count(method: string): number { return this.calls.filter(([m]) => m === method).length; }
}

function missing(): Error { return Object.assign(new Error('Method not found'), { code: -32601 }); }

let settings: ElasticSettings;
const log: string[] = [];

function setup(views: () => EngineView[]) {
  const tracker = new ActivityTracker({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    settings: () => settings,
    log: (l) => void log.push(l),
  });
  tracker.attach({ engines: views });
  return tracker;
}

function view(engine: FakeEngine, signals: () => Partial<EngineSignals>, ready = () => true): () => EngineView {
  return () => ({ key: engine, client: engine, label: 'chat 1', ready: ready(), signals: { ...QUIET, ...signals() } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  settings = { enabled: true, idleAfterMs: 5 * MIN, trimAfterMs: 0, retrimMs: 10 * MIN }; // the shipped defaults
  log.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('_elastic_class: once per change, debounced', () => {
  it('a burst of pokes sends ONE class; the next real change sends one more; no change sends nothing', async () => {
    const e = new FakeEngine();
    let s: Partial<EngineSignals> = { onScreen: true };
    const t = setup(() => [view(e, () => s)()]);
    for (let i = 0; i < 50; i++) t.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(e.classes()).toEqual(['active']);
    for (let i = 0; i < 50; i++) t.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS * 4);
    expect(e.classes()).toEqual(['active']);
    s = {}; // tab hidden
    t.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(e.classes()).toEqual(['active', 'background']);
  });

  it('a flip hidden -> shown inside the debounce window sends nothing', async () => {
    const e = new FakeEngine();
    let s: Partial<EngineSignals> = { onScreen: true };
    const t = setup(() => [view(e, () => s)()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    s = {}; t.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS / 2);
    s = { onScreen: true }; t.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS * 2);
    expect(e.classes()).toEqual(['active']);
  });

  it('an engine still starting is told nothing until it is ready', async () => {
    const e = new FakeEngine();
    let ready = false;
    const t = setup(() => [view(e, () => ({}), () => ready)()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(e.calls).toEqual([]);
    ready = true; t.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(e.classes()).toEqual(['background']);
  });
});

describe('idle: confirmed by the engine, then trimmed (defaults: idle 5 min, trim at idle, re-trim 10 min)', () => {
  it('hidden and quiet: background, idle after the idle delay (engine agrees), the trim goes out at that point, re-trim every retrim period', async () => {
    const e = new FakeEngine();
    e.replies['_elastic_idle_report'] = [{ parkable: true, reasons: [] }];
    e.replies['_elastic_trim'] = [{ trimmed: true, workingSetBefore: 700 * 1048576, workingSetAfter: 90 * 1048576 }];
    setup(() => [view(e, () => ({}))()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(e.classes()).toEqual(['background']);
    await vi.advanceTimersByTimeAsync(5 * MIN - 1000);
    expect(e.count('_elastic_idle_report')).toBe(0);
    expect(e.count('_elastic_trim')).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(e.count('_elastic_idle_report')).toBe(1);
    expect(e.classes()).toEqual(['background', 'idle']);
    expect(e.count('_elastic_trim')).toBe(1);
    expect(log.join('\n')).toMatch(/trimmed 700 MB -> 90 MB/);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(e.count('_elastic_trim')).toBe(2);
  });

  it('a trim delay from the setting is honoured (trimAfterMinutes > 0)', async () => {
    settings = { ...settings, trimAfterMs: 10 * MIN };
    const e = new FakeEngine();
    e.replies['_elastic_idle_report'] = [{ parkable: true }];
    e.replies['_elastic_trim'] = [{ trimmed: true }];
    setup(() => [view(e, () => ({}))()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS + 5 * MIN);
    expect(e.classes()).toEqual(['background', 'idle']);
    await vi.advanceTimersByTimeAsync(10 * MIN - 1000);
    expect(e.count('_elastic_trim')).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(e.count('_elastic_trim')).toBe(1);
  });

  it('never a trim within 2 min of the last turn end the HOST saw (idle set to 1 min)', async () => {
    settings = { ...settings, idleAfterMs: 1 * MIN };
    const e = new FakeEngine();
    e.replies['_elastic_idle_report'] = [{ parkable: true }];
    e.replies['_elastic_trim'] = [{ trimmed: true }];
    let s: Partial<EngineSignals> = { engineBusy: true };
    const t = setup(() => [view(e, () => s)()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    s = {};
    t.poke(); // the turn is seen ending at 500 ms
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS + 1 * MIN);
    expect(e.classes()).toEqual(['background', 'idle']); // idle after 1 min ...
    expect(e.count('_elastic_trim')).toBe(0); // ... but no trim yet
    await vi.advanceTimersByTimeAsync(1 * MIN - 1000);
    expect(e.count('_elastic_trim')).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(e.count('_elastic_trim')).toBe(1); // 2 min after the turn end
  });

  it('never a trim within 2 min of a turn only the ENGINE saw (idle report lastRequestAt, e.g. a collab turn in the host engine)', async () => {
    const e = new FakeEngine();
    e.replies['_elastic_idle_report'] = [{ parkable: true, lastRequestAt: 5 * MIN - 30_000 }];
    e.replies['_elastic_trim'] = [{ trimmed: true }];
    setup(() => [view(e, () => ({}))()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS + 5 * MIN);
    expect(e.classes()).toEqual(['background', 'idle']);
    expect(e.count('_elastic_trim')).toBe(0);
    // lastRequestAt + 2 min = 5 min + 90 s; now is 5 min + 250 ms.
    await vi.advanceTimersByTimeAsync(90_000 - EVALUATE_DEBOUNCE_MS - 1000);
    expect(e.count('_elastic_trim')).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(e.count('_elastic_trim')).toBe(1);
  });

  it('the engine reports running work (a background job): the class stays background and the report is asked again only after another idle period', async () => {
    const e = new FakeEngine();
    e.replies['_elastic_idle_report'] = [{ parkable: false, reasons: ['background job'] }, { parkable: true, reasons: [] }];
    setup(() => [view(e, () => ({}))()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS + 5 * MIN);
    expect(e.classes()).toEqual(['background']);
    expect(e.count('_elastic_idle_report')).toBe(1);
    expect(e.count('_elastic_trim')).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * MIN - 1000);
    expect(e.count('_elastic_idle_report')).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(e.count('_elastic_idle_report')).toBe(2);
    expect(e.classes()).toEqual(['background', 'idle']);
  });

  it('a refused trim (warm due) backs off and is never retried in a loop', async () => {
    const e = new FakeEngine();
    e.replies['_elastic_idle_report'] = [{ parkable: true }];
    e.replies['_elastic_trim'] = [{ trimmed: false, reason: 'cache warm due' }];
    setup(() => [view(e, () => ({}))()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS + 5 * MIN);
    expect(e.count('_elastic_trim')).toBe(1);
    expect(log.join('\n')).toMatch(/trim refused \(cache warm due\)/);
    // Back-off: 20 min, then 40, then capped at 60: three more tries in two hours, not hundreds.
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(e.count('_elastic_trim')).toBe(4);
  });

  it('t-z716d7: a trim answered unsupported-platform (macOS) is logged once and never retried, unlike an ordinary refusal', async () => {
    const e = new FakeEngine();
    e.replies['_elastic_idle_report'] = [{ parkable: true }];
    e.replies['_elastic_trim'] = [{ trimmed: false, reason: 'unsupported-platform' }];
    setup(() => [view(e, () => ({}))()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS + 5 * MIN);
    expect(e.count('_elastic_trim')).toBe(1);
    expect(log.join('\n')).toMatch(/trim not available on this platform/);
    // No 20-minute retry spam: hours pass, the count never moves again.
    await vi.advanceTimersByTimeAsync(180 * MIN);
    expect(e.count('_elastic_trim')).toBe(1);
  });

  it('a turn that ends with NO poke is still read: the hidden engine re-checks on its own and goes idle one idle period later', async () => {
    const e = new FakeEngine();
    e.replies['_elastic_idle_report'] = [{ parkable: true }];
    let s: Partial<EngineSignals> = { turnBusy: true };
    setup(() => [view(e, () => s)()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    s = {}; // turnBusy cleared in a `finally` after the last post: nobody pokes
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(e.classes()).toEqual(['background', 'idle']);
  });

  it('pokes while a trim is out never start a second trim', async () => {
    const e = new FakeEngine();
    e.replies['_elastic_idle_report'] = [{ parkable: true }];
    e.replies['_elastic_trim'] = [{ trimmed: true }];
    e.delayMs = 3000;
    const t = setup(() => [view(e, () => ({}))()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS + 5 * MIN + 3000);
    expect(e.count('_elastic_trim')).toBe(1); // out now, answers in 3 s
    for (let i = 0; i < 5; i++) { t.poke(); await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS); }
    await vi.advanceTimersByTimeAsync(3000);
    expect(e.count('_elastic_trim')).toBe(1);
  });

  it('an idle engine that starts work leaves idle at once and gets no further trim', async () => {
    const e = new FakeEngine();
    e.replies['_elastic_idle_report'] = [{ parkable: true }];
    e.replies['_elastic_trim'] = [{ trimmed: true }];
    let s: Partial<EngineSignals> = {};
    const t = setup(() => [view(e, () => s)()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS + 5 * MIN);
    expect(e.classes()).toEqual(['background', 'idle']);
    expect(e.count('_elastic_trim')).toBe(1);
    s = { turnBusy: true };
    t.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(e.classes()).toEqual(['background', 'idle', 'background']);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(e.count('_elastic_trim')).toBe(1);
  });

  it('a pass that meets a throwing settings store logs and does not throw out of the timer', async () => {
    let broken = true;
    const e = new FakeEngine();
    const tracker = new ActivityTracker({
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      settings: () => { if (broken) throw new Error('no settings store'); return settings; },
      log: (l) => void log.push(l),
    });
    tracker.attach({ engines: () => [view(e, () => ({}))()] });
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(log.join('\n')).toMatch(/pass failed: no settings store/);
    broken = false;
    tracker.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(e.classes()).toEqual(['background']);
  });
});

describe('leaving idle is raised from OUTSIDE first (an IDLE-priority engine may not get a CPU to read the message)', () => {
  it('raise(pid, class) runs once, before the _elastic_class that leaves idle; never on other moves', async () => {
    const order: string[] = [];
    const e = new FakeEngine();
    e.replies['_elastic_idle_report'] = [{ parkable: true }];
    const orig = e.extMethod.bind(e);
    e.extMethod = async (m, p) => { if (m === '_elastic_class') order.push('class:' + String(p?.['class'])); return orig(m, p); };
    let s: Partial<EngineSignals> = {};
    const t = new ActivityTracker({
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
      settings: () => settings,
      log: () => undefined,
      raise: (pid, cls) => void order.push('raise:' + pid + ':' + cls),
    });
    t.attach({ engines: () => [{ key: e, client: e, label: 'chat 1', ready: true, pid: 4242, signals: { ...QUIET, ...s } }] });
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS + 5 * MIN);
    expect(order).toEqual(['class:background', 'class:idle']);
    s = { onScreen: true };
    for (let i = 0; i < 5; i++) { t.poke(); await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS); }
    expect(order).toEqual(['class:background', 'class:idle', 'raise:4242:active', 'class:active']);
  });
});

describe('an older engine binary', () => {
  it('"method not found" on _elastic_class: nothing more is ever sent to that engine', async () => {
    const e = new FakeEngine();
    e.replies['_elastic_class'] = [missing()];
    let s: Partial<EngineSignals> = { onScreen: true };
    const t = setup(() => [view(e, () => s)()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    s = {}; t.poke();
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(e.calls.map(([m]) => m)).toEqual(['_elastic_class']);
    expect(log.join('\n')).toMatch(/engine has no _elastic_class; elastic calls stop/);
  });
  it('isMissingMethod reads both the JSON-RPC code and the message', () => {
    expect(isMissingMethod(missing())).toBe(true);
    expect(isMissingMethod(new Error('Method not found: _elastic_trim'))).toBe(true);
    expect(isMissingMethod(new Error('Internal error'))).toBe(false);
  });
});

describe('never blocks: every call is fire-and-forget', () => {
  it('a stuck engine: poke() returns at once, the other engine is still told, and the stuck one gets its latest class once it frees up', async () => {
    const stuck = new FakeEngine();
    stuck.replies['_elastic_class'] = ['hang', {}];
    const fine = new FakeEngine();
    let s: Partial<EngineSignals> = { onScreen: true };
    const t = setup(() => [
      { key: stuck, client: stuck, label: 'stuck', ready: true, signals: { ...QUIET, ...s } },
      { key: fine, client: fine, label: 'fine', ready: true, signals: { ...QUIET, ...s } },
    ]);
    for (let i = 0; i < 1000; i++) t.poke();
    // poke() does no engine I/O inline: nothing is asked until the debounced pass, off the caller's stack.
    expect(stuck.calls.length + fine.calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(fine.classes()).toEqual(['active']);
    s = {}; t.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(fine.classes()).toEqual(['active', 'background']);
    expect(stuck.classes()).toEqual(['active']); // one in flight, the change waits for it
    await vi.advanceTimersByTimeAsync(30_000); // the call time limit frees it
    expect(stuck.classes()).toEqual(['active', 'background']);
  });

  it('a slow engine (2 s per answer) never gets two calls in flight', async () => {
    const e = new FakeEngine();
    e.delayMs = 2000;
    let s: Partial<EngineSignals> = { onScreen: true };
    const t = setup(() => [view(e, () => s)()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    s = {}; t.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    s = { onScreen: true }; t.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(e.classes()).toEqual(['active']);
    await vi.advanceTimersByTimeAsync(5000);
    // The engine ended at 'active', which it already had: nothing more to send.
    expect(e.classes()).toEqual(['active']);
  });
});

describe('the setting', () => {
  it('off: an engine that was lowered goes back to active once, then nothing is sent', async () => {
    const e = new FakeEngine();
    const t = setup(() => [view(e, () => ({}))()]);
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    expect(e.classes()).toEqual(['background']);
    settings = { ...settings, enabled: false };
    t.poke();
    await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
    t.poke();
    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(e.classes()).toEqual(['background', 'active']);
    expect(e.count('_elastic_idle_report')).toBe(0);
  });
});

describe('reportVetoesIdle', () => {
  it('work vetoes; leases and a due warm do not', () => {
    expect(reportVetoesIdle({ parkable: true, reasons: [] })).toBe(false);
    expect(reportVetoesIdle({ parkable: false, reasons: ['turn running'] })).toBe(true);
    expect(reportVetoesIdle({ parkable: false, reasons: ['collab run'] })).toBe(true);
    expect(reportVetoesIdle({ parkable: false, reasons: ['pending permission'] })).toBe(true);
    expect(reportVetoesIdle({ parkable: false, reasons: ['flock lease holder', 'nest lease', 'warm pending'] })).toBe(false);
    expect(reportVetoesIdle({ parkable: false })).toBe(true);
  });
});
