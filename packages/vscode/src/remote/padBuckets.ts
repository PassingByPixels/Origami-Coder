// Origami Remote — PLAINTEXT PADDING, one file for both wire versions. It is
// not in `crypto.ts` because padding became a DECISION at wire v1.3, and
// nothing here imports crypto.ts, so the seal path has no cycle.
//
//   v1  plaintext = uint32 BE length || utf-8 JSON || zeros to a 1,024 multiple
//   v2  plaintext = uint32 BE length || utf-8 JSON || zeros to a BUCKET (§9)
//
// WHY BUCKETS. A v1 frame costs 1,058 bytes whatever it carries, which keeps
// the size-class property but makes every frame a kilobyte. The RECEIVER checks
// matter: an illegal bucket length, an overrunning declared length or a
// non-zero pad byte would each make the padding a side channel.

const TEXT = new TextEncoder();
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** v1: one flat size class. */
export const PAD_BLOCK = 1024;
/** v2, §9: the smallest of these that fits... */
export const V2_BUCKETS: readonly number[] = [256, 512, 1024, 2048, 4096];
/** ...and above the largest of them, the next multiple of this. */
export const V2_BLOCK = 4096;
/** 15 x 4,096. The relay's frame cap is 65,536 and a frame costs 18 header
 *  bytes plus a 16-byte GCM tag, so this is the largest bucket that fits. */
export const MAX_V2_PLAINTEXT_BYTES = 15 * V2_BLOCK;
/** ...and the largest single v2 JSON message. chunk.ts splits at 32,512 first. */
export const MAX_V2_JSON_BYTES = MAX_V2_PLAINTEXT_BYTES - 4;

/** Smallest legal v2 plaintext length holding `need`, or 0 when over the ceiling. */
export function bucketFor(need: number): number {
  for (const b of V2_BUCKETS) if (need <= b) return b;
  const rounded = Math.ceil(need / V2_BLOCK) * V2_BLOCK;
  return rounded > MAX_V2_PLAINTEXT_BYTES ? 0 : rounded;
}

/** Receiver rule 1: exactly one of the five buckets, or a multiple of 4,096 above. */
export function isBucket(len: number): boolean {
  if (V2_BUCKETS.includes(len)) return true;
  return len > V2_BLOCK && len % V2_BLOCK === 0 && len <= MAX_V2_PLAINTEXT_BYTES;
}

function frame(json: string, total: number): Uint8Array {
  const body = TEXT.encode(json);
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

/** v1. When 4 + JSON is ALREADY a multiple of 1,024 no padding is added — the
 *  length prefix is what makes that unambiguous on the way back. */
export function padPlaintext(json: string): Uint8Array {
  const needed = 4 + TEXT.encode(json).length;
  return frame(json, Math.ceil(needed / PAD_BLOCK) * PAD_BLOCK);
}

/** v2, §9. */
export function padPlaintextV2(json: string): Uint8Array {
  const needed = 4 + TEXT.encode(json).length;
  const total = bucketFor(needed);
  if (total === 0) {
    throw new Error(`origami remote: a ${needed}-byte v2 plaintext is over the ${MAX_V2_PLAINTEXT_BYTES}-byte ceiling`);
  }
  return frame(json, total);
}

/** Common to both: the declared length must fit and every pad byte must be zero. */
function readBody(buf: Uint8Array): string {
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
  if (len > buf.length - 4) {
    throw new Error(`origami remote: declared JSON length ${len} exceeds the ${buf.length}-byte plaintext`);
  }
  for (let i = 4 + len; i < buf.length; i++) {
    if (buf[i] !== 0) throw new Error(`origami remote: non-zero padding at byte ${i}`);
  }
  return UTF8.decode(buf.subarray(4, 4 + len));
}

/** Inverse of padPlaintext. */
export function unpadPlaintext(buf: Uint8Array): string {
  if (buf.length < 4 || buf.length % PAD_BLOCK !== 0) {
    throw new Error(`origami remote: plaintext is ${buf.length} bytes, not a multiple of ${PAD_BLOCK}`);
  }
  return readBody(buf);
}

/** Inverse of padPlaintextV2, with §9's rule 1 in front of it. */
export function unpadPlaintextV2(buf: Uint8Array): string {
  if (!isBucket(buf.length)) {
    throw new Error(`origami remote: a v2 plaintext of ${buf.length} bytes is not one of the §9 buckets`);
  }
  return readBody(buf);
}

/** Version 2 buckets; anything else is v1's flat block. */
export function padFor(version: number, json: string): Uint8Array {
  return version === 2 ? padPlaintextV2(json) : padPlaintext(json);
}

export function unpadFor(version: number, buf: Uint8Array): string {
  return version === 2 ? unpadPlaintextV2(buf) : unpadPlaintext(buf);
}
