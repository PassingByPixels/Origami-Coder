// Wire-frame tests. Every assertion here is against `remote_wire_spec_v1.md`
// section "Keys and ids" / "Frame" — the numbers are quoted from the spec, not
// read back out of the implementation, because the DESKTOP lane implements the
// same text independently and a byte we agree with ourselves about is worth
// nothing.
import { describe, expect, it } from 'vitest';
import {
  HEADER_LEN,
  ROLE_DESKTOP,
  ROLE_PHONE,
  b64urlDecode,
  b64urlEncode,
  deriveKey,
  deriveRid,
  openFrame,
  sealFrame,
} from './crypto';
// The padding moved to its own leaf when v1.3 gave a v2 frame a second rule.
import { PAD_BLOCK, padPlaintext, unpadPlaintext } from './pad';

const KS = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const RID = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('base64url', () => {
  it('round-trips arbitrary bytes without padding characters', () => {
    for (const n of [0, 1, 2, 3, 16, 31, 32, 255]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 251) & 0xff);
      const enc = b64urlEncode(bytes);
      expect(enc).not.toMatch(/[+/=]/);
      expect([...b64urlDecode(enc)]).toEqual([...bytes]);
    }
  });

  it('decodes every unpadded length class', () => {
    expect([...b64urlDecode('AQ')]).toEqual([1]);
    expect([...b64urlDecode('AQI')]).toEqual([1, 2]);
    expect([...b64urlDecode('AQID')]).toEqual([1, 2, 3]);
  });
});

describe('key derivation', () => {
  it('derives a stable rid from Ks and nothing else', async () => {
    const a = await deriveRid(KS);
    expect(a).toBe(await deriveRid(KS));
    // 16 bytes base64url-encoded, unpadded = 22 chars.
    expect(a).toHaveLength(22);
    expect(a).not.toMatch(/[+/=]/);
  });

  it('gives a different rid for a Ks that differs in one bit', async () => {
    const other = KS.slice();
    other[0] ^= 0x01;
    expect(await deriveRid(other)).not.toBe(await deriveRid(KS));
  });

  it('derives an AES-256-GCM key usable for both directions', async () => {
    const key = await deriveKey(KS);
    expect((key.algorithm as { name: string; length: number }).length).toBe(256);
    expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt']);
  });
});

describe('plaintext padding', () => {
  it('pads to a multiple of 1024 and preserves the message', () => {
    for (const size of [1, 100, 1019, 1020, 1021, 5000]) {
      const msg = { type: 'x', pad: 'y'.repeat(size) };
      const plain = padPlaintext(JSON.stringify(msg));
      expect(plain.length % PAD_BLOCK).toBe(0);
      expect(plain.length).toBeGreaterThanOrEqual(4 + JSON.stringify(msg).length);
      expect(unpadPlaintext(plain)).toEqual(msg);
    }
  });

  it('writes the JSON byte length as a big-endian uint32 at offset 0', () => {
    const json = JSON.stringify({ a: 1 });
    const plain = padPlaintext(json);
    const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    expect(dv.getUint32(0, false)).toBe(new TextEncoder().encode(json).length);
  });

  it('measures BYTES, not chars, so a multi-byte message survives', () => {
    const msg = { text: 'héllo 🌍 dash' };
    expect(unpadPlaintext(padPlaintext(JSON.stringify(msg)))).toEqual(msg);
  });

  it('refuses a length prefix that overruns its own block', () => {
    const bad = new Uint8Array(1024);
    new DataView(bad.buffer).setUint32(0, 9999, false);
    expect(() => unpadPlaintext(bad)).toThrow(/overruns/);
  });
});

