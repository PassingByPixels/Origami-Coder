// toolImageStamp.ts — WHICH host message carries a read-image card, and the walk
// that puts the rider on it (without the model's base64).
//
// EXTRACTED from toolImageCard.ts (t-j50p3r), which sat 1 line under its 105 cap
// when a THIRD message shape — a child's `subagentTranscriptData` — needed the
// same walk. The seam is the one the file already had: toolImageCard.ts says what
// a read-image card IS (the facts off the engine's `display` block, the byte
// caps, the src resolver's type); this says where that fact is attached on the
// wire. Neither half imports `vscode`, so both stay unit-testable.

import { beginDesktopImageFallbackBatch } from './desktopImageFallback';
import { readImageFacts, type ImageSrcFor, type ReadImageCard } from './toolImageCard';

/**
 * One tool-result payload, with the read card's picture named and its base64
 * dropped. Returns the SAME object for anything that is not a read image, so a
 * non-image read (and every other tool) travels untouched.
 */
export function stampReadImage(result: Record<string, unknown>, srcFor: ImageSrcFor): Record<string, unknown> {
  const facts = readImageFacts(result.toolName, result.rawOutputMeta);
  if (!facts) return result;
  const src = srcFor(facts);
  const { images: _dropped, ...rest } = result;
  const card: ReadImageCard = src ? { ...facts, src } : { ...facts };
  return { ...rest, readImage: card };
}

/** A replay-log list (sessionLog.ts entries) with every read-image result
 *  stamped, or undefined when nothing in it drew a picture — which is what lets
 *  the caller return its message by identity. Shared by the two message shapes
 *  that carry such a list: `restoreMessages` and `subagentTranscriptData`. */
function stampEntries(list: unknown, srcFor: ImageSrcFor): unknown[] | undefined {
  if (!Array.isArray(list)) return undefined;
  let touched = false;
  const out = (list as Array<Record<string, unknown>>).map((entry) => {
    const tool = entry?.tool as { call?: unknown; result?: Record<string, unknown> } | undefined;
    if (!tool?.result) return entry;
    const result = stampReadImage(tool.result, srcFor);
    if (result === tool.result) return entry;
    touched = true;
    return { ...entry, tool: { call: tool.call, result } };
  });
  return touched ? out : undefined;
}

/**
 * The rule applied to a whole host message, for the three shapes that carry a
 * tool result: the live `toolResult` broadcast, the `restoreMessages` replay
 * (sessionLog.ts entries), and a child's `subagentTranscriptData` — whose
 * entries are that same replay-log shape (subagentTranscript.ts), so the
 * sub-agent transcript view draws the picture the main chat draws (t-j50p3r)
 * instead of a plain text row. Any other message is returned unchanged, by
 * identity.
 */
export function stampToolImages(msg: object, srcFor: ImageSrcFor): object {
  const m = msg as Record<string, unknown>;
  if (m.type === 'toolResult') {
    const out = stampReadImage(m, srcFor);
    return out === m ? msg : out;
  }
  if (m.type === 'restoreMessages') {
    const messages = stampEntries(m.messages, srcFor);
    return messages ? { ...m, messages } : msg;
  }
  if (m.type === 'subagentTranscriptData') {
    // t-ru0by6: a poll walks this whole list in one synchronous pass, so open
    // a fresh cache batch first — see beginDesktopImageFallbackBatch's own
    // comment for why a big pass must not evict its own entries.
    beginDesktopImageFallbackBatch();
    const entries = stampEntries(m.entries, srcFor);
    return entries ? { ...m, entries } : msg;
  }
  return msg;
}
