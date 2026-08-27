// interjectSplit.ts — WHEN an interjected line becomes a transcript row.
//
// The transcript must read in the order things happened: what the agent said
// before the interjection, then the user's line, then what it said after. It did
// not. The row went up at the keypress while the stream kept appending into the
// bubble opened BEFORE it, so every delta the model produced AFTER being
// interrupted rendered ABOVE the user's row, and their own words drifted down
// the screen as the bubble above them grew.
//
// Two rules fix it, and they are deliberately in different places:
//
//   1. A user row SEALS the open assistant stream. That belongs in addMessage,
//      not here, because it is not a fact about interjections — it is the same
//      rule `toolCall` already applies (close the open bubble so later prose
//      opens a fresh one BELOW, preserving the real interleave), and it must
//      hold for a replayed interjection too, which never passes through here.
//   2. The row is drawn when the HOST answers, not at the keypress. This file.
//
// Why not at the keypress. A row drawn there claims a place in the turn the line
// may never get: `handleTurnMessage` (src/dashboard/turnMessages.ts) posts
// `interjected` on success and an `error` on failure, and one of those failures
// means the engine never saw the text at all (interjectRetry.ts). Sealing on an
// optimistic row would split one assistant turn in two and put a user row
// between the halves on the strength of something that did not happen.
//
// This is the OPPOSITE call to userEcho.ts, on purpose. There the row goes up at
// send to skip a SPECIFIC cost: `send` re-probes the model first (two sequential
// HTTP gets, 4 s timeout each) before it echoes. The interject path has no probe,
// so the wait here is one ext-method round trip — and the composer is not blank
// during it: InterjectingChip.svelte says "interjecting…" for that window.
//
// A FIFO, not a slot. Enter delivers on the keypress now, so a fast typist can
// have several lines outstanding at once, and a single field would let the
// second overwrite the first — which would then never get a row at all. Each
// answer draws the OLDEST line, so rows land in the order they were typed.
// Every host answer resolves one — `interjected`, `error`, `closed` — and the
// turn simply ENDING drains the rest, since no further answer is coming. So the
// user's words can never be swallowed by a reply that does not arrive, and a
// second answer for the same line can never draw a second row.

/** The two fields this rule owns on a chat session, and nothing else. */
export interface InterjectTarget {
  /** At least one line is with the host, unanswered. Drives the chip. */
  interjecting?: boolean;
  /** Those lines, oldest first, each held until there is somewhere honest to
   *  put it. Absent and empty mean the same thing: nothing outstanding. */
  pendingInterject?: string[];
}

/** The keypress: the line has left the composer for the host. No row yet. */
export function armInterject(s: InterjectTarget, text: string): void {
  s.pendingInterject = [...(s.pendingInterject ?? []), text];
  s.interjecting = true;
}

/**
 * A host answer about the OLDEST outstanding line. Returns the text whose row is
 * now due — draw it at the CURRENT end of the transcript, which is the split
 * point — or null when no interjection is outstanding.
 *
 * The same answer for accepted and rejected, and that is the honest shape: on
 * `interjected` the row marks where the turn took the line; on an `error` the
 * row is followed immediately by the `Interject failed: …` row that says it did
 * not land (unless the line never reached the engine at all, which is
 * interjectRetry.ts's call, not this one). Consumes: one interjection, one row.
 */
export function resolveInterject(s: InterjectTarget): string | null {
  const queue = s.pendingInterject ?? [];
  const text = queue[0] ?? null;
  s.pendingInterject = queue.slice(1);
  s.interjecting = s.pendingInterject.length > 0;
  return text;
}

/** Every line still outstanding, oldest first, and the queue emptied. For the
 *  turn simply ENDING: answers still in flight can no longer split anything, and
 *  a line left here is one the user typed and never saw again. */
export function drainInterject(s: InterjectTarget): string[] {
  const all = s.pendingInterject ?? [];
  s.pendingInterject = [];
  s.interjecting = false;
  return all;
}
