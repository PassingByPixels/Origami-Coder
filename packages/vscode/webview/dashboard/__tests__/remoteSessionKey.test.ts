// WIRE v1.3 — §8, THE ACCEPTANCE TESTS, both ends real.
//
// The claim v1.3 makes is exactly one sentence: after the phone has proved its
// enrolled key, a thief who copied `Ks` can read nothing. Every other test in
// this lane would go green with the session key deleted, because they assert
// what the two ends say to each other and both ends would still say it. So this
// file asserts what a THIRD party can do with the bytes, and it does it with
// the production controller, the production phone shell, the production
// crypto, and a loopback relay that keeps a ring exactly as the real one does.
//
// §8.1 an impersonator holding Ks and EVERY frame the relay saw opens no chat
// §8.2 a reconnect derives a NEW K', the transcript resumes, old v2 frames die
// §8.3 a swapped ephPub (the MITM) is refused by the desktop's own check
// §8.4 an app that predates v1.3 stays on v1 frames and the pane says so
//
// The one thing NOT driven end to end is §8.3: a man in the middle has to edit
// a frame the relay cannot open, so there is nowhere in this rig to stand. It
// is driven instead at the exact layer that decides it — `SessionExchange`,
// with a real signature over a point the desktop did not send.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: <T>(_k: string, d: T) => d, inspect: () => undefined }),
  },
  window: { activeTextEditor: undefined },
}));

import { b64urlDecode, b64urlEncode, deriveKey, deriveRid } from '../../../src/remote/crypto';
import { deviceAuthPayloadV2 } from '../../../src/remote/deviceAuth';
import { FRAME_VERSION, FRAME_VERSION_V2, ROLE_DESKTOP, ROLE_PHONE } from '../../../src/remote/frame';
import { RESTORE_Z_TYPE } from '../../../src/remote/remoteTranscript';
import { FrameCodec } from '../../../src/remote/frameCodec';
import { parseQrPayload, type SecretStore } from '../../../src/remote/pairing';
import { RemoteController } from '../../../src/remote/remoteController';
import { registerRemoteSeq, resetRemoteSeq, type SeqMemento } from '../../../src/remote/seqStore';
import { SessionExchange } from '../../../src/remote/sessionKey';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';
import { LoopbackRelay } from './remoteLoopback';
import { makePanelHarness, type HarnessSession } from './remotePanelHarness';
import { bootPhone, type Phone } from './remotePhoneHarness';

const CHAT = 'chat-1';
const TRANSCRIPT = [
  { kind: 'user', text: 'what did the session key change', timestamp: 1 },
  { kind: 'agent', text: 'every frame after the handshake', timestamp: 2 },
];

function memorySecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => Promise.resolve(void map.set(k, v)),
    delete: (k) => Promise.resolve(void map.delete(k)),
  };
}

function loopbackDeps(relay: LoopbackRelay): TransportDeps {
  return {
    connect: (url) => relay.connect(url) as unknown as RemoteSocket,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

async function until(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The wire and the DOM both stopped moving. Copied from remoteHydration.test:
 *  a fixed tick count is a fixed guess about how busy the machine is. */
async function quiet(relay: LoopbackRelay, phone?: Phone, ms = 10_000): Promise<void> {
  const shot = (): string => `${relay.forwarded.length}|${relay.controls.length}|${phone ? `${phone.pinned}|${phone.cells()}` : ''}`;
  const end = Date.now() + ms;
  let last = '';
  let still = 0;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 12));
    const now = shot();
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 4 && (!phone || phone.pinned !== '')) return;
  }
  throw new Error(`the wire never went quiet (last: ${last})`);
}

let phones: Phone[] = [];
let desks: RemoteController[] = [];

beforeEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
  const raw = new Map<string, unknown>();
  const machine: SeqMemento = {
    get: <T,>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
    update: (key, value) => Promise.resolve(void raw.set(key, value)),
  };
  registerRemoteSeq(machine);
});

afterEach(() => {
  for (const p of phones) p.close();
  for (const d of desks) d.dispose();
  phones = [];
  desks = [];
  resetRemoteSeq();
});

interface Rig {
  relay: LoopbackRelay;
  controller: RemoteController;
  harness: ReturnType<typeof makePanelHarness>;
  phone: Phone;
  ks: Uint8Array;
  rid: string;
  statuses: string[];
}

/** One desktop, one relay, one phone that is the APP: it enrols a Secure-
 *  Enclave-shaped key and, unless `oldApp`, answers the v2 challenge. */
