// Origami Remote — THE OTHER END OF `restoreMessagesZ`.
//
// A hydration's transcripts are the only large thing the desktop says, and they
// are repetitive text, so `src/remote/remoteTranscript.ts` deflates them into
//   { type: 'restoreMessagesZ', sessionId, enc: 'deflate', b64 }
// and this file turns that back into the plain `restoreMessages` the untouched
// chat bundle already knows. Measured on the harness: three chats of a working
// day, 256,575 bytes of JSON, under 60 KB once tailed, deflated and sealed.
//
// `DecompressionStream` rather than a vendored inflater ON PURPOSE. The shell
// ships no dependencies at all today, and the API is in every browser the phone
// page supports (Safari 16.4+, Chromium 103+, Firefox 113+). A page too old for
// it inflates nothing and passes the envelope through, which the bundle ignores
// — a chat with no scrollback, not a broken page.
//
// A HAND-BUILT `ReadableStream`, not `new Blob([bytes]).stream()`: jsdom ships
// a Blob with no `stream()` at all, so the tidier spelling inflated nothing
// under vitest and every transcript test timed out waiting for rows that were
// never going to paint. Measured, not assumed.

/** The envelope `remoteTranscript.ts` seals. */
export const RESTORE_Z_TYPE = 'restoreMessagesZ';

interface RestoreZ {
  type: typeof RESTORE_Z_TYPE;
  enc: string;
  b64: string;
}

function isRestoreZ(msg: unknown): msg is RestoreZ {
  const m = msg as Partial<RestoreZ> | null;
  return !!m && m.type === RESTORE_Z_TYPE && typeof m.b64 === 'string' && typeof m.enc === 'string';
}

function bytesOf(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function inflate(bytes: Uint8Array, enc: string): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream(enc as CompressionFormat)).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * The message the webview bus should see. Anything that is not a compressed
 * replay comes back untouched, so the caller can put EVERY inbound message
 * through this one seam and keep arrival order on a single tail.
 */
export async function expandRestore(msg: unknown): Promise<unknown> {
  if (!isRestoreZ(msg)) return msg;
  try {
    return JSON.parse(await inflate(bytesOf(msg.b64), msg.enc)) as unknown;
  } catch (err) {
    // Named, not swallowed: an empty transcript with a console line beats an
    // empty transcript with nothing to look at.
    console.warn('[remote] could not inflate a replay', err);
    return msg;
  }
}
