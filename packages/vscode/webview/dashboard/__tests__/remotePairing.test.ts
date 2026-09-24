// Origami Remote — pairing. The two behaviours worth the file are the
// 60-second window and rotation on revoke: a pairing that outlives its QR, or
// a revoke that leaves the old key usable, are both silent failures.
import { describe, expect, it } from 'vitest';
import { b64urlEncode, deriveRid, generateKs } from '../../../src/remote/crypto';
import {
  PAIRING_WINDOW_MS,
  PairingManager,
  SECRET_CONFIRMED,
  SECRET_KS,
  LEGACY_PIN_SECRET,
  parseQrPayload,
  qrPayload,
  relayHttpUrl,
  type SecretStore,
} from '../../../src/remote/pairing';

/** A SecretStorage over a Map — the shape VS Code gives us, none of the host. */
function fakeSecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
  };
}

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe('remote pairing — the QR payload the spec prints', () => {
  it('turns a wss relay into the https url the phone loads the shell from', () => {
    expect(relayHttpUrl('wss://relay.origamilabs.nl')).toBe('https://relay.origamilabs.nl');
    expect(relayHttpUrl('ws://localhost:8080/')).toBe('http://localhost:8080');
  });

  it('is <https>/app/#v1.<rid>.<base64url Ks>, secret in the FRAGMENT only', async () => {
    const ks = generateKs();
    const rid = await deriveRid(ks);
    const payload = qrPayload('wss://relay.origamilabs.nl', rid, ks);
    expect(payload).toBe(`https://relay.origamilabs.nl/app/#v1.${rid}.${b64urlEncode(ks)}`);
    // Nothing secret before the '#': that is the whole point of the format.
    expect(payload.slice(0, payload.indexOf('#'))).not.toContain(b64urlEncode(ks));
  });

  it('carries the optional LAN url as a fourth field', () => {
    const ks = generateKs();
    const payload = qrPayload('wss://r.example', 'RID', ks, 'https://192.168.1.9:7443');
    expect(parseQrPayload(payload)).toEqual({ rid: 'RID', ks, lanUrl: 'https://192.168.1.9:7443' });
  });

  it('round-trips through parseQrPayload', () => {
    const ks = generateKs();
    const parsed = parseQrPayload(qrPayload('wss://r.example', 'RID', ks));
    expect(parsed.rid).toBe('RID');
    expect([...parsed.ks]).toEqual([...ks]);
    expect(parsed.lanUrl).toBeUndefined();
  });

  it('refuses a payload that is not v1 or has no fragment', () => {
    expect(() => parseQrPayload('https://r/app/')).toThrow(/no fragment/);
    expect(() => parseQrPayload('https://r/app/#v2.a.b')).toThrow(/unrecognised/);
    expect(() => parseQrPayload('https://r/app/#v1.a')).toThrow(/unrecognised/);
  });
});

describe('remote pairing — begin', () => {
  it('stores Ks in SecretStorage and NOTHING else — there is no PIN to hash', async () => {
    const secrets = fakeSecrets();
    const m = new PairingManager(secrets);
    await m.begin('wss://r.example');
    expect([...secrets.map.keys()]).toEqual([SECRET_KS]);
    // No confirmation marker yet: an offer is not a pairing until a phone says hello.
    expect(secrets.map.has(SECRET_CONFIRMED)).toBe(false);
  });

  it('derives the offered rid from the Ks it stored', async () => {
    const secrets = fakeSecrets();
    const offer = await new PairingManager(secrets).begin('wss://r.example');
    const parsed = parseQrPayload(offer.qr);
    expect(parsed.rid).toBe(offer.rid);
    expect(await deriveRid(parsed.ks)).toBe(offer.rid);
  });

  it('opens a 60-second window', async () => {
    const c = clock();
    const m = new PairingManager(fakeSecrets(), c.now);
    const offer = await m.begin('wss://r.example');
    expect(offer.expiresAt - c.now()).toBe(PAIRING_WINDOW_MS);
    expect(m.pending).toBe(true);
    expect(m.expired).toBe(false);
  });

});

describe('remote pairing — the 60-second window', () => {
  it('confirms a hello that arrives inside it', async () => {
    const c = clock();
    const m = new PairingManager(fakeSecrets(), c.now);
    await m.begin('wss://r.example');
    c.advance(PAIRING_WINDOW_MS - 1);
    expect(await m.confirm()).toBe(true);
    expect(m.pending).toBe(false);
    expect(m.active).not.toBeNull();
  });

  it('REFUSES a hello at the window boundary and revokes the pairing', async () => {
    const c = clock();
    const secrets = fakeSecrets();
    const m = new PairingManager(secrets, c.now);
    await m.begin('wss://r.example');
    c.advance(PAIRING_WINDOW_MS);
    expect(m.expired).toBe(true);
    expect(await m.confirm()).toBe(false);
    expect(m.active).toBeNull();
    expect(secrets.map.size).toBe(0); // nothing left for a late phone to use
  });

  it('expire() clears an unclaimed pairing', async () => {
    const secrets = fakeSecrets();
    const m = new PairingManager(secrets);
    await m.begin('wss://r.example');
    await m.expire();
    expect(secrets.map.size).toBe(0);
    expect(m.active).toBeNull();
  });

  it('a confirmed pairing is not re-expired by a second hello', async () => {
    const c = clock();
    const m = new PairingManager(fakeSecrets(), c.now);
    await m.begin('wss://r.example');
    expect(await m.confirm()).toBe(true);
    c.advance(PAIRING_WINDOW_MS * 10);
    expect(await m.confirm()).toBe(true);
    expect(m.active).not.toBeNull();
  });
});

