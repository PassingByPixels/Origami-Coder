// labyrinthClaudeRuns.ts: Claude Code's own conversations in the
// Labyrinth's run index — which rows are one, what a pick asks for, and
// what the index can say about one without an engine call. A leaf: none
// of it draws, all of it is decisions, testable with no DOM.
//
// `claude:<uuid>` routes to the extension's own projection leaf
// (src/dashboard/claudeLabyrinth.ts), never the engine. The prefix is
// restated here rather than imported, since tsconfig pins this
// package's rootDir to `webview/` (TS6059); a test pins the pair.
//
// Row ids are rewritten here only: the History popup needs the raw uuid
// to resume a session, this index needs the routed id to map one.
//
// No engine call for a Claude row's stats: `run_stats` would cost a full
// read per id; the numbers are already read off claudeHistory.ts's scan.

import type { CollabRow } from './labyrinthCollabIndex';
import type { RunStatRow } from './labyrinthHealth';

/** MIRRORS `CLAUDE_RUN_PREFIX` in src/dashboard/claudeLabyrinth.ts. */
export const CLAUDE_RUN_PREFIX = 'claude:';

/** True for a run id the extension answers from a transcript. */
export function isClaudeRunId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(CLAUDE_RUN_PREFIX);
}

/** One `historyList` row, in the fields this leaf reads. A Claude row
 *  carries the usage claudeHistory.ts measured; an Origami row passes through untouched. */
export interface ClaudeIndexRow extends CollabRow {
  turns?: number;
  tokensIn?: number;
  cacheRead?: number;
}

/**
 * The index's rows: Claude ids routed, everything else untouched. A
 * Claude row with no `cwd` is dropped: the transcript is found by the
 * folder it belongs to, so an unmapped row would look like a run that
 * recorded nothing, which is worse than no row at all.
 */
export function labyrinthRunRows(rows: readonly ClaudeIndexRow[]): ClaudeIndexRow[] {
  const out: ClaudeIndexRow[] = [];
  for (const row of rows ?? []) {
    if (!row?.sessionId) continue;
    if (row.kind !== 'claude') { out.push(row); continue; }
    if (!row.cwd) continue;
    out.push({ ...row, sessionId: CLAUDE_RUN_PREFIX + row.sessionId });
  }
  return out;
}

/** The rows the index shows. The toggle hides only Claude rows — "show
 *  the other side too", not a mode, as in the History popup's filterHistory. */
export function visibleRunRows(rows: readonly ClaudeIndexRow[], showClaude: boolean): ClaudeIndexRow[] {
  return showClaude ? [...(rows ?? [])] : (rows ?? []).filter((r) => r?.kind !== 'claude');
}

/** The ids worth asking the engine about: every row it could possibly know. */
export function engineStatIds(rows: readonly ClaudeIndexRow[]): string[] {
  return (rows ?? []).filter((r) => r?.sessionId && !isClaudeRunId(r.sessionId)).map((r) => r.sessionId);
}

/** Stats for the Claude rows, read off the rows themselves. A row that
 *  measured neither turns nor tokens gets no entry — never a fabricated
 *  `{requests: 0}` claiming the session was read and found empty. */
export function claudeRunStats(rows: readonly ClaudeIndexRow[]): Record<string, RunStatRow> {
  const out: Record<string, RunStatRow> = {};
  for (const row of rows ?? []) {
    if (row?.kind !== 'claude' || !row.sessionId) continue;
    const requests = typeof row.turns === 'number' ? row.turns : undefined;
    const input = typeof row.tokensIn === 'number' ? row.tokensIn : undefined;
    const cacheRead = typeof row.cacheRead === 'number' ? row.cacheRead : undefined;
    if (requests === undefined && input === undefined) continue;
    out[row.sessionId] = {
      sessionId: row.sessionId,
      ...(requests === undefined ? {} : { requests }),
      ...(input === undefined ? {} : { tokens: { input, ...(cacheRead === undefined ? {} : { cacheRead }) } }),
    };
  }
  return out;
}
