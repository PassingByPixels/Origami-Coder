// Origami Remote — DEVICE IDENTITY (R-2b), driven through the real controller.
//
// The claim under test is the one the iOS app exists to make: a second phone
// holding a COPY of the pairing secret gets the handshake and nothing else.
// Nothing here fakes the crypto — every signature is made in the test with
// WebCrypto's own ECDSA P-256, and the desktop verifies it with WebCrypto's own
// `verify`, so a disagreement between the two would fail here rather than on a
// phone. The frame layer, the pairing manager and the dispatch table are all
// the production ones; only the socket is a fake.
//
// The four refusals are tested by REASON, not just by "it did not hydrate": a
// wrong signature, a key that is not the enrolled one, a replayed response and
// a response with no challenge are four different faults, and a desktop that
// collapsed them into one verdict would tell the owner nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { b64urlDecode, b64urlEncode, deriveKey } from '../../../src/remote/crypto';
import { ChunkAssembler, isChunkMessage, type ChunkMessage } from '../../../src/remote/chunk';
import { ROLE_PHONE } from '../../../src/remote/frame';
import { FrameCodec } from '../../../src/remote/frameCodec';
import { deviceAuthPayload, SECRET_DEVICE, verifyChallengeResponse } from '../../../src/remote/deviceAuth';
import { FOREIGN_DEVICE_PREFIX, REPEATED_ANSWER } from '../../../src/remote/inbound';
import { KEYLESS_APPROVAL, permissionAnswer } from '../../../src/remote/inboundApproval';
import type { InboundDeps } from '../../../src/remote/inbound';
import { ENVELOPE_REFUSED } from '../../../src/remote/remoteVerbs';
import { PAIRING_WEDGED } from '../../../src/remote/presence';
import { parseQrPayload, type SecretStore } from '../../../src/remote/pairing';
import { RemoteController, type RemoteConfig } from '../../../src/remote/remoteController';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';

async function flush(ms = 30): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 1));
}

async function waitFor(pred: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

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

class FakeSocket implements RemoteSocket {
  public readonly sent: Uint8Array[] = [];
  public binaryType = 'blob';
  public onopen: (() => void) | null = null;
  public onmessage: ((ev: { data: unknown }) => void) | null = null;
  public onclose: ((ev: { code?: number }) => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;
  public closed = false;
  constructor(public readonly url: string) {}
  public send(data: Uint8Array): void {
    this.sent.push(data);
  }
  public close(): void {
    this.closed = true;
  }
}

interface Rig {
  deps: TransportDeps;
  sockets: FakeSocket[];
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
}

function rig(): Rig {
  const sockets: FakeSocket[] = [];
  const timers: Rig['timers'] = [];
  return {
    sockets,
    timers,
    deps: {
      connect: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms, cleared: false });
        return timers.length - 1;
      },
      clearTimer: (h) => {
        const t = timers[h as number];
        if (t) t.cleared = true;
      },
    },
  };
}

/** A REAL Secure-Enclave-shaped identity: a P-256 keypair whose public half is
 *  the 65-byte X9.63 point the wire carries, and whose fingerprint is the
 *  base64url SHA-256 of those bytes — 43 characters, as the pane shows. */
async function makeDeviceKey(): Promise<{
  pub: string;
  fp: string;
  block: Record<string, string>;
  sign(challengeB64: string, rid: string): Promise<string>;
}> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pub = b64urlEncode(raw);
  const fp = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
  return {
    pub,
    fp,
    block: { alg: 'ES256', pub, fp, backend: 'secure-enclave' },
    async sign(challengeB64, rid) {
      const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        deviceAuthPayload(b64urlDecode(challengeB64), rid),
      );
      return b64urlEncode(new Uint8Array(sig));
    },
  };
}

/** The other end of the wire: the phone's codec plus its chunk reassembly. */
class FakePhone {
  private readonly assembler = new ChunkAssembler();
  public readonly received: Array<Record<string, unknown>> = [];
  constructor(private readonly codec: FrameCodec) {}

