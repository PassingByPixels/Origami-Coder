// Origami Remote — SIGNED AUTHORITY (spec v1.2), driven through the real
// controller with real signatures.
//
// Nothing here fakes the crypto. Every signature is made in the test with
// WebCrypto's own ECDSA P-256 over bytes this file builds by hand from the
// spec's own words — not by calling the production payload builders — so a
// desktop that assembled the payload differently would fail HERE rather than
// against a phone. The byte layout is cross-checked against the iOS harness's
// reference verifier (`harness/lib/challenge.mjs`): domain as utf8, then the
// RAW nonce bytes, then each remaining field as utf8, and `sig` is base64url of
// the 64-byte raw r||s that WebCrypto produces and verifies with no repacking.
//
// The frame layer, the pairing manager, the dispatch table and the privilege
// state are all the production ones; only the socket is a fake.
import { describe, expect, it, vi } from 'vitest';
import { b64urlDecode, b64urlEncode, deriveKey } from '../../../src/remote/crypto';
import { ChunkAssembler, isChunkMessage, type ChunkMessage } from '../../../src/remote/chunk';
import { ROLE_PHONE } from '../../../src/remote/frame';
import { FrameCodec } from '../../../src/remote/frameCodec';
import { deviceAuthPayload } from '../../../src/remote/deviceAuth';
import { ModeReport } from '../../../src/remote/modeReport';
import { APPROVAL_REFUSED, MODE_REFUSED, NO_CHALLENGE, NO_NONCE } from '../../../src/remote/privilege';
import { PEER_REPLACED } from '../../../src/remote/presence';
import { parseQrPayload, type SecretStore } from '../../../src/remote/pairing';
import { RemoteController, type RemoteConfig } from '../../../src/remote/remoteController';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';

const TEXT = new TextEncoder();

/** The spec's byte layout, rebuilt here from its words rather than imported. */
function payload(domain: string, nonceB64: string, fields: string[]): Uint8Array {
  const parts = [TEXT.encode(domain), b64urlDecode(nonceB64), ...fields.map((f) => TEXT.encode(f))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

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

/** A Secure-Enclave-shaped identity: a real P-256 keypair. */
async function makeDeviceKey(): Promise<{
  pub: string;
  fp: string;
  block: Record<string, string>;
  sign(bytes: Uint8Array): Promise<string>;
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
    async sign(bytes) {
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes);
      return b64urlEncode(new Uint8Array(sig));
    },
  };
}

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

type Key = Awaited<ReturnType<typeof makeDeviceKey>>;

interface Desk {
  controller: RemoteController;
  r: Rig;
  secrets: ReturnType<typeof fakeSecrets>;
  attach: ReturnType<typeof vi.fn>;
  statuses: string[];
  /** What the HOST received from the phone, in order. */
  host: unknown[];
  socket: () => FakeSocket;
  pair(): Promise<{ rid: string; phone: FakePhone }>;
  drain(phone: FakePhone): Promise<Array<Record<string, unknown>>>;
  fromPhone(phone: FakePhone, msg: unknown): Promise<void>;
  /** Push a host->phone message down the same path a broadcast takes. */
  toPhone(msg: unknown): void;
}

