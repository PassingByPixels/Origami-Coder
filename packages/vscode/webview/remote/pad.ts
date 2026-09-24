// Origami Remote — the phone's PLAINTEXT PADDING, both wire versions.
//
// The desktop's twin is `src/remote/padBuckets.ts` and the two are meant to be
// diffed against each other line by line; only the return type differs (the
// phone parses the JSON here, as it always has).
//
//   v1  uint32 BE length || utf-8 JSON || zeros to the next 1 KiB
//   v2  uint32 BE length || utf-8 JSON || zeros to a §9 BUCKET
//
// v1 IS UNTOUCHED. A v1 socket must behave exactly as it did before v1.3, so
// the flat block and its two checks are the same code, moved. The three extra
// receiver checks (§9: a legal bucket, a length that fits, a zero pad) apply to
// v2 frames only, where both ends are new enough to have always produced them.

const te = new TextEncoder();
const td = new TextDecoder();

/** v1: one flat size class. */
export const PAD_BLOCK = 1024;
/** v2, §9: the smallest of these that fits... */
export const V2_BUCKETS: readonly number[] = [256, 512, 1024, 2048, 4096];
/** ...and above the largest of them, the next multiple of this. */
export const V2_BLOCK = 4096;
/** 15 x 4,096 — the largest bucket that still fits the relay's 65,536-byte
 *  frame cap once the 18-byte header and the 16-byte GCM tag are paid for. */
export const MAX_V2_PLAINTEXT = 15 * V2_BLOCK;

/** The smallest legal v2 plaintext length that holds `need` bytes, or 0 when
 *  `need` is over the ceiling. */
export function bucketFor(need: number): number {
  for (const b of V2_BUCKETS) if (need <= b) return b;
  const rounded = Math.ceil(need / V2_BLOCK) * V2_BLOCK;
  return rounded > MAX_V2_PLAINTEXT ? 0 : rounded;
}

/** §9 receiver rule 1: exactly one of the five buckets, or a multiple of 4,096
 *  above them. Anything else is rejected before the JSON is read. */
export function isBucket(len: number): boolean {
  if (V2_BUCKETS.includes(len)) return true;
  return len > V2_BLOCK && len % V2_BLOCK === 0 && len <= MAX_V2_PLAINTEXT;
}

function frame(json: string, total: number): Uint8Array {
  const body = te.encode(json);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/** Plaintext = uint32BE byteLength || utf-8 JSON || zeros to the next 1 KiB. */
export function padPlaintext(json: string): Uint8Array {
  return frame(json, Math.ceil((4 + te.encode(json).length) / PAD_BLOCK) * PAD_BLOCK);
}

/** The v2 shape. Throws rather than truncating: a message this big should have
 *  been chunked (`chunk.ts` splits at 32,512) and silently losing it is worse
 *  than a rejected send the caller can report. */
export function padPlaintextV2(json: string): Uint8Array {
  const need = 4 + te.encode(json).length;
  const total = bucketFor(need);
  if (total === 0) throw new Error(`remote: a ${need}-byte v2 plaintext is over the ${MAX_V2_PLAINTEXT}-byte ceiling`);
  return frame(json, total);
}

/** v1, verbatim from crypto.ts: length prefix checked, padding NOT inspected —
 *  which is the behaviour a v1 socket has today and must keep. */
export function unpadPlaintext(plain: Uint8Array): unknown {
  if (plain.length < 4) throw new Error('remote: plaintext shorter than its length prefix');
  const len = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, false);
  if (len > plain.length - 4) throw new Error('remote: plaintext length prefix overruns the block');
  return JSON.parse(td.decode(plain.subarray(4, 4 + len)));
}

/** v2, with §9's three checks in front of the JSON. */
export function unpadPlaintextV2(plain: Uint8Array): unknown {
  if (!isBucket(plain.length)) throw new Error(`remote: a v2 plaintext of ${plain.length} bytes is not one of the §9 buckets`);
  const len = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, false);
  if (len > plain.length - 4) throw new Error('remote: plaintext length prefix overruns the bucket');
  for (let i = 4 + len; i < plain.length; i++) {
    if (plain[i] !== 0) throw new Error(`remote: non-zero padding at byte ${i}`);
  }
  return JSON.parse(td.decode(plain.subarray(4, 4 + len)));
}

export function padFor(version: number, json: string): Uint8Array {
  return version === 2 ? padPlaintextV2(json) : padPlaintext(json);
}

export function unpadFor(version: number, plain: Uint8Array): unknown {
  return version === 2 ? unpadPlaintextV2(plain) : unpadPlaintext(plain);
}
