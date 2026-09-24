// Origami Remote — WHAT A RECONNECT COSTS THE PHONE.
// `replaySessionsTo` sends every open chat's WHOLE `messageLog`. On the phone
// three chats of a working day measured ~256 KB of JSON, uploaded up to three
// times per socket, which is how the relay's 2 MiB/min limiter came to cut the
// socket. Three rules cut it:
//   1. A TAIL, not the log. `omitted` rides along so the pane can say how many
//      rows are not shown (an older page ignores the field).
//   2. COMPRESSED, for a phone that said it can inflate (`phoneCaps.ts`).
//   3. NO PICTURES. One `data:` screenshot is larger than the whole tail.
// COMPRESS-THEN-ENCRYPT IS SAFE HERE: the usual attack reads a length that
// varies with an attacker-chosen secret, and this frame has neither.

import { deflateSync } from 'node:zlib';
import type { SessionMessage } from '../dashboard/sessionLog';

/** Entries of `messageLog` the phone is sent, newest last. 80 is about four
 *  screens on a phone. */
export const REMOTE_TAIL_MESSAGES = 80;

/** Characters of a tool payload's `content` the phone is sent. The card itself
 *  truncates again at 2000 for everything but bash/chart. */
export const REMOTE_TOOL_CONTENT_CHARS = 2_000;

/** The compressed `restoreMessages` envelope. A name of its own rather than a
 *  flag: a page that cannot inflate must IGNORE it, not paint an empty chat. */
export const RESTORE_Z_TYPE = 'restoreMessagesZ';

/** zlib-wrapped deflate (RFC 1950) — what `zlib.deflateSync` writes and what
 *  `DecompressionStream('deflate')` reads (Safari 16.4+, Chromium 103+). */
export const RESTORE_ENC = 'deflate';

export interface RemoteTail {
  messages: SessionMessage[];
  /** Entries the tail dropped off the front. 0 when the whole log fits. */
  omitted: number;
}

/** One tool payload, cut to `chars` of `content` and with its `images` gone. The
 *  call half is treated the same rather than trusted to stay picture-free. */
function trim(payload: Record<string, unknown>, chars: number): Record<string, unknown> {
  const content = payload.content;
  const cutNeeded = typeof content === 'string' && content.length > chars;
  if (!cutNeeded && !('images' in payload)) return payload;
  const { images: _dropped, ...rest } = payload;
  return cutNeeded ? { ...rest, content: (content as string).slice(0, chars) } : rest;
}

/**
 * The last `keep` entries of a log, tool `content` cut to `chars` and `images`
 * dropped. Never mutates the log: the sidebar replays the same array after this.
 */
export function remoteTail(
  log: readonly SessionMessage[],
  keep = REMOTE_TAIL_MESSAGES,
  chars = REMOTE_TOOL_CONTENT_CHARS,
): RemoteTail {
  const omitted = Math.max(0, log.length - keep);
  const messages = log.slice(omitted).map((entry) => {
    if (!entry.tool) return entry;
    const call = trim(entry.tool.call, chars);
    const result = entry.tool.result === undefined ? undefined : trim(entry.tool.result, chars);
    return { ...entry, tool: result === undefined ? { call } : { call, result } };
  });
  return { messages, omitted };
}

/** The plain message the phone dispatches, before compression. */
export function remoteRestoreMessage(sessionId: string, log: readonly SessionMessage[]): object {
  const tail = remoteTail(log);
  return {
    type: 'restoreMessages',
    sessionId,
    messages: tail.messages,
    truncated: tail.omitted > 0,
    omitted: tail.omitted,
  };
}

/** ...and that message, deflated into the envelope the wire carries. */
export function remoteRestoreEnvelope(sessionId: string, log: readonly SessionMessage[]): object {
  const json = JSON.stringify(remoteRestoreMessage(sessionId, log));
  return {
    type: RESTORE_Z_TYPE,
    sessionId,
    enc: RESTORE_ENC,
    b64: deflateSync(Buffer.from(json, 'utf8')).toString('base64'),
  };
}