  public async absorb(frames: Uint8Array[]): Promise<void> {
    for (const frame of frames) {
      let msg = JSON.parse((await this.codec.decode(frame)).json) as unknown;
      if (isChunkMessage(msg)) {
        const whole = this.assembler.push(msg as ChunkMessage);
        if (whole === null) continue;
        msg = JSON.parse(whole);
      }
      this.received.push(msg as Record<string, unknown>);
    }
  }

  public seal(msg: unknown): Promise<Uint8Array> {
    return this.codec.encode(JSON.stringify(msg));
  }
}

interface Desk {
  controller: RemoteController;
  r: Rig;
  secrets: ReturnType<typeof fakeSecrets>;
  attach: ReturnType<typeof vi.fn>;
  statuses: string[];
  socket: () => FakeSocket;
  /** Show a code, open the socket, and build the phone that scanned it. */
  pair(): Promise<{ rid: string; ks: Uint8Array; phone: FakePhone }>;
  /** Everything the desktop has sent since the last drain, decoded. */
  drain(phone: FakePhone): Promise<Array<Record<string, unknown>>>;
  fromPhone(phone: FakePhone, msg: unknown): Promise<void>;
  /** The `challenge` string off the last `remote/challenge` frame. */
  challengeOf(frames: Array<Record<string, unknown>>): string;
}

function desk(config: Partial<RemoteConfig> = {}): Desk {
  const r = rig();
  const secrets = fakeSecrets();
  const attach = vi.fn();
  const statuses: string[] = [];
  const controller = new RemoteController({
    config: () => ({ enabled: true, relayUrl: 'wss://relay.example', capability: 'full', ...config }),
    secrets,
    deps: r.deps,
    attach,
    onStatus: (s) => statuses.push(s),
    deviceName: 'test-desk',
  });
  // Per SOCKET, not per desk: a reconnect starts a fresh `sent` array, and a
  // single counter would silently drain nothing after one.
  const drained = new WeakMap<FakeSocket, number>();
  const socket = (): FakeSocket => r.sockets[r.sockets.length - 1]!;
  return {
    controller,
    r,
    secrets,
    attach,
    statuses,
    socket,
    async pair() {
      const offer = await controller.pair();
      const { rid, ks } = parseQrPayload(offer.qr);
      socket().onopen?.();
      await waitFor(() => socket().sent.length >= 2, 'the desktop hello and challenge');
      return { rid, ks, phone: new FakePhone(new FrameCodec(await deriveKey(ks), rid, ROLE_PHONE)) };
    },
    async drain(phone) {
      const s = socket();
      const fresh = s.sent.slice(drained.get(s) ?? 0);
      drained.set(s, s.sent.length);
      const before = phone.received.length;
      await phone.absorb(fresh);
      return phone.received.slice(before);
    },
    async fromPhone(phone, msg) {
      socket().onmessage?.({ data: await phone.seal(msg) });
      await flush();
    },
    challengeOf(frames) {
      const c = frames.find((f) => f['type'] === 'remote/challenge');
      expect(c, 'the desktop sent no remote/challenge').toBeTruthy();
      return c!['challenge'] as string;
    },
  };
}

