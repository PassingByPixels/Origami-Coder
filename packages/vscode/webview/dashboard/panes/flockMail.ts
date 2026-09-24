// THE MAIL MANAGER'S ARITHMETIC — which row goes in which tray, what each row
// says it is, and the exact words a reply carries into a chat.
//
// Out of the component for the reason flockRows.ts is: every one of these has a
// wrong answer that a rendered test can only catch by accident. A reply filed
// under Sent instead of Inbox is a reply the owner never sees; a badge that
// counts an archived row is a badge that never goes out; and the prompt text
// below is the ONLY context a fresh chat gets about a question it did not ask,
// so a version of it that dropped the original question would produce a chat
// answering a stranger's sentence with no idea what it was a reply to.
//
// Types live here too, rather than in flockTypes.ts, because that module was at
// its architecture cap and this is a whole sub-surface, not a field.

export type MailDirection = 'out' | 'in';
export type MailState = 'sent' | 'delivered' | 'answered' | 'declined' | 'expired' | 'pending' | 'answering';

export interface MailReply {
  text: string;
  at: string;
  tokens: number;
  signatureOk: boolean;
  declined?: { reason?: string };
}

export interface MailRow {
  id: string;
  contact: string;
  direction: MailDirection;
  question: { text: string; sentAt: string; tokens?: number };
  state: MailState;
  reply?: MailReply;
  guidance?: string;
  deliveredTo?: string[];
  unread: boolean;
  followUpOf?: string;
  /** The chat that ASKED, when a chat did. Engine session id, plus its title at
   *  the time. What puts "asked from here" at the top of the picker. */
  origin?: { sessionID: string; title?: string };
  /** The contact's display name, folded in engine-side. Empty once revoked. */
  name: string;
  icon: string;
  handleShort: string;
}

export interface Mailbox {
  threads: MailRow[];
  waiting: number;
  unread: number;
}

export type MailTab = 'inbox' | 'sent' | 'archive';

/**
 * WHICH TRAY A ROW BELONGS IN.
 *
 * Inbox is everything that wants the owner: a question waiting on a decision, a
 * draft waiting on Send, and a reply they have not read. Sent is our own
 * questions still out there. Archive is everything finished and seen.
 *
 * A row is in exactly one tray — an owner who has to check two places for the
 * same thing checks neither — and `unread` is what moves a settled reply out of
 * Inbox, not its state, because "answered" says what the contact did and not
 * whether anyone here has looked at it.
 */
export function trayOf(row: MailRow): MailTab {
  if (row.direction === 'in') {
    return row.state === 'pending' || row.state === 'answering' ? 'inbox' : 'archive';
  }
  if (row.unread) return 'inbox';
  return row.state === 'sent' ? 'sent' : 'archive';
}

export function bucket(threads: readonly MailRow[]): Record<MailTab, MailRow[]> {
  const trays: Record<MailTab, MailRow[]> = { inbox: [], sent: [], archive: [] };
  for (const row of threads) trays[trayOf(row)].push(row);
  return trays;
}

/**
 * THE SIDEBAR BADGE. Questions waiting on a decision plus replies nobody has
 * read — the two things that are actually somebody's turn.
 *
 * A row that is both (there is no such row today) would be counted once: the
 * badge is "how many things want you", not a sum of two lists.
 */
export function badgeCount(threads: readonly MailRow[]): number {
  return threads.filter((row) => (row.direction === 'in' && row.state === 'pending') || row.unread).length;
}

/** What a row's state chip says. Prose, because a state id is not a sentence. */
export function stateLabel(row: MailRow): string {
  switch (row.state) {
    case 'pending':
      return 'waiting on you';
    case 'answering':
      return row.reply ? 'drafted — review it' : 'drafting…';
    case 'sent':
      return 'sent — no answer yet';
    case 'answered':
      return row.direction === 'in' ? 'you answered' : 'they answered';
    case 'declined':
      return row.direction === 'in' ? 'you declined' : 'they declined';
    case 'delivered':
      return 'delivered to a chat';
    case 'expired':
      return 'expired — never answered';
  }
}

/** The name to lead a row with. A revoked contact keeps its handle, honestly. */
export function labelOf(row: MailRow): string {
  return row.name.trim() || row.handleShort;
}

/** The reason on a decline, when the other side gave one. */
export function declineReason(row: MailRow): string {
  return row.reply?.declined?.reason?.trim() ?? '';
}
