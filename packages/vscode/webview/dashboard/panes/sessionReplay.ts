// sessionReplay.ts — the host's catch-up posts are a REPLAY of state this pane
// may ALREADY hold, and the pane used to read them as new state.
//
// Where they come from: a chat is announced before its engine connects
// (sessionAnnounce.ts), and once the engine answers, the same chat auto-opens
// its own editor tab. That second view is caught up by `replaySessionsTo`,
// which re-posts `sessionCreated` for every live session and `restoreMessages`
// with the host's whole `messageLog`. The host cannot know what a view already
// shows, so the same two messages reach a blank view and a live one alike.
//
// Read as new state they doubled the chat: a re-announced session was APPENDED
// under an id the pane already had (two entries, one key — a popped tab renders
// its `sessions.filter(id)` cells and shows the chat twice), and a replayed log
// was APPENDED under a transcript that already showed it, which is the user's
// own message on screen twice. Both rules below are the same rule: a replay
// tells this pane what the host holds, never that something new happened.

/** A `sessionCreated` as it arrives on the wire — identity only. */
export interface Announcement {
  sessionNumber?: unknown;
  agentName?: unknown;
  title?: unknown;
  agentArt?: unknown;
  needsSetup?: unknown;
  botGlyph?: unknown;
}

/** The identity fields of a chat session, and nothing else about one. */
export interface IdentityTarget {
  number: number;
  agentName: string;
  title?: string;
  agentArt: string | null;
  needsSetup: boolean;
  /** The `glyph:` of the bot this chat runs AS — the creature its empty state
   *  draws instead of the crane. Undefined for every ordinary chat. */
  botGlyph?: string;
}

/** The glyph an announcement states, or undefined. EXPORTED because two files
 *  need it — this module normalises a re-announcement, ChatPane builds the
 *  FIRST session — and two copies is how the two end up disagreeing. Empty is
 *  UNDEFINED, not '': a def stating no glyph sends '' (botsManager reads
 *  `def?.glyph ?? ''`) and the rule downstream is "a glyph, or the crane". */
export function glyphOf(msg: Announcement): string | undefined {
  return typeof msg.botGlyph === 'string' && msg.botGlyph ? msg.botGlyph : undefined;
}

/**
 * Take the identity a re-announcement carries, and only that — the transcript,
 * the in-flight turn and the pending echo all belong to this view and survive.
 *
 * Mirrors rather than merges: the host is the source of identity truth (a
 * replay carries the title the engine reported while this view was not
 * listening), so a field the announcement does not carry is a field the host
 * does not have. Same normalisation the first announcement gets.
 */
export function adoptAnnouncement(s: IdentityTarget, msg: Announcement): void {
  if (typeof msg.sessionNumber === 'number') s.number = msg.sessionNumber;
  s.agentName = (typeof msg.agentName === 'string' && msg.agentName) || 'Agent';
  s.title = typeof msg.title === 'string' && msg.title ? msg.title : undefined;
  s.agentArt = typeof msg.agentArt === 'string' && msg.agentArt.length > 0 ? msg.agentArt : null;
  s.needsSetup = !!msg.needsSetup;
  // MIRRORED like the rest: `replaySessionsTo` is the ONLY thing that ever
  // tells a reattached tab this chat is a bot, so skipping it here would draw
  // the crane in a popped-out bot chat and the creature in the sidebar one.
  s.botGlyph = glyphOf(msg);
}

/**
 * True when a replayed message log is this view's scrollback to draw.
 *
 * It is catch-up for a view with NOTHING on screen — the case it was written
 * for (a tab opened after the turns it must show). A view that already has rows
 * has them from the live wire, ahead of the log rather than behind it: the log
 * cannot add to that, it can only say the same things twice.
 */
export function acceptsReplayedLog(s: { messages: readonly unknown[] }): boolean {
  return s.messages.length === 0;
}
