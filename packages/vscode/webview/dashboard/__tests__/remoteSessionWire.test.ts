// Origami Remote — WIRE v1.3 AT THE BYTE LEVEL: the §9 pad buckets, the frame
// version byte, the receiver rule, and a PINNED K' vector.
//
// Every number here is quoted from `wire_v1_3_session_key.md` (§3, §4, §9), not
// read back out of the implementation. The app owner builds the phone half
// against the same text on a different machine in a different language, so a
// value the desktop agrees with itself about is worth nothing — which is what
// the vector at the bottom of this file is for: fixed keys in, one hex string
// out, cross-checkable without a socket.
//
// The two lanes' padding files (`src/remote/padBuckets.ts` and
// `webview/remote/pad.ts`) are asserted TOGETHER, in the same cases, because a
// one-byte disagreement between them is the failure mode that a per-lane test
// cannot see.

import { describe, expect, it } from 'vitest';

import { b64urlDecode, deriveKey, deriveRid, generateKs, type RemoteKey } from '../../../src/remote/crypto';
import {
  FRAME_VERSION,
  FRAME_VERSION_V2,
  FrameError,
  HEADER_BYTES,
  ROLE_DESKTOP,
  ROLE_PHONE,
  decodeFrame,
  encodeFrame,
} from '../../../src/remote/frame';
import { FrameCodec } from '../../../src/remote/frameCodec';
import {
  MAX_V2_PLAINTEXT_BYTES,
  V2_BUCKETS,
  bucketFor,
  isBucket,
  padPlaintext,
  padPlaintextV2,
  unpadPlaintextV2,
} from '../../../src/remote/padBuckets';
import { SESSION_KEY_INFO, sessionKeyBytes } from '../../../src/remote/sessionKey';

// The phone lane's own copies, so the two are compared and not assumed equal.
import { padPlaintextV2 as phonePadV2, unpadPlaintextV2 as phoneUnpadV2 } from '../../remote/pad';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
/** JSON whose UTF-8 length is exactly `n`, so a plaintext need of 4 + n. */
const jsonOf = (n: number): string => 'x'.repeat(n);

describe('wire v1.3 §9 — the pad buckets', () => {
  it('rounds a plaintext need to the smallest bucket that fits', () => {
    // need -> bucket, from the spec's own ladder: 256/512/1024/2048/4096, then
    // the next multiple of 4,096.
    const cases: Array<[number, number]> = [
      [1, 256],
      [255, 256],
      [256, 256],
      [257, 512],
      [512, 512],
      [513, 1024],
      [1024, 1024],
      [1025, 2048],
      [2048, 2048],
      [2049, 4096],
      [4096, 4096],
      [4097, 8192],
      [8192, 8192],
      [8193, 12288],
      [61440, 61440],
    ];
    for (const [need, want] of cases) expect(bucketFor(need), `need ${need}`).toBe(want);
  });

  it('refuses a plaintext over the 61,440-byte ceiling', () => {
    expect(bucketFor(61_440)).toBe(MAX_V2_PLAINTEXT_BYTES);
    expect(bucketFor(61_441)).toBe(0);
    // ...and the padder turns that into a named throw rather than a truncation.
    expect(() => padPlaintextV2(jsonOf(61_437))).toThrow(/over the 61440-byte ceiling/);
    expect(padPlaintextV2(jsonOf(61_436))).toHaveLength(61_440);
  });

  it('pads the SAME way in both lanes, byte for byte', () => {
    for (const n of [0, 1, 251, 252, 253, 1020, 4092, 4093, 61_400]) {
      const desktop = padPlaintextV2(jsonOf(n));
      const phone = phonePadV2(JSON.stringify(jsonOf(n)));
      // Same rule, different payloads: compare the LENGTH decision on the same
      // need, which is the part the two lanes must agree on.
      expect(desktop.length, `desktop ${n}`).toBe(bucketFor(4 + n));
      expect(phone.length, `phone ${n}`).toBe(bucketFor(4 + JSON.stringify(jsonOf(n)).length));
    }
  });

  it('a v1 frame still pads to a flat 1,024', () => {
    expect(padPlaintext(jsonOf(1)).length).toBe(1024);
    expect(padPlaintext(jsonOf(1019)).length).toBe(1024);
    expect(padPlaintext(jsonOf(1021)).length).toBe(2048);
  });

  describe('the receiver rule, before the JSON is read', () => {
    it('accepts only a legal bucket length', () => {
      for (const b of V2_BUCKETS) expect(isBucket(b)).toBe(true);
      expect(isBucket(8192)).toBe(true);
      expect(isBucket(61_440)).toBe(true);
      for (const bad of [0, 4, 128, 255, 300, 4095, 5000, 65_536]) expect(isBucket(bad), `${bad}`).toBe(false);
      expect(() => unpadPlaintextV2(new Uint8Array(300))).toThrow(/not one of the/);
    });

    it('rejects a declared length that overruns the bucket', () => {
      const buf = new Uint8Array(256);
      new DataView(buf.buffer).setUint32(0, 400, false);
      expect(() => unpadPlaintextV2(buf)).toThrow(/exceeds/);
      expect(() => phoneUnpadV2(buf)).toThrow(/overruns/);
    });

    it('rejects a NON-ZERO pad byte — the padding is not a side channel', () => {
      const good = padPlaintextV2('{"a":1}');
      expect(unpadPlaintextV2(good)).toBe('{"a":1}');
      const bad = padPlaintextV2('{"a":1}');
      bad[200] = 1;
      expect(() => unpadPlaintextV2(bad)).toThrow(/non-zero padding at byte 200/);
      expect(() => phoneUnpadV2(bad)).toThrow(/non-zero padding at byte 200/);
    });
  });
});

