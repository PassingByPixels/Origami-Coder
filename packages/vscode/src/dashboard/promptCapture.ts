// The prompt_capture host leaf — what the engine actually sent the model on this chat's last turn.
// Its own module because boardData.ts and AcpClient are both at their architecture caps.
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
 * The last turn's captured prompt, or null when there has not been one. A null capture is NOT an
 *  error — a chat opened but never sent a message legitimately has nothing to show.
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

/** The same capture for a session named EXPLICITLY — a collab participant's, never the chat
 *  client's currentSessionId. An absent id is the ordinary case, not a fault; the caller separates
 *  "never took a turn" from "evicted" since only it knows which applies. */
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
