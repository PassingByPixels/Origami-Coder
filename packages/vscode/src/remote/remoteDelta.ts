// Origami Remote — WHAT THE PHONE ALREADY HAS, AND WHAT THE DESK THEREFORE SENDS.
//
// A phone reconnects for reasons that have nothing to do with having lost
// anything, and since `webview/remote/cache.ts` it still HOLDS the transcript.
// So it says what it holds, on its own `remote/snapshot`:
//   { type: 'remote/snapshot', desk: '<nonce>', since: { 'session-1': 214 } }
// `since[id]` is a length of the desk's OWN `messageLog`; the desk answers with
// `log.slice(from)` instead of the tail.
//
// THE DESK NONCE IS NOT OPTIONAL. Session ids restart at `session-1` on every
// extension-host start, so a cursor minted against an older window names rows
// of a log that no longer exists. Compared BEFORE a cursor is recorded at all.
// THE OVERLAP IS THE OTHER HALF: a row is MUTATED IN PLACE after it has been
// sent, so the delta starts DELTA_OVERLAP rows BEFORE the cursor.

import { deflateSync } from 'node:zlib';
import type { SessionMessage } from '../dashboard/sessionLog';
import { REMOTE_CAPS_BRAND } from './phoneCaps';
import {
  REMOTE_TAIL_MESSAGES,
  RESTORE_ENC,
  RESTORE_Z_TYPE,
  remoteRestoreEnvelope,
  remoteRestoreMessage,
  remoteTail,
} from './remoteTranscript';

/** The capability a phone declares when it can splice a delta into rows it
 *  holds. A page that declares nothing is sent the tail, exactly as before. */
export const RESTORE_DELTA_CAP = 'restoreDelta';

/** Rows re-sent BEFORE the cursor, so a row mutated in place is corrected. */
export const DELTA_OVERLAP = 8;

/** THIS extension host, for as long as it runs — the same lifetime as the
 *  session ids it qualifies. Not a secret. */
export const DESK_NONCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Where a phone's per-session cursors are stamped. `RemoteView` builds a fresh
 *  webview object per socket, so the mark dies with the socket. */
const SINCE_BRAND = '__origamiRemoteSince';

function declared(webview: unknown, cap: string): boolean {
  const caps = (webview as Record<string, unknown> | null)?.[REMOTE_CAPS_BRAND];
  return Array.isArray(caps) && caps.includes(cap);
}

/**
 * Record what a `remote/snapshot` says the phone holds. A snapshot naming a
 * different desk, or with no `since` map, records NOTHING — the safe answer.
 * Called on EVERY snapshot, and it REPLACES rather than merges.
 */
export function markSince(webview: unknown, msg: unknown): void {
  const target = webview as Record<string, unknown> | null;
  if (!target) return;
  target[SINCE_BRAND] = undefined;
  const m = msg as { desk?: unknown; since?: unknown } | null;
  if (!m || m.desk !== DESK_NONCE) return;
  if (!m.since || typeof m.since !== 'object') return;
  target[SINCE_BRAND] = m.since;
}

/** How many rows of one chat this phone holds, or undefined for "send the tail".
 *  A malformed entry is ABSENT rather than repaired: a repaired cursor mis-splices. */
export function remoteCursor(webview: unknown, sessionId: string): number | undefined {
  if (!declared(webview, RESTORE_DELTA_CAP)) return undefined;
  const since = (webview as Record<string, unknown> | null)?.[SINCE_BRAND] as
    | Record<string, unknown>
    | undefined;
  const at = since?.[sessionId];
  return typeof at === 'number' && Number.isInteger(at) && at >= 0 ? at : undefined;
}

/** The restore ONE phone is sent for ONE chat: the tail, or only the rows it is
 *  missing. The full road DELEGATES rather than re-deriving. */
export function remoteRestore(
  sessionId: string,
  log: readonly SessionMessage[],
  ctx: { compress: boolean; since?: number },
): object {
  const since = ctx.since;
  if (since === undefined || since > log.length || log.length - since > REMOTE_TAIL_MESSAGES) {
    return ctx.compress ? remoteRestoreEnvelope(sessionId, log) : remoteRestoreMessage(sessionId, log);
  }
  const from = Math.max(0, since - DELTA_OVERLAP);
  const slice = log.slice(from);
  // `keep` is the slice itself: the 80-row cut is the FULL road's rule and would
  // drop the oldest overlap rows. What is wanted is the tool-payload trim.
  const msg = {
    type: 'restoreMessages',
    sessionId,
    messages: remoteTail(slice, slice.length).messages,
    truncated: from > 0,
    omitted: from,
    from,
  };
  return ctx.compress ? zip(sessionId, msg) : msg;
}

/** The same envelope `remoteRestoreEnvelope` seals, around a message that is not
 *  the whole tail. Spelled again rather than shared (architecture cap). */
function zip(sessionId: string, msg: object): object {
  return {
    type: RESTORE_Z_TYPE,
    sessionId,
    enc: RESTORE_ENC,
    b64: deflateSync(Buffer.from(JSON.stringify(msg), 'utf8')).toString('base64'),
  };
}