describe('wire v1.3 §4 — the frame version byte', () => {
  let key: RemoteKey;
  let other: RemoteKey;
  let rid: string;

  const setup = async (): Promise<void> => {
    const ks = generateKs();
    key = await deriveKey(ks);
    other = await deriveKey(generateKs());
    rid = await deriveRid(ks);
  };

  it('the smallest v2 frame on the wire is 290 bytes', async () => {
    await setup();
    const frame = await encodeFrame(key, rid, ROLE_DESKTOP, 1, '{}', undefined, FRAME_VERSION_V2);
    // 256 (the smallest bucket) + 18 (header) + 16 (GCM tag) — the spec's own
    // arithmetic. A v1 frame of the same message costs 1,058.
    expect(frame.length).toBe(290);
    expect(frame.length).toBe(256 + HEADER_BYTES + 16);
    expect(frame[0]).toBe(FRAME_VERSION_V2);
    expect((await encodeFrame(key, rid, ROLE_DESKTOP, 1, '{}')).length).toBe(1058);
  });

  it('the AAD covers the version byte, so a v2 frame cannot be downgraded', async () => {
    await setup();
    const frame = await encodeFrame(key, rid, ROLE_DESKTOP, 1, '{}', undefined, FRAME_VERSION_V2);
    frame[0] = FRAME_VERSION;
    const err = await decodeFrame(key, rid, frame).catch((e: unknown) => e);
    expect((err as FrameError).reason).toBe('gcm');
  });

  it('a codec seals v1 until it is given K', async () => {
    await setup();
    const codec = new FrameCodec(key, rid, ROLE_DESKTOP);
    expect(codec.outVersion).toBe(FRAME_VERSION);
    expect((await codec.encode('{}'))[0]).toBe(FRAME_VERSION);
    codec.useSessionKey(other);
    expect(codec.outVersion).toBe(FRAME_VERSION_V2);
    expect((await codec.encode('{}'))[0]).toBe(FRAME_VERSION_V2);
  });

  it('rejects a v2 frame that arrives before this socket holds K', async () => {
    await setup();
    const codec = new FrameCodec(key, rid, ROLE_DESKTOP);
    const v2 = await encodeFrame(other, rid, ROLE_PHONE, 1, '{}', undefined, FRAME_VERSION_V2);
    const err = await codec.decode(v2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FrameError);
    expect((err as FrameError).reason).toBe('version');
    expect((err as FrameError).message).toMatch(/before this socket derived a session key/);
  });

  it('rejects a v2 frame sealed with the WRONG key, non-fatally', async () => {
    await setup();
    const codec = new FrameCodec(key, rid, ROLE_DESKTOP);
    codec.useSessionKey(await deriveKey(generateKs()));
    const v2 = await encodeFrame(other, rid, ROLE_PHONE, 1, '{}', undefined, FRAME_VERSION_V2);
    const err = await codec.decode(v2).catch((e: unknown) => e);
    expect((err as FrameError).reason).toBe('gcm');
  });

  it('tolerates a v1 frame BEFORE the first v2 and rejects one AFTER it', async () => {
    await setup();
    const codec = new FrameCodec(key, rid, ROLE_DESKTOP);
    codec.useSessionKey(other);
    // In flight at the switch: accepted.
    expect((await codec.decode(await encodeFrame(key, rid, ROLE_PHONE, 1, '{"a":1}'))).version).toBe(FRAME_VERSION);
    // The peer switches.
    const v2 = await encodeFrame(other, rid, ROLE_PHONE, 2, '{"b":2}', undefined, FRAME_VERSION_V2);
    expect((await codec.decode(v2)).version).toBe(FRAME_VERSION_V2);
    // ...and a v1 from it is now a downgrade, for the rest of the socket.
    const late = await encodeFrame(key, rid, ROLE_PHONE, 3, '{"c":3}');
    const err = await codec.decode(late).catch((e: unknown) => e);
    expect((err as FrameError).reason).toBe('version');
    expect((err as FrameError).message).toMatch(/after this peer had switched/);
  });

  it('the seq counter CONTINUES across the switch', async () => {
    await setup();
    const codec = new FrameCodec(key, rid, ROLE_DESKTOP);
    const seqOf = (f: Uint8Array): number => new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(2, false);
    expect(seqOf(await codec.encode('{}'))).toBe(1);
    codec.useSessionKey(other);
    expect(seqOf(await codec.encode('{}'))).toBe(2);
    expect(seqOf(await codec.encode('{}'))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// THE PINNED VECTOR. Fixed keys, fixed Ks, fixed challenge, one hex string.
// The two private keys below are TEST-ONLY throwaways generated for this file
// and are in no keychain, on no device, and in no pairing.

const EPH_PRIV_JWK: JsonWebKey = {
  key_ops: ['deriveBits'],
  ext: true,
  kty: 'EC',
  crv: 'P-256',
  x: 'CWGfmt3gaaAtERcaRmeaKJmhXJ1qVNYjeOIycY_IGPU',
  y: 'G-Qbc39jvKkodDdlodeZlMnhqEcaLeCanzLBkiLsSts',
  d: '5qu1qUWVgZSu23-5H74J4ckJcYPrymCcsT9lUA7WXHw',
};
/** The 65-byte X9.63 point of the TEST device key, base64url. */
const DEVICE_PUB =
  'BKxC_fr2cvQxYDloffpf5PJtvglWYcOhEalc_WLgluCpRKUmjqMA6V7vh_M6194N0vEOL3D4e_VX5QY1flEkApo';
/** Ks = 00 01 02 ... 1f; challenge = ff fe fd ... e0. Both deliberately
 *  patterned so a reader can retype them. */
const KS = new Uint8Array(32).map((_, i) => i);
const CHALLENGE = new Uint8Array(32).map((_, i) => 0xff - i);

describe('wire v1.3 §3 — the K vector, for the app owner to cross-check', () => {
  it('derives the pinned key from the pinned inputs', async () => {
    const ephPriv = await crypto.subtle.importKey('jwk', EPH_PRIV_JWK, { name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ]);
    const raw = await sessionKeyBytes({
      ephPriv: ephPriv as never,
      devicePub: b64urlDecode(DEVICE_PUB),
      ks: KS,
      challenge: CHALLENGE,
    });
    expect(SESSION_KEY_INFO).toBe('origami-remote/v2/session-key');
    // Cross-checked against a straight reading of the spec: node's own
    // crypto.hkdfSync over the same IKM/salt/info gives the same 32 bytes, and
    // the phone side's ECDH(devicePriv, ephPub) gives the same Z as the
    // desktop's ECDH(ephPriv, devicePub).
    expect(hex(raw)).toBe('a9e4e0358e8c54ade1e0e1636038e1a3a7c9e9b38b9209c9d48882d454568de5');
  });
});
