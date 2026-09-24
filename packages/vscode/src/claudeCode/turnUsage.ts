// turnUsage.ts — how much a passthrough turn used, read off the closing `result` event. Extracted
// from protocol.ts, which owns the wire shape; this is where the wire is interpreted, and where the
// context-meter bug lived.

import type { ClaudeEvent } from './protocol';

export interface ResultUsage {
  /** Tokens sitting in the context window at turn end — the LAST model call's
   *  fresh input plus both cache halves. The meter's numerator, and NOT the
   *  turn's total: see `lastIteration`. */
  tokensUsed: number;
  /** The window, straight from `modelUsage[<model>].contextWindow` — the CLI
   *  tells us, so there is no model table here to go stale. 0 = unreported. */
  contextWindow: number;
  costUsd: number;
  /** The turn's OWN counts, split the way the engine's message store stores
   *  them. `tokensUsed` above is a context-fill reading and cannot serve: it
   *  folds both cache halves into the input and drops the output entirely. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  isError: boolean;
  stopReason: string;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * The last model call of the turn, off `usage.iterations`.
 *
 * A turn is one or more model calls, and the CLI reports top-level `input_tokens`/`cache_*` as the
 *  SUM over all of them — a spend figure, and the wrong numerator for a context gauge, since an
 *  eight-call turn would count the same conversation eight times. Occupancy at turn end is the last
 *  iteration's own input plus both cache halves; a build with no `iterations` falls back to the
 *  top-level fields, correct for a single-call turn.
 */
function lastIteration(usage: Record<string, unknown>): Record<string, unknown> {
  const its = usage.iterations;
  if (!Array.isArray(its) || its.length === 0) return usage;
  const last = its[its.length - 1];
  return last && typeof last === 'object' && !Array.isArray(last) ? (last as Record<string, unknown>) : usage;
}

/** Read the turn-closing `result` event. Returns null for anything else. */
export function resultUsage(ev: ClaudeEvent): ResultUsage | null {
  if (ev.type !== 'result') return null;
  const usage = (ev.usage ?? {}) as Record<string, unknown>;
  const modelUsage = (ev.modelUsage ?? {}) as Record<string, Record<string, unknown>>;
  let contextWindow = 0;
  for (const entry of Object.values(modelUsage)) {
    const w = num(entry?.contextWindow);
    if (w > contextWindow) contextWindow = w;
  }
  // OCCUPANCY from the last call; the SIZE counts below stay the turn's totals.
  // What a turn cost and what it left sitting in the window are two different
  // questions, and the engine mirror asks the first one.
  const fill = lastIteration(usage);
  return {
    tokensUsed: num(fill.input_tokens) + num(fill.cache_read_input_tokens) + num(fill.cache_creation_input_tokens),
    contextWindow,
    costUsd: num(ev.total_cost_usd),
    tokens: {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
    },
    isError: ev.is_error === true,
    stopReason: typeof ev.stop_reason === 'string' && ev.stop_reason
      ? ev.stop_reason
      : (typeof ev.subtype === 'string' ? ev.subtype : 'end_turn'),
  };
}
