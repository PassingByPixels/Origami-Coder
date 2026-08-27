// Triage's quick capture, pure half (contract §11.2). QuickAdd.svelte started as
// one field and grew to five, and the part that carries real rules is the wire
// shape it posts: which field is required, which are dropped when they still
// hold their default, and how the two free-text lists are split. Those rules are
// string-in / object-out, so they live here where a test can state them without
// standing up a DOM.

/** The boxes exactly as the user left them — untrimmed, unsplit. QuickAdd binds
 *  these straight to its inputs and hands the whole draft over; the normalising
 *  is this module's job, not the form's. */
export interface QuickAddDraft {
  root: string;
  title: string;
  body: string;
  priority: string;
  labels: string;
  acceptance: string;
}

/** The `amTicketQuickAdd` message, or null when there is no ticket to post.
 *  A body with no title is not a ticket, so a blank title is refused here
 *  rather than posted half-formed. A field still holding its default is OMITTED
 *  rather than sent empty: `tickets.ts` quickAdd() defaults to exactly the same
 *  values, so leaving them out costs nothing and keeps a title-only capture
 *  posting the same four-key message it posted before this form grew fields. */
export function buildQuickAddTicket(draft: QuickAddDraft): Record<string, unknown> | null {
  const t = draft.title.trim();
  if (!t) return null;
  const labelArr = draft.labels.split(',').map((s) => s.trim()).filter(Boolean);
  const accArr = draft.acceptance.split('\n').map((s) => s.trim()).filter(Boolean);
  const msg: Record<string, unknown> = {
    type: 'amTicketQuickAdd', root: draft.root, title: t, body: draft.body.trim(),
  };
  if (draft.priority !== 'normal') msg.priority = draft.priority;
  if (labelArr.length) msg.labels = labelArr;
  if (accArr.length) msg.acceptance = accArr;
  return msg;
}

/** Rows for the tasks box: grows with the list, 2 rows to 4, then scrolls. A
 *  fixed 2 hides what you typed, a fixed 4 eats a third of a Triage column. */
export function quickAddRows(body: string): number {
  return Math.min(4, Math.max(2, body.split('\n').length));
}
