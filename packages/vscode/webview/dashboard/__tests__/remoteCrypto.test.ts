// Origami Remote — crypto leaf. Every assertion here is against a sentence of
// the wire spec (reports/remote_wire_spec_v1.md, "Keys and ids" / "Frame"),
// not against the implementation: sizes, derivation independence, and the
// three ways an open() must fail.
import { describe, expect, it } from 'vitest';
import {
  KS_BYTES,
  b64urlDecode,
  b64urlEncode,
  deriveKey,
  deriveRid,
  generateKs,
  open,
  randomBytes,
  seal,
} from '../../../src/remote/crypto';
// The padding moved to its own leaf when v1.3 gave a v2 frame a second rule.
import { PAD_BLOCK, padPlaintext, unpadPlaintext } from '../../../src/remote/padBuckets';

const AAD = new TextEncoder().encode('rid-under-test');

describe('remote crypto — base64url', () => {
  it('round-trips every byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect([...b64urlDecode(b64urlEncode(all))]).toEqual([...all]);
  });

  it('emits only URL-safe characters and no padding', () => {
    for (let n = 1; n <= 34; n++) {
      expect(b64urlEncode(randomBytes(n))).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('round-trips the odd lengths where base64 grouping breaks', () => {
    for (const n of [1, 2, 3, 4, 5, 16, 31, 32, 33]) {
      const bytes = randomBytes(n);
      expect([...b64urlDecode(b64urlEncode(bytes))]).toEqual([...bytes]);
    }
  });

  it('refuses a character outside the alphabet', () => {
    expect(() => b64urlDecode('abc$')).toThrow(/bad base64url/);
  });
});

describe('remote crypto — key material', () => {
  it('Ks is 32 random bytes and never repeats', () => {
    const a = generateKs();
    const b = generateKs();
    expect(a.length).toBe(KS_BYTES);
    expect(b64urlEncode(a)).not.toBe(b64urlEncode(b));
  });

  it('rid is base64url of SIXTEEN bytes, so 22 unpadded characters', async () => {
    const rid = await deriveRid(generateKs());
    expect(rid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b64urlDecode(rid).length).toBe(16);
  });

  it('rid is a pure function of Ks, and a different Ks gives a different rid', async () => {
    const ks = generateKs();
    expect(await deriveRid(ks)).toBe(await deriveRid(ks));
    expect(await deriveRid(ks)).not.toBe(await deriveRid(generateKs()));
  });

  it('the key and the rid use DIFFERENT info strings, so one never reveals the other', async () => {
    // Sealing under a key derived from Ks must fail against a key derived
    // from the rid bytes — proof the two derivations are separated.
    const ks = generateKs();
    const rid = await deriveRid(ks);
    const key = await deriveKey(ks);
    const impostor = await deriveKey(b64urlDecode(rid.padEnd(43, 'A')));
    const nonce = randomBytes(12);
    const sealed = await seal(key, nonce, AAD, padPlaintext('{}'));
    await expect(open(impostor, nonce, AAD, sealed)).rejects.toThrow();
  });
});

describe('remote crypto — padding', () => {
  it('pads to a multiple of 1,024 and carries the JSON length in a uint32 BE prefix', () => {
    for (const len of [0, 1, 100, 1019, 1020, 1021, 2048, 5000]) {
      const json = 'x'.repeat(len);
      const padded = padPlaintext(json);
      expect(padded.length % PAD_BLOCK).toBe(0);
      expect(new DataView(padded.buffer).getUint32(0, false)).toBe(len);
      expect(unpadPlaintext(padded)).toBe(json);
    }
  });

  it('puts messages into SIZE CLASSES rather than leaking their length', () => {
    const classOf = (n: number) => padPlaintext('x'.repeat(n)).length;
    expect(classOf(1)).toBe(1024);
    expect(classOf(1019)).toBe(1024); // 4 + 1019 = 1023
    expect(classOf(1020)).toBe(1024); // 4 + 1020 = 1024 exactly, no extra block
    expect(classOf(1021)).toBe(2048);
    expect(classOf(2043)).toBe(2048);
    expect(classOf(2044)).toBe(2048);
    expect(classOf(2045)).toBe(3072);
  });

  it('survives multi-byte UTF-8 (the length prefix is BYTES, not characters)', () => {
    const json = JSON.stringify({ text: 'geen probleem — café 🚀' });
    const padded = padPlaintext(json);
    expect(new DataView(padded.buffer).getUint32(0, false)).toBe(new TextEncoder().encode(json).length);
    expect(unpadPlaintext(padded)).toBe(json);
  });

  it('rejects non-zero padding rather than ignoring it', () => {
    const padded = padPlaintext('{"a":1}');
    padded[900] = 0x41;
    expect(() => unpadPlaintext(padded)).toThrow(/non-zero padding at byte 900/);
  });

  it('rejects a plaintext that is not a whole number of pad blocks', () => {
    expect(() => unpadPlaintext(new Uint8Array(1000))).toThrow(/not a multiple of 1024/);
  });

  it('rejects a declared length that runs off the end of the buffer', () => {
    const padded = padPlaintext('{}');
    new DataView(padded.buffer).setUint32(0, 5000, false);
    expect(() => unpadPlaintext(padded)).toThrow(/exceeds/);
  });
});

describe('remote crypto — seal and open', () => {
  it('round-trips a sealed payload', async () => {
    const key = await deriveKey(generateKs());
    const nonce = randomBytes(12);
    const json = JSON.stringify({ type: 'remote/hello', v: 1, device: 'desk' });
    const sealed = await seal(key, nonce, AAD, padPlaintext(json));
    expect(unpadPlaintext(await open(key, nonce, AAD, sealed))).toBe(json);
  });

  it('the ciphertext carries the 16-byte GCM tag on top of the plaintext', async () => {
    const key = await deriveKey(generateKs());
    const sealed = await seal(key, randomBytes(12), AAD, padPlaintext('{}'));
    expect(sealed.length).toBe(PAD_BLOCK + 16);
  });

  it('a MISMATCHED AAD fails to open', async () => {
    const key = await deriveKey(generateKs());
    const nonce = randomBytes(12);
    const sealed = await seal(key, nonce, AAD, padPlaintext('{}'));
    const other = new TextEncoder().encode('rid-under-tesT');
    await expect(open(key, nonce, other, sealed)).rejects.toThrow();
  });

  it('a WRONG KEY fails to open', async () => {
    const nonce = randomBytes(12);
    const sealed = await seal(await deriveKey(generateKs()), nonce, AAD, padPlaintext('{}'));
    await expect(open(await deriveKey(generateKs()), nonce, AAD, sealed)).rejects.toThrow();
  });

  it('a WRONG NONCE fails to open', async () => {
    const key = await deriveKey(generateKs());
    const sealed = await seal(key, randomBytes(12), AAD, padPlaintext('{}'));
    await expect(open(key, randomBytes(12), AAD, sealed)).rejects.toThrow();
  });

  it('a single flipped ciphertext bit fails to open', async () => {
    const key = await deriveKey(generateKs());
    const nonce = randomBytes(12);
    const sealed = await seal(key, nonce, AAD, padPlaintext('{}'));
    sealed[10] ^= 0x01;
    await expect(open(key, nonce, AAD, sealed)).rejects.toThrow();
  });
});
