// Tweak 2 (0.2.176) — the pure selector behind the pinned last-user-message
// header. Split out of ChatPane so the "which message do we pin" rule is a
// testable leaf: it is the MOST RECENT user message's text, independent of
// whether a turn is in flight (the 0.2.174 pin was inFlight-gated and vanished
// when the stream ended; this keeps it up from send through the response until
// the next user message replaces it). Empty string ⇒ nothing to pin, and
// PinnedUserMessage renders nothing.
//
// Send-echo UAT (0.4.18): with NOTHING below it the pin is not a mirror, it is
// a duplicate — the real row is right there, one line under it, and the user
// reads their own words twice. That is the "appears TWICE" half of the report.
// The pin is for output scrolling UNDER it, so it earns its place only once
// output exists.

interface PinnableMessage {
  kind: string;
  text: string;
}

/** The text to mirror at the top of the transcript, or '' when there is
 *  nothing to mirror — no user message yet, or the latest one is still the
 *  last row (already on screen; a second copy is noise). */
export function pinnedMirrorText(messages: readonly PinnableMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind !== 'user') continue;
    return i === messages.length - 1 ? '' : messages[i].text;
  }
  return '';
}