function desk(config: Partial<RemoteConfig> = {}): Desk {
  const r = rig();
  const secrets = fakeSecrets();
  const host: unknown[] = [];
  // ONE subscription per view, like `viewWiring.rewireView`: the real
  // attachView tears the previous wiring down first, and a fake that stacked
  // them would double every inbound message and hide a real defect in the noise.
  let wiring: { dispose(): void } | null = null;
  const attach = vi.fn((h: { webview: { onDidReceiveMessage(l: (m: unknown) => void): { dispose(): void } } }) => {
    wiring?.dispose();
    wiring = h.webview.onDidReceiveMessage((m: unknown) => host.push(m));
  });
  const statuses: string[] = [];
  const controller = new RemoteController({
    config: () => ({
      enabled: true,
      relayUrl: 'wss://relay.example',
      capability: 'full',
      ...config,
    }),
    secrets,
    deps: r.deps,
    attach: attach as never,
    onStatus: (s) => statuses.push(s),
    deviceName: 'test-desk',
  });
  const drained = new WeakMap<FakeSocket, number>();
  const socket = (): FakeSocket => r.sockets[r.sockets.length - 1]!;
  return {
    controller,
    r,
    secrets,
    attach,
    statuses,
    host,
    socket,
    async pair() {
      const offer = await controller.pair('4821');
      const { rid, ks } = parseQrPayload(offer.qr);
      socket().onopen?.();
      await waitFor(() => socket().sent.length >= 2, 'the desktop hello and challenge');
      return { rid, phone: new FakePhone(new FrameCodec(await deriveKey(ks), rid, ROLE_PHONE)) };
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
    toPhone(msg) {
      // The RemoteView's webview IS what DashboardPanel posts into, and the
      // controller's outbound path is what stamps the nonce — so a broadcast is
      // simulated by posting through the attached view, exactly as the panel's
      // own fan-out does.
      const h = attach.mock.calls[0]?.[0] as { webview: { postMessage(m: unknown): unknown } } | undefined;
      h?.webview.postMessage(msg);
    },
  };
}

/** Pair, enrol a real key, and verify — the state every test below starts in. */
async function verified(config: Partial<RemoteConfig> = {}) {
  const d = desk(config);
  const key = await makeDeviceKey();
  const { rid, phone } = await d.pair();
  const frames = await d.drain(phone);
  const challenge = frames.find((f) => f['type'] === 'remote/challenge')!['challenge'] as string;
  await d.fromPhone(phone, { type: 'remote/hello', v: 1, device: "Sam's iPhone", deviceKey: key.block });
  await d.fromPhone(phone, {
    type: 'remote/challenge-response',
    v: 1,
    sig: await key.sign(deviceAuthPayload(b64urlDecode(challenge), rid)),
    pub: key.pub,
    fp: key.fp,
  });
  await waitFor(() => d.attach.mock.calls.length > 0, 'the verified phone to hydrate');
  return { d, key, rid, phone };
}

/** Send a `requestPermission` down to the phone and read back its nonce. */
async function ask(d: Desk, phone: FakePhone, toolCallId: string, extra: Record<string, unknown> = {}): Promise<string> {
  d.toPhone({ type: 'requestPermission', toolCallId, kind: 'execute', command: 'rm -rf /', sessionId: 's1', ...extra });
  await flush();
  const frames = await d.drain(phone);
  const sent = frames.find((f) => f['type'] === 'requestPermission' && f['toolCallId'] === toolCallId);
  expect(sent, 'the desktop sent no requestPermission').toBeTruthy();
  return sent!['approvalNonce'] as string;
}

async function approve(key: Key, nonce: string, toolCallId: string, optionId: string) {
  return {
    type: 'permission',
    toolCallId,
    optionId,
    sig: await key.sign(payload('origami-remote/v1/approve', nonce, [toolCallId, optionId])),
    pub: key.pub,
    fp: key.fp,
  };
}

/** The full YOLO round trip; returns the mode-challenge nonce the desk minted. */
async function modeChallenge(d: Desk, phone: FakePhone, sessionId: string): Promise<string> {
  await d.fromPhone(phone, { type: 'remote/set-mode-request', v: 1, mode: 'yolo', sessionId });
  const frames = await d.drain(phone);
  const c = frames.find((f) => f['type'] === 'remote/mode-challenge');
  expect(c, 'the desktop sent no remote/mode-challenge').toBeTruthy();
  expect(c!['sessionId']).toBe(sessionId);
  return c!['nonce'] as string;
}

async function setMode(key: Key, nonce: string, sessionId: string, mode = 'yolo') {
  return {
    type: 'remote/set-mode',
    v: 1,
    mode,
    sessionId,
    sig: await key.sign(payload('origami-remote/v1/set-mode', nonce, [sessionId, mode])),
    pub: key.pub,
    fp: key.fp,
  };
}

function approveModes(host: unknown[]): Array<Record<string, unknown>> {
  return host.filter((m) => (m as { type?: string }).type === 'setApproveMode') as Array<Record<string, unknown>>;
}

describe('Ask mode — an approval is a signature over the desk\'s own nonce', () => {
  it('every requestPermission carries a fresh approvalNonce of at least 16 bytes', async () => {
    const { d, phone } = await verified();
    const first = await ask(d, phone, 't1');
    const second = await ask(d, phone, 't2');
    expect(b64urlDecode(first).length).toBeGreaterThanOrEqual(16);
    expect(first).not.toBe(second);
    // ...and the SAME ask re-sent keeps its nonce, or a hydration would make
    // the copy already on the phone's screen unanswerable.
    expect(await ask(d, phone, 't1')).toBe(first);
  });

  it('a correctly signed approval reaches the host', async () => {
    const { d, key, phone } = await verified();
    const nonce = await ask(d, phone, 't1');
    await d.fromPhone(phone, await approve(key, nonce, 't1', 'allow_once'));
    expect(d.host.filter((m) => (m as { type?: string }).type === 'permission')).toEqual([
      expect.objectContaining({ type: 'permission', toolCallId: 't1', optionId: 'allow_once' }),
    ]);
  });

  it('an UNSIGNED approval is dropped and the pane says why', async () => {
    const { d, phone } = await verified();
    await ask(d, phone, 't1');
    await d.fromPhone(phone, { type: 'permission', toolCallId: 't1', optionId: 'allow_once' });
    expect(d.host.filter((m) => (m as { type?: string }).type === 'permission')).toEqual([]);
    expect(d.statuses.at(-1)).toBe(APPROVAL_REFUSED + 'the message carries no signature');
  });

  it('a WRONG signature is dropped — one flipped byte over the right bytes', async () => {
    const { d, key, phone } = await verified();
    const nonce = await ask(d, phone, 't1');
    const good = await approve(key, nonce, 't1', 'allow_once');
    const bytes = b64urlDecode(good.sig);
    bytes[0] = bytes[0]! ^ 0xff;
    await d.fromPhone(phone, { ...good, sig: b64urlEncode(bytes) });
    expect(d.host.filter((m) => (m as { type?: string }).type === 'permission')).toEqual([]);
    expect(d.statuses.at(-1)).toBe(APPROVAL_REFUSED + 'the signature did not verify');
  });

  it('a signature by ANOTHER key is refused even when the message carries that key', async () => {
    // The whole reason the verifier checks against the ENROLLED pub and not the
    // one in the envelope: otherwise an attacker signs his own bytes with his
    // own key and every check passes.
    const { d, phone } = await verified();
    const thief = await makeDeviceKey();
    const nonce = await ask(d, phone, 't1');
    await d.fromPhone(phone, await approve(thief, nonce, 't1', 'allow_once'));
    expect(d.host.filter((m) => (m as { type?: string }).type === 'permission')).toEqual([]);
    expect(d.statuses.at(-1)).toBe(APPROVAL_REFUSED + 'a key that is not the enrolled device');
  });

  it('a nonce is SINGLE USE: the same signed approval replayed is dropped', async () => {
    const { d, key, phone } = await verified();
    const nonce = await ask(d, phone, 't1');
    const signed = await approve(key, nonce, 't1', 'allow_once');
    await d.fromPhone(phone, signed);
    expect(d.host.filter((m) => (m as { type?: string }).type === 'permission')).toHaveLength(1);
    await d.fromPhone(phone, signed);
    expect(d.host.filter((m) => (m as { type?: string }).type === 'permission')).toHaveLength(1);
    expect(d.statuses.at(-1)).toBe(APPROVAL_REFUSED + NO_NONCE);
  });

  it('a signature bound to ANOTHER ask does not answer this one', async () => {
    const { d, key, phone } = await verified();
    const n1 = await ask(d, phone, 't1');
    await ask(d, phone, 't2');
    // Signed over t1's nonce and t1's id, sent as an answer to t2.
    const wrong = await approve(key, n1, 't1', 'allow_once');
    await d.fromPhone(phone, { ...wrong, toolCallId: 't2' });
    expect(d.host.filter((m) => (m as { type?: string }).type === 'permission')).toEqual([]);
    expect(d.statuses.at(-1)).toBe(APPROVAL_REFUSED + 'the signature did not verify');
  });

  it('a DENY needs no signature and is always honoured', async () => {
    const { d, phone } = await verified();
    await ask(d, phone, 't1');
    await d.fromPhone(phone, { type: 'permission', toolCallId: 't1', optionId: null });
    expect(d.host.filter((m) => (m as { type?: string }).type === 'permission')).toEqual([
      { type: 'permission', toolCallId: 't1', optionId: null },
    ]);
  });

  // WHAT THE PIN LEFT BEHIND (2026-09-06). There is no second road to an
  // approval any more: a keyless browser page is not offered one and cannot
  // take one. It is asked, it may say no, and an APPROVE it sends is dropped.
  it('a keyless browser page is asked, may DENY, and cannot approve', async () => {
    const b = desk();
    const { phone: page } = await b.pair();
    await b.fromPhone(page, { type: 'remote/hello', v: 1, device: 'Chrome' });
    await waitFor(() => b.attach.mock.calls.length > 0, 'the browser page to hydrate');
    b.toPhone({ type: 'requestPermission', toolCallId: 't9', kind: 'execute', command: 'ls', sessionId: 's1' });
    await flush();
    // The ask reaches it — the page can SEE what is being asked.
    expect((await b.drain(page)).map((f) => f['type'])).toContain('requestPermission');

    await b.fromPhone(page, { type: 'permission', toolCallId: 't9', optionId: 'allow_once' });
    expect(b.host.filter((m) => (m as { type?: string }).type === 'permission')).toHaveLength(0);
    // NOTHING comes back. The desktop used to answer a keyless approve with a
    // demand for the pairing PIN; there is no second road now, so silence on the
    // wire is the assertion.
    expect(await b.drain(page)).toEqual([]);

    await b.fromPhone(page, { type: 'permission', toolCallId: 't9', optionId: null });
    expect(b.host.filter((m) => (m as { type?: string }).type === 'permission')).toEqual([
      { type: 'permission', toolCallId: 't9', optionId: null },
    ]);
  });
});

describe('YOLO — a signed set-mode drives the REAL permission ruleset', () => {
  it('request -> 32-byte challenge -> signed set-mode -> the host is told bypass', async () => {
    const { d, key, phone } = await verified();
    const nonce = await modeChallenge(d, phone, 's1');
    expect(b64urlDecode(nonce)).toHaveLength(32);
    await d.fromPhone(phone, await setMode(key, nonce, 's1'));
    // The SAME message the InputBar's own Actions row posts. There is one road
    // into the engine's session permission ruleset and this is it.
    expect(approveModes(d.host)).toEqual([{ type: 'setApproveMode', mode: 'bypass', sessionId: 's1' }]);
    expect(d.controller.modes).toEqual([
      { sessionId: 's1', mode: 'yolo', device: "Sam's iPhone", fp: key.fp, at: expect.any(Number) },
    ]);
  });

  it('a set-mode with NO challenge outstanding is refused', async () => {
    const { d, key, phone } = await verified();
    await d.fromPhone(phone, await setMode(key, b64urlEncode(new Uint8Array(32)), 's1'));
    expect(approveModes(d.host)).toEqual([]);
    expect(d.statuses.at(-1)).toBe(MODE_REFUSED + NO_CHALLENGE);
  });

  it('a challenge is SINGLE USE: the same signed set-mode replayed is refused', async () => {
    const { d, key, phone } = await verified();
    const nonce = await modeChallenge(d, phone, 's1');
    const signed = await setMode(key, nonce, 's1');
    await d.fromPhone(phone, signed);
    await d.fromPhone(phone, { type: 'remote/set-mode', v: 1, mode: 'ask', sessionId: 's1' });
    await d.fromPhone(phone, signed);
    expect(d.statuses.at(-1)).toBe(MODE_REFUSED + NO_CHALLENGE);
    expect(d.controller.modes).toEqual([]);
  });

  it('a signature for ANOTHER session does not escalate this one', async () => {
    const { d, key, phone } = await verified();
    const n1 = await modeChallenge(d, phone, 's1');
    const n2 = await modeChallenge(d, phone, 's2');
    expect(n1).not.toBe(n2);
    // Signed over s1's nonce and the name "s1", replayed at s2's challenge.
    const wrong = await setMode(key, n1, 's1');
    await d.fromPhone(phone, { ...wrong, sessionId: 's2' });
    expect(approveModes(d.host)).toEqual([]);
    expect(d.statuses.at(-1)).toBe(MODE_REFUSED + 'the signature did not verify');
    expect(d.controller.modes).toEqual([]);
  });

  it('a signature by ANOTHER key is refused', async () => {
    const { d, phone } = await verified();
    const thief = await makeDeviceKey();
    const nonce = await modeChallenge(d, phone, 's1');
    await d.fromPhone(phone, await setMode(thief, nonce, 's1'));
    expect(approveModes(d.host)).toEqual([]);
    expect(d.statuses.at(-1)).toBe(MODE_REFUSED + 'a key that is not the enrolled device');
  });

  it('reverting to Ask needs NO signature', async () => {
    const { d, key, phone } = await verified();
    const nonce = await modeChallenge(d, phone, 's1');
    await d.fromPhone(phone, await setMode(key, nonce, 's1'));
    await d.fromPhone(phone, { type: 'remote/set-mode', v: 1, mode: 'ask', sessionId: 's1' });
    expect(approveModes(d.host)).toEqual([
      { type: 'setApproveMode', mode: 'bypass', sessionId: 's1' },
      { type: 'setApproveMode', mode: 'default', sessionId: 's1' },
    ]);
    expect(d.controller.modes).toEqual([]);
  });
});

describe('YOLO ends on facts, never on a clock', () => {
  async function escalated(sessionId = 's1') {
    const v = await verified();
    const nonce = await modeChallenge(v.d, v.phone, sessionId);
    await v.d.fromPhone(v.phone, await setMode(v.key, nonce, sessionId));
    expect(v.d.controller.modes).toHaveLength(1);
    return v;
  }

  it('the SESSION ending forgets it, without writing to a session that is gone', async () => {
    const { d } = await escalated();
    d.toPhone({ type: 'sessionClosed', sessionId: 's1' });
    await flush();
    expect(d.controller.modes).toEqual([]);
    // No second setApproveMode: the ruleset died with the session, and writing
    // to it would be an error the owner would have to read past.
    expect(approveModes(d.host)).toEqual([{ type: 'setApproveMode', mode: 'bypass', sessionId: 's1' }]);
  });

  it('the desk telling the phone to revert (a bypass the host refused) forgets the record too', async () => {
    const { d } = await escalated();
    // approveModeFailure.ts posts this when the host could not honour the bypass.
    d.toPhone({ type: 'remote/set-mode', v: 1, mode: 'ask', sessionId: 's1', reason: 'no such chat: s1' });
    await flush();
    expect(d.controller.modes).toEqual([]);
    // No second setApproveMode either: the host already refused it.
    expect(approveModes(d.host)).toEqual([{ type: 'setApproveMode', mode: 'bypass', sessionId: 's1' }]);
  });

  it('the TRANSPORT stopping for good reverts it through the host', async () => {
    const { d } = await escalated();
    d.controller.dispose();
    expect(approveModes(d.host)).toEqual([
      { type: 'setApproveMode', mode: 'bypass', sessionId: 's1' },
      { type: 'setApproveMode', mode: 'default', sessionId: 's1' },
    ]);
    expect(d.controller.modes).toEqual([]);
  });

  it('a RECONNECT does not: the socket dropping is not the owner changing his mind', async () => {
    const { d } = await escalated();
    d.socket().onclose?.({ code: 1006 });
    d.r.timers.filter((t) => !t.cleared && t.ms < 60_000).forEach((t) => t.fn());
    await waitFor(() => d.r.sockets.length >= 2, 'the transport to reconnect');
    d.socket().onopen?.();
    await flush();
    expect(d.controller.modes).toHaveLength(1);
    expect(approveModes(d.host)).toEqual([{ type: 'setApproveMode', mode: 'bypass', sessionId: 's1' }]);
  });

  it('REVOKING the pairing reverts it', async () => {
    const { d } = await escalated();
    await d.controller.revoke('revoked from the pane');
    expect(approveModes(d.host).at(-1)).toEqual({ type: 'setApproveMode', mode: 'default', sessionId: 's1' });
    expect(d.controller.modes).toEqual([]);
  });

  it('RE-PAIRING reverts it', async () => {
    const { d } = await escalated();
    await d.controller.pair('1234');
    expect(approveModes(d.host).at(-1)).toEqual({ type: 'setApproveMode', mode: 'default', sessionId: 's1' });
    expect(d.controller.modes).toEqual([]);
  });
});

describe('the capability envelope, through the real dispatch table', () => {
  it('FULL (the default) lets a signed set-mode through', async () => {
    const { d, key, phone } = await verified({ capability: 'full' });
    const nonce = await modeChallenge(d, phone, 's1');
    await d.fromPhone(phone, await setMode(key, nonce, 's1'));
    expect(approveModes(d.host)).toHaveLength(1);
  });

  it('ASK refuses the set-mode REQUEST, so no challenge is ever minted', async () => {
    const { d, key, phone } = await verified({ capability: 'ask' });
    await d.fromPhone(phone, { type: 'remote/set-mode-request', v: 1, mode: 'yolo', sessionId: 's1' });
    expect((await d.drain(phone)).filter((f) => f['type'] === 'remote/mode-challenge')).toEqual([]);
    expect(d.statuses.at(-1)).toContain('refused remote/set-mode-request');
    // ...but an APPROVAL still works, which is what "ask" means.
    const nonce = await ask(d, phone, 't1');
    await d.fromPhone(phone, await approve(key, nonce, 't1', 'allow_once'));
    expect(d.host.filter((m) => (m as { type?: string }).type === 'permission')).toHaveLength(1);
  });

  it('WATCH refuses send and approvals, and still honours a cancel and a deny', async () => {
    const { d, key, phone } = await verified({ capability: 'watch' });
    const nonce = await ask(d, phone, 't1');
    await d.fromPhone(phone, { type: 'send', text: 'rm -rf /', sessionId: 's1' });
    await d.fromPhone(phone, await approve(key, nonce, 't1', 'allow_once'));
    expect(d.host.filter((m) => ['send', 'permission'].includes((m as { type?: string }).type ?? ''))).toEqual([]);

    await d.fromPhone(phone, { type: 'cancel', sessionId: 's1' });
    await d.fromPhone(phone, { type: 'permission', toolCallId: 't1', optionId: null });
    expect(d.host).toEqual([
      { type: 'cancel', sessionId: 's1' },
      { type: 'permission', toolCallId: 't1', optionId: null },
    ]);
  });
});

describe('R-1 through the real dispatch table', () => {
  it('setApproveMode from the phone never reaches the host', async () => {
    const { d, phone } = await verified();
    await d.fromPhone(phone, { type: 'setApproveMode', mode: 'bypass', sessionId: 's1' });
    expect(d.host).toEqual([]);
    expect(d.statuses.at(-1)).toContain('setApproveMode');
    // ...and the ONLY road to bypass still works, so the feature is gated, not
    // removed.
    expect(approveModes(d.host)).toEqual([]);
  });

  it('a verified phone can still do the things it is meant to do', async () => {
    const { d, phone } = await verified();
    await d.fromPhone(phone, { type: 'send', text: 'hello', sessionId: 's1' });
    await d.fromPhone(phone, { type: 'requestSessions' });
    expect(d.host).toEqual([
      { type: 'send', text: 'hello', sessionId: 's1' },
      { type: 'requestSessions' },
    ]);
  });
});

describe('a peer that REPLACES a verified one proves the key again', () => {
  it('discards the verdict, re-challenges with fresh bytes, and serves nothing until it answers', async () => {
    const { d, key, rid, phone } = await verified();
    const before = d.attach.mock.calls.length;
    await d.drain(phone);

    // The relay's one-socket rule: a second client attaches and evicts the
    // phone. The desktop's OWN socket never dropped, and it may never see a
    // `peer:absent` at all.
    d.socket().onmessage?.({ data: 'peer:present' });
    await flush();
    expect(d.statuses).toContain(PEER_REPLACED);

    const frames = await d.drain(phone);
    const challenge = frames.find((f) => f['type'] === 'remote/challenge');
    expect(challenge, 'the desktop must re-challenge a replacement peer').toBeTruthy();
    expect(b64urlDecode(challenge!['challenge'] as string)).toHaveLength(32);

    // Nothing is served to the new peer meanwhile.
    d.host.length = 0;
    await d.fromPhone(phone, { type: 'send', text: 'rm -rf /', sessionId: 's1' });
    expect(d.host).toEqual([]);
    expect(d.attach.mock.calls.length).toBe(before);

    // ...and it IS served once it proves the enrolled key on the new challenge.
    await d.fromPhone(phone, {
      type: 'remote/challenge-response',
      v: 1,
      sig: await key.sign(deviceAuthPayload(b64urlDecode(challenge!['challenge'] as string), rid)),
      pub: key.pub,
      fp: key.fp,
    });
    await d.fromPhone(phone, { type: 'send', text: 'hello', sessionId: 's1' });
    expect(d.host).toEqual([{ type: 'send', text: 'hello', sessionId: 's1' }]);
  });
});

// ------------------------------------------------------------- the report --

describe('the mode report — the desk saying what its OWN records hold', () => {
  it('rides the hydration, ONCE, and carries no grant', async () => {
    const { d, phone } = await verified();
    const frames = await d.drain(phone);
    // This rig's `attach` posts no burst, so the first report has nothing to
    // name — which is the point: the frame is built from what the desk SAID to
    // this phone, never from a list it invents. The real burst, and the yolo a
    // reopened app learns from it, are `remoteHydration.test.ts`.
    expect(frames.filter((f) => f['type'] === 'remote/mode-state')).toEqual([
      { type: 'remote/mode-state', v: 1, modes: {} },
    ]);
  });

  // The builder, on its own. `Privilege` feeds it every desk -> phone message
  // and its own session records; these are the four inputs that decide a row.
  describe('what a report names', () => {
    it('every chat the desk named, with the escalated ones marked', () => {
      const report = new ModeReport();
      report.note({ type: 'restoreActiveSession', sessionId: 's1' });
      report.note({ type: 'sessionCreated', sessionId: 's2' });
      report.note({ type: 'requestPermission', sessionId: 's1', toolCallId: 't1' });
      expect(report.frame(new Map([['s1', {}]]))).toEqual({
        type: 'remote/mode-state',
        v: 1,
        modes: { s1: 'yolo', s2: 'ask' },
      });
    });

    it('a REVERTED chat as ask, never by leaving it out', () => {
      const report = new ModeReport();
      report.note({ type: 'sessionCreated', sessionId: 's1' });
      // A page that had learned the yolo could not otherwise tell "reverted"
      // from "the desk has not mentioned that chat".
      expect(report.frame(new Map()).modes).toEqual({ s1: 'ask' });
    });

    it('drops a CLOSED chat — the ruleset died with the session', () => {
      const report = new ModeReport();
      report.note({ type: 'sessionCreated', sessionId: 's1' });
      report.note({ type: 'sessionCreated', sessionId: 's2' });
      report.note({ type: 'sessionClosed', sessionId: 's2' });
      expect(report.frame(new Map()).modes).toEqual({ s1: 'ask' });
    });

    it('still reports a bypass on a chat it never named, and ignores messages with no chat', () => {
      const report = new ModeReport();
      report.note({ type: 'remote/hello', v: 1 });
      report.note({ type: 'agentText', sessionId: '' });
      report.note(null);
      // An entry the strip cannot draw costs nothing; a MISSING one is a chip
      // that goes on lying until the next hydration.
      expect(report.frame(new Map([['s9', {}]])).modes).toEqual({ s9: 'yolo' });
    });
  });
});
