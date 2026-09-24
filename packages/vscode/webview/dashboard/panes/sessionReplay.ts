// sessionReplay.ts — the host's catch-up posts are a replay of state this
// pane may already hold, which the pane used to read as new state.
//
// A chat is announced before its engine connects, and once it answers, the
// same chat auto-opens its own editor tab; that second view is caught up by
// `replaySessionsTo`, which re-posts `sessionCreated` and `restoreMessages`
// with the whole `messageLog`. The host can't know what a view already
// shows, so the same messages reach a blank view and a live one alike.
//
// Read as new state they doubled the chat: a re-announced session appended
// under an id the pane already had, and a replayed log appended under a
// transcript that already showed it. Both rules below say the same thing: a
// replay tells this pane what the host holds, never that something new happened.

/** A `sessionCreated` as it arrives on the wire — identity only. */
export interface Announcement {
  sessionNumber?: unknown;
  agentName?: unknown;
  title?: unknown;
  agentArt?: unknown;
  needsSetup?: unknown;
  botGlyph?: unknown;
  kind?: unknown;
  starting?: unknown;
}

/** The identity fields of a chat session, and nothing else about one. */
export interface IdentityTarget {
  number: number;
  agentName: string;
  title?: string;
  agentArt: string | null;
  needsSetup: boolean;
  /** The `glyph:` of the bot this chat runs as; undefined for an ordinary chat. */
  botGlyph?: string;
  /** 'claude' while this cell is bound to a Claude Code passthrough (passthroughCaps.ts). */
  kind?: string;
  /** True while the chat's engine is still starting (sessionAnnounce.ts). */
  starting?: boolean;
}

/** The glyph an announcement states, or undefined. Exported since two files
 *  need it (this module normalises a re-announcement, ChatPane builds the
 *  first session). Empty is undefined, not '': the rule downstream is "a
 *  glyph, or the crane". */
export function glyphOf(msg: Announcement): string | undefined {
  return typeof msg.botGlyph === 'string' && msg.botGlyph ? msg.botGlyph : undefined;
}

/** The title a message states, or undefined. One rule for the first
 *  announcement, the `sessionTitle` case, and adoptAnnouncement below. */
export function titleOf(msg: { title?: unknown }): string | undefined {
  return typeof msg.title === 'string' && msg.title ? msg.title : undefined;
}

/** The cell kind a message states, or undefined. Empty string is undefined:
 *  unbinding a Claude Code cell posts `kind: ''` for "back to the engine". */
export function kindOf(msg: { kind?: unknown }): string | undefined {
  return typeof msg.kind === 'string' && msg.kind ? msg.kind : undefined;
}

/** Take the identity a re-announcement carries, and only that — the
 *  transcript, in-flight turn and pending echo all belong to this view and
 *  survive. Mirrors rather than merges: a field the announcement doesn't
 *  carry is a field the host doesn't have. */
export function adoptAnnouncement(s: IdentityTarget, msg: Announcement): void {
  if (typeof msg.sessionNumber === 'number') s.number = msg.sessionNumber;
  s.agentName = (typeof msg.agentName === 'string' && msg.agentName) || 'Agent';
  s.title = titleOf(msg);
  s.agentArt = typeof msg.agentArt === 'string' && msg.agentArt.length > 0 ? msg.agentArt : null;
  s.needsSetup = !!msg.needsSetup;
  // `replaySessionsTo` is the only thing that tells a reattached tab this
  // cell is bound to Claude Code; skipping it would show engine-only
  // controls over a chat the CLI is driving.
  s.kind = kindOf(msg);
  // Same reason: skipping it would draw the crane in a popped-out bot chat
  // and the creature in the sidebar one.
  s.botGlyph = glyphOf(msg);
  // And the same again for the engine's starting state: the tab a new chat opens
  // attaches DURING start() now, so its catch-up is the only thing that can tell it
  // the composer should say so.
  s.starting = msg.starting === true;
}

/** True when a replayed message log is this view's scrollback to draw: catch-up
 *  for a view with nothing on screen. A view with rows already has them from
 *  the live wire, ahead of the log, which can only say the same things twice. */
export function acceptsReplayedLog(s: { messages: readonly unknown[] }): boolean {
  return s.messages.length === 0;
}
