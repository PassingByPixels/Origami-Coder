/**
 * Every host message the Labyrinth pane listens for, read in one place.
 *
 * EXTRACTED from LabyrinthPane.svelte, on the instruction its own cap note in
 * architecture.test.ts carries: "the next thing to land in it should extract the
 * message listener into a leaf of its own rather than shave lines to fit".
 *
 * WHAT THIS OWNS is the READING — which message this is, and what each field of
 * it means once the wire's optionality is taken off (an absent `total` is the
 * loaded count, an absent `error` is null, a non-array is empty). The pane owns
 * the WRITING: every branch below hands its result to a callback, so all the
 * reactive state stays where it is declared.
 *
 * WHY THAT SPLIT AND NOT A PURE REDUCER. The pane's state is a dozen separate
 * runes, not one object, so a reducer would have to return a patch the pane then
 * unpacks field by field — the same lines, in two files instead of one, plus a
 * shape to keep in step. Callbacks keep each field's owner and its writer
 * adjacent.
 *
 * NOTHING HERE DECIDES ANYTHING. There is one judgement in the file — dropping a
 * `runStepsData` for a run the user has already navigated away from — and it is
 * commented where it happens.
 */

import type { LayoutStep } from './labyrinthLayout';
import type { RunStatRow } from './labyrinthHealth';
import type { PriceTable } from './labyrinthCost';
import { labyrinthRunRows, type ClaudeIndexRow } from './labyrinthClaudeRuns';

/** The steps reply, with the wire's optionality already resolved. */
export interface StepsPayload {
  readonly steps: LayoutStep[];
  readonly members: string[];
  readonly truncated: boolean;
  readonly total: number;
  readonly error: string | null;
}

export interface ColumnsPayload {
  readonly indexWidthPx: number | null;
  readonly inspectWidthPx: number | null;
  readonly inspectCollapsed: boolean;
}

export interface DeletePayload {
  readonly ok: boolean;
  readonly sessionId: string;
  /** The refusal, or null when the delete happened. */
  readonly error: string | null;
}

/** The pane's writers. One per thing a message can change. */
export interface LabyrinthMessageSink {
  /** Which run is open, so a reply for another one can be dropped. */
  selectedRun(): string | null;
  runs(rows: ClaudeIndexRow[]): void;
  stats(byId: Record<string, RunStatRow>): void;
  steps(payload: StepsPayload): void;
  columns(payload: ColumnsPayload): void;
  prices(table: PriceTable): void;
  deleted(payload: DeletePayload): void;
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** True when the message was one of the pane's — for a caller that wants to know. */
export function applyLabyrinthMessage(msg: Record<string, unknown>, sink: LabyrinthMessageSink): boolean {
  switch (msg.type) {
    case 'historyList':
      // BOTH kinds. The sidebar's History popup put Claude Code's own
      // transcripts on this same wire (t-463pb6) and the index lists them too
      // (t-47bk8j) — but the engine has never heard of one, so a Claude row's
      // id is REWRITTEN to the `claude:` route on the way in. Nothing past this
      // point may send one to run_steps, run_stats or a delete.
      sink.runs(labyrinthRunRows(arr<ClaudeIndexRow>(msg.sessions)));
      return true;
    case 'runStatsData': {
      const rows = arr<RunStatRow>(msg.stats).filter((r) => r?.sessionId);
      sink.stats(Object.fromEntries(rows.map((r) => [r.sessionId, r])));
      return true;
    }
    case 'runStepsData': {
      // A reply for a run the user has already navigated away from is dropped —
      // drawing it would put another run's steps under this run's title.
      if (msg.sessionId && msg.sessionId !== sink.selectedRun()) return true;
      const steps = arr<LayoutStep>(msg.steps);
      sink.steps({
        steps,
        members: arr<string>(msg.members),
        truncated: msg.truncated === true,
        total: typeof msg.total === 'number' ? msg.total : steps.length,
        error: typeof msg.error === 'string' ? msg.error : null,
      });
      return true;
    }
    case 'labyrinthColumns':
      sink.columns({
        indexWidthPx: typeof msg.indexWidthPx === 'number' ? msg.indexWidthPx : null,
        inspectWidthPx: typeof msg.inspectWidthPx === 'number' ? msg.inspectWidthPx : null,
        inspectCollapsed: msg.inspectCollapsed === true,
      });
      return true;
    case 'labyrinthPrices':
      sink.prices(msg.prices && typeof msg.prices === 'object' ? (msg.prices as PriceTable) : {});
      return true;
    case 'labDeleteSessionDone':
      sink.deleted({
        ok: msg.ok === true,
        sessionId: String(msg.sessionId ?? ''),
        error: msg.ok === true ? null : String(msg.error ?? 'The chat was not deleted.'),
      });
      return true;
    default:
      return false;
  }
}
