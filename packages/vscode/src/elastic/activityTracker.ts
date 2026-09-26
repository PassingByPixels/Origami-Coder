// activityTracker.ts — t-w2qv3o: tells each engine its activity class and asks idle engines to trim.
// No vscode here: the clock, the settings and the log are injected (elasticWindow.ts has the real ones).
//
// Pull model. The window calls poke() whenever something may have changed (every panel post, a view
// shown or hidden, the phone moving). One debounced pass then reads every engine's signals from the
// source, runs the pure classifier (activityClass.ts) and sends `_elastic_class` only for a class that
// changed. A hidden engine keeps one re-check timer, so a missed change is read at the latest after
// `idleAfterMs`.
//
// Wire contract (ticket t-w2qlop): `_elastic_class {class}`, `_elastic_trim {}` -> {trimmed, reason?},
// `_elastic_idle_report {}` -> {parkable, reasons[], lastRequestAt?}. Timing (lead, 2026-09-24
// measurements): idle after `idleAfterMs` hidden and quiet; the trim request goes out as the engine
// turns idle (trimAfterMs 0), never within NO_TRIM_AFTER_TURN_MS of its last turn end, then every
// `retrimMs`. An engine that answers "method not found" is an
// older binary: nothing more is sent to it. Every call is fire-and-forget with a time limit, so a slow
// or stuck engine never holds up the extension host or another engine.

import { START, holdsWork, nextClass, type ActivityClass, type ClassState, type EngineSignals } from './activityClass';
import { parkVerdict, type ParkSettings } from './parkPolicy';

export interface ElasticClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** One engine as the source sees it now. `key` is its identity: a new process is a new key. */
export interface EngineView {
  key: object;
  client: ElasticClient;
  /** For the log only. */
  label: string;
  /** The engine answers calls (its start finished). Nothing is sent before. */
  ready: boolean;
  /** The engine's OS pid, for raise() below. */
  pid?: number;
  signals: EngineSignals;
  /** t-w2txb2: stop this engine on purpose (elastic/park.ts; the host engine: hostPark.ts, t-wdyi2t).
   *  null = parked, else why not. Absent = never parked. */
  park?: () => Promise<string | null>;
  /** t-wdyi2t: this engine's own park delay, for the timed and the untimed rule (the host engine: 10 min,
   *  lead decision). Only while parking is on (`parkAfterMs` > 0). Absent = the settings. */
  parkAfterMs?: number;
  /** t-wdyi2t (review #9): park as soon as no view shows it and it holds no work, with no quiet time and no
   *  idle report first (the engine's `_elastic_park` still makes its own last check). A finished Folds chat. */
  parkSoon?: boolean;
}

export interface ElasticSource {
  engines(): EngineView[];
  /** t-wy2jj3: start the parked engines that are on screen now (sessionSignals.ts wakeOnScreen). Run first
   *  in every pass, also with the setting off: a chat parked before it was turned off still starts on show. */
  wake?(): void;
}

export interface ElasticSettings {
  enabled: boolean;
  idleAfterMs: number;
  trimAfterMs: number;
  retrimMs: number;
  /** t-w2txb2 (parkPolicy.ts): hidden and quiet this long before an idle engine is parked; 0 or absent = never. */
  parkAfterMs?: number;
  /** The same for an engine whose provider publishes no cache window. */
  parkUntimedAfterMs?: number;
}

export interface TrackerDeps {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
  settings(): ElasticSettings;
  log(line: string): void;
  /** Lift an engine out of the idle class from OUTSIDE, before the message that tells it: an engine at
   *  the OS idle priority may not get a CPU to read that message while the machine is busy (E2 lane
   *  report, attack 2). Optional; a no-op where the OS will not allow it. */
  raise?(pid: number, cls: ActivityClass): void;
}

