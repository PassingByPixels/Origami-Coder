// interjectSplit.ts — when an interjected line becomes a transcript row.
//
// The transcript must read in the order things happened: what the agent
// said before the interjection, then the user's line, then what it said
// after. It used to draw the row at the keypress while the stream kept
// appending into the bubble opened before it, so post-interruption deltas
// rendered above the row.
//
// Two rules fix it, deliberately in different places: (1) a user row seals
// the open assistant stream — that belongs in addMessage, since it's the
// same rule `toolCall` already applies, and must hold for a replayed
// interjection, which never comes through here; (2) the row is drawn when
// the host answers, not at the keypress — this file. A row drawn at the
// keypress claims a place in the turn the line may never get, since
// `handleTurnMessage` can post an `error` meaning the engine never saw the
// text at all. The opposite call to userEcho.ts on purpose: that row goes
// up at send to skip a reprobe, and this path has no probe to skip.
//
// A FIFO, not a slot: a fast typist can have several lines outstanding at
// once, and a single field would let the second overwrite the first. Each
// answer draws the oldest line. Every host answer resolves one, and the
// turn ending drains the rest, so a reply that never arrives can't swallow
// the words.

/** One outstanding line, with whatever was attached to it. `images` are
 *  `data:` URLs, the same encoding `echoUser` hands an ordinary prompt's row. */
export interface InterjectLine {
  text: string;
  images?: string[];
}

/** The two fields this rule owns on a chat session. */
export interface InterjectTarget {
  /** At least one line is with the host, unanswered. Drives the chip. */
  interjecting?: boolean;
  /** Those lines, oldest first. Absent and empty both mean nothing outstanding. */
  pendingInterject?: InterjectLine[];
}

/** The keypress: the line has left the composer for the host. No row yet. */
export function armInterject(s: InterjectTarget, text: string, images?: string[]): void {
  s.pendingInterject = [...(s.pendingInterject ?? []), images?.length ? { text, images } : { text }];
  s.interjecting = true;
}

/** A host answer about the oldest outstanding line. Returns the line whose
 *  row is now due, drawn at the current end of the transcript, or null when
 *  none is outstanding. Same shape for accepted and rejected: on
 *  `interjected` the row marks where the turn took the line; on `error` the
 *  failure row follows it. */
export function resolveInterject(s: InterjectTarget): InterjectLine | null {
  const queue = s.pendingInterject ?? [];
  const line = queue[0] ?? null;
  s.pendingInterject = queue.slice(1);
  s.interjecting = s.pendingInterject.length > 0;
  return line;
}

/** Every line still outstanding, oldest first, and the queue emptied. For the
 *  turn simply ENDING: a line left here is one the user typed and never saw. */
export function drainInterject(s: InterjectTarget): InterjectLine[] {
  const all = s.pendingInterject ?? [];
  s.pendingInterject = [];
  s.interjecting = false;
  return all;
}
