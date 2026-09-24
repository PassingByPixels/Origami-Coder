// nestIndex.ts — t-s9k0q6 (Nests L4c): the pure half of the sidebar's flat
// Nest view (Mock-Redesign round 7, rules 1-5). No DOM, no wire: the host push
// is parsed here, the list is ordered and filtered here, and every sentence
// the rows and the read-only popover say is chosen here, so the components
// only draw.
//
// THE WIRE (shared with L4a t-s9jgzh and L5; do not change it here):
//   origami/nestIndex { rows: NestIndexRow[], desks: NestDesk[] }
// `rows` are the chats on the OTHER desks (the host drops this desk's own rows
// before it posts, see src/dashboard/nestSidebar.ts). `desks` is the whole
// group, this desk included, so "another desk is registered" is
// desks.length > 1. The host sends no desks while origamicoder.nests.enabled
// is off, which is how rule 1's two conditions become one.

export type NestState = 'running' | 'open' | 'closed';

export interface NestIndexRow {
  id: string;
  title: string;
  /** Device id of the desk the chat is on. */
  desk: string;
  deskName: string;
  state: NestState;
  /** Device id of the owner. */
  owner: string;
  /** Last message time, ms. */
  lastAt: number;
  forkOf?: { id: string; desk: string; at: number };
  size: number;
  seq: number;
}

export interface NestDesk {
  id: string;
  name: string;
  os: string;
  online: boolean;
  lastSeen: number;
  motherBase: boolean;
}

/** t-t7lfho: a chat this desk gave to another desk (src/dashboard/nestAway.ts, mirrored). */
export interface NestAwayRow { id: string; desk: string; at: number }

export interface NestIndex {
  rows: NestIndexRow[];
  desks: NestDesk[];
  away?: NestAwayRow[];
}

/** What "Continue here" does to one chat, as the host will decide it. */
export type ContinueCase = 'idle' | 'offline' | 'running' | 'closed';

/** What came in from the nest this session, keyed by the LOCAL chat id. */
export interface NestArrival {
  kind: 'moved' | 'forked';
  /** The desk the chat (or its parent) is on. */
  fromDesk: string;
  /** The parent chat, for a fork. */
  parent?: { id: string; title: string; desk: string };
}

const STATES: readonly string[] = ['running', 'open', 'closed'];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** A webview is not a trusted validator of the host either: a row without an
 *  id, a desk or a known state is dropped, not guessed at. */
export function parseNestIndex(msg: { rows?: unknown; desks?: unknown; away?: unknown }): NestIndex {
  const rows: NestIndexRow[] = [];
  for (const r of Array.isArray(msg.rows) ? msg.rows : []) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = str(o.id), desk = str(o.desk), state = str(o.state);
    if (!id || !desk || !STATES.includes(state)) continue;
    const f = o.forkOf as Record<string, unknown> | undefined;
    rows.push({
      id,
      title: str(o.title) || id,
      desk,
      deskName: str(o.deskName),
      state: state as NestState,
      owner: str(o.owner) || desk,
      lastAt: num(o.lastAt),
      ...(f && typeof f === 'object' && str(f.id) ? { forkOf: { id: str(f.id), desk: str(f.desk), at: num(f.at) } } : {}),
      size: num(o.size),
      seq: num(o.seq),
    });
  }
  const desks: NestDesk[] = [];
  for (const d of Array.isArray(msg.desks) ? msg.desks : []) {
    if (!d || typeof d !== 'object') continue;
    const o = d as Record<string, unknown>;
    if (!str(o.id)) continue;
    desks.push({
      id: str(o.id),
      name: str(o.name) || str(o.id),
      os: str(o.os),
      online: o.online === true,
      lastSeen: num(o.lastSeen),
      motherBase: o.motherBase === true,
    });
  }
  const away = (Array.isArray(msg.away) ? msg.away : []).map((w) => (w && typeof w === 'object' ? w as Record<string, unknown> : {}))
    .filter((w) => str(w.id) && str(w.desk)).map((w) => ({ id: str(w.id), desk: str(w.desk), at: num(w.at) }));
  return { rows, desks, away };
}

/** Rule 1: the control exists only when another desk is registered (and the
 *  host only sends desks while Nests is on). */
export function nestGateOn(index: NestIndex): boolean {
  return index.desks.length > 1;
}

export function deskOf(index: NestIndex, id: string): NestDesk | undefined {
  return index.desks.find((d) => d.id === id);
}

/** The name a row shows for its desk: the desk list's name wins over the
 *  row's copy, which can be older. */
