// Delete one past chat from the Labyrinth's run index, host side. Routed out of DashboardPanel.ts
// so the panel carries a dispatch line and none of the decisions.
// Three refusals: (1) a chat open in this window is never deleted — the index row and the live tab
// are the same engine session, so deleting would leave a live chat whose store rows are gone; (2) a
// collab header (`collab:<id>`) is not a chat and cannot be deleted by this path; (3) no engine, no
// delete. Everything else is the ACP call — the store cascades children/messages/parts, and a
// resolved call means the row is gone.
// No vscode import: every branch runs against a fake host, per labyrinthPrices.ts's convention.

/** Just the part of AcpClient this leaf uses. */
export interface SessionDeleteClient {
  deleteSession(sessionId: string, cwd?: string): Promise<void>;
}

export interface SessionDeleteHost {
  /** The engine client to ask. Absent when no chat has a live engine. */
  client?: SessionDeleteClient | null;
  /** The engine session id of EVERY chat cell this window currently holds. */
  openSessionIds(): readonly string[];
  post(message: Record<string, unknown>): void;
}

/** The message types this leaf owns, in DashboardPanel's dispatch idiom. */
export const SESSION_DELETE_MESSAGE_TYPES = new Set(['labDeleteSession']);

/** Shown when the target chat is open in a tab — names the action that unblocks the delete. */
export const OPEN_CHAT_REFUSAL = 'Close the chat first, then delete it here.';
export const NO_ENGINE_REFUSAL = 'Open a chat first — this needs a live engine connection.';
export const COLLAB_REFUSAL = 'That row is a collab, not a chat. Open it and delete its runs one at a time.';

const COLLAB_PREFIX = 'collab:'; // mirrors labyrinthCollabIndex.ts's COLLAB_PREFIX (webview cannot be imported from src/)

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Delete one stored session, or say why not. Always replies — the confirm card needs an answer
 *  either way. */
export async function handleSessionDeleteMessage(
  host: SessionDeleteHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type !== 'labDeleteSession') return;
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId : '';
  const cwd = typeof m.cwd === 'string' ? m.cwd : '';
  const done = (ok: boolean, error?: string) =>
    host.post({ type: 'labDeleteSessionDone', sessionId, ok, ...(error ? { error } : {}) });

  if (!sessionId) return done(false, 'No chat was named.');
  if (sessionId.startsWith(COLLAB_PREFIX)) return done(false, COLLAB_REFUSAL);
  if (host.openSessionIds().includes(sessionId)) return done(false, OPEN_CHAT_REFUSAL);
  if (!host.client) return done(false, NO_ENGINE_REFUSAL);

  try {
    await host.client.deleteSession(sessionId, cwd || undefined);
  } catch (e) {
    return done(false, reason(e));
  }
  done(true);
}
