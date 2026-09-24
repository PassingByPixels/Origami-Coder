// The recorded history of plan usage, as a PURE value. usageHistory.ts owns the sampling PASS
// (timer, engine client, globalState); this owns the decision each sample forces (same cycle? too
// soon? too long?) — none of which needs VS Code.
// Nothing here reads or writes anything; `applySample` takes a store and returns a new one, and the
// caller persists it.
// A window with no `resetsAt` is not recorded: a glide path is a percentage measured against a
// window END, and without it there's no length, no pace, no projection to compare against.

/** One reading: the clock it was taken at, and the percent spent at that time. */
export interface UsageSample {
  readonly t: number;
  readonly pct: number;
}

/** One reset-to-reset cycle of one window. */
export interface UsageCycle {
  readonly resetsAt: number;
  readonly samples: readonly UsageSample[];
  /** What the PROVIDER said about this window's extent, when it said anything — recorded because
   *  the alternative was guessing (the view once assumed thirty days for Grok and drew a weekly
   *  window at 78% of a month). */
  readonly startsAt?: number;
  readonly lengthMs?: number;
}

/** The CURRENT cycle of one window, plus the one before it when there was one. */
export interface UsageWindowHistory extends UsageCycle {
  readonly previous?: UsageCycle;
}

export interface UsageProviderHistory {
  readonly windows: Record<string, UsageWindowHistory>;
}

export interface UsageHistoryStore {
  readonly version: 1;
  readonly providers: Record<string, UsageProviderHistory>;
}

/** The window shape the engine reports (`acp/provider-usage.ts`). */
export interface SampledWindow {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: number;
  /** Optional on the wire: an engine that predates them simply omits both. */
  readonly startsAt?: number;
  readonly lengthMs?: number;
}

/** How far a reported `resetsAt` may move before it means a NEW cycle. A rolling window's end
 *  drifts by seconds between reads; a real reset moves it by the whole window length — 60s
 *  separates the two with no calendar assumption. */
export const CYCLE_DRIFT_MS = 60_000;

/** The shortest gap between two recorded samples of one window. */
export const MIN_SAMPLE_GAP_MS = 120_000;

/** The most samples one cycle keeps. */
export const MAX_SAMPLES = 500;

export const EMPTY_STORE: UsageHistoryStore = { version: 1, providers: {} };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const clampPct = (v: number): number => Math.max(0, Math.min(100, v));

function readSamples(raw: unknown): UsageSample[] {
  if (!Array.isArray(raw)) return [];
  const out: UsageSample[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const t = finite(entry.t);
    const pct = finite(entry.pct);
    if (t === undefined || pct === undefined) continue;
    out.push({ t, pct: clampPct(pct) });
  }
  return out;
}

function readCycle(raw: unknown): UsageCycle | undefined {
  if (!isRecord(raw)) return undefined;
  const resetsAt = finite(raw.resetsAt);
  if (resetsAt === undefined || resetsAt <= 0) return undefined;
  // Kept through a re-read: a history written by a build that knew the period is worth more than
  // one that has to infer it again.
  const startsAt = positive(raw.startsAt);
  const lengthMs = positive(raw.lengthMs);
  return {
    resetsAt,
    samples: readSamples(raw.samples),
    ...(startsAt !== undefined ? { startsAt } : {}),
    ...(lengthMs !== undefined ? { lengthMs } : {}),
  };
}

function positive(raw: unknown): number | undefined {
  const v = finite(raw);
  return v !== undefined && v > 0 ? v : undefined;
}

/** Anything out of globalState becomes a store this build understands, or an empty one. Defensive
 *  on purpose — the value survives extension updates, so an unreadable field is dropped and the
 *  rest kept rather than made to throw. */
export function readStore(raw: unknown): UsageHistoryStore {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.providers)) return EMPTY_STORE;
  const providers: Record<string, UsageProviderHistory> = {};
  for (const [providerId, providerRaw] of Object.entries(raw.providers)) {
    if (!isRecord(providerRaw) || !isRecord(providerRaw.windows)) continue;
    const windows: Record<string, UsageWindowHistory> = {};
    for (const [label, windowRaw] of Object.entries(providerRaw.windows)) {
      const current = readCycle(windowRaw);
      if (!current) continue;
      const previous = isRecord(windowRaw) ? readCycle(windowRaw.previous) : undefined;
      windows[label] = { ...current, ...(previous ? { previous } : {}) };
    }
    if (Object.keys(windows).length > 0) providers[providerId] = { windows };
  }
  return { version: 1, providers };
}

/** Drop the oldest half of the list to every second reading. Thins rather than truncates: the start
 *  of a cycle is what a front-load warning is computed from, and truncating would delete exactly
 *  that evidence. */
export function thin(samples: readonly UsageSample[]): UsageSample[] {
  const half = Math.floor(samples.length / 2);
  const kept: UsageSample[] = [];
  for (let i = 0; i < half; i += 2) kept.push(samples[i]!);
  return kept.concat(samples.slice(half));
}

/**
 * Record one reading of one window, in order: (1) no `resetsAt` — not
 * recorded (see header); (2) stored `resetsAt` moved by more than
 * CYCLE_DRIFT_MS — the window reset, the current cycle becomes `previous`
 * and the one before that is dropped; (3) less than MIN_SAMPLE_GAP_MS since
 * the last sample — ignored; (4) over MAX_SAMPLES — thinned. Returns the
 * SAME object when nothing was recorded, so a caller can skip a write.
 */
export function applySample(
  store: UsageHistoryStore,
  providerId: string,
  window: SampledWindow,
  now: number,
): UsageHistoryStore {
  const resetsAt = finite(window.resetsAt);
  const pct = finite(window.usedPercent);
  if (!providerId || !window.label || resetsAt === undefined || resetsAt <= 0 || pct === undefined) return store;

  const provider = store.providers[providerId];
  const existing = provider?.windows[window.label];
  const sample: UsageSample = { t: now, pct: clampPct(pct) };
  // What the provider STATED about this window, refreshed on every sample beside `resetsAt` for the
  // same reason: a rolling window's start moves with its end. Omitted when the engine sends
  // nothing, rather than writing zeroes.
  const startsAt = finite(window.startsAt);
  const lengthMs = finite(window.lengthMs);
  const stated = {
    ...(startsAt !== undefined && startsAt > 0 ? { startsAt } : {}),
    ...(lengthMs !== undefined && lengthMs > 0 ? { lengthMs } : {}),
  };

  let next: UsageWindowHistory;
  if (!existing) {
    next = { resetsAt, samples: [sample], ...stated };
  } else if (Math.abs(existing.resetsAt - resetsAt) > CYCLE_DRIFT_MS) {
    // Rule 2. The closed cycle is kept WHOLE, including its own last reading:
    // its length is what the new cycle's length is inferred from.
    next = {
      resetsAt,
      samples: [sample],
      ...stated,
      previous: { resetsAt: existing.resetsAt, samples: existing.samples },
    };
  } else {
    const last = existing.samples[existing.samples.length - 1];
    if (last && now - last.t < MIN_SAMPLE_GAP_MS) return store; // rule 3
    const grown = existing.samples.concat(sample);
    next = {
      ...existing,
      // Refreshed even on a same-cycle sample: a rolling window's end really does move by seconds,
      // and the newest read is what the projection should aim at.
      resetsAt,
      ...stated,
      samples: grown.length > MAX_SAMPLES ? thin(grown) : grown, // rule 4
    };
  }

  return {
    version: 1,
    providers: {
      ...store.providers,
      [providerId]: { windows: { ...(provider?.windows ?? {}), [window.label]: next } },
    },
  };
}
