// What a finished turn does with text that was waiting on it — EXTRACTED
// VERBATIM from ChatPane.svelte's `turnDone` case, which sat at 2700/2700 with
// no room for the Interject wiring beside it.
//
// ONE thing waits here now, and the second one leaving is the point. There used
// to be two: a plan-mode "Revise" (`pendingSend`) and a line the user typed
// mid-turn (`queuedMessage`), with the Revise outranking the typed line. The
// composer no longer queues — Enter during a turn delivers into the turn
// (interjectSplit.ts) — so `queuedMessage` had no writer left and went with the
// chip. The ORDER rule went with it; there is nothing to order.
//
// The `setTimeout(..., 0)` is not decoration. It defers the fresh send past the
// rest of the turnDone body (todo summary, the linger timer), so that work still
// resolves against the turn that just ENDED rather than the one this starts.
// The field is cleared BEFORE the send is armed, so a second `turnDone` for the
// same session cannot fire it twice.

/** The one field this rule reads, and nothing else about a chat session. */
export interface QueuedFlushTarget {
  /** A revision the user submitted from the plan panel while the plan turn was
   *  still running — it can only go out once that turn is over. */
  pendingSend?: string;
}

/**
 * Send whatever was waiting on the turn that just ended.
 *
 * `send` is the pane's own `handleSendForSession` — passed in rather than
 * imported, because this rule is about WHEN the text goes, not about how a chat
 * session sends.
 */
export function flushQueuedSend<S extends QueuedFlushTarget>(
  s: S,
  send: (session: S, text: string) => void,
): void {
  if (s.pendingSend) {
    const revision = s.pendingSend;
    s.pendingSend = undefined;
    setTimeout(() => send(s, revision), 0);
  }
}