/** One pass per burst of pokes (a streaming turn posts many times a second). */
export const EVALUATE_DEBOUNCE_MS = 250;
/** A call the engine has not answered by then is given up, so the next change can be sent. */
export const CALL_TIMEOUT_MS = 30_000;
/** The longest back-off after trim refusals. */
export const MAX_TRIM_BACKOFF_MS = 60 * 60_000;
/** No trim request inside this long after the engine's last turn ended (lead, 2026-09-24 measurements). */
export const NO_TRIM_AFTER_TURN_MS = 2 * 60_000;
/** A refused `parkSoon` park is tried again after this long, never in a loop. */
export const PARK_SOON_RETRY_MS = 60_000;

/** `lastRequestAt` from `_elastic_idle_report`, as ms epoch: a number, or an ISO date. */
function epochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** An engine that predates a method answers JSON-RPC -32601 (same test as nestContract.ts). */
export function isMissingMethod(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === -32601 || /method not found/i.test(String(e?.message ?? error));
}

/** Idle-report reasons that do not keep an engine busy: leases and a warm that is due. Any other
 *  reason (a turn, a sub-agent, a job, an ask, a collab run) is work that must not drop to idle. */
const PASSIVE_REASON = /flock|nest|warm/i;

/** True when the engine reports work, so the class must stay background. */
export function reportVetoesIdle(report: Record<string, unknown>): boolean {
  if (report['parkable'] === true) return false;
  const reasons = Array.isArray(report['reasons']) ? report['reasons'].map(String) : [];
  if (reasons.length === 0) return report['parkable'] === false;
  return reasons.some((r) => !PASSIVE_REASON.test(r));
}

interface EngineState {
  view: EngineView;
  cs: ClassState;
  /** The class the engine should have now. */
  cls: ActivityClass;
  /** The class the engine last accepted (undefined = nothing sent yet). */
  sent?: ActivityClass;
  sending: boolean;
  reporting: boolean;
  trimming: boolean;
  /** A turn was running at the last pass (host turn or engine-reported turn). */
  inTurn: boolean;
  /** When the last turn ended: seen by the host, or the engine's `lastRequestAt` (a turn the host
   *  cannot see, such as a collab turn in the host engine). */
  turnEndAt: number | null;
  unsupported: boolean;
  /** t-z716d7: `_elastic_trim` answered `unsupported-platform` (macOS: no working-set
   *  equivalent). Logged once; never retried, unlike an ordinary refusal. */
  trimUnsupported: boolean;
  idleSince: number | null;
  refusals: number;
  checkTimer: unknown;
  /** When the check timer fires (ms epoch); null = a re-read while the engine holds work. */
  checkAt: number | null;
  trimTimer: unknown;
  /** t-w2txb2: the next park attempt, and one attempt at a time. */
  parkTimer: unknown;
  parkAt: number | null;
  /** t-xoenfh: the earliest next ask a refusal named. Kept apart from `parkAt`, so a lowered parkAfterMinutes
   *  moves the planned park of an engine that is already idle (the setting applies at once). */
  parkRetryAt: number | null;
  parking: boolean;
  /** t-wdyi2t: the next `parkSoon` attempt after a refusal. */
  soonTimer: unknown;
  soonAt: number;
}

export class ActivityTracker {
  private source: ElasticSource | null = null;
  /** What is tracked with no panel: the window's host engine alone. */
  private base: ElasticSource | null = null;
  private readonly engines = new Map<object, EngineState>();
  private evalTimer: unknown = null;
  private enabled = true;

  constructor(private readonly deps: TrackerDeps) {}

  /** The engines tracked while no panel is attached (the host engine of a window with no chat view). */
  public setBase(source: ElasticSource): void {
    this.base = source;
    this.poke();
  }

  /** A panel's engines. The newest panel wins; its disposable releases only its own source. */
  public attach(source: ElasticSource): { dispose(): void } {
    this.source = source;
    this.poke();
    return { dispose: () => { if (this.source === source) { this.source = null; this.poke(); } } };
  }