export function deskName(index: NestIndex, row: NestIndexRow): string {
  return deskOf(index, row.desk)?.name || row.deskName || row.desk;
}

/** A desk the list does not name is treated as offline: nothing says it is up. */
export function continueCase(row: NestIndexRow, desk: NestDesk | undefined): ContinueCase {
  if (row.state === 'closed') return 'closed';
  if (!desk || !desk.online) return 'offline';
  return row.state === 'running' ? 'running' : 'idle';
}

/** Rule 5: only a turn that runs NOW makes a fork; everything else moves. */
export function continueKind(row: NestIndexRow, desk: NestDesk | undefined): 'moved' | 'forked' {
  return continueCase(row, desk) === 'running' ? 'forked' : 'moved';
}

/** The "Continue here" tooltip, one per case (round 7 rule 5). */
export function continueTip(row: NestIndexRow, desk: NestDesk | undefined, name: string): string {
  switch (continueCase(row, desk)) {
    case 'running': return `${name} is mid-turn: this makes a fork here`;
    case 'offline': return `${name} is offline: this moves the chat here.\nAnything ${name} wrote while away comes back as a fork.`;
    case 'closed': return `Closed on ${name}: this opens the chat again here`;
    default: return `${name} is idle: this moves the chat here`;
  }
}

/** The read-only popover's one sentence. `home` is the mother base, which
 *  serves the body while the owner desk is offline. */
export function readText(row: NestIndexRow, desk: NestDesk | undefined, name: string, home: NestDesk | undefined, now: number): string {
  switch (continueCase(row, desk)) {
    case 'running': return `${name} is mid-turn. You can read along here. Continue here makes a fork on this desk; the turn on ${name} goes on.`;
    case 'offline': return `${name} is offline, so the body comes from the mother base${home ? ` (${home.name})` : ''}. To write in it, continue here.`;
    case 'closed': return `Closed on ${name} · ${ageText(row.lastAt, now)}. The body pulls from ${name} when you open it. To write in it, continue here.`;
    default: return `This chat lives on ${name}. You can read it here. To write in it, continue here: it moves to this desk.`;
  }
}

/** Rule 4's ages: "now", "8 min", "3 h", "1 d", "1 w". */
export function ageText(lastAt: number, now: number): string {
  const min = Math.max(0, Math.floor((now - lastAt) / 60_000));
  if (min < 1) return 'now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d`;
  return `${Math.floor(d / 7)} w`;
}

export interface NestRows {
  open: NestIndexRow[];
  closed: NestIndexRow[];
  /** Rows in the nest before the query: the "2 of 9" denominator. */
  total: number;
}

/** Rules 2-3: the flat list. `gone` = ids that moved to this desk this session
 *  (the next index push drops them too; until then they must not show twice).
 *  Running first (only on a desk that is up: an offline desk's "running" is
 *  stale), then open by last activity, newest first; closed newest first. The
 *  query matches the title or the desk name, case-insensitively. */
export function nestRows(index: NestIndex, query: string, gone: ReadonlySet<string>): NestRows {
  const all = index.rows.filter((r) => !gone.has(r.id));
  const q = query.trim().toLowerCase();
  const shown = q
    ? all.filter((r) => r.title.toLowerCase().includes(q) || deskName(index, r).toLowerCase().includes(q))
    : all;
  const live = (r: NestIndexRow) => (continueCase(r, deskOf(index, r.desk)) === 'running' ? 1 : 0);
  const open = shown.filter((r) => r.state !== 'closed').sort((a, b) => live(b) - live(a) || b.lastAt - a.lastAt);
  const closed = shown.filter((r) => r.state === 'closed').sort((a, b) => b.lastAt - a.lastAt);
  return { open, closed, total: all.length };
}

/** Rule 2 in Here: a chat another desk owns is in the Nest only. A read-only
 *  open can put one in this window's session list; Here drops it (and the
 *  section counts follow) until it moves here. t-t7lfho: a chat this desk GAVE
 *  to another desk stays in Here, with its "on <desk>" chip. */
export function hereHiddenIds(index: NestIndex, gone: ReadonlySet<string>): Set<string> {
  const away = new Set((index.away ?? []).map((w) => w.id));
  return new Set(index.rows.map((r) => r.id).filter((id) => !gone.has(id) && !away.has(id)));
}

/** The filter line under the search box, or '' with no query. */
export function filterText(shown: number, total: number, query: string): string {
  const q = query.trim();
  if (!q) return '';
  return shown ? `${shown} of ${total} match "${q}"` : `No chat in the nest matches "${q}"`;
}