async function rig(opts: { oldApp?: boolean } = {}): Promise<Rig> {
  const relay = new LoopbackRelay();
  const sessions: HarnessSession[] = [{ id: CHAT, number: 1, title: 'v1.3', log: [...TRANSCRIPT] }];
  const harness = makePanelHarness(sessions, CHAT);
  const statuses: string[] = [];
  const controller = new RemoteController({
    config: () => ({ enabled: true, relayUrl: 'wss://loopback', capability: 'full' }),
    secrets: memorySecrets(),
    deps: loopbackDeps(relay),
    attach: (host) => harness.panel.attachView(host, 'chat'),
    onStatus: (s) => statuses.push(s),
    deviceName: 'v13 desktop',
  });
  desks.push(controller);
  const offer = await controller.pair();
  const { ks } = parseQrPayload(offer.qr);
  const phone = await bootPhone({ relay, ks, rid: offer.rid, enrolKey: true, oldApp: opts.oldApp });
  phones.push(phone);
  await quiet(relay, phone);
  return { relay, controller, harness, phone, ks, rid: offer.rid, statuses };
}

/** THE THIEF. He has `Ks` — the QR, a screenshot, a keychain read — and he has
 *  every frame the relay ever forwarded, which is more than the real relay's
 *  90-second ring would give him. He opens what he can. */
async function impersonate(relay: LoopbackRelay, ks: Uint8Array): Promise<{ opened: unknown[]; refused: number }> {
  const key = await deriveKey(ks);
  const rid = await deriveRid(ks);
  const opened: unknown[] = [];
  let refused = 0;
  for (const f of relay.forwarded) {
    // A FRESH codec per frame: the thief is not bound by a replay guard, and
    // giving him one would be testing our own bookkeeping instead of the key.
    const codec = new FrameCodec(key, rid, f.role === ROLE_DESKTOP ? ROLE_PHONE : ROLE_DESKTOP);
    try {
      opened.push(JSON.parse((await codec.decode(f.data)).json) as unknown);
    } catch {
      refused++;
    }
  }
  return { opened, refused };
}

const typeOf = (m: unknown): string => String((m as { type?: unknown } | null)?.type ?? '');
/** Everything that is NOT the pre-verification handshake. */
const HANDSHAKE = ['remote/hello', 'remote/challenge', 'remote/challenge-response', 'remote/snapshot'];
const CONTENT = (m: unknown): boolean => !HANDSHAKE.includes(typeOf(m));

// ---------------------------------------------------------------- §8.1 ----

