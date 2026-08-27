// subagentFormat.ts — how a sub-agent row PRINTS: its age and the tail of its
// live output.
//
// Extracted from subagentRows.ts when live activity landed and pushed that file
// past its architecture cap. The split is by responsibility, not by size:
// subagentRows.ts answers "which agents are still out" (a rule about lifecycle
// that has to be right), this answers "what does one look like" (formatting
// that has to be readable). Pure and DOM-free, so both are testable without a
// render — which is the only way the age formatter's boundaries (59s -> 1m 00s)
// ever get checked at all.

/** `4s` / `2m 05s` / `1h 12m`, and `''` for an unknown age — the drawer prints
 *  nothing rather than "0s", which would read as "it just started". */
export function elapsedText(elapsedMs: number): string {
  if (elapsedMs <= 0) return '';
  const total = Math.floor(elapsedMs / 1000);
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  if (mins < 60) return `${mins}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** Lines of live output kept per row. The drawer is a glance surface, not a
 *  log: enough to see WHICH file an agent is on, never enough to push a roster
 *  of ten agents off the panel. */
export const ACTIVITY_LINES = 3;

/**
 * The last ACTIVITY_LINES non-empty lines of a child's stream, oldest first.
 *
 * TAIL, not head: the stream is what the agent is doing NOW, and the pane's own
 * cap already drops the front of it. Blank lines are dropped first so a child
 * that streamed prose ending in newlines still shows three lines of substance
 * rather than three blanks.
 */
export function activityTail(stream: string | undefined): string {
  if (!stream) return '';
  const lines = stream.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
  return lines.slice(-ACTIVITY_LINES).join('\n');
}

/** The drawer's one-line roster summary — `3 running · 1 queued · 2 done`.
 *  `running` always prints (it is the number the drawer exists to answer); the
 *  rest only when non-zero, because a standing "0 failed" is noise on the one
 *  line a glance surface has. Every terminal state is listed: one left out is
 *  a row the header does not count but the Complete group still shows. */
export function rosterSummary(rows: ReadonlyArray<{ state: string }>): string {
  const count = (state: string) => rows.filter((row) => row.state === state).length;
  const parts = [`${count('running')} running`];
  for (const state of ['queued', 'done', 'error', 'failed']) {
    const n = count(state);
    if (n > 0) parts.push(`${n} ${state}`);
  }
  return parts.join(' · ');
}