describe('frame seal/open', () => {
  it('round-trips a message with the spec header layout', async () => {
    const key = await deriveKey(KS);
    const msg = { type: 'send', text: 'hello', sessionId: 's1' };
    const frame = await sealFrame(key, RID, ROLE_PHONE, 7, msg);

    expect(frame[0]).toBe(1);
    expect(frame[1]).toBe(ROLE_PHONE);
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(dv.getUint32(2, false)).toBe(7);
    // header + one 1 KiB plaintext block + the 16-byte GCM tag.
    expect(frame.length).toBe(HEADER_LEN + PAD_BLOCK + 16);

    expect(await openFrame(key, RID, frame)).toEqual({ role: ROLE_PHONE, seq: 7, message: msg, version: 1 });
  });

  it('gives a different nonce (and so different bytes) for the same message', async () => {
    const key = await deriveKey(KS);
    const a = await sealFrame(key, RID, ROLE_PHONE, 1, { type: 'x' });
    const b = await sealFrame(key, RID, ROLE_PHONE, 1, { type: 'x' });
    expect([...a.subarray(6, 18)]).not.toEqual([...b.subarray(6, 18)]);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('pads a small and a much larger message to the SAME visible size', async () => {
    const key = await deriveKey(KS);
    const a = await sealFrame(key, RID, ROLE_DESKTOP, 1, { t: 'a' });
    const b = await sealFrame(key, RID, ROLE_DESKTOP, 2, { t: 'b'.repeat(400) });
    expect(a.length).toBe(b.length);
  });

  // --- MUTATION PROOF 1: the AAD really binds the rid and the header. -------
  it('REJECTS a frame opened under a different rid (AAD carries the rid)', async () => {
    const key = await deriveKey(KS);
    const frame = await sealFrame(key, RID, ROLE_PHONE, 1, { type: 'x' });
    await expect(openFrame(key, 'BBBBBBBBBBBBBBBBBBBBBB', frame)).rejects.toThrow();
  });

  it('REJECTS a frame whose seq byte was edited in flight (AAD carries the header)', async () => {
    const key = await deriveKey(KS);
    const frame = await sealFrame(key, RID, ROLE_PHONE, 1, { type: 'x' });
    frame[5] = 9; // seq low byte — inside the AAD's header[0..6)
    await expect(openFrame(key, RID, frame)).rejects.toThrow();
  });

  it('REJECTS a frame whose ROLE byte was edited in flight', async () => {
    const key = await deriveKey(KS);
    const frame = await sealFrame(key, RID, ROLE_PHONE, 1, { type: 'x' });
    frame[1] = ROLE_DESKTOP;
    await expect(openFrame(key, RID, frame)).rejects.toThrow();
  });

  it('REJECTS a frame sealed under a different Ks', async () => {
    const mine = await deriveKey(KS);
    const theirs = await deriveKey(new Uint8Array(32).fill(9));
    const frame = await sealFrame(theirs, RID, ROLE_DESKTOP, 1, { type: 'x' });
    await expect(openFrame(mine, RID, frame)).rejects.toThrow();
  });

  it('REJECTS an unknown version before it tries to decrypt', async () => {
    const key = await deriveKey(KS);
    const frame = await sealFrame(key, RID, ROLE_PHONE, 1, { type: 'x' });
    // 3, not 2: 2 is the session-key frame since wire v1.3, and a version the
    // wire DOES define must not be the one this test proves is refused.
    frame[0] = 3;
    await expect(openFrame(key, RID, frame)).rejects.toThrow(/unknown frame version 3/);
  });

  it('REJECTS a frame with no body', async () => {
    const key = await deriveKey(KS);
    await expect(openFrame(key, RID, new Uint8Array(HEADER_LEN))).rejects.toThrow(/shorter than its header/);
  });

  it('REJECTS a truncated ciphertext', async () => {
    const key = await deriveKey(KS);
    const frame = await sealFrame(key, RID, ROLE_PHONE, 1, { type: 'x' });
    await expect(openFrame(key, RID, frame.subarray(0, frame.length - 1))).rejects.toThrow();
  });

  it('survives a Uint8Array that is a VIEW onto a larger buffer', async () => {
    // The socket hands us `new Uint8Array(arrayBuffer)`, but a caller that
    // slices out of a batch would not — and passing a view's whole backing
    // buffer to WebCrypto would silently seal or open the wrong bytes.
    const key = await deriveKey(KS);
    const frame = await sealFrame(key, RID, ROLE_DESKTOP, 3, { type: 'y' });
    const padded = new Uint8Array(frame.length + 20);
    padded.set(frame, 10);
    expect((await openFrame(key, RID, padded.subarray(10, 10 + frame.length))).message).toEqual({ type: 'y' });
  });
});
