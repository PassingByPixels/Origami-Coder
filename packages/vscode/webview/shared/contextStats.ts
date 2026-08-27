// Context manager — pure aggregation for the cross-session token tracker in the
// SidebarLauncher. The host emits real per-turn usage (from the prompt-response)
// via `usageUpdate` and turn/context-window info via `contextUpdate`; this
// module folds both into a per-session running tally of REAL tokens spent —
// prefill (input), read (cache-read), write (output) — plus the window fill.
// Kept separate + dependency-free so it's unit-testable.

export interface CtxStat {
  /** Tokens currently occupying the model's context window (last turn's input +
   *  cache-read) — drives the fill %. */
  contextUsed: number;
  /** The model's context window size (0 = unknown). */
  contextTotal: number;
  /** Cumulative prompt/input tokens processed this session (prefill). */
  prefill: number;
  /** Cumulative cache-read tokens this session. */
  read: number;
  /** Cumulative generated/output tokens this session (write). */
  write: number;
  /** Turns taken this session. */
  turns: number;
}

export const EMPTY_CTX: CtxStat = {
  contextUsed: 0,
  contextTotal: 0,
  prefill: 0,
  read: 0,
  write: 0,
  turns: 0,
};

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// Positive-only: treats 0 as "not reported" and keeps the prior value. The two
// sources disagree on occupancy/window — usageUpdate has the real `used`, while
// contextUpdate's controller-state `context_used`/`context_total` are 0 on local
// models. Without this, a 0-carrying contextUpdate would wipe the real numbers.
function pos(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Fold a `usageUpdate` OR `contextUpdate` payload onto the last-known stat.
 *
 * Two shapes feed this: `usageUpdate` carries the real token breakdown
 * (prefill/read/write) + `used` (current occupancy) + `size` (0 for local — no
 * limit); `contextUpdate` carries `turns` + the probed `contextWindow`. A field
 * absent from THIS payload keeps its prior value, so a fallback frame can't zero
 * a real count. `used`→contextUsed and `contextWindow`/positive-`size`→contextTotal
 * are accepted as aliases.
 */
export function mergeContextStat(prev: CtxStat | undefined, update: Record<string, unknown>): CtxStat {
  const base = prev ?? EMPTY_CTX;
  return {
    // Occupancy + window use pos(): a 0 from either source means "unknown" and
    // must keep the prior real value (usageUpdate `used` vs contextUpdate 0s;
    // usageUpdate `size` is 0 for local, so it can't wipe the probed window).
    contextUsed: pos(update.contextUsed, pos(update.used, base.contextUsed)),
    contextTotal: pos(update.contextTotal, pos(update.contextWindow, pos(update.size, base.contextTotal))),
    prefill: num(update.prefill, base.prefill),
    read: num(update.read, base.read),
    write: num(update.write, base.write),
    turns: num(update.turns, base.turns),
  };
}

/** Context-window fill %, 0-100. 0 when the window size or usage is unknown. */
export function ctxPct(stat: CtxStat | undefined): number {
  if (!stat || stat.contextTotal <= 0 || stat.contextUsed <= 0) return 0;
  return Math.min(100, Math.round((stat.contextUsed / stat.contextTotal) * 100));
}

/** Threshold band for the fill bar, matching the InputBar gauge (>=80 red,
 *  >=60 amber, else green). The Svelte maps the band to a colour var. */
export function ctxLevel(pct: number): 'low' | 'mid' | 'high' {
  return pct >= 80 ? 'high' : pct >= 60 ? 'mid' : 'low';
}

/** Compact token count: 940, 12.3k, 1.2M. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** Per-category token totals across every tracked session for the footer line. */
export function sumContext(stats: Record<string, CtxStat>): {
  prefill: number;
  read: number;
  write: number;
  turns: number;
  sessions: number;
} {
  let prefill = 0;
  let read = 0;
  let write = 0;
  let turns = 0;
  let sessions = 0;
  for (const k of Object.keys(stats)) {
    const s = stats[k];
    if (!s) continue;
    prefill += s.prefill || 0;
    read += s.read || 0;
    write += s.write || 0;
    turns += s.turns || 0;
    sessions += 1;
  }
  return { prefill, read, write, turns, sessions };
}