describe('remote pairing — revoke rotates EVERYTHING', () => {
  it('wipes the stored material', async () => {
    const secrets = fakeSecrets();
    const m = new PairingManager(secrets);
    await m.begin('wss://r.example');
    await m.revoke();
    expect(secrets.map.size).toBe(0);
    expect(m.active).toBeNull();
  });

  it('gives the next pairing a different Ks, rid and key', async () => {
    const secrets = fakeSecrets();
    const m = new PairingManager(secrets);
    const first = await m.begin('wss://r.example');
    const firstKs = b64urlEncode(m.active!.ks);
    await m.revoke();
    const second = await m.begin('wss://r.example');
    expect(second.rid).not.toBe(first.rid);
    expect(b64urlEncode(m.active!.ks)).not.toBe(firstKs);
  });

  it('begin() itself revokes the previous pairing before minting a new one', async () => {
    const secrets = fakeSecrets();
    const m = new PairingManager(secrets);
    const first = await m.begin('wss://r.example');
    const second = await m.begin('wss://r.example');
    expect(second.rid).not.toBe(first.rid);
    expect(secrets.map.get(SECRET_KS)).toBe(b64urlEncode(m.active!.ks));
  });

});

describe('remote pairing — load', () => {
  it('restores a pairing a previous window CONFIRMED', async () => {
    const secrets = fakeSecrets();
    const m = new PairingManager(secrets);
    const first = await m.begin('wss://r.example');
    expect(await m.confirm()).toBe(true);
    const restored = await new PairingManager(secrets).load();
    expect(restored?.rid).toBe(first.rid);
  });

  // THE RETIRED PIN. A machine that paired on an older build has a PBKDF2 hash
  // of a four-digit code sitting in its keychain for a gate that no longer
  // exists. load() deletes it and never reads it, and the pairing itself — Ks
  // plus the confirmation — still restores: an upgrade must not un-pair a phone.
  it('deletes a PIN hash an older build left behind, and still restores the pairing', async () => {
    const secrets = fakeSecrets();
    const m = new PairingManager(secrets);
    const first = await m.begin('wss://r.example');
    await m.confirm();
    secrets.map.set(LEGACY_PIN_SECRET, 'a-pbkdf2-digest-from-0.4.104');

    const next = new PairingManager(secrets);
    expect((await next.load())?.rid).toBe(first.rid);
    expect(secrets.map.has(LEGACY_PIN_SECRET)).toBe(false);
  });

  it('deletes the stale PIN hash even when there is no pairing to restore', async () => {
    const secrets = fakeSecrets();
    secrets.map.set(LEGACY_PIN_SECRET, 'a-pbkdf2-digest-from-0.4.104');
    expect(await new PairingManager(secrets).load()).toBeNull();
    expect(secrets.map.size).toBe(0);
  });

  // THE PHANTOM DEVICE. Pressing "Show code" and never scanning it used to
  // leave Ks in the keychain, and the next window read it
  // as an ACTIVE pairing: the pane said "Paired · <rid> · reconnecting",
  // "1 device", and opened a relay socket for a phone that never existed.
  it('does NOT restore an offer that no phone ever confirmed, and clears it', async () => {
    const secrets = fakeSecrets();
    await new PairingManager(secrets).begin('wss://r.example');
    expect(secrets.map.size).toBeGreaterThan(0); // the offer IS on disk

    const next = new PairingManager(secrets);
    expect(await next.load()).toBeNull();
    expect(next.active).toBeNull();
    // and it is gone, so the window after this one cannot resurrect it either.
    expect(secrets.map.size).toBe(0);
  });

  it('does not restore an offer whose window closed unclaimed', async () => {
    const c = clock();
    const secrets = fakeSecrets();
    const m = new PairingManager(secrets, c.now);
    await m.begin('wss://r.example');
    c.advance(PAIRING_WINDOW_MS);
    await m.expire();
    expect(await new PairingManager(secrets).load()).toBeNull();
  });

  it('a revoked pairing cannot leave its confirmation behind for the NEXT offer', async () => {
    const secrets = fakeSecrets();
    const m = new PairingManager(secrets);
    await m.begin('wss://r.example');
    await m.confirm();
    await m.revoke();
    expect(secrets.map.size).toBe(0);
    await m.begin('wss://r.example'); // a fresh offer, never scanned
    expect(await new PairingManager(secrets).load()).toBeNull();
  });

  it('treats a half-written pair as no pairing at all', async () => {
    const secrets = fakeSecrets();
    const m = new PairingManager(secrets);
    await m.begin('wss://r.example');
    await m.confirm();
    secrets.map.delete(SECRET_KS);
    expect(await new PairingManager(secrets).load()).toBeNull();
  });

  it('returns null when nothing is stored', async () => {
    expect(await new PairingManager(fakeSecrets()).load()).toBeNull();
  });
});