describe('device identity — the challenge on the wire', () => {
  it('sends 32 random bytes as base64url on every socket open, right after its hello', async () => {
    const d = desk();
    const { phone } = await d.pair();
    const frames = await d.drain(phone);
    expect(frames.map((f) => f['type'])).toEqual(['remote/hello', 'remote/challenge']);
    // v:2 since wire v1.3, and it carries the desktop's ephemeral P-256 point:
    // 65 X9.63 bytes, 0x04 first. The PRESENCE of ephPub is what decides which
    // signature shape both ends use, so it is asserted on the wire.
    expect(frames[1]).toMatchObject({ v: 2 });
    expect(b64urlDecode(d.challengeOf(frames))).toHaveLength(32);
    const ephPub = b64urlDecode(frames[1]!['ephPub'] as string);
    expect(ephPub).toHaveLength(65);
    expect(ephPub[0]).toBe(0x04);
  });

  it('a NEW socket gets a NEW challenge — a verdict never survives a reconnect', async () => {
    const d = desk();
    const { rid, phone } = await d.pair();
    const first = d.challengeOf(await d.drain(phone));
    const key = await makeDeviceKey();
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: 'iPhone', deviceKey: key.block });
    await d.fromPhone(phone, {
      type: 'remote/challenge-response',
      v: 1,
      sig: await key.sign(first, rid),
      pub: key.pub,
    });
    await waitFor(() => d.attach.mock.calls.length > 0, 'the verified phone to hydrate');

    // The socket drops and the transport reconnects: a fresh challenge, and
    // nothing is served until it is answered again.
    const attachedBefore = d.attach.mock.calls.length;
    d.socket().onclose?.({ code: 1006 });
    d.r.timers.filter((t) => !t.cleared && t.ms < 60_000).forEach((t) => t.fn());
    await waitFor(() => d.r.sockets.length >= 2, 'the transport to reconnect');
    d.socket().onopen?.();
    // The desktop greets ONCE per pairing, so the second socket carries the
    // challenge alone — which is the frame this test is about.
    await waitFor(() => d.socket().sent.length >= 1, 'the challenge on the second socket');
    const second = d.challengeOf(await d.drain(phone));
    expect(second).not.toBe(first);

    // The OLD challenge's signature is a stale answer and is refused.
    await d.fromPhone(phone, {
      type: 'remote/challenge-response',
      v: 1,
      sig: await key.sign(first, rid),
      pub: key.pub,
    });
    expect(d.statuses.at(-1)).toContain('the signature did not verify');
    expect(d.attach.mock.calls.length).toBe(attachedBefore);
  });

  it('re-sends the SAME challenge when the phone arrives, and stops once verified', async () => {
    const d = desk();
    const { rid, phone } = await d.pair();
    const first = d.challengeOf(await d.drain(phone));

    // peer:absent, then peer:present — the race the MacBook lane hit live: the
    // first challenge went out while the relay said nobody was listening.
    d.socket().onmessage?.({ data: 'peer:absent' });
    d.socket().onmessage?.({ data: 'peer:present' });
    await flush();
    const again = await d.drain(phone);
    expect(again.filter((f) => f['type'] === 'remote/challenge')).toHaveLength(1);
    expect(d.challengeOf(again)).toBe(first);

    const key = await makeDeviceKey();
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: 'iPhone', deviceKey: key.block });
    await d.fromPhone(phone, {
      type: 'remote/challenge-response',
      v: 1,
      sig: await key.sign(first, rid),
      pub: key.pub,
    });
    await waitFor(() => d.attach.mock.calls.length > 0, 'the verified phone to hydrate');

    // ...and a peer that comes back AFTER the verdict IS re-challenged, with
    // FRESH bytes. CHANGED with the privilege lane: the relay's `peer:present`
    // says a socket attached on the phone's side and never says whose, so the
    // returning peer may be a different client that evicted the phone. It gets
    // a new challenge, not the old one — a replacement holding a copied Ks
    // could have read the first challenge and its answer off the relay's replay
    // ring (t-xyhymy), so re-offering those bytes would hand it the session.
    await d.drain(phone);
    d.socket().onmessage?.({ data: 'peer:absent' });
    d.socket().onmessage?.({ data: 'peer:present' });
    await flush();
    const after = await d.drain(phone);
    const reoffered = after.filter((f) => f['type'] === 'remote/challenge');
    expect(reoffered).toHaveLength(1);
    expect(reoffered[0]!['challenge']).not.toBe(first);
    expect(b64urlDecode(reoffered[0]!['challenge'] as string)).toHaveLength(32);
  });
});

