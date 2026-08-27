// Messages that act on the turn a chat is CURRENTLY running — stop one of its
// background shells, or interject a line into it — routed out of
// DashboardPanel.ts's switch in the shape TOOLS_PANE_MESSAGE_TYPES /
// COLLAB_MESSAGE_TYPES / CHAT_SECTION_MESSAGE_TYPES already established there
// (a Set, plus one delegating `if` ahead of the switch). The panel was sitting
// at 6336/6336, so `interject` could not have been a second `case` at any size;
// folding the existing `stopBackgroundShell` case in here is what paid for it.
//
// The two belong together beyond the line count: both are session-scoped ACP
// ext-methods that only mean anything while a turn is in flight, and both report
// failure the same way — as an `error` message on the posting chat, never a
// native toast, because the thing that failed happened inside that chat.
//
// `stopBackgroundShell` delegates to the EXISTING backgroundShellMessage.ts leaf
// unchanged. Nothing about it was reimplemented here.

import { handleBackgroundShellStop } from './backgroundShellMessage';
import { engineSessionId } from './engineSessionId';

/** The method + identity shape this file needs, declared structurally so nothing
 *  here depends on the concrete AcpClient (which is at its own cap). Same style
 *  as backgroundShellStop.ts's BackgroundShellClient, and assignable to it.
 *
 *  `currentSessionId` is the ENGINE's session id (`ses_…`). The webview only
 *  ever names its local id (`session-N`), and sending that to a session-scoped
 *  ext-method is the exact live failure this shape exists to prevent:
 *  "Invalid params: session not found: session-3". */
export interface TurnClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  readonly currentSessionId: string | null;
}

/** The ACP call itself. A leaf, mirroring stopBackgroundShell(): the generic
 *  `extMethod` needs no wrapper on the client, only a named call site. */
export function interjectIntoTurn(client: TurnClient, sessionId: string, text: string) {
  return client.extMethod('interject', { sessionId, text });
}

export const TURN_MESSAGE_TYPES = new Set(['stopBackgroundShell', 'interject']);

export interface TurnMessageHost {
  /** The posting session's live engine client; null/absent when it has none. */
  client?: TurnClient | null;
  /** The session the webview named. Every method here is session-scoped. */
  sessionId?: string;
  post: (msg: Record<string, unknown>) => void;
}

export function handleTurnMessage(
  host: TurnMessageHost,
  m: { type?: string; [k: string]: unknown },
): void {
  const failed = (message: string) => host.post({ type: 'error', message, sessionId: host.sessionId });
  // TWO ids, deliberately: the ENGINE id goes on the wire, the webview's LOCAL
  // id goes on every post back — the chat that asked is keyed by the local one.
  // engineSessionId.ts is the one resolver, and it refuses a local id outright.
  const engineSid = engineSessionId(host.client, host.sessionId);

  if (m.type === 'stopBackgroundShell') {
    // Silent-dead-end contract unchanged: no posting session, nothing happens —
    // an error post with no sessionId would land on no chat at all.
    if (!host.sessionId) return;
    handleBackgroundShellStop(host.client, engineSid ?? undefined, m.jobId, failed);
    return;
  }

  if (m.type === 'interject') {
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    // Unlike the shell stop, a dead end here is REPORTED rather than swallowed:
    // the composer cleared the line on the keypress and is showing an
    // "interjecting…" chip, and only a message coming back clears it. The
    // webview also mirrors THIS EXACT SENTENCE (interjectRetry.ts) to mean "the
    // engine never saw it" and re-sends the line; a test reads both files.
    if (!host.client || !engineSid || !host.sessionId || !text) {
      failed('Interject failed: no running turn to interject into.');
      return;
    }
    interjectIntoTurn(host.client, engineSid, text)
      .then(() => host.post({ type: 'interjected', sessionId: host.sessionId }))
      .catch(e => failed(`Interject failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}
