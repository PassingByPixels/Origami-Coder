// The step LEDGER — the printable record the picture drops.
//
// It exists because the corridor view deliberately prints no per-step labels
// (that omission is what buys its density), so the picture alone is a grid of
// anonymous dots. The table is the answer, and it stays complete in every mode.
//
// Extracted from labyrinthHtml.ts when the export became a console and the
// table moved into a drawer; the columns and their honesty rules are unchanged.
// An absent field is an EMPTY cell — never "undefined", and never a fabricated
// 0 that would read as a measurement the run never took.

import { esc } from './labyrinthAtlas';
import { formatClock, formatDuration } from './labyrinthFormat';
import { branchOf, subDepth, tokensCell, type HtmlStep } from './labyrinthReport';

const COLUMNS = [
  '#', 'Kind', 'Tool', 'Title', 'Status', 'Start', 'End',
  'Duration', 'Tokens in/out', 'Model', 'Agent', 'Depth', 'Branch of',
] as const;

/**
 * One row's values, in COLUMNS order. `undefined` for anything the step does
 * not carry — depth included: 0 is the main thread, not a sub-agent level, so
 * printing it would put a number in a column that is about delegation.
 */
function cells(s: HtmlStep): Array<string | number | undefined> {
  return [
    s.ordinal, s.kind, s.tool, s.title, s.status,
    formatClock(s.startedAt), formatClock(s.endedAt), formatDuration(s.durationMs),
    tokensCell(s), s.model, s.agent, subDepth(s), branchOf(s),
  ];
}

/** The whole table, one row per step the map DREW — no more and no less. */
export function ledgerTable(steps: readonly HtmlStep[]): string {
  const head = COLUMNS.map((c) => `<th>${esc(c)}</th>`).join('');
  const rows = steps
    .map((s) => `<tr data-ordinal="${esc(s.ordinal)}">`
      + `${cells(s).map((v, i) => `<td${i === 3 ? ' class="t"' : ''}>${esc(v)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<div class="dwbody" id="og-ledger"><table><thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody></table></div>`;
}