describe('device identity — enrolment', () => {
  it('stores the key, the name, the platform, the app and the backend on the confirming hello', async () => {
    const d = desk();
    const key = await makeDeviceKey();
    const { phone } = await d.pair();
    await d.fromPhone(phone, {
      type: 'remote/hello',
      v: 1,
      device: "Sam's iPhone",
      platform: 'ios',
      app: '1.0 (1)',
      deviceKey: key.block,
    });
    await waitFor(() => d.secrets.map.has(SECRET_DEVICE), 'the device record to be stored');

    expect(d.controller.device).toEqual({
      name: "Sam's iPhone",
      fp: key.fp,
      platform: 'ios',
      app: '1.0 (1)',
      backend: 'secure-enclave',
      // Enrolled, but this socket has not proved the key yet, so no K'.
      session: 'off',
    });
    // 43 characters: base64url of a SHA-256, unpadded. The pane shows all of it.
    expect(key.fp).toHaveLength(43);
  });

  it('enrols NOTHING for a hello with no device key — that is a browser page', async () => {
    const d = desk();
    const { phone } = await d.pair();
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: 'Chrome on Android' });
    expect(d.secrets.map.has(SECRET_DEVICE)).toBe(false);
    expect(d.controller.device).toBeNull();
    // ...and it is still HYDRATED. The owner's rule is "it can read the chat
    // and nothing else", so reading is exactly what it keeps.
    await waitFor(() => d.attach.mock.calls.length > 0, 'the keyless page to hydrate');
  });

  it('FIRST ENROLMENT WINS: a second key is dropped, named by fingerprint, and the pairing stands', async () => {
    const d = desk();
    const mine = await makeDeviceKey();
    const theirs = await makeDeviceKey();
    const { rid, phone } = await d.pair();
    const challenge = d.challengeOf(await d.drain(phone));
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: 'iPhone', deviceKey: mine.block });

    // The thief has the QR (so the same Ks and the same codec) and their own key.
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: 'thief', deviceKey: theirs.block });
    expect(d.statuses.at(-1)).toBe(FOREIGN_DEVICE_PREFIX + theirs.fp);
    // The enrolled key is KEPT and the owner's pairing is not revoked — an
    // attacker who could revoke it by connecting once would have a free denial
    // of service.
    expect(d.controller.device?.fp).toBe(mine.fp);
    expect(d.controller.rid).toBe(rid);

    // ...and the thief's own signature over the live challenge does not verify.
    await d.fromPhone(phone, {
      type: 'remote/challenge-response',
      v: 1,
      sig: await theirs.sign(challenge, rid),
      pub: theirs.pub,
    });
    expect(d.statuses.at(-1)).toContain('a key that is not the enrolled device');
    expect(d.attach).not.toHaveBeenCalled();
  });

  it('a NEW pairing forgets the old device, so the next phone can enrol', async () => {
    const d = desk();
    const first = await makeDeviceKey();
    const p1 = await d.pair();
    await d.fromPhone(p1.phone, { type: 'remote/hello', v: 1, device: 'old', deviceKey: first.block });
    await waitFor(() => d.controller.device !== null, 'the first device to enrol');

    const second = await makeDeviceKey();
    const p2 = await d.pair();
    expect(d.controller.device).toBeNull();
    await d.fromPhone(p2.phone, { type: 'remote/hello', v: 1, device: 'new', deviceKey: second.block });
    await waitFor(() => d.controller.device !== null, 'the second device to enrol');
    expect(d.controller.device?.fp).toBe(second.fp);
  });

  it('revoke clears the device record with the pairing', async () => {
    const d = desk();
    const key = await makeDeviceKey();
    const { phone } = await d.pair();
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: 'iPhone', deviceKey: key.block });
    await waitFor(() => d.secrets.map.has(SECRET_DEVICE), 'the device record to be stored');
    await d.controller.revoke();
    expect(d.secrets.map.has(SECRET_DEVICE)).toBe(false);
    expect(d.controller.device).toBeNull();
  });
});

