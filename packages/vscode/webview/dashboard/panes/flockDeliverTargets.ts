// Where a reply goes, and in what order — the "send to chat" picker's
// arithmetic, and the message one pick posts.
//
// Its own leaf: flockMail.ts owns which tray a row is in; this is the
// only place that knows a webview chat id from an engine one.
// the tray tests.

import type { MailRow } from './flockMail';

/**
 * A chat the owner has open. `engineId` is what a thread's `origin` is
 * matched against — the webview's own `session-3` names nothing the
 * engine holds, so comparing `id` to an origin would offer "New chat" first.
 */
export interface MailSession {
  id: string;
  label: string;
  engineId?: string;
}

/** One entry in the picker. `value` is a LOCAL session id, or `new`. */
export interface DeliverTarget {
  value: string;
  label: string;
  /** Set on the origin entry when that chat is CLOSED: the engine session id to
   *  recall before delivering into it. */
  recall?: string;
}

/**
 * Where a reply can go, in order it should go there. The chat that
 * asked comes first, always — even closed, its entry stays at the top
 * and carries the engine session id to recall, since the right chat
 * closed still beats a blank one. Then "New chat", then every other
 * open chat. A thread with no origin starts at "New chat".
 */
export function deliverTargets(row: MailRow, sessions: readonly MailSession[]): DeliverTarget[] {
  const origin = row.origin?.sessionID;
  const open = origin ? sessions.find((session) => session.engineId === origin) : undefined;
  const head: DeliverTarget[] = open
    ? [{ value: open.id, label: `${open.label} · asked from here` }]
    : origin
      ? [{ value: 'recall', label: `${row.origin?.title || 'the chat that asked'} · recall it`, recall: origin }]
      : [];
  const rest = sessions
    .filter((session) => session !== open)
    .map((session) => ({ value: session.id, label: session.label }));
  return [...head, { value: 'new', label: 'New chat' }, ...rest];
}

/**
 * The message one pick posts — never a `send`. The engine writes the
 * envelope (`flock/deliver.ts`); both doors post a row id and let it do
 * that: `flockOpenChat` opens a chat first, `flockDeliver` names one
 * already open. Kept here, not in each caller, since two spellings of
 * one message is how one of them stops working.
 */
export function deliverMessage(row: MailRow, target: DeliverTarget): Record<string, unknown> {
  if (target.recall) return { type: 'flockOpenChat', thread: row.id, recall: target.recall };
  if (target.value === 'new') return { type: 'flockOpenChat', thread: row.id };
  return { type: 'flockDeliver', thread: row.id, sessionID: target.value };
}
