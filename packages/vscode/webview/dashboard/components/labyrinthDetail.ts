// The FLIGHT strip's per-step detail block. Flight is the DETAIL view — it has
// room to show inline what the inspector otherwise shows one step at a time —
// so this decides which rows a step has EARNED.
//
// The rule the inspector already keeps, kept here too: an absent field yields
// no row at all. Never "undefined", and never a fabricated 0 that would read
// as a measurement we never took.

import { formatDuration, truncate } from './labyrinthFormat';

export interface DetailStep {
  kind: string;
  tool?: string;
  status?: string;
  durationMs?: number;
  tokens?: { input: number; output: number };
  model?: string;
  agent?: string;
}

/** Longest per-step detail row, in characters. */
export const DETAIL_CHARS = 22;

export function flightDetail(step: DetailStep, max: number = DETAIL_CHARS): string[] {
  const rows: string[] = [step.tool ? `${step.kind} · ${step.tool}` : step.kind];
  if (step.status) rows.push(step.status);

  const dur = formatDuration(step.durationMs);
  if (dur) rows.push(dur);

  const tokens = step.tokens;
  if (tokens && Number.isFinite(tokens.input) && Number.isFinite(tokens.output)) {
    rows.push(`${tokens.input}/${tokens.output} tok`);
  }
  // The agent NAME is the more useful of the two on a delegated step; the model
  // is the fallback when the run did not record one.
  const who = step.agent ?? step.model;
  if (who) rows.push(who);

  return rows.map((row) => truncate(row, max));
}