describe('device identity — nothing is served before the signature verifies', () => {
  /** Enrol a device, then answer nothing. */
  async function enrolled(config: Partial<RemoteConfig> = {}) {
    const d = desk(config);
    const key = await makeDeviceKey();
    const { rid, phone } = await d.pair();
    const challenge = d.challengeOf(await d.drain(phone));
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: 'iPhone', deviceKey: key.block });
    return { d, key, rid, phone, challenge };
  }

  it('holds the snapshot that rides the same socket open, then replays the hydration on the verdict', async () => {
    const { d, key, rid, phone, challenge } = await enrolled();
    // The phone sends hello and snapshot together on open — before it can have
    // seen the challenge. Neither may hydrate.
    await d.fromPhone(phone, { type: 'remote/snapshot' });
    expect(d.attach).not.toHaveBeenCalled();
    expect(d.statuses.at(-1)).toContain('waiting for the phone to prove');

    await d.fromPhone(phone, {
      type: 'remote/challenge-response',
      v: 1,
      sig: await key.sign(challenge, rid),
      pub: key.pub,
      fp: key.fp,
    });
    await waitFor(() => d.attach.mock.calls.length === 1, 'the held hydration to be replayed');
    expect(d.statuses.at(-1)).toContain('proved the enrolled device key');
  });

  it('drops everything else while unverified, and dispatches it once verified', async () => {
    const { d, key, rid, phone, challenge } = await enrolled({ approvals: 'yolo' });
    await d.fromPhone(phone, { type: 'send', text: 'rm -rf /', sessionId: 's1' });
    expect(d.attach).not.toHaveBeenCalled();
    expect(d.statuses.at(-1)).toContain('has not proved the enrolled device key');

    await d.fromPhone(phone, {
      type: 'remote/challenge-response',
      v: 1,
      sig: await key.sign(challenge, rid),
      pub: key.pub,
    });
    await waitFor(() => d.attach.mock.calls.length > 0, 'the verified phone to hydrate');
    const host = d.attach.mock.calls[0]![0] as { webview: { onDidReceiveMessage(l: (m: unknown) => void): unknown } };
    const inbound: unknown[] = [];
    host.webview.onDidReceiveMessage((m) => inbound.push(m));
    await d.fromPhone(phone, { type: 'send', text: 'hello', sessionId: 's1' });
    expect(inbound).toEqual([{ type: 'send', text: 'hello', sessionId: 's1' }]);
  });

  it('refuses a WRONG signature by reason and stays blocked', async () => {
    const { d, key, rid, phone, challenge } = await enrolled();
    const sig = await key.sign(challenge, rid);
    // Flip one byte of r. Still 64 bytes, still this key's shape, still wrong.
    const bytes = b64urlDecode(sig);
    bytes[0] = bytes[0]! ^ 0xff;
    await d.fromPhone(phone, { type: 'remote/challenge-response', v: 1, sig: b64urlEncode(bytes), pub: key.pub });
    expect(d.statuses.at(-1)).toContain('the signature did not verify');
    await d.fromPhone(phone, { type: 'remote/snapshot' });
    expect(d.attach).not.toHaveBeenCalled();
  });

  // A REPLAY of a valid response is not a refusal and must not be reported as
  // one: the desktop re-offers the same challenge whenever the phone reappears
  // and the phone answers every challenge it sees, so a verified socket getting
  // a second valid answer is the desktop's own doing. Seen live on the relay.
  it('names a REPLAYED response as a repeat, never as a refusal, and does not un-verify', async () => {
    const { d, key, rid, phone, challenge } = await enrolled();
    const response = { type: 'remote/challenge-response', v: 1, sig: await key.sign(challenge, rid), pub: key.pub };
    await d.fromPhone(phone, response);
    expect(d.statuses.at(-1)).toContain('proved the enrolled device key');
    await d.fromPhone(phone, response);
    expect(d.statuses.at(-1)).toBe(REPEATED_ANSWER);
    expect(d.statuses.at(-1)).not.toContain('refused');
    // ...and the socket is still verified, so the phone keeps being served.
    await d.fromPhone(phone, { type: 'remote/snapshot' });
    await waitFor(() => d.attach.mock.calls.length > 0, 'the still-verified phone to hydrate');
  });

  it('refuses a response when no challenge is pending on this socket', async () => {
    const { d, key, rid, phone, challenge } = await enrolled();
    // The socket drops and the transport reconnects. The new socket has not
    // opened yet, so no challenge has been generated on it — and a response
    // that arrives anyway has nothing to answer.
    d.socket().onclose?.({ code: 1006 });
    d.r.timers.filter((t) => !t.cleared && t.ms < 60_000).forEach((t) => t.fn());
    await waitFor(() => d.r.sockets.length >= 2, 'the transport to reconnect');
    await d.fromPhone(phone, {
      type: 'remote/challenge-response',
      v: 1,
      sig: await key.sign(challenge, rid),
      pub: key.pub,
    });
    expect(d.statuses.at(-1)).toContain('no challenge is pending on this socket');
    expect(d.attach).not.toHaveBeenCalled();
  });

  it('refuses a malformed pub and a malformed sig by reason, without throwing', async () => {
    const { d, key, rid, phone, challenge } = await enrolled();
    const sig = await key.sign(challenge, rid);
    // A verifier that threw on rubbish would take the reason down with it.
    await expect(verifyChallengeResponse({ challengeBytes: new Uint8Array(32), rid, sig, pub: 'not!base64url' })).resolves
      .toMatchObject({ ok: false });
    await expect(verifyChallengeResponse({ challengeBytes: new Uint8Array(32), rid, sig: 'AAAA', pub: key.pub })).resolves
      .toMatchObject({ ok: false, reason: expect.stringContaining('the signature is 3 bytes') });
    await expect(verifyChallengeResponse({ challengeBytes: new Uint8Array(32), rid, sig, pub: b64urlEncode(new Uint8Array(64)) })).resolves
      .toMatchObject({ ok: false, reason: expect.stringContaining('64 bytes, want a 65-byte uncompressed point') });
    // 65 bytes but not an uncompressed point: named for what it IS, since
    // "is 65 bytes, want 65 bytes" tells the reader nothing.
    await expect(verifyChallengeResponse({ challengeBytes: new Uint8Array(32), rid, sig, pub: b64urlEncode(new Uint8Array(65)) })).resolves
      .toMatchObject({ ok: false, reason: expect.stringContaining('does not start with 0x04') });
  });
});

