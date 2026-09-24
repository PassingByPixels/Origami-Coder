// composerPrefill.ts — the rule behind `composerPrefill`, the one host message
// that puts text into a composer the user did not type (t-f89g49).
//
// WHY A PREFILL AND NOT A SEND. Starting a side quest opens a NEW chat, and a
// new chat has no model yet: the owner picks one, and answers the "also use for
// sub-agents" follow-up, before the first turn goes out (ModelPicker.svelte,
// ModelPickerFollowUp.svelte). A Start that SENT the brief would burn that
// choice on whatever the new cell defaulted to. So the brief lands in the
// composer and the owner presses Send.
//
// A LEAF with the whole rule in it, because the rule is the dangerous part:
// this is the only path by which one surface writes into another's text box,
// and "never overwrite what the user typed" has to be one testable function
// rather than a condition spelled out at the call site.
//
// EXACT SESSION MATCH, deliberately NOT the InputBar's ordinary
// `msg.sessionId == null || msg.sessionId === sessionId` broadcast rule. Every
// other host message is safe to broadcast to every open composer; this one
// would drop the same paragraph into all of them.

/** The host frame. `sessionId` is required — see the header. */
export interface ComposerPrefill {
  type: 'composerPrefill';
  sessionId: string;
  text: string;
}

/**
 * The text this composer should take from `msg`, or null to ignore it.
 *
 * Refused when: the type is anything else; the frame names no session or names
 * another cell's; the text is empty; or THIS composer already holds something.
 * `current.trim()` rather than `current`, so a composer holding only the
 * whitespace a stray keystroke left is still "empty" — but any real draft, in
 * progress or abandoned, wins over a prefill the user never asked for.
 */
export function prefillFor(msg: unknown, sessionId: string | null, current: string): string | null {
  const m = msg as Partial<ComposerPrefill> | null;
  if (m?.type !== 'composerPrefill') return null;
  if (typeof m.sessionId !== 'string' || !m.sessionId || m.sessionId !== sessionId) return null;
  if (typeof m.text !== 'string' || !m.text) return null;
  return current.trim() === '' ? m.text : null;
}
