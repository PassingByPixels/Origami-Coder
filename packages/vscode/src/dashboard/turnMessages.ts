// Messages that act on the turn a chat is CURRENTLY running — stop a background shell, or interject
// a line — routed out of DashboardPanel.ts's switch (the panel was at its cap).
// Both are session-scoped ACP ext-methods that only mean anything mid-turn, and both report failure
// as an `error` on the posting chat, never a native toast.

import { handleBackgroundShellStop } from './backgroundShellMessage';
import { handleSubagentStop } from './subagentStop';
import { settleSubagent, type SettleSession } from './subagentSettle';
import { engineSessionId } from './engineSessionId';
import { parseImageDataUrls, rawImagesOf, type ImageDataPair } from './imageDataUrls';

/** The method + identity shape this file needs, declared structurally. `currentSessionId` is the
 *  ENGINE's id — sending the webview's local id to a session-scoped ext-method is the live failure
 *  ("session not found") this shape prevents. */
export interface TurnClient {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  readonly currentSessionId: string | null;
}

/** The ACP call itself. `images` is omitted rather than sent empty, so a text-only interjection
 *  keeps the params it always had. */
export function interjectIntoTurn(client: TurnClient, sessionId: string, text: string, images: ImageDataPair[] = []) {
  return client.extMethod('interject', { sessionId, text, ...(images.length ? { images } : {}) });
}

export const TURN_MESSAGE_TYPES = new Set(['stopBackgroundShell', 'stopSubagent', 'interject']);

export interface TurnMessageHost {
  /** The posting session's live engine client; null/absent when it has none. */
  client?: TurnClient | null;
  /** The session the webview named. Every method here is session-scoped. */
  sessionId?: string;
  /** The posting chat's host state, so a stop's reply settles the row in its log too (t-v5qi8q). */
  session?: SettleSession;
  post: (msg: Record<string, unknown>) => void;
}

export function handleTurnMessage(
  host: TurnMessageHost,
  m: { type?: string; [k: string]: unknown },
): void {
  const failed = (message: string) => host.post({ type: 'error', message, sessionId: host.sessionId });
  // Two ids deliberately: the ENGINE id goes on the wire, the webview's LOCAL id goes on every post
  // back — engineSessionId.ts is the one resolver and refuses a local id outright.
  const engineSid = engineSessionId(host.client, host.sessionId);

  if (m.type === 'stopBackgroundShell') {
    // Silent-dead-end contract unchanged: no posting session, nothing happens —
    // an error post with no sessionId would land on no chat at all.
    if (!host.sessionId) return;
    handleBackgroundShellStop(host.client, engineSid ?? undefined, m.jobId, failed);
    return;
  }

  if (m.type === 'stopSubagent') {
    // t-q910fo. The id on the wire is the CHILD's, which the engine already owns,
    // so this one does NOT take `engineSid` — the posting chat is only where a
    // failure is shown. Same silent dead end as the shell stop above.
    if (!host.sessionId) return;
    const child = m.sessionId;
    handleSubagentStop(host.client, child, m.label, failed, (state) =>
      settleSubagent(host.session, host.post, host.sessionId, { taskSessionId: String(child), state, endedAt: Date.now() }));
    return;
  }

  if (m.type === 'interject') {
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    // Parsed the way sendWithImages parses its own; a picture with no words is still a message, so
    // the emptiness test reads both.
    const images = parseImageDataUrls(rawImagesOf(m.images));
    // Unlike the shell stop, a dead end here is REPORTED: the composer shows an "interjecting…"
    // chip that only a message clears. The webview mirrors this exact sentence to mean "the engine
    // never saw it" and re-sends.
    if (!host.client || !engineSid || !host.sessionId || (!text && images.length === 0)) {
      failed('Interject failed: no running turn to interject into.');
      return;
    }
    interjectIntoTurn(host.client, engineSid, text, images)
      .then(() => host.post({ type: 'interjected', sessionId: host.sessionId }))
      .catch(e => failed(`Interject failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}
