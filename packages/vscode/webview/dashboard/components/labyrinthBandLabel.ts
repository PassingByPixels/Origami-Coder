// THE DELEGATE ROW LABEL AND ITS GUTTER.
//
// A span's bar on the sub-agent band can start no further left than the chart's
// left padding, and the row's name is drawn from the left edge on the SAME y —
// deliberately, so "the label belongs to that bar" is a checkable equality.
// That makes the space between them a fixed GUTTER, and nothing was budgeting
// it: `agent` is free text (or a step TITLE when a delegate declared no agent)
// with a live marker appended, so a real agent name printed straight over the
// bars. jsdom has no layout engine, so this can only be caught as arithmetic —
// which is why the whole drawn string, x included, is decided here rather than
// composed in the template: a prefix added in markup is a width the budget
// cannot see. Nothing is lost by cutting it; the bar's own <title> carries the
// full detail line.
//
// Its own leaf because labyrinthChart.ts was at its architecture cap, and this
// is a self-contained rule with an input and an output — the same split
// labyrinthThreadFit.ts already makes for thread's labels.

import { truncate } from './labyrinthFormat';

/** Over-estimated advance for the 10px row label — THREAD_CHAR_W's 8.4 at 13px,
 *  scaled, and used for the 9.5px nested rows too: erring wide is the safe
 *  direction when the cost of being wrong is text drawn over a bar. */
export const BAND_CHAR_W = 6.5;
export const BAND_LABEL_X = 8;
export const BAND_NEST_X = 22;
/** Clear air between the longest label and the earliest bar. */
export const BAND_GUTTER = 6;

export interface BandLabelRow { label: string; indent: number; open: boolean }

/** The string the band draws for one delegate row, and the x it draws it at. */
export function bandLabel(row: BandLabelRow, padLeft: number): { text: string; x: number } {
  const nested = row.indent > 0;
  const x = nested ? BAND_NEST_X : BAND_LABEL_X;
  const prefix = nested ? '↳ ' : '';
  const suffix = row.open ? ' ● live' : '';
  const budget = Math.floor((padLeft - x - BAND_GUTTER) / BAND_CHAR_W);
  // At least one character of the NAME survives: a row reduced to its ornaments
  // would be a lane nobody can tell apart from the next one.
  const room = Math.max(1, budget - prefix.length - suffix.length);
  return { text: `${prefix}${truncate(row.label, room)}${suffix}`, x };
}
