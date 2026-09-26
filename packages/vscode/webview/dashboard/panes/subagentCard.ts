// subagentCard.ts — what ONE sub-agent card says, in the pull-out AND on the
// agent map (t-yyz57i, redesign R3: "one card in both views").
//
// Line 1: `type · T<n>` (muted) and the job. Line 2: ONE of the live activity
// line (running), the reason (failed), or the totals (otherwise). Thinking is
// not here: SubagentThinkingLine.svelte prints it from `row.thinking`.
//
// Pure and DOM-free, so the choice of line 2 is testable without a render, and
// the two views cannot disagree about it.

import { isSettled } from './subagentEntry';
import { elapsedText } from './subagentFormat';
import { subagentShort } from './subagentLabel';
import { tokensTotalText } from './subagentTokens';
import type { SubagentRow, SubagentState } from './subagentRows';

/** `explore · T1`, or `T1` with no agent type. The trailing ` · ` that joins it
 *  to the job is markup, so the card's full text stays subagentLabel()'s. */
export function cardWho(row: SubagentRow): string {
  return [row.agentType, subagentShort(row)].filter(Boolean).join(' · ');
}

/** The job: the model's own description, or '' — never the card header, which
 *  is the word `task` (subagentLabel.ts). */
export function cardJob(row: SubagentRow): string {
  return row.description ?? '';
}

export type CardLine2 =
  | { kind: 'activity'; text: string; age: string } // running, and it printed something
  | { kind: 'reason'; text: string } // stopped badly
  | { kind: 'totals'; tokens: string; age: string }; // everything else

export const isFailedState = (s: SubagentState) => s === 'failed' || s === 'error';

const lastLine = (text: string) => text.split('\n').filter((l) => l.trim()).pop()?.trim() ?? '';

/** Which second line the card prints. A failed card with no output says only
 *  that it failed: there is no error field on the row to quote. */
export function cardLine2(row: SubagentRow): CardLine2 {
  const age = elapsedText(row.elapsedMs);
  if (isFailedState(row.state)) {
    return { kind: 'reason', text: lastLine(row.activity) || (row.state === 'failed' ? 'failed to start' : 'failed') };
  }
  const act = lastLine(row.activity);
  if (!isSettled(row.state) && act) return { kind: 'activity', text: act, age };
  return { kind: 'totals', tokens: tokensTotalText(row.tokens), age };
}

/** The header's three dot counts. `running` is the running state only (a queued
 *  agent is not running); failed = failed + error. */
export function stateCounts(rows: ReadonlyArray<{ state: SubagentState }>): { running: number; done: number; failed: number } {
  let running = 0, done = 0, failed = 0;
  for (const r of rows) {
    if (r.state === 'running') running++;
    else if (r.state === 'done') done++;
    else if (isFailedState(r.state)) failed++;
  }
  return { running, done, failed };
}

/** The map hub's second line: `This chat · 5 sub-agents · 1.4M tokens`. The
 *  token part is dropped when no row rode a token figure. */
export function hubLine(rows: ReadonlyArray<SubagentRow>): string {
  let input = 0, output = 0, any = false;
  for (const r of rows) {
    if (r.tokens?.input === undefined || r.tokens.output === undefined) continue;
    input += r.tokens.input; output += r.tokens.output; any = true;
  }
  const parts = ['This chat', `${rows.length} sub-agent${rows.length === 1 ? '' : 's'}`];
  if (any) parts.push(tokensTotalText({ input, output }));
  return parts.join(' · ');
}

/** An S-curve from the hub's right side to a card's left edge, in viewBox units. */
export function wirePath(x1: number, y1: number, x2: number, y2: number): string {
  const mid = Math.round(((x1 + x2) / 2) * 100) / 100;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}