// A KEYLESS PAGE IS WATCH-ONLY (2026-09-06). The owner's rule replaced both the
// pairing PIN and the device-key requirement setting: a pairing that has
// enrolled no device key is clamped to the `watch` envelope in `inbound.ts`,
// whatever this desk allows. Every test below runs on a desk set to FULL, which
// is the point — if the clamp were dropped the desk's own setting would let
// each of these through, so a regression fails here rather than on a phone.
describe('device identity — a page with no device key may only watch', () => {
  /** What the HOST was told. attach() fires on every hydration and this fake
   *  never drops the previous wiring the way DashboardPanel.rewireView does, so
   *  the listener is registered on the FIRST attach only — otherwise a single
   *  message arrives once per hydration and every count below is wrong. */
  function collect(d: Desk): unknown[] {
    const host: unknown[] = [];
    let wired = false;
    d.attach.mockImplementation((h: { webview: { onDidReceiveMessage(l: (m: unknown) => void): unknown } }) => {
      if (wired) return;
      wired = true;
      h.webview.onDidReceiveMessage((m) => host.push(m));
    });
    return host;
  }

  /** A browser page: it scanned the code, said hello with no key, and hydrated. */
  async function browserPage(): Promise<{ d: Desk; phone: FakePhone; host: unknown[] }> {
    const d = desk({ capability: 'full' });
    const host = collect(d);
    const { phone } = await d.pair();
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: 'Chrome' });
    await d.fromPhone(phone, { type: 'remote/snapshot' });
    await waitFor(() => d.attach.mock.calls.length > 0, 'the browser page to hydrate');
    return { d, phone, host };
  }

  it('reads: it hydrates on a snapshot and can cancel a turn', async () => {
    const { d, phone, host } = await browserPage();
    await d.fromPhone(phone, { type: 'cancel', sessionId: 's1' });
    expect(host).toEqual([{ type: 'cancel', sessionId: 's1' }]);
  });

  it('DROPS a send, and names the type on the status line', async () => {
    const { d, phone, host } = await browserPage();
    await d.fromPhone(phone, { type: 'send', text: 'rm -rf /', sessionId: 's1' });
    await flush(60);
    expect(host).toEqual([]);
    expect(d.statuses.at(-1)).toBe(ENVELOPE_REFUSED + 'watch — refused send');
  });

  it('DROPS an approve, and the ask stays outstanding', async () => {
    const { d, phone, host } = await browserPage();
    await d.fromPhone(phone, { type: 'permission', toolCallId: 'tc-1', optionId: 'allow_once', sessionId: 's1' });
    await flush(60);
    expect(host).toEqual([]);
    expect(d.statuses.at(-1)).toBe(ENVELOPE_REFUSED + 'watch — refused permission');
  });

  // THE SELF-SIGNED CLIENT. Answering the challenge with a key it minted itself
  // makes a socket `verified` — nothing was enrolled for it to fail against — so
  // a clamp that keyed on the verdict would hand it the whole envelope. The
  // clamp keys on ENROLMENT instead, and this is the test that says so.
  it('DROPS an approve from a VERIFIED socket that enrolled no key', async () => {
    const d = desk({ capability: 'full' });
    const host = collect(d);
    const key = await makeDeviceKey();
    const { rid, phone } = await d.pair();
    const challenge = d.challengeOf(await d.drain(phone));
    // A hello with NO key enrols nothing; a valid answer to the challenge then
    // verifies the socket without there being an enrolled key behind it.
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: 'Chrome' });
    await d.fromPhone(phone, {
      type: 'remote/challenge-response', v: 1, sig: await key.sign(challenge, rid), pub: key.pub,
    });
    expect(d.controller.device).toBeNull();
    await d.fromPhone(phone, { type: 'permission', toolCallId: 'tc-1', optionId: 'allow_once', sessionId: 's1' });
    await flush(60);
    expect(host).toEqual([]);
    expect(d.statuses.at(-1)).toBe(ENVELOPE_REFUSED + 'watch — refused permission');
  });

  it('HONOURS a deny — refusing an ask is free at every envelope', async () => {
    const { d, phone, host } = await browserPage();
    await d.fromPhone(phone, { type: 'permission', toolCallId: 'tc-1', optionId: null, sessionId: 's1' });
    await flush(60);
    expect(host).toEqual([{ type: 'permission', toolCallId: 'tc-1', optionId: null, sessionId: 's1' }]);
  });

  it('DROPS a request for YOLO, and the desk being FULL does not help it', async () => {
    const { d, phone } = await browserPage();
    await d.fromPhone(phone, { type: 'remote/set-mode-request', v: 1, sessionId: 's1', mode: 'yolo' });
    await flush(60);
    expect((await d.drain(phone)).map((f) => f['type'])).not.toContain('remote/mode-challenge');
    expect(d.statuses.at(-1)).toBe(ENVELOPE_REFUSED + 'watch — refused remote/set-mode-request');
  });

  it('an ENROLLED, VERIFIED phone gets the desk envelope back — the clamp is not a floor', async () => {
    const d = desk({ capability: 'full' });
    const host = collect(d);
    const key = await makeDeviceKey();
    const { rid, phone } = await d.pair();
    const challenge = d.challengeOf(await d.drain(phone));
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: 'iPhone', deviceKey: key.block });
    // Before it proves the key: blocked, as it has been since 0.4.102.
    await d.fromPhone(phone, { type: 'send', text: 'too early', sessionId: 's1' });
    expect(host).toEqual([]);
    await d.fromPhone(phone, {
      type: 'remote/challenge-response', v: 1, sig: await key.sign(challenge, rid), pub: key.pub,
    });
    await waitFor(() => d.attach.mock.calls.length > 0, 'the verified phone to hydrate');
    await d.fromPhone(phone, { type: 'send', text: 'fix the build', sessionId: 's1' });
    expect(host).toEqual([{ type: 'send', text: 'fix the build', sessionId: 's1' }]);
  });

  it('a desk set to WATCH still refuses a send from a verified phone', async () => {
    const d = desk({ capability: 'watch' });
    const host = collect(d);
    const key = await makeDeviceKey();
    const { rid, phone } = await d.pair();
    const challenge = d.challengeOf(await d.drain(phone));
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: 'iPhone', deviceKey: key.block });
    await d.fromPhone(phone, {
      type: 'remote/challenge-response', v: 1, sig: await key.sign(challenge, rid), pub: key.pub,
    });
    await waitFor(() => d.attach.mock.calls.length > 0, 'the verified phone to hydrate');
    await d.fromPhone(phone, { type: 'send', text: 'nope', sessionId: 's1' });
    await flush(60);
    expect(host).toEqual([]);
    expect(d.statuses.at(-1)).toBe(ENVELOPE_REFUSED + 'watch — refused send');
  });
});

