// interjectRetry.ts — WHICH interject failure means the line must be sent again.
//
// Enter mid-turn delivers straight into the running turn, so a line the host
// refuses has nowhere to wait: there is no queue chip left holding a copy of it.
// Either it is re-sent, or the user's words are gone. But re-sending the WRONG
// failure is the double-send — the same defect the retired queue guarded — so
// exactly one failure qualifies, and this file is that judgement.
//
// What the engine actually does, since 19be94b666 (engine/session/prompt.ts's
// `interject`): it never refuses for "the turn is over". On an IDLE session it
// writes the user message and FORKS the turn a plain send would have started,
// answering `{ delivered: true, busy: false }`. So the classic race — the turn
// ends between the keypress and the ext-method — is ACCEPTANCE, not rejection,
// and needs no retry at all; the row lands on `interjected` as usual. The only
// visible trace is the synthetic envelope the model reads.
//
// That leaves one failure where the text provably never crossed the wire:
// turnMessages.ts's own pre-flight refusal, when the chat has no engine session
// to address (no client, or the handshake has not produced an engine id yet).
// It posts a FIXED sentence, and that sentence is the discriminator. Every other
// error — an engine-side reject, a session that vanished, a turn error arriving
// while a line happens to be outstanding — may have taken the line already, so
// those keep the annotated shape (the row, then the failure under it).
//
// The sentence is MIRRORED, not imported: tsconfig.webview.json pins rootDir to
// webview/, so a .ts leaf here cannot import anything from src/ — not even a
// type. composerEnter.test.ts reads BOTH files and fails if they drift, which is
// the standing obligation for every mirror in this codebase.

/** Mirrored VERBATIM from src/dashboard/turnMessages.ts's `interject` guard. */
export const NEVER_REACHED_ENGINE = 'Interject failed: no running turn to interject into.';

/**
 * Should the outstanding line be re-sent as an ordinary next prompt?
 *
 * True only for the host's pre-flight refusal above. `false` for everything
 * else, including the empty string: an error with no message says nothing about
 * where the line got to, and silence is not permission to send it twice.
 */
export function retryAsPrompt(errorMessage: string): boolean {
  return errorMessage.trim() === NEVER_REACHED_ENGINE;
}
