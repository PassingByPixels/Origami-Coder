// tabWaiting.ts — whether a chat's TAB should carry the waiting-for-user
// colour the sidebar ring already uses (chat/sessionRowState.ts): an open
// question batch OR a pending tool-permission approval. Same semantic as the
// ring, for the same reason — the wire carries both through the identical
// `requestPermission` message (see sessionRowState.ts's own note on this),
// so the user's next move is identical either way: open the chat, answer it.
// Pure and DOM-free so the OR rule is testable without a render, and so
// ChatPane (at its 2700-line cap) carries none of it.

/** A chat's tab lights up when a question batch is open for it, OR a
 *  permission ask (current or queued behind it) is still unanswered. */
export function isTabWaiting(hasOpenQuestion: boolean, hasPendingApproval: boolean): boolean {
  return hasOpenQuestion || hasPendingApproval;
}