describe('device identity — the seq trap', () => {
  // SEEN LIVE. An impersonator that holds a copy of the QR connects FIRST and
  // its frame advances the desktop's inbound mark, so the real phone's seq-1
  // hello is then rejected as a replay and it can never enrol. The mark cannot
  // be rewound without re-opening the replay hole, so the only clean recovery is
  // a new pairing — and the pane has to SAY so, or the owner sees a phone that
  // scanned a valid code and did nothing.
  it('says "make a new QR" when a hello is refused as a replay on an unconfirmed pairing', async () => {
    const d = desk();
    const { rid, ks, phone } = await d.pair();
    const key = await deriveKey(ks);
    // Two clients, same Ks, each counting from seq 1 — which is exactly what a
    // leaked QR gives an attacker.
    const impersonator = new FakePhone(new FrameCodec(key, rid, ROLE_PHONE));
    await d.fromPhone(impersonator, { type: 'remote/snapshot' });
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: "Sam's iPhone" });

    expect(d.statuses).toContain(PAIRING_WEDGED);
    // The pairing is still unconfirmed, so no device was enrolled off a frame
    // the desktop threw away.
    expect(d.controller.confirmedAt).toBeNull();
    expect(d.controller.device).toBeNull();
  });

  it('still says "needs re-pairing" when the pairing IS confirmed — a phone that lost its marks', async () => {
    const d = desk();
    const { rid, ks, phone } = await d.pair();
    await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: "Sam's iPhone" });
    await waitFor(() => d.controller.confirmedAt !== null, 'the pairing to be confirmed');
    // The page reloads and its localStorage seq marks are gone: it starts at 1.
    const reloaded = new FakePhone(new FrameCodec(await deriveKey(ks), rid, ROLE_PHONE));
    await d.fromPhone(reloaded, { type: 'remote/hello', v: 1, device: "Sam's iPhone" });
    expect(d.statuses).not.toContain(PAIRING_WEDGED);
    expect(d.statuses.some((t) => t.includes('needs re-pairing'))).toBe(true);
  });
});

