// Origami Remote — the controller, driven end to end against a FAKE PHONE:
// a second FrameCodec on the other side of a fake socket, opening and sealing
// with the real crypto. Everything except the relay itself is the production
// path, so these are the tests that would catch a wiring mistake no leaf test
// can see — a chunk run that never reassembles, a replayed frame acted on
// twice, a disabled feature that still opens a socket.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { b64urlEncode, deriveKey, generateKs } from '../../../src/remote/crypto';
import { ChunkAssembler, encodeMessage, isChunkMessage, type ChunkMessage } from '../../../src/remote/chunk';
import { ROLE_PHONE } from '../../../src/remote/frame';
import { FrameCodec } from '../../../src/remote/frameCodec';
import { PairingManager, SECRET_KS, parseQrPayload, type SecretStore } from '../../../src/remote/pairing';
import { RemoteController, type RemoteConfig } from '../../../src/remote/remoteController';
import { remoteAcceptsZ } from '../../../src/remote/phoneCaps';
import { DESK_NONCE } from '../../../src/remote/remoteDelta';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';

// The production path is genuinely asynchronous - WebCrypto seals and HKDF
// derivations resolve off the main task - so these tests settle
// on an OBSERVED condition rather than on a fixed sleep. `flush` burns real
// macrotasks (an `await Promise.resolve()` would not let WebCrypto land);
// `waitFor` polls until the thing being asserted has actually happened, and
// fails loudly rather than quietly asserting too early.
async function flush(ms = 25): Promise<void> {
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

/** Build the phone side straight from the QR the desktop just minted — the
 *  same route a real phone takes, and the only one left now that an
 *  unconfirmed offer cannot be read back out of SecretStorage. */
async function phoneFor(qr: string): Promise<FakePhone> {
  const { rid, ks } = parseQrPayload(qr);
  return new FakePhone(new FrameCodec(await deriveKey(ks), rid, ROLE_PHONE));
}

/** The other end of the wire: the phone's codec plus its chunk reassembly. */
class FakePhone {
  private readonly assembler = new ChunkAssembler();
  public readonly received: unknown[] = [];
  constructor(private readonly codec: FrameCodec) {}

  public async absorb(frames: Uint8Array[]): Promise<void> {
    for (const frame of frames) {
      let msg = JSON.parse((await this.codec.decode(frame)).json) as unknown;
      if (isChunkMessage(msg)) {
        const whole = this.assembler.push(msg as ChunkMessage);
        if (whole === null) continue;
        msg = JSON.parse(whole);
      }
      this.received.push(msg);
    }
  }

  public seal(msg: unknown): Promise<Uint8Array> {
    return this.codec.encode(JSON.stringify(msg));
  }
}

interface Harness {
  controller: RemoteController;
  r: Rig;
  socket: FakeSocket;
  phone: FakePhone;
  attached: number;
  attach: ReturnType<typeof vi.fn>;
  statuses: string[];
  /** Frames the desktop has sent, decoded by the phone, since the last drain. */
  drain(): Promise<unknown[]>;
  /** Push one message from the phone into the desktop; returns the sent-frame
   *  count from BEFORE it, so a caller can wait for the reply it expects. */
  fromPhone(msg: unknown): Promise<number>;
}

async function paired(config: Partial<RemoteConfig> = {}): Promise<Harness> {
  const r = rig();
  const secrets = fakeSecrets();
  // Pre-seed a stored pairing, as a previous window would have left it. It must
  // be CONFIRMED: a code that was shown and never scanned is not a pairing, and
  // since the phantom fix restore() will not bring one back.
  const seed = new PairingManager(secrets);
  await seed.begin('wss://relay.example');
  await seed.confirm();
  const active = seed.active!;

  const statuses: string[] = [];
  const attach = vi.fn();
  const controller = new RemoteController({
    config: () => ({ enabled: true, relayUrl: 'wss://relay.example', ...config }),
    secrets,
    deps: r.deps,
    attach,
    onStatus: (s) => statuses.push(s),
    deviceName: 'test-desk',
  });
  await controller.restore();
  const socket = r.sockets[0]!;
  socket.onopen?.();
  // ALL THREE opening frames: the hello, the device-key challenge and the mode
  // report (hydrate() sends both in the same burst — remoteController.ts). The
  // challenge is the slowest of the three (it mints a fresh ECDH keypair before
  // it can seal), so waiting for only 2 let it straggle in behind whichever
  // drain() a test ran next — under load, or even alone often enough to flake
  // "greets ONCE, not again on every status change" and "a transcript too big
  // for one frame arrives intact" on unrelated `remote/challenge` leftovers
  // (t-2ek0o9). Every `paired()` caller pre-seeds a CONFIRMED pairing, so this
  // burst is always exactly three frames — never fewer, never more.
  await waitFor(() => socket.sent.length >= 3, 'the desktop hello, challenge and mode-report frames');

  const phone = new FakePhone(new FrameCodec(active.key, active.rid, ROLE_PHONE));
  let drained = 0;
  const h: Harness = {
    controller,
    r,
    socket,
    phone,
    attach,
    get attached() {
      return attach.mock.calls.length;
    },
    statuses,
    async drain() {
      const fresh = socket.sent.slice(drained);
      drained = socket.sent.length;
      const before = phone.received.length;
      await phone.absorb(fresh);
      return phone.received.slice(before);
    },
    async fromPhone(msg) {
      const before = socket.sent.length;
      socket.onmessage?.({ data: await phone.seal(msg) });
      await flush();
      return before;
    },
  };
  return h;
}

describe('remote controller — DISABLED means nothing is constructed', () => {
  const hostile: TransportDeps = {
    connect: () => {
      throw new Error('a socket was opened while remote.enabled was false');
    },
    setTimer: () => {
      throw new Error('a timer was armed while remote.enabled was false');
    },
    clearTimer: () => {},
  };

  it('restore() opens no socket and arms no timer', async () => {
    const secrets = fakeSecrets();
    await new PairingManager(secrets).begin('wss://relay.example'); // a pairing IS stored
    const controller = new RemoteController({
      config: () => ({ enabled: false, relayUrl: 'wss://relay.example' }),
      secrets,
      deps: hostile,
      attach: () => {
        throw new Error('the dashboard was attached while remote.enabled was false');
      },
    });
    await expect(controller.restore()).resolves.toBeUndefined();
    expect(controller.connected).toBe(false);
    expect(controller.rid).toBeNull();
  });

  it('does not even READ the stored pairing material', async () => {
    const secrets = fakeSecrets();
    await new PairingManager(secrets).begin('wss://relay.example');
    const get = vi.fn(() => Promise.resolve(undefined));
    const controller = new RemoteController({
      config: () => ({ enabled: false, relayUrl: 'wss://r' }),
      secrets: { ...secrets, get },
      deps: hostile,
      attach: () => {},
    });
    await controller.restore();
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses to start a pairing', async () => {
    const controller = new RemoteController({
      config: () => ({ enabled: false, relayUrl: 'wss://r' }),
      secrets: fakeSecrets(),
      deps: hostile,
      attach: () => {},
    });
    await expect(controller.pair()).rejects.toThrow(/remote.enabled/);
  });

  it('restore() with the feature ON but NO pairing stored still opens no socket', async () => {
    const r = rig();
    const controller = new RemoteController({
      config: () => ({ enabled: true, relayUrl: 'wss://r' }),
      secrets: fakeSecrets(),
      deps: r.deps,
      attach: () => {},
    });
    await controller.restore();
    expect(r.sockets).toHaveLength(0);
    expect(r.timers).toHaveLength(0);
  });
});

describe('remote controller — coming up on a stored pairing', () => {
  it('connects to the paired rid, greets the phone and challenges it', async () => {
    const h = await paired();
    expect(h.socket.url).toContain(`/r/${encodeURIComponent(h.controller.rid!)}?role=desktop&after=0`);
    // The device-key challenge rides every socket open (deviceSession.ts). Its
    // 32 bytes are random, so the SHAPE is asserted and the bytes are checked
    // for length by the device-auth tests that can control them.
    const frames = await h.drain();
    const hello = frames[0];
    // The mode report (privilege.ts) rides the hydration this same open serves,
    // so the challenge is no longer positionally second. It is asserted BY NAME,
    // which is what this test was ever about — that the desk sends one at all.
    const challenge = frames.find((m) => (m as { type?: unknown }).type === 'remote/challenge');
    // `desk` names THIS extension host, so a phone can tell whether the cursors
    // it cached still mean anything (remoteDelta.ts).
    expect(hello).toEqual({ type: 'remote/hello', v: 1, device: 'test-desk', desk: DESK_NONCE });
    // v:2 since wire v1.3 — the challenge now also carries `ephPub`.
    expect(challenge).toMatchObject({ type: 'remote/challenge', v: 2 });
  });

  it('greets ONCE, not again on every status change', async () => {
    const h = await paired();
    await h.drain();
    h.socket.onopen?.();
    await flush(40);
    expect(await h.drain()).toEqual([]);
  });
});

describe('remote controller — hydration', () => {
  // A pairing a phone ALREADY confirmed is hydrated when the socket comes up,
  // without waiting to be asked: the phone's own socket never dropped, so it
  // has no way to know this window replaced the one it was talking to. That is
  // what the owner saw as a blank page after a second window took the pairing.
  it('hydrates on OPEN for a pairing a phone already confirmed', async () => {
    const h = await paired();
    expect(h.attached).toBe(1);
    expect(h.attach.mock.calls[0]![0]).toHaveProperty('webview');
  });

  // ONE PER SOCKET (hydrateGate.ts). This used to read "+1 for the hello, +3
  // for the hello and two snapshots" — every one of them a whole transcript up
  // the relay, and all four inside a few milliseconds of the same socket. The
  // hydration the OPEN already pushed is the one the phone gets; a phone that
  // was not there for it is served from the relay's ring.
  it('the phone saying hello is not hydrated a second time on the same socket', async () => {
    const h = await paired();
    const onOpen = h.attached;
    expect(onOpen).toBe(1);
    await h.fromPhone({ type: 'remote/hello', v: 1, device: 'pixel' });
    expect(h.attached).toBe(onOpen);
    expect(h.attach.mock.calls[0]![0]).toHaveProperty('webview');
  });

  it('the whole ask-burst — hello, snapshot, snapshot — costs ONE hydration', async () => {
    const h = await paired();
    await h.fromPhone({ type: 'remote/hello', v: 1, device: 'pixel' });
    await h.fromPhone({ type: 'remote/snapshot' });
    await h.fromPhone({ type: 'remote/snapshot' });
    expect(h.attached).toBe(1);
  });

  it('...but a phone that went away and came back asking IS hydrated again', async () => {
    const h = await paired();
    expect(h.attached).toBe(1);
    // The relay's presence channel: the phone's socket dropped and a new one
    // took its place. Inside the flap window the desktop does not push — but
    // the phone then ASKS, which is the one thing only a phone that lost its
    // page can say, and that is served (hydrateGate.asked).
    h.socket.onmessage?.({ data: 'peer:absent' });
    h.socket.onmessage?.({ data: 'peer:present' });
    await h.fromPhone({ type: 'remote/snapshot' });
    expect(h.attached).toBe(2);
  });

  it('...but a flap plus the page re-declaring its cursors costs NOTHING', async () => {
    const h = await paired();
    expect(h.attached).toBe(1);
    h.socket.onmessage?.({ data: 'peer:absent' });
    h.socket.onmessage?.({ data: 'peer:present' });
    // What `webview/remote/cache.ts` sends after EVERY restore. In 0.4.114 that
    // frame was a `remote/snapshot`, and a snapshot is the one sentence a phone
    // has for "I have nothing" — so a screen-off/on, an app switch or a cell
    // handover cashed in a whole hydration on the next restore.
    await h.fromPhone({ type: 'remote/cursors', desk: DESK_NONCE, since: { s1: 12 } });
    expect(h.attached).toBe(1);
    // ...and it did not leave the gate OPEN behind it either: the next thing
    // that means "hydrate me" on this socket is the returning hello, and the
    // flap window is still refusing it.
    await h.fromPhone({ type: 'remote/hello', v: 1, device: 'pixel' });
    expect(h.attached).toBe(1);
    // ...and the reload the flap window refused is still served: a real page
    // reload looks identical from here, and only its snapshot says so.
    await h.fromPhone({ type: 'remote/snapshot' });
    expect(h.attached).toBe(2);
  });

  // The SAME defect as the phone lane's (webview/remote/transport.test.ts,
  // "a fast decrypt cannot overtake a slow one"), in the other direction:
  // onFrame was invoked as `void this.onFrame(frame)` per frame, so N decodes
  // ran concurrently and the replay guard advanced in RESOLUTION order. The
  // frame that decrypted late was then rejected as a replay and the phone's
  // message was lost. Decrypt order is made explicit here rather than raced.
  // Mutation: unchain onFrame -> red, first message gone.
  it('serialises inbound frames: a fast decrypt cannot overtake a slow one', async () => {
    const h = await paired();
    await h.fromPhone({ type: 'remote/hello', v: 1, device: 'pixel' });
    const host = h.attach.mock.calls[0]![0] as {
      webview: { onDidReceiveMessage(l: (m: unknown) => void): { dispose(): void } };
    };
    const inbound: unknown[] = [];
    host.webview.onDidReceiveMessage((m) => inbound.push(m));

    // `cancel`, not `send`: this harness's phone enrols no device key, so it is
    // watch-only (inbound.ts). The verb is beside the point here — what is
    // under test is that two frames reach the host in the ORDER they arrived -
    // and the enrolled phone's own tiers are proven in remoteDeviceKey.test.ts.
    const a = { type: 'cancel', sessionId: 's1', reason: 'first' };
    const b = { type: 'cancel', sessionId: 's1', reason: 'second' };
    const f1 = await h.phone.seal(a);
    const f2 = await h.phone.seal(b);

    const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let nth = 0;
    const spy = vi
      .spyOn(crypto.subtle, 'decrypt')
      .mockImplementation(async (...args: Parameters<typeof realDecrypt>) => {
        const mine = nth++;
        const out = await realDecrypt(...args);
        if (mine === 0) await new Promise((r) => setTimeout(r, 30));
        return out;
      });

    h.socket.onmessage?.({ data: f1 });
    h.socket.onmessage?.({ data: f2 });
    await waitFor(() => inbound.length === 2, 'both phone messages to reach the host', 3000);
    spy.mockRestore();

    expect(inbound).toEqual([a, b]);
  });

  // --- INTEROP DEFECT, caught by remoteInterop.test.ts against a real relay:
  // the phone reported `replayed seq 4 <= 6` and silently lost two of five
  // messages. Each post() is its own promise chain, so the chunks WITHIN one
  // message stayed ordered but two posts raced: seq was assigned in call order
  // and then the frames left in RESOLUTION order. A frame that arrives after a
  // higher seq is a replay by the spec's own rule, so the receiver is required
  // to drop it — the message is gone for good, with no error anywhere.
  //
  // attachView posts exactly this shape: restoreMessages (chunked) followed
  // immediately by contextUpdate and restoreActiveSession, so the tail of every
  // hydration is what a real phone would lose.
  it('a small post cannot overtake the chunk run of a big one', async () => {
    const h = await paired();
    await h.fromPhone({ type: 'remote/hello', v: 1, device: 'pixel' });
    await h.drain();
    const host = h.attach.mock.calls[0]![0] as { webview: { postMessage(m: unknown): unknown } };

    const big = {
      type: 'restoreMessages',
      sessionId: 's1',
      messages: [{ kind: 'agent', text: 'z'.repeat(200_000), timestamp: 1 }],
    };
    const small = { type: 'restoreActiveSession', sessionId: 's1' };
    // Wait for a BASELINE-RELATIVE count of exactly the frames these two
    // messages need. `>= 8` was absolute, so the hello frame already on the
    // socket meant the wait could finish one frame early — after the last
    // chunk of `big` but before `small` — and drain() then saw only `big`.
    // That made this test itself flaky, which is not the defect it is for.
    const before = h.socket.sent.length;
    const expected = encodeMessage(big).length + encodeMessage(small).length;
    void host.webview.postMessage(big);
    void host.webview.postMessage(small);
    await waitFor(() => h.socket.sent.length >= before + expected, 'the whole burst to reach the socket');

    // drain() opens the frames through a real FrameCodec, so it ENFORCES the
    // spec's "reject seq <= last seen" rule: a frame that left out of order
    // throws here rather than being quietly tolerated.
    expect(await h.drain()).toEqual([big, small]);
  });

  // --- THE CHUNK REASSEMBLY, over the real wire. Break the join in
  // ChunkAssembler.push and this is the test that goes red with the transcript
  // truncated rather than an error. ---
  it('a transcript too big for one frame arrives intact', async () => {
    const h = await paired();
    await h.drain();
    // The host the socket-open hydration already attached. Posting through it
    // is exactly what replaySessionsTo does to a fresh view; driving it with a
    // second remote/snapshot stopped working when the gate landed, and the
    // claim here was never about how many hydrations a socket gets.
    const attached = h.attach.mock.calls[0]![0] as { webview: { postMessage(m: unknown): unknown } };
    const hydration = {
      type: 'restoreMessages',
      sessionId: 's1',
      messages: Array.from({ length: 800 }, (_, i) => ({
        kind: 'assistant',
        text: `turn ${i} — "quoted" and unicode 🚀 ${'x'.repeat(120)}`,
        timestamp: i,
      })),
    };
    const before = h.socket.sent.length;
    // The exact chunk count this message needs, the same way "a small post
    // cannot overtake the chunk run of a big one" (above) waits for its own
    // burst: a fixed flush() after the FIRST chunk landed raced the remaining
    // ones under load, so `received` sometimes saw the transcript truncated
    // rather than the reassembly error the file exists to catch (t-2ek0o9).
    const expected = encodeMessage(hydration).length;
    void attached.webview.postMessage(hydration);
    await waitFor(() => h.socket.sent.length >= before + expected, 'the whole chunked hydration to reach the socket');
    const frames = h.socket.sent.length;
    const received = await h.drain();
    expect(frames).toBeGreaterThan(1); // it really was chunked
    expect(received).toEqual([hydration]);
  });

  // COALESCING, on the production path: DashboardPanel posts one message per
  // token, and every one of them used to be its own sealed 1 KiB frame. The
  // shaper (`remoteOutbound.ts`) buffers them and lets the next NON-delta flush
  // them, so what matters here is that the phone still receives the same text,
  // in order, and that `privilege.outbound` still ran on the way past — the ask
  // must arrive carrying the nonce its approval has to sign.
  it('sends a 300-token turn as a handful of frames, nonce intact and pictures dropped', async () => {
    const h = await paired();
    const words: string[] = [];
    // THE HOST THE SOCKET OPEN ALREADY ATTACHED. A second `remote/snapshot`
    // brings no second attach any more - one hydration per socket
    // (hydrateGate.ts) - so the turn is posted into the view that exists.
    const attached = h.attach.mock.calls[0]![0] as { webview: { postMessage(m: unknown): unknown } };
    const before = h.socket.sent.length;
    for (let i = 0; i < 300; i++) {
      const text = `d${String(i).padStart(4, '0')}.`;
      words.push(text);
      void attached.webview.postMessage({ type: 'agentText', sessionId: 's1', messageId: 'm1', text });
    }
    // Heavy, and the phone has no surface for it: it must never reach the wire.
    void attached.webview.postMessage({ type: 'browserSnapshot', sessionId: 's1', imageDataUrl: 'data:image/png;base64,AAAA' });
    void attached.webview.postMessage({ type: 'requestPermission', sessionId: 's1', toolCallId: 't1', title: 'Run ls', options: [] });
    void attached.webview.postMessage({ type: 'turnDone', sessionId: 's1', stopReason: 'end_turn' });
    await waitFor(() => h.socket.sent.length > before + 1, 'the shaped turn');
    await flush(80);
    const frames = h.socket.sent.length - before;
    const all = (await h.drain()) as Array<Record<string, unknown>>;
    // The socket-open handshake rides the same drain; the turn is what is under test.
    const got = all.filter((m) => !String(m.type).startsWith('remote/'));

    expect(frames).toBeLessThan(10); // 300 deltas would have been 300 frames
    expect(got.map((m) => m.type)).toEqual(['agentText', 'requestPermission', 'turnDone']);
    expect(got[0]!.text).toBe(words.join(''));
    expect(got[0]!.messageId).toBe('m1'); // the SAME shape a single delta had
    // privilege.outbound ran BEFORE the shaper handed it to the pipe.
    expect(typeof got[1]!.approvalNonce).toBe('string');
    expect(all.some((m) => m.type === 'browserSnapshot')).toBe(false);
  });

  it('lets the model catalogue and the per-session status through, but only when they change', async () => {
    // They were DENIED at the view boundary on the reading that nothing on the
    // phone reads them. The phone mounts the dashboard bundle, and its
    // ModelPicker reads both by name, so the 0.4.104 device pass drove a picker
    // the desk had stopped feeding. The rebroadcast cost they were denied for
    // is answered by the shaper instead - an unchanged catalogue is dropped.
    const h = await paired();
    const attached = h.attach.mock.calls[0]![0] as { webview: { postMessage(m: unknown): unknown } };
    await h.drain();
    const catalogue = { type: 'modelOptions', current: 'a', options: [{ id: 'a' }, { id: 'b' }] };
    void attached.webview.postMessage(catalogue);
    void attached.webview.postMessage({ ...catalogue });
    void attached.webview.postMessage({ type: 'modelStatus', sessionId: 's1', ok: true });
    await flush(80);
    const got = (await h.drain()) as Array<Record<string, unknown>>;
    expect(got.map((m) => m.type)).toEqual(['modelOptions', 'modelStatus']);
    expect(got[0]!.options).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('records what the phone said it can open, so the replay envelope fits the page', async () => {
    // `restoreMessagesZ` on a page with no arm for it is an EMPTY transcript
    // over the owner's chat, and the shipped iOS app is exactly such a page.
    const h = await paired();
    const attached = h.attach.mock.calls[0]![0] as { webview: unknown };
    // Today's app: a hello with no caps at all.
    await h.fromPhone({ type: 'remote/hello', v: 1, device: 'iphone' });
    expect(remoteAcceptsZ(attached.webview)).toBe(false);
    // A hello that names something else still declares no restoreZ.
    await h.fromPhone({ type: 'remote/hello', v: 1, device: 'iphone', caps: ['somethingElse'] });
    expect(remoteAcceptsZ(attached.webview)).toBe(false);
    // The page in this tree (webview/remote/native.ts buildHello).
    await h.fromPhone({ type: 'remote/hello', v: 1, device: 'iphone', caps: ['restoreZ'] });
    expect(remoteAcceptsZ(attached.webview)).toBe(true);
  });

  it('a tap on the phone chat strip scopes the stream, and never moves the desktop', async () => {
    // The strip is LOCAL (webview/remote/sessionBar.ts), so until `remote/focus`
    // existed the desk kept filtering the chat the owner had just tapped to.
    // THIS PHONE ENROLLED NO KEY, so it is clamped to `watch` - the verb has to
    // be admitted at that tier or the whole strip is dead on a browser page.
    const h = await paired();
    const attached = h.attach.mock.calls[0]![0] as {
      webview: {
        postMessage(m: unknown): unknown;
        onDidReceiveMessage(l: (m: unknown) => void): unknown;
      };
    };
    const inbound: unknown[] = [];
    attached.webview.onDidReceiveMessage((m) => inbound.push(m));
    await h.drain();
    await h.fromPhone({ type: 'remote/focus', sessionId: 's2' });
    void attached.webview.postMessage({ type: 'agentText', sessionId: 's1', messageId: 'm1', text: 'the other chat' });
    // A non-delta flushes ITS OWN session's buffer first (remoteOutbound.ts), so
    // each `turnDone` here is what proves the delta above it was dropped rather
    // than still sitting in a buffer this test never waited out.
    void attached.webview.postMessage({ type: 'turnDone', sessionId: 's1', stopReason: 'end_turn' });
    void attached.webview.postMessage({ type: 'agentText', sessionId: 's2', messageId: 'm2', text: 'the one it reads' });
    void attached.webview.postMessage({ type: 'turnDone', sessionId: 's2', stopReason: 'end_turn' });
    await flush(80);
    const got = (await h.drain()) as Array<Record<string, unknown>>;
    expect(got.filter((m) => m.type === 'agentText').map((m) => m.text)).toEqual(['the one it reads']);
    // ...and the desktop's own active chat is the OWNER's. `remote/focus` is
    // acted on and dropped; it never reaches handleWebviewMessage.
    expect(inbound).toEqual([]);
  });

  it('every frame it sends is inside the relay cap', async () => {
    const h = await paired();
    const attached = h.attach.mock.calls[0]![0] as { webview: { postMessage(m: unknown): unknown } };
    const before = h.socket.sent.length;
    void attached.webview.postMessage({ type: 'restoreMessages', text: 'y'.repeat(300_000) });
    await waitFor(() => h.socket.sent.length > before + 1, 'the chunked hydration frames');
    await flush(60);
    for (const frame of h.socket.sent) expect(frame.length).toBeLessThanOrEqual(65_536);
  });
});

describe('remote controller — the phone driving the chat', () => {
  // THE PHONE HERE ENROLS NO KEY, so the desk treats it as a browser page and
  // allows it the `watch` envelope only. These tests are about the WIRE — the
  // frame reaching the host once, and only once — so they drive it with a watch
  // verb; that a keyed phone may send is remoteDeviceKey.test.ts's claim.
  it('forwards an ordinary webview message to the host untouched', async () => {
    const h = await paired();
    const inbound: unknown[] = [];
    // The host the socket open already attached — a hello no longer brings a
    // second one (hydrateGate.ts), and the claim here is about the WIRE.
    const attached = h.attach.mock.calls[0]![0] as {
      webview: { onDidReceiveMessage(l: (m: unknown) => void): unknown };
    };
    attached.webview.onDidReceiveMessage((m) => inbound.push(m));
    await h.fromPhone({ type: 'remote/hello', v: 1, device: 'pixel' });
    await h.fromPhone({ type: 'cancel', sessionId: 's1' });
    expect(inbound).toEqual([{ type: 'cancel', sessionId: 's1' }]);
  });

  it('drops a REPLAYED frame instead of acting on it twice', async () => {
    const h = await paired();
    const inbound: unknown[] = [];
    const attached = h.attach.mock.calls[0]![0] as {
      webview: { onDidReceiveMessage(l: (m: unknown) => void): unknown };
    };
    attached.webview.onDidReceiveMessage((m) => inbound.push(m));
    await h.fromPhone({ type: 'remote/hello', v: 1, device: 'pixel' });
    const frame = await h.phone.seal({ type: 'cancel', sessionId: 's1' });
    h.socket.onmessage?.({ data: frame });
    await flush();
    h.socket.onmessage?.({ data: frame });
    await flush();
    expect(inbound).toEqual([{ type: 'cancel', sessionId: 's1' }]);
    expect(h.statuses.some((s) => s.includes('rejected a frame (replay)'))).toBe(true);
  });

  it('drops a frame sealed under a DIFFERENT key', async () => {
    const h = await paired();
    const inbound: unknown[] = [];
    h.attach.mockImplementation((host: { webview: { onDidReceiveMessage(l: (m: unknown) => void): unknown } }) => {
      host.webview.onDidReceiveMessage((m) => inbound.push(m));
    });
    await h.fromPhone({ type: 'remote/hello', v: 1, device: 'pixel' });
    // An impostor with the right rid but a Ks of its own.
    const impostorKey = await deriveKey(generateKs());
    const impostor = new FrameCodec(impostorKey, h.controller.rid!, ROLE_PHONE);
    h.socket.onmessage?.({ data: await impostor.encode(JSON.stringify({ type: 'send', text: 'pwn' })) });
    await flush();
    expect(inbound).toEqual([]);
    expect(h.statuses.some((s) => s.includes('rejected a frame (gcm)'))).toBe(true);
  });
});

describe('remote controller — pairing and revoke', () => {
  let r: Rig;
  let secrets: ReturnType<typeof fakeSecrets>;
  let controller: RemoteController;

  beforeEach(() => {
    r = rig();
    secrets = fakeSecrets();
    controller = new RemoteController({
      config: () => ({ enabled: true, relayUrl: 'wss://relay.example' }),
      secrets,
      deps: r.deps,
      attach: () => {},
    });
  });

  it('pair() offers a QR, opens a socket and arms the 60-second window', async () => {
    const offer = await controller.pair();
    expect(offer.qr).toContain(`#v1.${offer.rid}.`);
    expect(r.sockets).toHaveLength(1);
    expect(r.timers.map((t) => t.ms)).toEqual([60_000]);
  });

  it('the expiry timer revokes a pairing no phone claimed', async () => {
    await controller.pair();
    r.timers[0]!.fn();
    await waitFor(() => secrets.map.size === 0, 'the expired pairing to be wiped');
    expect(secrets.map.size).toBe(0);
    expect(controller.rid).toBeNull();
    expect(r.sockets[0]!.closed).toBe(true);
  });

  it('a hello inside the window stops the pairing being expired', async () => {
    const offer = await controller.pair();
    // Read the key from the OFFER, not from load(): an unconfirmed offer is no
    // longer loadable, and asking would wipe the very pairing under test.
    const phone = await phoneFor(offer.qr);
    r.sockets[0]!.onopen?.();
    r.sockets[0]!.onmessage?.({ data: await phone.seal({ type: 'remote/hello', v: 1, device: 'pixel' }) });
    await flush(40);
    r.timers[0]!.fn(); // the timer still fires; the pairing is no longer pending
    await flush(40);
    expect(controller.rid).toBe(offer.rid);
    expect(secrets.map.size).toBe(2); // Ks AND the confirmation
  });

  // A CODE SCANNED AT SECOND 61. The pairing is refused, correctly — but the
  // phone used to get nothing at all: a dead Ks, an open socket and silence,
  // which is indistinguishable from "the desktop is just slow". It is now told
  // `remote/revoked`, and told BEFORE the socket goes.
  it('a hello AFTER the window tells the phone it was revoked, then revokes', async () => {
    let clock = 1_700_000_000_000;
    const late = new RemoteController({
      config: () => ({ enabled: true, relayUrl: 'wss://relay.example' }),
      secrets,
      deps: r.deps,
      attach: () => {},
      now: () => clock,
    });
    const offer = await late.pair();
    const phone = await phoneFor(offer.qr);
    const socket = r.sockets.at(-1)!;
    socket.onopen?.();
    await flush(20);

    clock += 61_000; // the sixty-second window has closed
    socket.onmessage?.({ data: await phone.seal({ type: 'remote/hello', v: 1, device: 'pixel' }) });
    await waitFor(() => secrets.map.size === 0, 'the late hello to revoke the pairing');

    await phone.absorb(socket.sent);
    expect((phone.received as Array<{ type?: string }>).map((m) => m.type)).toContain('remote/revoked');
    expect(late.rid).toBeNull();
    expect(socket.closed).toBe(true);
  });

  // MUTATION PROOF for the phantom device. The socket the desktop opens in
  // pair() is how the PHONE finds it, so against a live relay it opens at once
  // — `connected` is true a millisecond after Show code. Anything that reads
  // that as "a phone is paired" passes the old assertions and fails these.
  it('MUTATION PROOF — pair() with the socket OPEN is still NOT confirmed', async () => {
    await controller.pair();
    r.sockets[0]!.onopen?.();
    await flush(40);
    expect(controller.connected).toBe(true); // the desktop's own socket, up
    expect(controller.rid).not.toBeNull(); // and a rid exists
    expect(controller.confirmedAt).toBeNull(); // but NO phone has answered
  });

  it("the phone's hello is what makes it confirmed, and stamps the time", async () => {
    const before = Date.now();
    const offer = await controller.pair();
    const phone = await phoneFor(offer.qr);
    r.sockets[0]!.onopen?.();
    r.sockets[0]!.onmessage?.({ data: await phone.seal({ type: 'remote/hello', v: 1, device: 'pixel' }) });
    await waitFor(() => controller.confirmedAt !== null, 'the hello to confirm the pairing');
    expect(controller.confirmedAt).toBeGreaterThanOrEqual(before);
    expect(controller.confirmedAt).toBeLessThanOrEqual(Date.now());
  });

  it('a confirmed pairing survives a reload; an unanswered code does not', async () => {
    const offer = await controller.pair();
    // Reload now, with the code still on screen and never scanned.
    expect(await new PairingManager(secrets).load()).toBeNull();
    expect(secrets.map.size).toBe(0);

    const second = await controller.pair();
    expect(second.rid).not.toBe(offer.rid);
    const phone = await phoneFor(second.qr);
    r.sockets.at(-1)!.onopen?.();
    r.sockets.at(-1)!.onmessage?.({ data: await phone.seal({ type: 'remote/hello', v: 1, device: 'pixel' }) });
    await waitFor(() => controller.confirmedAt !== null, 'the second pairing to confirm');

    const reloaded = await new PairingManager(secrets).load();
    expect(reloaded?.rid).toBe(second.rid);
    expect(reloaded?.confirmedAt).toBe(controller.confirmedAt);
  });

  it('pairing a SECOND phone rotates the rid and the stored Ks', async () => {
    const first = await controller.pair();
    const firstKs = secrets.map.get(SECRET_KS);
    const second = await controller.pair();
    expect(second.rid).not.toBe(first.rid);
    expect(secrets.map.get(SECRET_KS)).not.toBe(firstKs);
    expect(r.sockets[0]!.closed).toBe(true);
    expect(r.sockets[1]!.url).toContain(second.rid);
  });

  it('revoke() closes the socket, wipes the secrets and cancels the timer', async () => {
    await controller.pair();
    await controller.revoke();
    expect(r.sockets[0]!.closed).toBe(true);
    expect(r.timers[0]!.cleared).toBe(true);
    expect(secrets.map.size).toBe(0);
    expect(controller.connected).toBe(false);
  });

  it('dispose() leaves no live socket and no armed timer', async () => {
    await controller.pair();
    controller.dispose();
    expect(r.sockets[0]!.closed).toBe(true);
    expect(r.timers.every((t) => t.cleared)).toBe(true);
  });

  it('a revoked pairing cannot be reached with the OLD Ks', async () => {
    const offer = await controller.pair();
    const oldKs = secrets.map.get(SECRET_KS)!;
    await controller.revoke();
    const next = await controller.pair();
    expect(b64urlEncode(generateKs())).not.toBe(oldKs); // sanity: keys are random
    expect(next.rid).not.toBe(offer.rid);
  });
});
