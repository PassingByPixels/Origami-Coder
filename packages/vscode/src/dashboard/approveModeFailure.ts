// approveModeFailure.ts — what a FAILED approve-mode write says, to the user
// and to the phone.
//
// On failure a `system` line goes to the pane and an unsigned
// `remote/set-mode: ask` goes to the phone — lowering privilege needs no proof.

export type FailurePost = (msg: Record<string, unknown>) => void;

export function postApproveModeFailure(post: FailurePost, sid: string | undefined, mode: string, reason: string): void {
  post({ type: 'system', text: `Couldn't set approve mode "${mode}" — ${reason}`, sessionId: sid ?? '' });
  if (sid) post({ type: 'remote/set-mode', v: 1, mode: 'ask', sessionId: sid, reason });
}
