// streamDropNotice.ts — what the webview knows about a dropped provider stream,
// and the rule that turns a run of notices into ONE card (t-q90gj9).
//
// MIRROR of src/acpStreamDrop.ts's StreamDropNotice. A webview .ts file cannot
// import anything from src/ — not even a type: tsconfig.webview.json pins
// rootDir to webview/, and TS6059 fires on a plain .ts the moment it enters the
// program. streamDropNotice.test.ts reads BOTH files and fails if the two
// declarations drift.
//
// NOTHING here matches text. The engine names the facts; these rules only
// decide which of the three cards is showing.

/** One notice off the wire. `detail` is the provider's own sentence, verbatim. */
export interface StreamDropNotice {
  kind: 'retrying' | 'stopped';
  attempt: number;
  max: number;
  detail: string;
  terminal: boolean;
}

/** What the card looks like. `recovered` is never sent — it is EARNED, below. */
export type StreamDropState = 'retrying' | 'recovered' | 'stopped';

/** The row a transcript holds for one stream-drop card. */
export interface StreamDropRow {
  notice: StreamDropNotice;
  /** Set once real output — prose, reasoning or a tool call — landed after
   *  this notice and before any later drop. Held on the row, not derived at
   *  render time, so leaving and re-entering a view cannot un-recover a card. */
  recovered?: boolean;
}

/** Fail-closed shape check for a value off the host wire. */
export function asStreamDropNotice(value: unknown): StreamDropNotice | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { kind, attempt, max, detail } = value as Record<string, unknown>;
  if (kind !== 'retrying' && kind !== 'stopped') return undefined;
  if (!Number.isInteger(attempt) || !Number.isInteger(max)) return undefined;
  if (typeof detail !== 'string') return undefined;
  return { kind, attempt: attempt as number, max: max as number, detail, terminal: kind === 'stopped' };
}

export function streamDropState(row: StreamDropRow): StreamDropState {
  if (row.notice.kind === 'stopped') return 'stopped';
  return row.recovered ? 'recovered' : 'retrying';
}

/** The card's headline. Attempt numbers are the engine's, never recomputed. */
export function streamDropTitle(state: StreamDropState, notice: StreamDropNotice): string {
  if (state === 'stopped') return `Stopped after ${notice.attempt} of ${notice.max} attempts`;
  if (state === 'recovered') return `Recovered on attempt ${notice.attempt} of ${notice.max}`;
  return `Retrying \u00b7 attempt ${notice.attempt} of ${notice.max}`;
}

/**
 * A LATER notice arriving while a card is open: does it belong to the card, or
 * does it open a new one?
 *
 * It belongs while the ladder is climbing — the engine sends one per attempt and
 * five drops must read as one card counting up, not five stacked cards, which is
 * the blob this feature exists to undo. A card that already RECOVERED is closed:
 * the stream came back and this is a fresh failure. So is a card that STOPPED.
 */
export function continuesCard(open: StreamDropRow, next: StreamDropNotice): boolean {
  if (open.recovered || open.notice.kind === 'stopped') return false;
  return next.attempt >= open.notice.attempt;
}

/**
 * Real output landed. The OPEN card (the latest one, if it is still
 * retrying) is marked recovered; every earlier card keeps whatever it
 * already said.
 *
 * Bounded by the next drop BY CONSTRUCTION: a later notice either continues this
 * card — which then stops being the one prose can recover, because the attempt
 * that failed is newer than the prose — or opens a new card that this run of
 * prose is already behind. Measured failing first in the mock: without the
 * bound, prose replayed after a spent ladder flipped a `gave up after 3` card to
 * `recovered on attempt 3 of 3`.
 */
export function recoverOpenCard(row: StreamDropRow | undefined): StreamDropRow | undefined {
  if (!row || row.recovered || row.notice.kind === 'stopped') return undefined;
  return { ...row, recovered: true };
}

/**
 * Real output landed AFTER the open card: close it, wherever it sits in
 * `rows`. Returns `rows` UNCHANGED when there is nothing to close, so a
 * caller can apply it on every line — prose, reasoning or a tool call —
 * without checking first.
 *
 * "Open" means the LAST row of kind 'streamDrop': scanning from the end for
 * it is what makes it the latest one by construction, with no later
 * stream-drop row after it. After a retry the model often resumes with
 * reasoning or tool calls before any prose, so those rows land AFTER the
 * card without being the card's neighbour — the card is no longer
 * `rows[rows.length - 1]`, only the last row of ITS KIND. Reading only the
 * last row (the old rule) is exactly why the card in the owner's screenshot
 * never settled: "Thought process" and two tool rows landed after it and
 * `settleStreamDrop` never looked past the very end.
 *
 * Generic over the row type because two callers hold different ones — the live
 * pane's Message and the restore path's rebuilt row — and the rule must be the
 * same in both, or a reload disagrees with what the user was just looking at.
 */
export function settleStreamDrop<R extends { kind?: string; streamDrop?: StreamDropRow }>(rows: R[]): R[] {
  let openIndex = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    // A user turn ends the search: output of a NEW turn must not recover a
    // card the user stopped mid-retry in an earlier one.
    if (rows[i]?.kind === 'user') break;
    if (rows[i]?.kind === 'streamDrop') { openIndex = i; break; }
  }
  if (openIndex === -1) return rows;
  const open = rows[openIndex];
  const settled = recoverOpenCard(open.streamDrop);
  if (!settled) return rows;
  return [...rows.slice(0, openIndex), { ...open, streamDrop: settled }, ...rows.slice(openIndex + 1)];
}

/**
 * A NEW notice arriving: the rows with it folded into the open card, or
 * undefined when it opens a fresh one (the caller owns row ids, so it appends).
 *
 * The fold is the whole point. The engine sends one notice per attempt, and the
 * text form appended them to a single bubble — `…attempt 1 of 3.Stream dropped
 * (…attempt 2 of 3.` — which is what a reader saw. One card counting up says the
 * same thing and can be read.
 */
export function foldStreamDrop<R extends { kind?: string; streamDrop?: StreamDropRow }>(
  rows: R[],
  notice: StreamDropNotice,
): R[] | undefined {
  const open = rows[rows.length - 1];
  if (open?.kind !== 'streamDrop' || !open.streamDrop) return undefined;
  if (!continuesCard(open.streamDrop, notice)) return undefined;
  return [...rows.slice(0, -1), { ...open, streamDrop: { notice } }];
}

/** The last thing the USER actually typed, for Retry. Empty when there is none
 *  — a card with no prompt above it has nothing to send again. */
export function lastUserText(rows: readonly { kind?: string; text?: string }[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.kind === 'user' && row.text?.trim()) return row.text;
  }
  return '';
}