describe('inboundApproval — the second belt under the envelope clamp', () => {
  function deps(device: unknown): { d: InboundDeps; host: unknown[]; said: string[] } {
    const host: unknown[] = [];
    const said: string[] = [];
    const d = {
      auth: { device },
      privilege: { approve: () => Promise.resolve(false) },
      deliver: (m: unknown) => host.push(m),
      status: (t: string) => said.push(t),
    } as unknown as InboundDeps;
    return { d, host, said };
  }

  it('drops an APPROVE when nothing is enrolled, and names why', async () => {
    const { d, host, said } = deps(null);
    await permissionAnswer({ type: 'permission', toolCallId: 'tc-1', optionId: 'allow_once' }, d);
    expect(host).toEqual([]);
    expect(said).toEqual([KEYLESS_APPROVAL]);
  });

  it('honours a DENY when nothing is enrolled', async () => {
    const { d, host, said } = deps(null);
    await permissionAnswer({ type: 'permission', toolCallId: 'tc-1', optionId: null }, d);
    expect(host).toEqual([{ type: 'permission', toolCallId: 'tc-1', optionId: null }]);
    expect(said).toEqual([]);
  });

  it('with a device enrolled it asks the SIGNATURE, not the enrolment', async () => {
    const { d, host, said } = deps({ pub: 'p', fp: 'f' });
    await permissionAnswer({ type: 'permission', toolCallId: 'tc-1', optionId: 'allow_once' }, d);
    // privilege.approve() said no, so nothing was delivered — and the sentence
    // is privilege.ts's, not this file's.
    expect(host).toEqual([]);
    expect(said).toEqual([]);
  });
});
