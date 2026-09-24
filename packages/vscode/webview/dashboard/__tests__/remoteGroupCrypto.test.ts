// Device group — the pairwise derivation (t-rz1b14, design note section 2).
//
// The expected values are NOT taken from the code under test. They are
// recomputed here with Node's own `hkdfSync`, a different implementation of the
// same RFC 5869 than the WebCrypto `deriveBits` the module uses, so a change to
// the ikm order, the label or the output length fails this file even though
// both sides would still "agree with themselves".
import { describe, expect, it } from 'vitest';
import { hkdfSync } from 'node:crypto';
import { b64urlEncode } from '../../../src/remote/crypto';
import { deriveRid } from '../../../src/remote/crypto';
import {
  DEVICE_ID_CHARS,
  GROUP_LABEL_JOIN_RID,
  GROUP_LABEL_MATCH,
  GROUP_LABEL_KEY,
  GROUP_LABEL_RID,
  derivePairKey,
  derivePairRid,
  deriveJoinRid,
  deriveMatchCode,
  generateDeviceId,
  generateKg,
  isDeviceId,
  pairIkm,
  pairRole,
  roleQuery,
  sortedPair,
} from '../../../src/remote/groupCrypto';
import { ROLE_DESKTOP, ROLE_PHONE } from '../../../src/remote/frame';
import { seal, open } from '../../../src/remote/crypto';

/** A fixed Kg, so every value in this file is reproducible by hand. */
const KG = new Uint8Array(32);
for (let i = 0; i < 32; i++) KG[i] = i;
const A = 'AAAAAAAAAAA';
const B = 'BBBBBBBBBBB';
/** A fixed one-time invite secret (16 bytes). */
const S = KG.slice(0, 16);

/** RFC 5869 with an empty salt — Node's implementation, not the module's. */
function hkdf(ikm: Uint8Array, info: string, len: number): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, new Uint8Array(0), Buffer.from(info, 'utf8'), len));
}

function ikmOf(kg: Uint8Array, low: string, high: string): Uint8Array {
  const out = new Uint8Array(kg.length + low.length + high.length);
  out.set(kg, 0);
  out.set(Buffer.from(low + high, 'utf8'), kg.length);
  return out;
}

describe('device group — pairwise rid', () => {
  it('matches an independent HKDF over Kg || sorted(idA, idB)', async () => {
    const expected = b64urlEncode(hkdf(ikmOf(KG, A, B), GROUP_LABEL_RID, 16));
    expect(await derivePairRid(KG, A, B)).toBe(expected);
  });

  it('is the SAME rid whichever desk derives it', async () => {
    expect(await derivePairRid(KG, A, B)).toBe(await derivePairRid(KG, B, A));
    expect([...pairIkm(KG, A, B)]).toEqual([...pairIkm(KG, B, A)]);
  });

  it('is a different rid for a different pair, a different Kg and a different label', async () => {
    const C = 'CCCCCCCCCCC';
    const kg2 = generateKg();
    const base = await derivePairRid(KG, A, B);
    expect(await derivePairRid(KG, A, C)).not.toBe(base);
    expect(await derivePairRid(kg2, A, B)).not.toBe(base);
    // The artifacts lane derives over the SAME pair with its own label; sharing
    // a rid would put two lanes in one relay slot.
    expect(await derivePairRid(KG, A, B, 'origami-artifacts/v1/rid')).not.toBe(base);
    // ...and the join rendezvous is not the pair's rid either. v2 (t-sj32zl):
    // it derives from the invite's one-time secret, not from Kg.
    expect(await deriveJoinRid(S, A)).not.toBe(base);
    expect(await deriveJoinRid(S, A)).toBe(b64urlEncode(hkdf(ikmOf(S, A, ''), GROUP_LABEL_JOIN_RID, 16)));
    expect(GROUP_LABEL_JOIN_RID).toBe('origami-group/v2/join-rid');
  });

  it("is distinct from the phone pairing's rid over the same 32 bytes", async () => {
    // Kg and Ks are both 32 random bytes. If the group had reused the remote
    // label, a desk and a phone would land on ONE relay rendezvous.
    expect(await derivePairRid(KG, A, B)).not.toBe(await deriveRid(KG));
  });

  it('refuses an id that is not a device id, and a device paired with itself', async () => {
    await expect(derivePairRid(KG, A, 'short')).rejects.toThrow(/device id/);
    await expect(derivePairRid(KG, A, A)).rejects.toThrow(/itself/);
    expect(() => sortedPair(A, B)).not.toThrow();
  });
});