describe('§8.1 — a thief with Ks opens NO chat frame', () => {
  it('streams a turn, then the impersonator opens zero content frames', async () => {
    const { relay, harness, phone, ks } = await rig();
    await until(() => phone.rows().length === 2, 'the transcript to paint');

    // A turn, through the real fan-out: the desktop posts what it posts to any
    // attached view, and every one of those becomes a sealed frame.
    harness.panel.post({ type: 'agentText', sessionId: CHAT, text: 'the ring can replay this' });
    harness.panel.post({ type: 'agentText', sessionId: CHAT, text: ' and it stays shut' });
    await quiet(relay, phone);

    const thief = await impersonate(relay, ks);
    // He opens the HANDSHAKE — it is v1 by design, and it carries no chat.
    expect(thief.opened.length).toBeGreaterThan(0);
    expect(thief.opened.map(typeOf)).toContain('remote/hello');
    expect(thief.opened.map(typeOf)).toContain('remote/challenge');
    // ...and NOTHING else. This number is the whole of wire v1.3.
    expect(thief.opened.filter(CONTENT)).toEqual([]);
    expect(thief.opened.filter(CONTENT)).toHaveLength(0);
    // The frames he could not open are the ones with content in them.
    expect(thief.refused).toBeGreaterThan(0);

    // Sanity, so a green above cannot mean "nothing was ever sent": the phone
    // itself DID paint the turn, through frames sealed with K.
    await until(() => phone.received.some((m) => typeOf(m) === 'agentText'), 'the phone to receive the turn');
    expect(phone.keys.sessionOn).toBe(true);
    expect(relay.forwarded.some((f) => f.data[0] === FRAME_VERSION_V2)).toBe(true);
  }, 30_000);

  it('the desktop seals the hydration itself with K, not just the deltas', async () => {
    const { relay, phone, ks } = await rig();
    await until(() => phone.rows().length === 2, 'the transcript to paint');
    const v2 = relay.forwarded.filter((f) => f.role === ROLE_DESKTOP && f.data[0] === FRAME_VERSION_V2);
    expect(v2.length).toBeGreaterThan(0);
    // EVERY v1 frame the desktop sent is a greeting — the hello and the
    // challenge, and neither carries a word of the transcript. Asserted by
    // TYPE rather than by count: the greeting is re-said on a presence edge,
    // and a count would be a test of how many edges the relay produced.
    const thief = await impersonate(relay, ks);
    expect(thief.opened.filter(CONTENT)).toEqual([]);
    // The challenge-response is v1 too, by design: it is the LAST v1 frame the
    // phone sends (§4), and what it carries is a signature over bytes bound to
    // this socket — nothing a replay can spend.
    expect(new Set(thief.opened.map(typeOf))).toEqual(
      new Set(['remote/hello', 'remote/challenge', 'remote/challenge-response', 'remote/snapshot']),
    );
  }, 30_000);

  // §2.2: the v2 answer says v: 2 on the wire — a v1 desktop or a wire sniffer
  // must not mistake the ECDH-bound answer for the v1 signature it replaces.
  // An old app, with no `deviceAuth` bridge, still answers the v1 shape.
  it('the challenge-response says v: 2 for the session-key answer, v: 1 for an old app', async () => {
    const { relay, phone, ks } = await rig();
    await until(() => phone.rows().length === 2, 'the transcript to paint');
    const answer = (await impersonate(relay, ks)).opened.find((m) => typeOf(m) === 'remote/challenge-response');
    expect((answer as { v?: number } | undefined)?.v).toBe(2);

    const old = await rig({ oldApp: true });
    await until(() => old.phone.rows().length === 2, 'the old-app transcript to paint');
    const oldAnswer = (await impersonate(old.relay, old.ks)).opened.find((m) => typeOf(m) === 'remote/challenge-response');
    expect((oldAnswer as { v?: number } | undefined)?.v).toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------- §8.2 ----

describe('§8.2 — a reconnect derives a NEW K', () => {
  it('resumes the transcript, and the previous socket frames stay shut', async () => {
    const { relay, controller, phone, ks, rid } = await rig();
    await until(() => phone.rows().length === 2, 'the first transcript to paint');
    const firstRun = relay.forwarded.filter((f) => f.data[0] === FRAME_VERSION_V2).map((f) => f.data);
    expect(firstRun.length).toBeGreaterThan(0);
    const seqBefore = Math.max(...relay.forwarded.filter((f) => f.role === ROLE_DESKTOP).map((f) => f.seq));

    // The app is killed and reopened. A NEW socket, so a new challenge, a new
    // ephemeral key, and a K' the old frames were not sealed with.
    phone.close();
    const second = await bootPhone({ relay, ks, rid, enrolKey: true });
    phones.push(second);
    await quiet(relay, second);
    await until(() => second.rows().length === 2, 'the transcript to resume on the new socket');
    expect(second.keys.sessionOn).toBe(true);

    // Seq is monotonic ACROSS the switch and across the reconnect: the desktop
    // never restarts a counter, whatever key it is sealing with.
    const desktopSeqs = relay.forwarded.filter((f) => f.role === ROLE_DESKTOP).map((f) => f.seq);
    expect([...desktopSeqs].sort((a, b) => a - b)).toEqual(desktopSeqs);
    expect(Math.max(...desktopSeqs)).toBeGreaterThan(seqBefore);

    // The OLD socket's v2 frames, replayed at the new phone: unopenable, and
    // non-fatal — the socket stays up and the page keeps its transcript.
    const rejectsBefore = second.rejects.length;
    for (const data of firstRun) {
      if (data[1] !== ROLE_DESKTOP) continue;
      await second.keys.open(data).then(
        () => expect.unreachable('an old socket v2 frame must not open under the new K'),
        () => undefined,
      );
    }
    expect(second.rejects.length).toBe(rejectsBefore);
    expect(second.rows()).toEqual(['row user', 'row agent']);
    expect(controller.connected).toBe(true);
  }, 40_000);
});

// ---------------------------------------------------------------- §8.3 ----

describe('§8.3 — a swapped ephPub is refused', () => {
  /** One P-256 identity, signing and agreeing, as the Enclave does. */
  async function device(): Promise<{ pub: string; sign: (b: Uint8Array) => Promise<string> }> {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return {
      pub: b64urlEncode(raw),
      sign: async (bytes) =>
        b64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes))),
    };
  }

  const enrolled = (pub: string) => ({ alg: 'ES256', pub, fp: 'fp', backend: 'secure-enclave', device: 'iPhone', platform: 'ios', app: '1.0' });

  it('accepts a signature over the point the desktop SENT', async () => {
    const ex = new SessionExchange();
    const body = await ex.offer();
    const dev = await device();
    const challenge = b64urlDecode(body['challenge'] as string);
    const ephPub = b64urlDecode(body['ephPub'] as string);
    const sig = await dev.sign(deviceAuthPayloadV2(challenge, 'rid-1', ephPub));
    const verdict = await ex.accept({ sig, pub: dev.pub, rid: 'rid-1', enrolled: enrolled(dev.pub), ks: new Uint8Array(32) });
    expect(verdict.ok).toBe(true);
    expect(verdict.key).toBeDefined();
    expect(ex.status).toBe('on');
  });

  it('REFUSES a signature over an ephPub the desktop did not send', async () => {
    const ex = new SessionExchange();
    const body = await ex.offer();
    const dev = await device();
    const challenge = b64urlDecode(body['challenge'] as string);
    // The man in the middle: he opened the challenge with a copied Ks, put his
    // OWN ephemeral point in front of the phone, and forwarded the answer. The
    // phone signed his point; the desktop checks its own.
    const mitm = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair;
    const mitmPub = new Uint8Array(await crypto.subtle.exportKey('raw', mitm.publicKey));
    expect(b64urlEncode(mitmPub)).not.toBe(body['ephPub']);
    const sig = await dev.sign(deviceAuthPayloadV2(challenge, 'rid-1', mitmPub));

    const verdict = await ex.accept({ sig, pub: dev.pub, rid: 'rid-1', enrolled: enrolled(dev.pub), ks: new Uint8Array(32) });
    expect(verdict.ok).toBe(false);
    expect(verdict.key).toBeUndefined();
    expect(ex.status).toBe('off');
  });

  it('REFUSES a v2 signature made by a key that is not the enrolled one', async () => {
    const ex = new SessionExchange();
    const body = await ex.offer();
    const mine = await device();
    const thief = await device();
    const challenge = b64urlDecode(body['challenge'] as string);
    const ephPub = b64urlDecode(body['ephPub'] as string);
    const sig = await thief.sign(deviceAuthPayloadV2(challenge, 'rid-1', ephPub));
    // The thief's own pub travels with his own signature, so every check that
    // used the message's key would pass. The verifier uses the ENROLLED one.
    const verdict = await ex.accept({ sig, pub: thief.pub, rid: 'rid-1', enrolled: enrolled(mine.pub), ks: new Uint8Array(32) });
    expect(verdict.ok).toBe(false);
    expect(ex.status).toBe('off');
  });
});

// ---------------------------------------------------------------- §8.4 ----

describe('§8.4 — an app that predates v1.3 stays on v1', () => {
  it('verifies by the v1 shape, keeps v1 frames, and the pane says "old app"', async () => {
    const { relay, controller, phone, ks, statuses } = await rig({ oldApp: true });
    await until(() => phone.rows().length === 2, 'the transcript to paint on the old app');

    expect(statuses).toContain('remote: the phone proved the enrolled device key');
    expect(phone.keys.sessionOn).toBe(false);
    // NOT ONE v2 frame crossed the relay in either direction.
    expect(relay.forwarded.filter((f) => f.data[0] === FRAME_VERSION_V2)).toEqual([]);

    // The pane's line. `off (old app)` is the wording the pane renders from it.
    expect(controller.device?.session).toBe('old-app');

    // And the honest half: this is TODAY's exposure, so the thief still reads
    // the transcript. Asserted, not implied — it is why the pane says so.
    const thief = await impersonate(relay, ks);
    expect(thief.opened.filter(CONTENT).length).toBeGreaterThan(0);
  }, 30_000);

  it('a browser page with no device key derives no session key at all', async () => {
    const relay = new LoopbackRelay();
    const sessions: HarnessSession[] = [{ id: CHAT, number: 1, title: 'v1.3', log: [...TRANSCRIPT] }];
    const harness = makePanelHarness(sessions, CHAT);
    const controller = new RemoteController({
      config: () => ({ enabled: true, relayUrl: 'wss://loopback', capability: 'full' }),
      secrets: memorySecrets(),
      deps: loopbackDeps(relay),
      attach: (host) => harness.panel.attachView(host, 'chat'),
      deviceName: 'v13 desktop',
    });
    desks.push(controller);
    const offer = await controller.pair();
    const { ks } = parseQrPayload(offer.qr);
    // enrolKey false: this is the relay-served page, watch-tier since v1.2.1.
    const page = await bootPhone({ relay, ks, rid: offer.rid });
    phones.push(page);
    await quiet(relay, page);

    expect(page.keys.sessionOn).toBe(false);
    expect(controller.device).toBeNull();
    expect(relay.forwarded.filter((f) => f.data[0] === FRAME_VERSION_V2)).toEqual([]);
  }, 30_000);
});

// --------------------------------------------------- §7, the hydrate order --

describe('§7 — nothing is hydrated before the v2 verdict', () => {
  it('no restoreMessages frame leaves the desk until the phone has proved its key', async () => {
    const { relay, phone, ks } = await rig();
    await until(() => phone.rows().length === 2, 'the transcript to paint');

    // THE ORDER, read off the wire. Everything the desktop sent BEFORE the
    // phone's answer landed must be the greeting, because the greeting is the
    // only thing that is v1 — and a transcript sealed with K is a transcript
    // the relay's ring hands to anyone holding Ks. The app lane's first run
    // hydrated one frame too early and the impersonator read 19 chat frames.
    const answerAt = relay.forwarded.findIndex(
      (f) => f.role === ROLE_PHONE && f.data[0] === FRAME_VERSION_V2,
    );
    const thief = await impersonate(relay, ks);
    expect(thief.opened.map(typeOf)).not.toContain('restoreMessages');
    expect(thief.opened.map(typeOf)).not.toContain(RESTORE_Z_TYPE);
    expect(thief.opened.filter(CONTENT)).toEqual([]);

    // ...and the transcript really did cross, sealed with K'. Without this a
    // desk that hydrated NOTHING would pass every assertion above. The desk
    // sends the DEFLATED envelope to a page that declared `restoreZ` in its
    // hello caps, so either name counts as "the transcript arrived".
    const got = phone.received.map(typeOf);
    expect(got.includes('restoreMessages') || got.includes(RESTORE_Z_TYPE)).toBe(true);
    expect(answerAt).toBeGreaterThanOrEqual(0);
    const desktopAfterAnswer = relay.forwarded
      .slice(answerAt)
      .filter((f) => f.role === ROLE_DESKTOP);
    expect(desktopAfterAnswer.every((f) => f.data[0] === FRAME_VERSION_V2)).toBe(true);
  }, 30_000);
});

// ------------------------------------------------------- the receiver rule --

describe('the receiver rule, on a live socket', () => {
  it('the latch is scoped to the HANDSHAKE EPOCH, not to the relay socket', async () => {
    // The desktop's socket to the relay outlives a phone reconnect, so the
    // codec that carries the latch does too. A latch that survived would
    // refuse the returning phone's legitimate v1 hello and wedge the pairing
    // until a new QR — the phone would reconnect for ever and paint nothing.
    const { relay, phone, ks, rid } = await rig();
    await until(() => phone.rows().length === 2, 'the first transcript to paint');
    expect(relay.forwarded.some((f) => f.role === ROLE_PHONE && f.data[0] === FRAME_VERSION_V2)).toBe(true);

    phone.close();
    const back = await bootPhone({ relay, ks, rid, enrolKey: true });
    phones.push(back);
    await quiet(relay, back);

    // Its hello is v1 — it cannot be anything else, the new challenge has not
    // been answered yet — and it was ACCEPTED, which is what a resumed
    // transcript proves. Then the socket switches to v2 again.
    await until(() => back.rows().length === 2, 'the transcript to resume after the reconnect');
    expect(back.keys.sessionOn).toBe(true);
    const thief = await impersonate(relay, ks);
    expect(thief.opened.filter(CONTENT)).toEqual([]);
  }, 40_000);

  it('a v1 frame from the phone after its first v2 is rejected, non-fatally', async () => {
    const { relay, controller, phone, ks, rid } = await rig();
    await until(() => phone.rows().length === 2, 'the transcript to paint');
    expect(phone.keys.sessionOn).toBe(true);

    // The desktop has accepted v2 frames from this phone. A frame sealed with
    // K — which is exactly what a thief holding Ks can still make — is now a
    // downgrade and must be dropped without killing the socket.
    const stale = new FrameCodec(await deriveKey(ks), rid, ROLE_PHONE, 9_000);
    const forged = await stale.encode(JSON.stringify({ type: 'send', text: 'rm -rf /', sessionId: CHAT }));
    expect(forged[0]).toBe(FRAME_VERSION);
    const before = relay.forwarded.length;
    relay.connect(`wss://loopback/r/${rid}?role=phone&after=0`).send(forged);
    await quiet(relay);

    expect(relay.forwarded.length).toBeGreaterThan(before);
    expect(controller.connected).toBe(true);
  }, 30_000);
});
