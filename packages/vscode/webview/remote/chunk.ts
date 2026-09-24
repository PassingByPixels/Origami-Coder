// Origami Remote — message chunking.
//
// The relay caps a FRAME at 65,536 bytes (close 4002) and the webview protocol
// routinely exceeds it — a hydration replay, a pasted file, a diff payload. The
// frame header has no chunk field to borrow, so chunking lives one layer up,
// inside the sealed plaintext, where it is encrypted too: the relay must never
// learn how a message was split. This began as a declared spec gap and is now
// `remote_wire_spec_v1.md` §Clarifications, which both lanes build to.

/** The wire spec's chunk size (§Clarifications: "a message whose JSON exceeds
 *  32,512 bytes is sent as N envelopes"). Both the threshold above which a
 *  message is split and the budget for one `part`, counted in ESCAPED bytes.
 *  The desktop lane builds to the same constant. */
export const CHUNK_BODY_BYTES = 32512;

/** Largest UTF-8 JSON that fits one frame: 65,536 frame - 18 header - 16 tag
 *  = 65,502 ciphertext; plaintext must be a multiple of 1,024, so 63 KiB =
 *  64,512, less the 4-byte length prefix. */
export const MAX_MESSAGE_BYTES = 64508;

export interface ChunkEnvelope {
  type: 'remote/chunk';
  id: string;
  i: number;
  n: number;
  part: string;
}

export function isChunk(msg: unknown): msg is ChunkEnvelope {
  const m = msg as ChunkEnvelope | null;
  return (
    !!m &&
    typeof m === 'object' &&
    m.type === 'remote/chunk' &&
    typeof m.id === 'string' &&
    typeof m.i === 'number' &&
    typeof m.n === 'number' &&
    typeof m.part === 'string'
  );
}

const te = new TextEncoder();

/** Bytes one code point costs INSIDE a JSON string literal — the escape, not the
 *  character. `part` is re-escaped by the envelope's own stringify, so a quote
 *  costs two there; budgeting one emitted frames the relay refused with 4002. */
function escapedCost(cp: string): number {
  const c = cp.codePointAt(0)!;
  if (c === 0x22 || c === 0x5c) return 2; // " and the escape character itself
  if (c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) return 2;
  if (c < 0x20) return 6; // \u00xx
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c < 0x10000) return 3;
  return 4;
}

/**
 * Split a message for the wire. Returns `[message]` unchanged when it already
 * fits — the common case, and the one that must stay allocation-free-ish.
 * Otherwise returns N `remote/chunk` envelopes whose `part`s concatenate back
 * to the original JSON text.
 *
 * Splitting walks the JSON STRING by code POINTS against the escaped-byte
 * budget. Two things follow, and only the first is a correctness rule:
 *   - The parts are STRING slices, never byte slices. Slicing the encoded
 *     bytes would cut a multi-byte character in half and the rejoin would be
 *     mojibake; the test for that was mutation-proven.
 *   - Walking code points rather than UTF-16 units makes the byte accounting
 *     exact. It is NOT a data-loss guard: JSON.stringify escapes a lone
 *     surrogate and JSON.parse returns it, so a unit walk round-trips too.
 *     That mutation was tried and stayed green; the claim is not made.
 */
export function splitMessage(message: unknown, id: string): unknown[] {
  const json = JSON.stringify(message);
  if (te.encode(json).length <= CHUNK_BODY_BYTES) return [message];

  const parts: string[] = [];
  let buf = '';
  let bytes = 0;
  for (const ch of json) {
    const w = escapedCost(ch);
    if (bytes + w > CHUNK_BODY_BYTES) {
      parts.push(buf);
      buf = '';
      bytes = 0;
    }
    buf += ch;
    bytes += w;
  }
  if (buf) parts.push(buf);
  return parts.map((part, i) => {
    const envelope = { type: 'remote/chunk', id, i, n: parts.length, part };
    // The budget is on the PART; the frame cap is what bites, so check it too.
    if (te.encode(JSON.stringify(envelope)).length > MAX_MESSAGE_BYTES) {
      throw new Error(`remote: chunk ${i + 1}/${parts.length} does not fit one frame`);
    }
    return envelope;
  });
}

/**
 * Reassembles chunks. Feed it every opened message; it returns the message to
 * dispatch, or undefined while a multi-part message is still incomplete.
 *
 * Out-of-order parts are tolerated (the relay's ring can replay them after a
 * reconnect); a part that arrives twice overwrites itself harmlessly.
 */
export class ChunkAssembler {
  private pending = new Map<string, { n: number; parts: string[]; have: number }>();

  accept(msg: unknown): unknown | undefined {
    if (!isChunk(msg)) return msg;
    if (msg.n <= 0 || msg.i < 0 || msg.i >= msg.n) {
      throw new Error(`remote: chunk ${msg.i}/${msg.n} is out of range`);
    }
    let slot = this.pending.get(msg.id);
    if (!slot) {
      slot = { n: msg.n, parts: new Array<string>(msg.n), have: 0 };
      this.pending.set(msg.id, slot);
    }
    if (slot.n !== msg.n) throw new Error(`remote: chunk ${msg.id} changed length mid-flight`);
    if (slot.parts[msg.i] === undefined) slot.have++;
    slot.parts[msg.i] = msg.part;
    if (slot.have < slot.n) return undefined;
    this.pending.delete(msg.id);
    return JSON.parse(slot.parts.join(''));
  }

  /** Parts still waiting on siblings — a leak check for the tests. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