describe('device group — pairwise key', () => {
  it('opens what an independent HKDF of the same label seals', async () => {
    const raw = hkdf(ikmOf(KG, A, B), GROUP_LABEL_KEY, 32);
    const { webcrypto } = await import('node:crypto');
    const theirs = await webcrypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
    const nonce = new Uint8Array(12);
    const aad = new TextEncoder().encode('rid');
    const sealed = await seal(theirs as never, nonce, aad, new TextEncoder().encode('hello desk'));
    const ours = await derivePairKey(KG, A, B);
    expect(new TextDecoder().decode(await open(ours, nonce, aad, sealed))).toBe('hello desk');
  });

  it('does not open a frame sealed under a different label', async () => {
    const other = await derivePairKey(KG, A, B, 'origami-artifacts/v1/key');
    const nonce = new Uint8Array(12);
    const aad = new TextEncoder().encode('rid');
    const sealed = await seal(other, nonce, aad, new TextEncoder().encode('x'));
    await expect(open(await derivePairKey(KG, A, B), nonce, aad, sealed)).rejects.toThrow();
  });
});

describe('device group — the join match code (t-sj32zl)', () => {
  const pub = new Uint8Array(65).fill(7);

  it('matches an independent HKDF over secret || inviter || joiner || joiner key, as "ddd ddd"', async () => {
    const ids = ikmOf(S, A, B); // inviter first, joiner second: roles, not sorted
    const ikm = new Uint8Array(ids.length + pub.length);
    ikm.set(ids, 0);
    ikm.set(pub, ids.length);
    const n = Buffer.from(hkdf(ikm, GROUP_LABEL_MATCH, 4)).readUInt32BE(0) % 1_000_000;
    const d = String(n).padStart(6, '0');
    expect(await deriveMatchCode(S, A, B, pub)).toBe(`${d.slice(0, 3)} ${d.slice(3)}`);
  });

  it('differs for another joiner id, another joiner key and another invite', async () => {
    const base = await deriveMatchCode(S, A, B, pub);
    expect(await deriveMatchCode(S, A, 'CCCCCCCCCCC', pub)).not.toBe(base);
    expect(await deriveMatchCode(S, A, B, new Uint8Array(65).fill(8))).not.toBe(base);
    expect(await deriveMatchCode(KG.slice(16), A, B, pub)).not.toBe(base);
  });
});

describe('device group — roles and ids', () => {
  it('gives the lower id the desktop role, on both desks', () => {
    expect(pairRole(A, B)).toBe(ROLE_DESKTOP);
    expect(pairRole(B, A)).toBe(ROLE_PHONE);
    expect(roleQuery(pairRole(A, B))).toBe('desktop');
    expect(roleQuery(pairRole(B, A))).toBe('phone');
  });

  it('mints fixed-length base64url ids — the ikm is a concatenation', () => {
    for (let i = 0; i < 20; i++) {
      const id = generateDeviceId();
      expect(id).toHaveLength(DEVICE_ID_CHARS);
      expect(isDeviceId(id)).toBe(true);
    }
    expect(isDeviceId('AAAAAAAAAA')).toBe(false); // 10 characters
    expect(isDeviceId('AAAAAAAAAA.')).toBe(false); // not base64url
    expect(isDeviceId(null)).toBe(false);
  });

  it('cannot be confused by ids that concatenate the same way', async () => {
    // The fixed length is what makes ("ab","c") and ("a","bc") impossible.
    expect(pairIkm(KG, A, B).length).toBe(KG.length + DEVICE_ID_CHARS * 2);
  });
});
