// The `prompt_capture` host leaf — what the engine ACTUALLY sent the model on
// this chat's last turn. Sibling of boardData.ts's instructionsPayload, and
// separate from it (and from AcpClient) only because both of those are at
// their architecture caps; the ratchet's remedy is a new module, not a raise.
//
// No `vscode` import, so the decisions here — the no-session guard, the
// failure-into-an-`error`-field shape, and the defensive read of a response
// that crossed a JSON-RPC wire — are testable without an extension host.
import type { PromptCapture, PromptCaptureResult } from '../acpExtTypes';

/** Just the two public members of AcpClient this needs, so a test can fake it. */
export interface PromptCaptureSource {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The ENGINE's session id. Null before the session is created. */
  readonly currentSessionId: string | null;
}

export interface PromptCapturePayload {
  capture: PromptCapture | null;
  error?: string;
}

const NO_SESSION = 'Open a chat first — this needs a live engine connection.';
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The last turn's captured prompt, or null when there has not been one.
 *
 * A null capture is NOT an error and must not be reported as one: a chat that
 * has been opened but never sent a message legitimately has nothing to show,
 * and an error banner there would read as a broken feature.
 */
export async function promptCapturePayload(
  client: PromptCaptureSource | null | undefined,
): Promise<PromptCapturePayload> {
  if (!client) return { capture: null, error: NO_SESSION };
  const sessionId = client.currentSessionId;
  // No engine session yet: asking would be asking about nothing. Same empty
  // answer as an unsent session, because that is exactly what it is.
  if (!sessionId) return { capture: null };
  try {
    const res = (await client.extMethod('prompt_capture', { sessionId })) as unknown as PromptCaptureResult;
    return { capture: isCapture(res?.capture) ? res.capture : null };
  } catch (e) {
    return { capture: null, error: message(e) };
  }
}

/** The same capture for a session named EXPLICITLY — a collab participant's,
 *  which is never the chat client's `currentSessionId`. An absent id is the
 *  ordinary case, not a fault (a participant that has not taken a turn carries
 *  none), so it answers empty rather than erroring. The engine keeps only the
 *  last few captures process-wide, so a null can equally mean "evicted" — the
 *  CALLER separates the two, since only it knows if there was a session. */
export async function promptCaptureForSession(
  client: PromptCaptureSource | null | undefined,
  sessionId: string | undefined,
): Promise<PromptCapturePayload> {
  if (!client) return { capture: null, error: NO_SESSION };
  if (!sessionId) return { capture: null };
  try {
    const res = (await client.extMethod('prompt_capture', { sessionId })) as unknown as PromptCaptureResult;
    return { capture: isCapture(res?.capture) ? res.capture : null };
  } catch (e) {
    return { capture: null, error: message(e) };
  }
}

/** A wire value is only a capture if it carries the three lists the view reads. */
function isCapture(value: unknown): value is PromptCapture {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<PromptCapture>;
  return Array.isArray(c.labeledParts) && Array.isArray(c.finalSystem) && Array.isArray(c.tools);
}
