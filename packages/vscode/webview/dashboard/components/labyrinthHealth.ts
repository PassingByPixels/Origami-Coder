// CACHE HEALTH of a listed run — the one number the run index can show that
// says "this session was paying full price for prefill it could have cached".
//
// Pure, and deliberately CONSERVATIVE about when it will say anything at all.
// Two ways a hit rate misleads, and this refuses to draw one in either:
//
//  1. THE PROVIDER NEVER MEASURED. Most local servers report no cache fields,
//     so the engine omits them. A 0% there reads as "caching is broken on this
//     session" when the truth is that nobody counted — a blank is honest, a
//     zero is not.
//  2. THE SAMPLE IS TOO SMALL. A two-request session is mostly its first,
//     uncacheable turn. Reading 0% into that would flag every short chat.
//
// The threshold itself is a judgement, not a measurement, and is named so the
// reader can see what "warning" means rather than inferring it from a colour.

/** Requests a session needs before its hit rate is worth reading. Below this the
 *  first (necessarily uncached) turn dominates, and every short chat looks ill. */
export const MIN_REQUESTS_FOR_HEALTH = 10;

/** Below this share of prefill served from cache, the session is flagged. */
export const HEALTHY_HIT_RATIO = 0.8;

/** Just the members of a run's stats this reads. The wire type satisfies it. */
export interface HealthStat {
  requests?: number;
  tokens?: { input: number; cacheRead?: number };
}

/** One `runStatsData` row as the index reads it. Mirrors `RunStat` in
 *  src/acpExtTypes.ts rather than importing it: a webview .ts that reaches into
 *  src/ breaks the type gate (TS6059), so the shape is restated and the drift
 *  is what the pane test pins. */
export interface RunStatRow extends HealthStat {
  sessionId: string;
}

export interface RunHealth {
  /** Absent = draw nothing (a dash), never a 0%. See the two rules above. */
  ratio?: number;
  /** True only when a ratio EXISTS and is below the healthy share. */
  warn: boolean;
}

export function runCacheHealth(stat: HealthStat | undefined): RunHealth {
  const tokens = stat?.tokens;
  if (!tokens || tokens.cacheRead === undefined) return { warn: false };
  if ((stat?.requests ?? 0) < MIN_REQUESTS_FOR_HEALTH) return { warn: false };
  const prefill = tokens.cacheRead + tokens.input;
  if (prefill <= 0) return { warn: false };
  const ratio = tokens.cacheRead / prefill;
  return { ratio, warn: ratio < HEALTHY_HIT_RATIO };
}

/** "81%", or the DASH that means "not measurable here" — never "0%" by default. */
export function healthLabel(health: RunHealth): string {
  return health.ratio === undefined ? '—' : `${Math.round(health.ratio * 100)}%`;
}