  /** Something may have changed. Cheap and synchronous: at most one pass is scheduled. */
  public poke(): void {
    if (this.evalTimer !== null) return;
    this.evalTimer = this.deps.setTimer(() => { this.evalTimer = null; this.safeEvaluate(); }, EVALUATE_DEBOUNCE_MS);
  }

  /** The class an engine is at now, for a test or a log. */
  public classOf(key: object): ActivityClass | undefined {
    return this.engines.get(key)?.cls;
  }

  /** Window close: timers go, nothing more is sent. */
  public dispose(): void {
    if (this.evalTimer !== null) this.deps.clearTimer(this.evalTimer);
    this.evalTimer = null;
    for (const st of this.engines.values()) this.clearTimers(st);
    this.engines.clear();
    this.source = null;
    this.base = null;
  }

  /** A pass runs from a timer: nothing it meets (a settings store, a source) may throw out of it. */
  private safeEvaluate(): void {
    try {
      this.evaluate();
    } catch (e) {
      this.deps.log(`[elastic] pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private evaluate(): void {
    (this.source ?? this.base)?.wake?.();
    const settings = this.deps.settings();
    if (!settings.enabled) return this.disable();
    this.enabled = true;
    const now = this.deps.now();
    const views = (this.source ?? this.base)?.engines() ?? [];
    const seen = new Set<object>();
    for (const view of views) {
      seen.add(view.key);
      let st = this.engines.get(view.key);
      if (!st) {
        st = { view, cs: START, cls: 'background', sending: false, reporting: false, trimming: false, inTurn: false, turnEndAt: null, unsupported: false, trimUnsupported: false, idleSince: null, refusals: 0, checkTimer: null, checkAt: null, trimTimer: null, parkTimer: null, parkAt: null, parkRetryAt: null, parking: false, soonTimer: null, soonAt: 0 };
        this.engines.set(view.key, st);
      }
      st.view = view;
      if (st.unsupported || !view.ready) continue;
      this.step(st, now, settings);
    }
    for (const [key, st] of this.engines) {
      if (seen.has(key)) continue;
      this.clearTimers(st);
      this.engines.delete(key);
    }
  }

  private step(st: EngineState, now: number, settings: ElasticSettings): void {
    const inTurn = st.view.signals.turnBusy || st.view.signals.engineBusy;
    if (st.inTurn && !inTurn) st.turnEndAt = now;
    st.inTurn = inTurn;
    st.cs = nextClass(st.cs, st.view.signals, now, settings.idleAfterMs);
    if (st.cs.cls === 'idle' && st.cls !== 'idle') {
      // Idle is confirmed by the engine first: only it knows its background jobs and collab runs.
      this.confirmIdle(st);
      this.setClass(st, 'background', now);
    } else {
      this.setClass(st, st.cs.cls, now);
    }
    this.armCheck(st, now, settings);
    this.armTrim(st, now, settings);
    this.armPark(st, now, settings);
    this.parkSoon(st, now);
  }

  /** t-wdyi2t: the park delays for this engine (its own, or the settings), both 0 while parking is off. */
  private delays(st: EngineState, settings: ElasticSettings): ParkSettings {
    if (!((settings.parkAfterMs ?? 0) > 0)) return { parkAfterMs: 0, parkUntimedAfterMs: 0 };
    const own = st.view.parkAfterMs;
    return own !== undefined ? { parkAfterMs: own, parkUntimedAfterMs: own } : { parkAfterMs: settings.parkAfterMs ?? 0, parkUntimedAfterMs: settings.parkUntimedAfterMs ?? 0 };
  }

  /** t-wdyi2t (review #1): the engine is parked. Its timers go at once and its state is dropped: a pending
   *  trim or park timer must not reach it (an `_elastic_*` call would fail, or once woke it), and its
   *  restored process starts from START, so it is told its class again. */
  private forget(st: EngineState): void {
    this.clearTimers(st);
    if (this.engines.get(st.view.key) === st) this.engines.delete(st.view.key);
    this.poke();
  }

  /** t-wdyi2t (review #9): a `parkSoon` engine is parked on the first pass that finds it hidden with no work. */
  private parkSoon(st: EngineState, now: number): void {
    const s = st.view.signals;
    if (!st.view.parkSoon || !st.view.park || st.parking || s.onScreen || s.phone || holdsWork(s) || now < st.soonAt) return;
    st.parking = true;
    void st.view.park().catch((e: unknown) => (e instanceof Error ? e.message : String(e))).then((why) => {
      st.parking = false;
      this.deps.log(`[elastic] ${st.view.label}: ${why === null ? 'parked (finished, hidden)' : `not parked (${why})`}`);
      if (why === null) return this.forget(st);
      st.soonAt = this.deps.now() + PARK_SOON_RETRY_MS;
      if (this.engines.get(st.view.key) === st) st.soonTimer = this.deps.setTimer(() => { st.soonTimer = null; this.poke(); }, PARK_SOON_RETRY_MS);
    });
  }

  /** t-w2txb2: an idle engine is parked once parkPolicy.ts says so, never before `parkAfterMs` of quiet.
   *  A refusal names when to ask again (the cache's end of life, the untimed delay, or one period). */
  private armPark(st: EngineState, now: number, settings: ElasticSettings, retryAt?: number | null): void {
    const after = this.delays(st, settings).parkAfterMs;
    const wanted = st.cls === 'idle' && !!st.view.park && after > 0 && st.cs.quietSince !== null && !st.unsupported;
    if (!wanted) {
      if (st.parkTimer !== null) { this.deps.clearTimer(st.parkTimer); st.parkTimer = null; }
      st.parkAt = null;
      st.parkRetryAt = null;
      return;
    }
    if (st.parking) return; // its answer arms the next
    if (retryAt != null) st.parkRetryAt = retryAt;
    const at = Math.max(st.cs.quietSince! + after, st.parkRetryAt ?? 0);
    if (st.parkTimer !== null && st.parkAt === at) return;
    if (st.parkTimer !== null) this.deps.clearTimer(st.parkTimer);
    st.parkAt = at;
    st.parkTimer = this.deps.setTimer(() => { st.parkTimer = null; this.tryPark(st); }, Math.max(at - now, 0));
  }

  private tryPark(st: EngineState): void {
    if (st.cls !== 'idle' || st.parking || !st.view.park || this.engines.get(st.view.key) !== st) return;
    st.parking = true;
    // A FRESH report: the one that confirmed idle may be an hour old.
    void this.call(st, '_elastic_idle_report', {}).then(async (report) => {
      const now = this.deps.now();
      const settings = this.deps.settings();
      const verdict = st.cls === 'idle' && st.cs.quietSince !== null
        ? parkVerdict(report, now, st.cs.quietSince, this.delays(st, settings))
        : { park: false as const, why: 'no longer idle', retryAt: null };
      if (verdict.park) {
        const why = await st.view.park!().catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
        st.parking = false;
        this.deps.log(`[elastic] ${st.view.label}: ${why === null ? 'parked' : `not parked (${why})`}`);
        if (why === null) return this.forget(st);
        if (this.engines.get(st.view.key) === st) this.armPark(st, this.deps.now(), settings, this.deps.now() + this.delays(st, settings).parkAfterMs);
        return;
      }
      st.parking = false;
      this.deps.log(`[elastic] ${st.view.label}: not parked yet (${verdict.why})`);
      if (this.engines.get(st.view.key) === st) this.armPark(st, now, settings, verdict.retryAt);
    });
  }

  private setClass(st: EngineState, cls: ActivityClass, now: number): void {
    if (st.cls === 'idle' && cls !== 'idle' && st.view.pid !== undefined) this.deps.raise?.(st.view.pid, cls);
    if (cls === 'idle' && st.cls !== 'idle') st.idleSince = now;
    if (cls !== 'idle') { st.idleSince = null; st.refusals = 0; }
    st.cls = cls;
    this.send(st);
  }

  /** One `_elastic_class` in flight per engine; a change made meanwhile is sent when it answers. */
  private send(st: EngineState): void {
    if (st.unsupported || st.sending || st.sent === st.cls) return;
    const target = st.cls;
    st.sending = true;
    void this.call(st, '_elastic_class', { class: target })
      .then((ok) => {
        if (ok === undefined) return;
        this.deps.log(`[elastic] ${st.view.label}: ${st.sent ?? 'start'} -> ${target}`);
      })
      .finally(() => {
        // A failed send is not retried in a loop: it counts as sent, and the next change sends again.
        st.sent = target;
        st.sending = false;
        if (this.engines.get(st.view.key) === st) this.send(st);
      });
  }

  private confirmIdle(st: EngineState): void {
    if (st.reporting) return;
    st.reporting = true;
    void this.call(st, '_elastic_idle_report', {}).then((report) => {
      st.reporting = false;
      if (this.engines.get(st.view.key) !== st || !this.enabled || st.unsupported) return;
      const now = this.deps.now();
      const settings = this.deps.settings();
      const cs = nextClass(st.cs, st.view.signals, now, settings.idleAfterMs);
      if (cs.cls !== 'idle') return; // it woke meanwhile; the pass that saw it has sent it
      if (report === undefined || reportVetoesIdle(report)) {
        // Work in the engine, or no answer: the quiet clock restarts, so the next ask is a full idle period away.
        if (report) this.deps.log(`[elastic] ${st.view.label}: stays background (${(report['reasons'] as unknown[] | undefined)?.join(', ') ?? 'busy'})`);
        st.cs = { cls: 'background', quietSince: now };
        this.armCheck(st, now, settings);
        return;
      }
      const lastRequest = epochMs(report['lastRequestAt']);
      if (lastRequest !== null) st.turnEndAt = Math.max(st.turnEndAt ?? 0, lastRequest);
      st.cs = cs;
      this.setClass(st, 'idle', now);
      this.armTrim(st, now, settings);
      this.armPark(st, now, settings);
    });
  }

  /** A hidden engine is read again when its idle time is due, or after `idleAfterMs` while it holds work. */
  private armCheck(st: EngineState, now: number, settings: ElasticSettings): void {
    // While the idle report is out, its answer re-arms this; a timer now would spin at 0 ms.
    const wanted = st.cls === 'background' && !st.reporting;
    const at = st.cs.quietSince !== null ? st.cs.quietSince + settings.idleAfterMs : null;
    // A pass every 250 ms during a turn must not churn timers: keep one that is still right.
    if (wanted && st.checkTimer !== null && st.checkAt === at) return;
    if (st.checkTimer !== null) { this.deps.clearTimer(st.checkTimer); st.checkTimer = null; }
    if (!wanted) return;
    st.checkAt = at;
    st.checkTimer = this.deps.setTimer(() => { st.checkTimer = null; this.safeEvaluate(); }, Math.max((at ?? now + settings.idleAfterMs) - now, 0));
  }

  private armTrim(st: EngineState, now: number, settings: ElasticSettings): void {
    if (st.cls !== 'idle' || st.unsupported || st.trimUnsupported) {
      if (st.trimTimer !== null) { this.deps.clearTimer(st.trimTimer); st.trimTimer = null; }
      return;
    }
    if (st.trimTimer !== null || st.trimming) return; // one trim at a time; its answer arms the next
    const first = (st.idleSince ?? now) + settings.trimAfterMs;
    const wait = Math.max(first - now, this.turnHold(st, now));
    if (wait > 0) this.trimAt(st, wait);
    else this.trim(st); // trimAfterMinutes 0: the request goes out as the engine turns idle
  }

  /** How long a trim must still wait so it is never inside NO_TRIM_AFTER_TURN_MS of a turn end. */
  private turnHold(st: EngineState, now: number): number {
    return st.turnEndAt === null ? 0 : st.turnEndAt + NO_TRIM_AFTER_TURN_MS - now;
  }

  private trimAt(st: EngineState, ms: number): void {
    st.trimTimer = this.deps.setTimer(() => { st.trimTimer = null; this.trim(st); }, ms);
  }

  private trim(st: EngineState): void {
    if (st.cls !== 'idle' || st.unsupported || st.trimUnsupported || this.engines.get(st.view.key) !== st) return;
    const hold = this.turnHold(st, this.deps.now());
    if (hold > 0) return this.trimAt(st, hold);
    st.trimming = true;
    void this.call(st, '_elastic_trim', {}).then((result) => {
      st.trimming = false;
      if (st.cls !== 'idle' || st.unsupported || st.trimUnsupported || this.engines.get(st.view.key) !== st) return;
      const settings = this.deps.settings();
      if (result?.['trimmed'] === true) {
        st.refusals = 0;
        const mb = (n: unknown) => (typeof n === 'number' ? `${Math.round(n / 1048576)} MB` : '?');
        this.deps.log(`[elastic] ${st.view.label}: trimmed ${mb(result['workingSetBefore'])} -> ${mb(result['workingSetAfter'])}`);
        this.trimAt(st, settings.retrimMs);
        return;
      }
      // t-z716d7: no working-set equivalent on this platform (macOS). Say so once
      // and stop asking - parking is what frees memory there, not a retry loop.
      if (result?.['reason'] === 'unsupported-platform') {
        st.trimUnsupported = true;
        if (st.trimTimer !== null) { this.deps.clearTimer(st.trimTimer); st.trimTimer = null; }
        this.deps.log(`[elastic] ${st.view.label}: memory trim not available on this platform; parking frees memory instead`);
        return;
      }
      // A refusal (a turn, or a cache warm due soon) backs off; it is never retried in a loop.
      st.refusals++;
      const wait = Math.min(settings.retrimMs * 2 ** st.refusals, MAX_TRIM_BACKOFF_MS);
      this.deps.log(`[elastic] ${st.view.label}: trim refused (${String(result?.['reason'] ?? 'no answer')}), next try in ${Math.round(wait / 60_000)} min`);
      this.trimAt(st, wait);
    });
  }

  /** One ext call. undefined = no answer (failed, timed out, or the engine is too old). */
  private async call(st: EngineState, method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    let timer: unknown = null;
    try {
      return await Promise.race([
        st.view.client.extMethod(method, params),
        new Promise<never>((_, reject) => { timer = this.deps.setTimer(() => reject(new Error(`no answer in ${CALL_TIMEOUT_MS / 1000} s`)), CALL_TIMEOUT_MS); }),
      ]);
    } catch (e) {
      if (isMissingMethod(e)) {
        st.unsupported = true;
        this.clearTimers(st);
        this.deps.log(`[elastic] ${st.view.label}: engine has no ${method}; elastic calls stop for this engine`);
      } else {
        this.deps.log(`[elastic] ${st.view.label}: ${method} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return undefined;
    } finally {
      if (timer !== null) this.deps.clearTimer(timer);
    }
  }

  /** The setting went off: every engine this moved off active goes back to active, once. */
  private disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    let reset = 0;
    for (const st of this.engines.values()) {
      this.clearTimers(st);
      if (!st.unsupported && st.sent !== undefined && st.sent !== 'active') {
        reset++;
        void this.call(st, '_elastic_class', { class: 'active' });
      }
    }
    this.engines.clear();
    if (reset > 0) this.deps.log(`[elastic] off: ${reset} engine(s) set back to the active class`);
  }

  private clearTimers(st: EngineState): void {
    if (st.checkTimer !== null) this.deps.clearTimer(st.checkTimer);
    if (st.trimTimer !== null) this.deps.clearTimer(st.trimTimer);
    if (st.parkTimer !== null) this.deps.clearTimer(st.parkTimer);
    if (st.soonTimer !== null) this.deps.clearTimer(st.soonTimer);
    st.checkTimer = null;
    st.trimTimer = null;
    st.parkTimer = null;
    st.soonTimer = null;
  }
}
