// nestAway.ts — t-t7lfho: the pure half of the hand-over UX. No DOM, no wire.
//
// A chat this desk gave to another desk comes in the host push as `away`
// (nestIndex.ts parses it). Its pane shows a bar in place of the composer and
// a block at the end of the transcript; its Here row shows an "on <desk>" chip.
// Every sentence they say is chosen here, in ASD-STE100 wording. A desk name
// comes from the roster; a raw device id is never shown.
//
// `arrive` is the sidebar's Continue result rule: which row moved or forked
// here, read from the row the user CLICKED (the host's next index has already
// dropped a taken row by the time the result lands).

import { deskOf, type NestArrival, type NestAwayRow, type NestIndex, type NestIndexRow } from './nestIndex';

export function awayOf(index: NestIndex, id: string): NestAwayRow | undefined {
  return (index.away ?? []).find((w) => w.id === id);
}

/** The roster name of a desk. A roster entry with no name of its own (its name
 *  is its id), and a desk not in the roster, fall back to a row's copy of the
 *  name, then to "another desk". */
export function awayName(index: NestIndex, desk: string): string {
  const d = deskOf(index, desk);
  if (d && d.name && d.name !== d.id) return d.name;
  return index.rows.find((r) => r.desk === desk && r.deskName && r.deskName !== desk)?.deskName || 'another desk';
}

/** "14:02" in this desk's local time. */
export function clockText(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The bar's line, and the chip's tooltip first sentence. A record with no time says none. */
export function awayLine(index: NestIndex, w: NestAwayRow): string {
  return `Continued on ${awayName(index, w.desk)}${w.at > 0 ? ` at ${clockText(w.at)}` : ''}`;
}

/** The transcript block. */
export function awayBlockText(index: NestIndex, w: NestAwayRow): string {
  return `${awayLine(index, w)}. You can read this chat here, but you cannot write in it. To write in it, click Take back here.`;
}

export function awayChipTip(index: NestIndex, w: NestAwayRow): string {
  return `${awayLine(index, w)}. This desk can only read it.`;
}

export function viewTip(index: NestIndex, w: NestAwayRow): string {
  return `Get the newest copy from ${awayName(index, w.desk)} and read it here. You cannot write in it.`;
}

/** Take back here with no index row for the chat yet: the host says which case it is. */
export const TAKE_BACK_TIP = 'Move this chat back to this desk.';

/** The sidebar's "moved here this session" ids, less the ones that left this desk again. */
export function notAway(gone: ReadonlySet<string>, index: NestIndex): ReadonlySet<string> {
  const left = new Set((index.away ?? []).map((w) => w.id));
  return [...gone].some((id) => left.has(id)) ? new Set([...gone].filter((id) => !left.has(id))) : gone;
}

/** The Continue result as the sidebar records it, or null when it names nothing it asked for. */
export function arrive(
  index: NestIndex,
  row: NestIndexRow | undefined,
  msg: Record<string, unknown>,
): { gone?: string; id: string; arrival: NestArrival } | null {
  if (!row || (msg.result !== 'taken' && msg.result !== 'forked')) return null;
  const id = typeof msg.newId === 'string' && msg.newId ? msg.newId : row.id;
  const fromDesk = awayName(index, row.desk);
  if (msg.result === 'taken') return { gone: row.id, id, arrival: { kind: 'moved', fromDesk } };
  return { id, arrival: { kind: 'forked', fromDesk, parent: { id: row.id, title: row.title, desk: row.desk } } };
}
