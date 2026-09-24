// Origami Remote — message-level chunking. The relay caps a FRAME at 65,536
// bytes, so a big message becomes a run of
//   { "type": "remote/chunk", id, i, n, part }
// messages, each an ordinary sealed frame, reassembled by the receiver.
// `part` is a slice of the ORIGINAL JSON TEXT, so the parts concatenate back
// into the source string. Split per CODE POINT, never per UTF-16 unit: half a
// surrogate pair is invalid UTF-8 and reassembles into different text.

import { MAX_JSON_BYTES } from './frame';
import { b64urlEncode, randomBytes } from './crypto';

export const CHUNK_TYPE = 'remote/chunk';

/** Bytes of ESCAPED payload one `part` may carry — the interop constant the
 *  phone lane and this one both build to. Half a frame, since the envelope,
 *  padding and GCM tag sit on top. At or under it a message is sent unwrapped. */
export const CHUNK_BUDGET_BYTES = 32_512;

export interface ChunkMessage {
  type: typeof CHUNK_TYPE;
  id: string;
  i: number;
  n: number;
  part: string;
}

/** How many bytes one code point costs INSIDE a JSON string literal — the
 *  escape, not the character. Assuming 1 byte per char ships oversized parts. */
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

export function newChunkId(): string {
  return b64urlEncode(randomBytes(8));
}

/**
 * Turn one message into the JSON string(s) to seal. A message that already fits
 * comes back as a single-element array holding its own JSON.
 */
export function encodeMessage(msg: unknown, budget = CHUNK_BUDGET_BYTES, id = newChunkId()): string[] {
  const json = JSON.stringify(msg);
  if (json === undefined) throw new Error('origami remote: message is not JSON-serialisable');
  if (byteLength(json) <= budget) return [json];
  if (budget < 16) throw new Error(`origami remote: chunk budget ${budget} leaves no room for a payload`);

  const parts: string[] = [];
  let buf = '';
  let cost = 0;
  for (const cp of json) {
    const c = escapedCost(cp);
    if (cost + c > budget) {
      parts.push(buf);
      buf = '';
      cost = 0;
    }
    buf += cp;
    cost += c;
  }
  if (buf.length > 0) parts.push(buf);

  const n = parts.length;
  return parts.map((part, i) => {
    const envelope = JSON.stringify({ type: CHUNK_TYPE, id, i, n, part } satisfies ChunkMessage);
    // The budget is on the PAYLOAD; the finished envelope is checked against the frame cap.
    if (byteLength(envelope) > MAX_JSON_BYTES) {
      throw new Error(`origami remote: chunk ${i + 1}/${n} is ${byteLength(envelope)} bytes, over the ${MAX_JSON_BYTES} frame cap`);
    }
    return envelope;
  });
}

export function isChunkMessage(m: unknown): m is ChunkMessage {
  if (typeof m !== 'object' || m === null) return false;
  const c = m as Partial<ChunkMessage>;
  // An out-of-range `i` is deliberately not checked here: it is still a chunk
  // message, and the interop contract is that REASSEMBLY ignores it (see push).
  return (
    c.type === CHUNK_TYPE &&
    typeof c.id === 'string' &&
    typeof c.part === 'string' &&
    Number.isInteger(c.i) &&
    Number.isInteger(c.n) &&
    (c.n as number) > 0
  );
}

/**
 * Reassembles chunk runs. A run completes when every index 0..n-1 has arrived;
 * parts are concatenated in INDEX order, never arrival order, because the
 * relay's replay-on-reconnect can deliver a tail before a head. `maxPending`
 * bounds the memory a peer can hold open: the OLDEST incomplete run is dropped.
 */
export class ChunkAssembler {
  private readonly runs = new Map<string, { n: number; parts: Array<string | undefined>; have: number }>();

  constructor(private readonly maxPending = 8) {}

  /** Returns the reassembled JSON when the run completes, else null. An `i`
   *  outside [0, n) is IGNORED — it would corrupt the run or grow the array. */
  public push(chunk: ChunkMessage): string | null {
    if (!Number.isInteger(chunk.i) || chunk.i < 0 || chunk.i >= chunk.n) return null;
    let run = this.runs.get(chunk.id);
    if (!run) {
      run = { n: chunk.n, parts: new Array<string | undefined>(chunk.n), have: 0 };
      this.runs.set(chunk.id, run);
      while (this.runs.size > this.maxPending) {
        const oldest = this.runs.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === chunk.id) break;
        this.runs.delete(oldest);
      }
    }
    if (run.n !== chunk.n) throw new Error(`origami remote: chunk run ${chunk.id} changed length ${run.n} -> ${chunk.n}`);
    if (run.parts[chunk.i] === undefined) {
      run.parts[chunk.i] = chunk.part;
      run.have++;
    }
    if (run.have < run.n) return null;
    this.runs.delete(chunk.id);
    return run.parts.join('');
  }

  public get pending(): number {
    return this.runs.size;
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
