// One contact, one thread, and which of them the rail opens on. Out of the
// components since every function here has a wrong answer a rendered test
// can only catch by accident: a thread built newest-first reads backwards; a
// day separator on the wrong row splits one conversation into two days; a
// "last line" taken from the question when a reply exists shows the owner
// their own words instead of the answer waiting for them.
//
// It knows nothing about the DOM, and takes `now` rather than reading the
// clock, so "TODAY" is assertable instead of true for one day only.

import { declineReason, labelOf, type MailRow } from './flockMail';
import { displayNameOf, iconOf } from './flockRows';
import type { FlockFriendRow } from './flockTypes';

/** The rail's first row: every contact's mail at once, in the three trays. */
export const ALL_MAIL = '__all__';

/** One contact, and everything ever exchanged with them. */
export interface ContactThread {
  /** The FULL handle. What the rail selects on and what the composer addresses. */
  handle: string;
  /** The owner's label for them, else the name they use, else the handle. */
  name: string;
  icon: string;
  handleShort: string;
  /** Oldest first — a messenger reads down. */
  rows: MailRow[];
  /** The rail's second line: the newest thing said, whoever said it. */
  last: string;
  /** Their questions parked on a decision. */
  waiting: number;
  /** Their replies nobody has read. */
  unread: number;
}

/** A run of rows that happened on one day, with the separator that heads it. */
export interface ThreadDay {
  /** `TODAY`, or the ISO date. Drawn as the mockup's `.day` divider. */
  label: string;
  rows: MailRow[];
}

/** The UTC day an instant falls in. UTC on both sides, so the comparison in
 *  {@link threadDays} cannot straddle a timezone and label yesterday TODAY. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** The last line of a thread: what was said last, not what was asked first.
 *  A decline reads as its reason, the same words FlockMailBubbles draws in
 *  the bubble. */
function lastLine(row: MailRow | undefined): string {
  if (!row) return '';
  if (row.reply) return declineReason(row) || row.reply.text.trim();
  return row.question.text.trim();
}

/** Every contact, with their whole thread. Driven by the friends list first
 *  and the mail second, so a contact accepted five seconds ago has a rail
 *  row to click before they've ever said anything. A revoked contact keeps
 *  its thread, since dropping it would delete history to tidy a list, and
 *  leads with `labelOf`, which falls back to the handle honestly. Order is
 *  newest activity first, then silent contacts by name. */
export function contactThreads(threads: readonly MailRow[], friends: readonly FlockFriendRow[]): ContactThread[] {
  const byHandle = new Map<string, ContactThread>();
  const seed = (handle: string, from: FlockFriendRow | MailRow): ContactThread => ({
    handle,
    name: 'policy' in from ? displayNameOf(from) : labelOf(from),
    icon: iconOf(from),
    handleShort: from.handleShort,
    rows: [],
    last: '',
    waiting: 0,
    unread: 0,
  });

  for (const friend of friends) byHandle.set(friend.handle, seed(friend.handle, friend));
  for (const row of threads) {
    const thread = byHandle.get(row.contact) ?? seed(row.contact, row);
    byHandle.set(row.contact, thread);
    thread.rows.push(row);
    if (row.direction === 'in' && row.state === 'pending') thread.waiting++;
    if (row.unread) thread.unread++;
  }

  const out = [...byHandle.values()];
  for (const thread of out) {
    thread.rows.sort((a, b) => a.question.sentAt.localeCompare(b.question.sentAt));
    thread.last = lastLine(thread.rows[thread.rows.length - 1]);
  }
  return out.sort((a, b) => {
    const at = a.rows[a.rows.length - 1]?.question.sentAt ?? '';
    const bt = b.rows[b.rows.length - 1]?.question.sentAt ?? '';
    if (at !== bt) return bt.localeCompare(at);
    return a.name.localeCompare(b.name);
  });
}

/** The day separators. Consecutive rows on one day share one divider; a row
 *  on a new day starts a new group. Grouping runs over the already-sorted
 *  rows rather than a map keyed by date, since two visits to the same day
 *  would otherwise collapse and print the second day's rows above the first's. */
export function threadDays(rows: readonly MailRow[], now: Date): ThreadDay[] {
  const today = now.toISOString().slice(0, 10);
  const out: ThreadDay[] = [];
  for (const row of rows) {
    const day = dayOf(row.question.sentAt);
    const label = day === today ? 'TODAY' : day;
    const tail = out[out.length - 1];
    if (tail && tail.label === label) tail.rows.push(row);
    else out.push({ label, rows: [row] });
  }
  return out;
}

/** Which rail row opens first: "All mail" whenever anything waits on the
 *  owner (a question parked on a decision, or an unread reply), since that
 *  pane answers "what wants me" and it can be on a contact the rail hasn't
 *  selected. With nothing waiting, the newest thread. With no contacts, "All
 *  mail" and its empty trays. */
export function defaultSelection(threads: readonly ContactThread[]): string {
  if (threads.some((thread) => thread.waiting > 0 || thread.unread > 0)) return ALL_MAIL;
  return threads[0]?.handle ?? ALL_MAIL;
}

/** PIN TO THE BOTTOM: within ~40px counts as "there" (rounding, a scrollbar's
 *  own width) — scrolled up to read history, a new row must not yank it back. */
export function shouldPin(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= 40;
}

/** The time under a bubble. Local, because the owner reads it beside a clock. */
export function timeOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
