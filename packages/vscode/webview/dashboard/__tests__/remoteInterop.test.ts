// @vitest-environment node
//
// Origami Remote — BYTE-LEVEL INTEROP between the three halves that were built
// independently: the real `origami relay` (Bun, spawned as a child process
// here), the desktop lane (src/remote/*) and the phone lane (webview/remote/*).
//
// Every other remote test proves one lane against a FAKE of the other two, so a
// shared misreading of the wire spec would be green in all of them. This file
// removes the fakes: real sockets, the real relay, the desktop's own
// crypto/frame/transport/controller and the phone's own crypto/chunk/transport,
// with nothing re-implemented from the spec in between. If the two lanes
// disagree by one byte, a frame here fails to open.
//
// The relay is Bun code and cannot be imported into vitest, so it is spawned:
//   bun run packages/engine/src/index.ts relay --port 0 --hostname 127.0.0.1
// and the port is read off its "listening on <host>:<port>" line. With no `bun`
// on PATH the suite SKIPS with a printed reason rather than failing — the relay
// lane's own `bun test test/relay` still covers the relay itself.
//
// Loopback only (127.0.0.1), ephemeral port, no TLS, nothing written to disk.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// --- the DESKTOP lane, imported as production code -------------------------
import { deriveKey, deriveRid, generateKs, type RemoteKey } from '../../../src/remote/crypto';
import { ROLE_DESKTOP, encodeFrame } from '../../../src/remote/frame';
import { FrameCodec } from '../../../src/remote/frameCodec';
import type { SecretStore } from '../../../src/remote/pairing';
import { RemoteController, type RemoteConfig } from '../../../src/remote/remoteController';
import { DESK_NONCE } from '../../../src/remote/remoteDelta';
import {
  RemoteTransport as DesktopTransport,
  type RemoteSocket,
  type TransportDeps,
} from '../../../src/remote/transport';

// --- the PHONE lane, imported as production code ---------------------------
import { deriveKey as phoneDeriveKey, deriveRid as phoneDeriveRid } from '../../remote/crypto';
import { parseFragment } from '../../remote/pairing';
import { WireKeys } from '../../remote/sessionKey';
import { RemoteTransport as PhoneTransport, type SocketLike } from '../../remote/transport';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** __tests__ -> dashboard -> webview -> vscode -> packages -> repo root */
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const ENGINE_ENTRY = path.join(REPO_ROOT, 'packages', 'engine', 'src', 'index.ts');

const bunProbe = spawnSync('bun', ['--version'], { encoding: 'utf8', windowsHide: true });
const HAS_BUN = !bunProbe.error && bunProbe.status === 0;
if (!HAS_BUN) {
  console.warn(
    '[remoteInterop] SKIPPED: `bun` is not on PATH, so the real relay cannot be spawned. ' +
      'Install bun and re-run to exercise the three-lane interop.',
  );
}

// ---------------------------------------------------------------- helpers --

async function waitFor(pred: () => boolean, what: string | (() => string), ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
}

/** The phone lane reports the relay's presence CONTROL frames through the same
 *  `onReject` channel as a bad frame — it has no arm for a non-binary frame,
 *  which is precisely the compat property the relay's presence lane relies on
 *  (`remotePresence.test.ts`). Assertions about FRAME rejections filter them
 *  out, or they would be asserting on the relay's plumbing. */
const CONTROL_REJECT = 'non-binary frame';
const frameRejects = (rejects: readonly string[]): string[] => rejects.filter((r) => r !== CONTROL_REJECT);

const typeOf = (m: unknown): string | undefined => (m as { type?: string } | null)?.type;
const ofType = (list: unknown[], t: string): unknown[] => list.filter((m) => typeOf(m) === t);

/** One pairing's key material, derived once per lane. Building it asserts the
 *  two HKDF implementations agree on the rid before anything relies on it. */
interface Pairing {
  ks: Uint8Array;
  rid: string;
  desktopKey: RemoteKey;
  phoneKey: CryptoKey;
}

async function pairingFromKs(ks: Uint8Array): Promise<Pairing> {
  const rid = await deriveRid(ks);
  const phoneRid = await phoneDeriveRid(ks);
  if (rid !== phoneRid) throw new Error(`rid disagreement: desktop ${rid} vs phone ${phoneRid}`);
  return { ks, rid, desktopKey: await deriveKey(ks), phoneKey: await phoneDeriveKey(ks) };
}

const newPairing = (): Promise<Pairing> => pairingFromKs(generateKs());

/** What a phone actually does with a scanned QR: read the fragment with the
 *  PHONE's parser, then derive its own key. Proves the QR encoder and the QR
 *  parser agree as well as the crypto. */
async function pairingFromQr(qr: string): Promise<Pairing> {
  const parsed = parseFragment(qr.slice(qr.indexOf('#')));
  if (!parsed) throw new Error(`the phone could not parse the desktop's QR payload: ${qr}`);
  const p = await pairingFromKs(parsed.ks);
  if (p.rid !== parsed.rid) throw new Error(`QR rid ${parsed.rid} does not match the derived rid ${p.rid}`);
  return p;
}

// ------------------------------------------------------------ the relay ----

let relay: ChildProcessWithoutNullStreams | null = null;
let relayPort = 0;

const wsBase = (): string => `ws://127.0.0.1:${relayPort}`;

async function startRelayChild(): Promise<void> {
  const child = spawn('bun', ['run', ENGINE_ENTRY, 'relay', '--port', '0', '--hostname', '127.0.0.1'], {
    cwd: REPO_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay = child;
  let stderr = '';
  let stdout = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => (stderr += d));
  child.stdout.setEncoding('utf8');
  relayPort = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`relay did not announce a port in 45s. stdout=${stdout} stderr=${stderr}`)),
      45_000,
    );
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const m = /listening on [^:]+:(\d+)/.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited with ${code} before listening. stderr=${stderr}`));
    });
  });
}

// ------------------------------------------------------- socket adapters ---
// Both lanes take their socket by injection, so the ONLY thing written below is
// glue from Node's global WebSocket onto each lane's own interface. No framing,
// no crypto, no protocol — those must come from the lanes or the test proves
// nothing.

interface RawSocket {
  ws: WebSocket;
  opened: Promise<void>;
  closes: number[];
  frames: Uint8Array[];
}

function rawSocket(rid: string, role: 'desktop' | 'phone', after = 0): RawSocket {
  const ws = new WebSocket(`${wsBase()}/r/${encodeURIComponent(rid)}?role=${role}&after=${after}`);
  ws.binaryType = 'arraybuffer';
  const closes: number[] = [];
  const frames: Uint8Array[] = [];
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('close', (ev) => reject(new Error(`closed before open: ${(ev as CloseEvent).code}`)));
  });
  // The relay's presence control frames are TEXT. This raw socket models a
  // client that knows nothing about them, which is the compat claim: they are
  // skipped, and the FRAME stream this test asserts on is unchanged.
  ws.addEventListener('message', (ev) => {
    const data = (ev as MessageEvent).data;
    if (typeof data === 'string') return;
    frames.push(new Uint8Array(data as ArrayBuffer));
  });
  ws.addEventListener('close', (ev) => closes.push((ev as CloseEvent).code));
  return { ws, opened, closes, frames };
}

/** Frame seq straight off the wire — bytes 2..5, uint32 BE. No key needed, so
 *  the harness can log the ORDER the relay actually delivered without touching
 *  either lane's crypto or its replay state. */
function wireSeq(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, false);
}

function desktopSocketFactory(urls: string[], sent = { frames: 0, seqs: [] as number[] }): (url: string) => RemoteSocket {
  return (url: string) => {
    urls.push(url);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const shim: RemoteSocket = {
      binaryType: 'arraybuffer',
      send: (data) => {
        sent.frames++;
        sent.seqs.push(wireSeq(data));
        ws.send(data);
      },
      close: (code, reason) => (code === undefined ? ws.close() : ws.close(code, reason)),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    ws.addEventListener('open', () => shim.onopen?.());
    ws.addEventListener('message', (ev) => shim.onmessage?.({ data: (ev as MessageEvent).data }));
    ws.addEventListener('close', (ev) =>
      shim.onclose?.({ code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason }),
    );
    ws.addEventListener('error', () => shim.onerror?.({}));
    return shim;
  };
}

/** The raw socket behind one phone connection. `closed` flips only when the
 *  real close event has been dispatched, which the transport's own status flag
 *  does NOT tell us: close() reports 'closed' synchronously while the socket is
 *  still open at the relay. */
interface PhoneRawSocket {
  ws: WebSocket;
  closed: boolean;
}

function phoneSocketFactory(
  urls: string[],
  raws: PhoneRawSocket[] = [],
  wire: number[] = [],
): (url: string) => SocketLike {
  return (url: string) => {
    urls.push(url);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const raw: PhoneRawSocket = { ws, closed: false };
    raws.push(raw);
    const shim: SocketLike = {
      binaryType: 'arraybuffer',
      get readyState() {
        return ws.readyState;
      },
      send: (data: ArrayBuffer) => ws.send(data),
      close: (code?: number, reason?: string) => (code === undefined ? ws.close() : ws.close(code, reason)),
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    ws.addEventListener('open', () => shim.onopen?.({}));
    ws.addEventListener('message', (ev) => {
      const data = (ev as MessageEvent).data;
      // A control frame has no header to read a seq out of. It is still handed
      // to the shim, because what the PHONE lane does with one — reject it and
      // keep the socket — is exactly what this file is here to prove.
      if (typeof data !== 'string') wire.push(wireSeq(new Uint8Array(data as ArrayBuffer)));
      shim.onmessage?.({ data });
    });
    ws.addEventListener('close', (ev) => shim.onclose?.({ code: (ev as CloseEvent).code }));
    // Registered AFTER the shim's dispatch, so once `closed` is true the
    // transport has already handled this socket's close and cannot clobber a
    // newer one from a late handler.
    ws.addEventListener('close', () => (raw.closed = true));
    ws.addEventListener('error', () => shim.onerror?.({}));
    return shim;
  };
}

// ------------------------------------------------------------ phone side ---

interface PhoneSide {
  transport: PhoneTransport;
  received: unknown[];
  rejects: string[];
  statuses: string[];
  urls: string[];
  /** The raw sockets, newest last, so a test can wait on a REAL close. */
  sockets: PhoneRawSocket[];
  /** Frame seqs in the order the relay delivered them, before any decrypt. */
  wire: number[];
  /** Ordered log of `message: <type>` and `socket: closed`, for the revoke race. */
  timeline: string[];
}

function startPhone(p: Pairing, onMessage?: (m: unknown) => void): PhoneSide {
  const received: unknown[] = [];
  const rejects: string[] = [];
  const statuses: string[] = [];
  const timeline: string[] = [];
  const urls: string[] = [];
  const sockets: PhoneRawSocket[] = [];
  const wire: number[] = [];
  const transport = new PhoneTransport({
    keys: new WireKeys(p.phoneKey, p.rid),
    url: (after) => `${wsBase()}/r/${encodeURIComponent(p.rid)}?role=phone&after=${after}`,
    socketFactory: phoneSocketFactory(urls, sockets, wire),
    backoff: [20],
    onStatus: (s) => {
      statuses.push(s);
      if (s === 'closed') timeline.push('socket: closed');
    },
    onReject: (why) => rejects.push(why),
    onMessage: (msg) => {
      received.push(msg);
      timeline.push(`message: ${String(typeOf(msg))}`);
      onMessage?.(msg);
    },
  });
  return { transport, received, rejects, statuses, urls, sockets, wire, timeline };
}

// ---------------------------------------------------------- desktop side ---

function fakeSecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
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

interface DesktopSide {
  controller: RemoteController;
  statuses: string[];
  /** Phone messages that reached the `handleWebviewMessage` seam. */
  inbound: unknown[];
  urls: string[];
  /** What a freshly attached view is replayed. Set before the phone says hello. */
  hydration: unknown[];
  attaches(): number;
  /** Frames actually handed to the desktop's socket. post() returns before the
   *  seal finishes, so this is the observable "the bytes have left" signal. */
  framesSent(): number;
  /** Frame seqs in the order the desktop put them on the wire. */
  sentSeqs(): number[];
  post(msg: unknown): void;
}

function startDesktop(now?: () => number): DesktopSide {
  const urls: string[] = [];
  const statuses: string[] = [];
  const inbound: unknown[] = [];
  const state = { attaches: 0, hydration: [] as unknown[], post: (_msg: unknown) => {} };
  const sent = { frames: 0, seqs: [] as number[] };
  let subscription: { dispose(): void } | null = null;

  const deps: TransportDeps = {
    connect: desktopSocketFactory(urls, sent),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  const controller = new RemoteController({
    config: (): RemoteConfig => ({ enabled: true, relayUrl: wsBase(), capability: 'full' }),
    secrets: fakeSecrets(),
    deps,
    now,
    deviceName: 'interop-desktop',
    onStatus: (s) => statuses.push(s),
    // The DashboardPanel seam. attachView subscribes once per attach and
    // REWIRES (drops the previous subscription) — mirrored here, because a
    // second `remote/snapshot` re-attaches and a duplicated listener would
    // double every inbound message and hide a real defect behind the noise.
    attach: (host) => {
      state.attaches++;
      subscription?.dispose();
      subscription = host.webview.onDidReceiveMessage((m: unknown) => inbound.push(m));
      state.post = (msg: unknown) => void host.webview.postMessage(msg);
      for (const m of state.hydration) void host.webview.postMessage(m);
    },
  });

  return {
    controller,
    statuses,
    inbound,
    urls,
    get hydration() {
      return state.hydration;
    },
    set hydration(v: unknown[]) {
      state.hydration = v;
    },
    attaches: () => state.attaches,
    framesSent: () => sent.frames,
    sentSeqs: () => sent.seqs,
    post: (msg: unknown) => state.post(msg),
  };
}

// ===========================================================================

describe.skipIf(!HAS_BUN)('origami remote — three-lane byte interop over a real relay', () => {
  beforeAll(async () => {
    await startRelayChild();
  }, 60_000);

  afterAll(() => {
    relay?.kill();
    relay = null;
  });

  it('the spawned relay answers /healthz', async () => {
    const res = await fetch(`http://127.0.0.1:${relayPort}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  // (a) --------------------------------------------------------------------
  it('(a) the desktop remote/hello opens on the phone, and the phone hello confirms the pairing', async () => {
    const desktop = startDesktop();
    const offer = await desktop.controller.pair();
    const p = await pairingFromQr(offer.qr);
    expect(p.rid).toBe(offer.rid);
    const phone = startPhone(p);
    desktop.hydration = [{ type: 'sessionCreated', sessionId: 's-hello' }];

    phone.transport.connect();
    await waitFor(() => phone.statuses.includes('open'), 'the phone socket to open');
    await phone.transport.send({ type: 'remote/hello', v: 1, device: 'interop-phone' });

    await waitFor(
      () => ofType(phone.received, 'remote/hello').length > 0,
      `the desktop hello to open on the phone (rejects: ${phone.rejects.join(' | ')})`,
    );
    expect(ofType(phone.received, 'remote/hello')[0]).toEqual({
      type: 'remote/hello',
      v: 1,
      device: 'interop-desktop',
      // THIS extension host, so the phone knows whether the cursors it cached
      // still name rows of this desk's logs (src/remote/remoteDelta.ts).
      desk: DESK_NONCE,
    });

    await waitFor(() => desktop.statuses.includes('remote: phone paired'), 'the desktop to accept the phone hello');
    await waitFor(() => desktop.attaches() >= 1, 'the desktop to hydrate on hello');
    await waitFor(() => ofType(phone.received, 'sessionCreated').length > 0, 'the hydration to reach the phone');

    // The real shell sends hello AND snapshot on every open (main.ts), and both
    // land on ONE socket a few milliseconds apart. Since hydrateGate.ts they
    // share one hydration: the second ask is answered by the first answer,
    // which is the whole saving (it used to be a second transcript up the
    // relay, and a third for the socket open before them).
    const attachesAfterHello = desktop.attaches();
    await phone.transport.send({ type: 'remote/snapshot' });
    await new Promise((r) => setTimeout(r, 500));
    expect(desktop.attaches()).toBe(attachesAfterHello);
    expect(ofType(phone.received, 'sessionCreated')).toHaveLength(1);

    phone.transport.close();
    desktop.controller.dispose();
  }, 30_000);

  // (b) --------------------------------------------------------------------
  it('(b) a 100 KB hydration chunked by one lane reassembles byte-identically on the other', async () => {
    const desktop = startDesktop();
    const offer = await desktop.controller.pair();
    const p = await pairingFromQr(offer.qr);
    const phone = startPhone(p);

    // Shaped like a real transcript replay: long, heavily QUOTED — a splitter
    // that budgets RAW bytes rather than JSON-ESCAPED bytes overflows the
    // 65,536-byte frame cap on exactly this shape — and with astral
    // characters, which a byte-slicing splitter would cut into mojibake.
    const big = {
      type: 'restoreMessages',
      sessionId: 's-big',
      messages: Array.from({ length: 40 }, (_, i) => ({
        kind: i % 2 ? 'agent' : 'user',
        timestamp: 1_756_800_000_000 + i,
        // A tool result that is itself quoted JSON — every character costs TWO
        // bytes inside the transcript's JSON, and two more inside a chunk
        // envelope's `part`. Ordinary prose never reaches that ratio, so a
        // splitter budgeting raw bytes stays green until a payload like this
        // one arrives and the relay closes the socket 4002.
        text: `${'"'.repeat(2_000)} \u{1F30D}\u{1F409} line ${i} ${'x'.repeat(600)}`,
      })),
    };
    expect(JSON.stringify(big).length).toBeGreaterThan(100_000);
    desktop.hydration = [big];

    phone.transport.connect();
    await waitFor(() => phone.statuses.includes('open'), 'the phone socket to open');
    await phone.transport.send({ type: 'remote/hello', v: 1, device: 'interop-phone' });

    await waitFor(
      () => ofType(phone.received, 'restoreMessages').length > 0,
      `the 100 KB hydration to reassemble on the phone (rejects: ${phone.rejects.join(' | ')})`,
      20_000,
    );
    expect(JSON.stringify(ofType(phone.received, 'restoreMessages')[0])).toBe(JSON.stringify(big));

    // ...and the same payload the other way, so the phone's splitter meets the
    // desktop's assembler too. It rides a WATCH verb: R-1 (`remoteVerbs.ts`)
    // drops anything the phone may not say, and this phone enrols no device
    // key, so since 2026-09-06 the desk treats it as a browser page and allows
    // it the `watch` envelope only. The bytes are the point here and they are
    // the same bytes: the payload is carried verbatim.
    const upward = { type: 'requestSessions', sessionId: 's-big', text: JSON.stringify(big) };
    await phone.transport.send(upward);
    await waitFor(
      () => ofType(desktop.inbound, 'requestSessions').length > 0,
      `the 100 KB message to reassemble on the desktop (rejects: ${phone.rejects.join(' | ')})`,
      20_000,
    );
    expect(JSON.stringify(ofType(desktop.inbound, 'requestSessions')[0])).toBe(JSON.stringify(upward));

    phone.transport.close();
    desktop.controller.dispose();
  }, 45_000);

  it('(b2) a quote-dense message survives BOTH splitters without a frame over the relay cap', async () => {
    const desktop = startDesktop();
    const offer = await desktop.controller.pair();
    const p = await pairingFromQr(offer.qr);
    const phone = startPhone(p);
    desktop.hydration = [{ type: 'sessionCreated', sessionId: 's-quotes' }];

    phone.transport.connect();
    await waitFor(() => phone.statuses.includes('open'), 'the phone socket to open');
    await phone.transport.send({ type: 'remote/hello', v: 1, device: 'interop-phone' });
    await waitFor(() => desktop.attaches() >= 1, 'the desktop to hydrate');

    // The worst realistic ratio: a pasted JSON blob or a tool result whose
    // every character needs escaping. Each such character costs one byte in
    // the transcript's JSON and TWO inside a chunk envelope's `part`, so a
    // splitter that budgets the part in RAW bytes emits a 66,594-byte frame —
    // 1,058 over the relay's cap — and the relay closes the socket 4002,
    // killing the pairing. Nothing under 64,508 bytes can reach this: the
    // message must be big enough to chunk in the first place.
    // A WATCH verb, not `agentText` and not `send`: R-1 drops anything the phone
    // may not say and this keyless phone is held to `watch`, while the claim
    // under test is about the SPLITTERS, not about the dispatch policy.
    const dense = { type: 'requestSessions', sessionId: 's-quotes', text: `${'"'.repeat(70_000)}${String.fromCharCode(92).repeat(70_000)}` };

    await phone.transport.send(dense);
    await waitFor(
      () => ofType(desktop.inbound, 'requestSessions').length > 0,
      `the quote-dense message to reach the desktop (phone status ${phone.statuses.at(-1)}, rejects: ${phone.rejects.join(' | ')})`,
      20_000,
    );
    expect(desktop.inbound.find((m) => typeOf(m) === 'requestSessions')).toEqual(dense);
    // A socket the relay closed for an oversized frame would show up here.
    expect(phone.statuses.at(-1)).toBe('open');

    phone.transport.close();
    desktop.controller.dispose();
  }, 45_000);

  // (c) --------------------------------------------------------------------
  it('(c) the desktop goes QUIET while the phone is away, then re-hydrates it on the reconnect', async () => {
    // THIS TEST CHANGED SHAPE WITH PRESENCE (t-uttzsd). It used to assert that
    // a desktop keeps posting into the relay's ring while the phone is gone and
    // that the ring replays those frames on the reconnect. That behaviour was
    // the defect: the relay drops every peerless frame, so all of it was upload
    // for nothing (317 KB per 300 streamed tokens, measured 2026-09-04). The
    // relay now says `peer:absent` when the phone's socket closes and
    // `peer:present` when it opens, and the desktop stops and starts on those.
    //
    // What still has to hold, and is asserted below: the resume query is
    // unchanged (`?after=<last seq>`), nothing is delivered twice, and the
    // phone that comes back is HYDRATED rather than left staring at whatever
    // the ring happened to hold.
    const desktop = startDesktop();
    const offer = await desktop.controller.pair();
    const p = await pairingFromQr(offer.qr);
    const phone = startPhone(p);
    desktop.hydration = [{ type: 'sessionCreated', sessionId: 's-resume' }];

    phone.transport.connect();
    await waitFor(() => phone.statuses.includes('open'), 'the phone socket to open');
    await phone.transport.send({ type: 'remote/hello', v: 1, device: 'interop-phone' });
    await waitFor(() => ofType(phone.received, 'sessionCreated').length > 0, 'the first hydration');

    const afterAtDisconnect = phone.transport.after;
    expect(afterAtDisconnect).toBeGreaterThan(0);
    const seenBefore = phone.received.length;

    // 1. DISCONNECT, observably — the real close event, not transport.close()'s
    //    synchronous status push. While the socket lives the relay still
    //    forwards to it, which would advance `after` behind this test's back.
    phone.transport.close();
    await waitFor(() => phone.sockets.at(-1)?.closed === true, 'the phone socket to really close');
    expect(phone.sockets.at(-1)!.ws.readyState).toBe(3);
    await waitFor(
      () => desktop.statuses.some((st) => st.includes('phone absent')),
      () => `the relay to tell the desktop the phone is gone (${desktop.statuses.slice(-3).join(' | ')})`,
    );

    // 2. AND THEN NOTHING LEAVES. A whole turn's worth of fan-out, and not one
    //    byte of it is sealed, padded or uploaded.
    const framesBefore = desktop.framesSent();
    for (let i = 1; i <= 5; i++) desktop.post({ type: 'agentText', sessionId: 's-resume', text: `missed ${i}` });
    await new Promise((r) => setTimeout(r, 500));
    expect(desktop.framesSent()).toBe(framesBefore);

    // ...and nothing reached the phone while it was disconnected.
    expect(phone.received.length).toBe(seenBefore);

    // 3. RECONNECT. The resume query is still the last seq accepted, and the
    //    phone is hydrated again — but on its OWN ask, not on the presence
    //    edge. A socket that came back inside PRESENCE_FLAP_MS is a flap as far
    //    as the desktop can see (hydrateGate.ts), and the shell answers that by
    //    sending hello AND snapshot on every open (main.ts) — so this drives
    //    the raw transport the way the real page drives itself.
    phone.transport.connect();
    await waitFor(() => phone.statuses.at(-1) === 'open', 'the phone to reconnect');
    expect(phone.urls.at(-1)).toContain(`after=${afterAtDisconnect}`);
    await phone.transport.send({ type: 'remote/hello', v: 1, device: 'interop-phone' });
    await phone.transport.send({ type: 'remote/snapshot' });

    await waitFor(
      () => ofType(phone.received.slice(seenBefore), 'sessionCreated').length > 0,
      () =>
        `the desktop to hydrate the reconnected phone (got ${phone.received.length - seenBefore}` +
        `; DESKTOP SENT seqs [${desktop.sentSeqs().join(',')}]` +
        `; PHONE WIRE seqs [${phone.wire.join(',')}]` +
        `; statuses ${phone.statuses.join('>')}; urls ${phone.urls.join(' ')}` +
        `; rejects ${phone.rejects.join(' | ')}; desktop ${desktop.statuses.slice(-4).join(' | ')})`,
      15_000,
    );
    // Nothing was delivered twice: the ring holds only what the phone already
    // had, and `?after=` is what keeps it out.
    expect(frameRejects(phone.rejects)).toEqual([]);

    phone.transport.close();
    desktop.controller.dispose();
  }, 45_000);

  // (d) --------------------------------------------------------------------
  it('(d) a replayed frame is rejected by BOTH receivers and never advances `after`', async () => {
    const p = await newPairing();
    const phone = startPhone(p);
    const raw = rawSocket(p.rid, 'desktop');
    await raw.opened;
    phone.transport.connect();
    await waitFor(() => phone.statuses.includes('open'), 'the phone socket to open');

    // desktop -> phone
    const f1 = await encodeFrame(p.desktopKey, p.rid, ROLE_DESKTOP, 1, JSON.stringify({ type: 'agentText', text: 'one' }));
    const f2 = await encodeFrame(p.desktopKey, p.rid, ROLE_DESKTOP, 2, JSON.stringify({ type: 'agentText', text: 'two' }));
    raw.ws.send(f1);
    await waitFor(() => phone.received.length === 1, 'the first frame to open on the phone');
    expect(phone.transport.after).toBe(1);

    raw.ws.send(f1); // byte-identical replay
    await waitFor(() => frameRejects(phone.rejects).length >= 1, 'the phone to reject the replay');
    expect(frameRejects(phone.rejects).at(-1)).toMatch(/replayed seq 1/);
    expect(phone.transport.after).toBe(1);
    expect(phone.received.length).toBe(1);

    raw.ws.send(f2);
    await waitFor(() => phone.received.length === 2, 'the phone to accept seq 2 after the replay');
    expect(phone.transport.after).toBe(2);

    // phone -> desktop, through the desktop's own FrameCodec
    const codec = new FrameCodec(p.desktopKey, p.rid, ROLE_DESKTOP);
    await phone.transport.send({ type: 'send', text: 'alpha' });
    await phone.transport.send({ type: 'send', text: 'beta' });
    await waitFor(() => raw.frames.length >= 2, 'two phone frames at the raw desktop socket');

    expect((await codec.decode(raw.frames[0]!)).json).toContain('alpha');
    expect(codec.afterSeq).toBe(1);
    await expect(codec.decode(raw.frames[0]!)).rejects.toMatchObject({ reason: 'replay' });
    expect(codec.afterSeq).toBe(1);
    expect((await codec.decode(raw.frames[1]!)).json).toContain('beta');
    expect(codec.afterSeq).toBe(2);

    phone.transport.close();
    raw.ws.close();
  }, 30_000);

  // (e2) -------------------------------------------------------------------
  // The revoke ORDER, over a real relay. Its trigger used to be three wrong
  // PINs; with the PIN gone the remaining revoke the desktop announces is a code
  // scanned after its sixty seconds are up, which is the same code path
  // (inbound.ts onHello: send, THEN revoke) and the same defect to guard.
  it('(e2) a code scanned too late lands remote/revoked BEFORE the socket goes, and the old rid then refuses', async () => {
    let clock = 1_700_000_000_000;
    const desktop = startDesktop(() => clock);
    const offer = await desktop.controller.pair();
    const p = await pairingFromQr(offer.qr);
    const phone: PhoneSide = startPhone(p, (msg) => {
      // Exactly what webview/remote/main.ts does when a revoke arrives.
      if (typeOf(msg) === 'remote/revoked') phone.transport.close();
    });

    phone.transport.connect();
    await waitFor(() => phone.statuses.includes('open'), 'the phone socket to open');

    clock += 61_000; // the sixty-second window has closed
    await phone.transport.send({ type: 'remote/hello', v: 1, device: 'interop-phone' });

    await waitFor(
      () => ofType(phone.received, 'remote/revoked').length > 0,
      `remote/revoked to arrive (rejects: ${phone.rejects.join(' | ')})`,
    );
    // The ORDER is the assertion: a revoke that tore the socket down before the
    // frame left would strand the phone with no idea why it went quiet.
    const revokedAt = phone.timeline.indexOf('message: remote/revoked');
    const closedAt = phone.timeline.indexOf('socket: closed');
    expect(revokedAt).toBeGreaterThanOrEqual(0);
    expect(closedAt).toBeGreaterThan(revokedAt);

    // The desktop re-pairs onto a NEW rid. A frame it seals now is bound by AAD
    // to that rid, so replaying it into the OLD room cannot open on a phone
    // still holding the old pairing.
    const next = await desktop.controller.pair();
    expect(next.rid).not.toBe(p.rid);

    const stranded = startPhone(p);
    stranded.transport.connect();
    await waitFor(() => stranded.statuses.includes('open'), 'the stranded phone to reach the old rid');
    const oldRoom = rawSocket(p.rid, 'desktop');
    await oldRoom.opened;
    const mismatched = await encodeFrame(
      p.desktopKey,
      next.rid,
      ROLE_DESKTOP,
      1,
      JSON.stringify({ type: 'agentText', text: 'after revoke' }),
    );
    oldRoom.ws.send(mismatched);
    await waitFor(
      () => frameRejects(stranded.rejects).length >= 1,
      'the stranded phone to refuse the rid-mismatched frame',
    );
    expect(frameRejects(stranded.rejects).at(-1)).toMatch(/did not open/);
    expect(stranded.received).toHaveLength(0);

    stranded.transport.close();
    oldRoom.ws.close();
    desktop.controller.dispose();
  }, 60_000);

  // (f) --------------------------------------------------------------------
  it('(f) a second desktop on one rid closes the first with 4001, and the evicted transport stops for good', async () => {
    const p = await newPairing();
    const first = rawSocket(p.rid, 'desktop');
    await first.opened;
    const second = rawSocket(p.rid, 'desktop');
    await second.opened;
    await waitFor(() => first.closes.length > 0, 'the first desktop socket to be closed');
    expect(first.closes[0]).toBe(4001);
    second.ws.close();

    // ...and the desktop LANE treats 4001 as terminal rather than reconnecting
    // into an eviction loop with the peer that displaced it.
    const p2 = await newPairing();
    const urls: string[] = [];
    const statuses: Array<[string, string | undefined]> = [];
    const transport = new DesktopTransport({
      relayUrl: wsBase(),
      rid: p2.rid,
      afterSeq: () => 0,
      deps: {
        connect: desktopSocketFactory(urls),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      onFrame: () => {},
      onStatus: (s, d) => statuses.push([s, d]),
      backoff: [20],
    });
    transport.start();
    await waitFor(() => transport.status === 'open', 'the desktop transport to open');
    const usurper = rawSocket(p2.rid, 'desktop');
    await usurper.opened;
    await waitFor(() => transport.status === 'stopped', 'the evicted desktop transport to stop');
    expect(statuses.at(-1)).toEqual(['stopped', 'another desktop claimed this pairing']);
    const urlCount = urls.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(urls.length).toBe(urlCount); // never retried
    usurper.ws.close();
  }, 30_000);

  it('(f2) a second PHONE on one rid evicts the first with 4001, and the first does not reconnect', async () => {
    // The relay's one-socket-per-role rule is symmetric, so the phone can be
    // evicted exactly as the desktop can — two shells open on one pairing, or a
    // tab restored beside a live one. The desktop lane makes 4001 terminal on
    // purpose; a phone that reconnects on it puts the two shells in an eviction
    // loop that never settles, so it must stop for the same reason.
    const p = await newPairing();
    const first = startPhone(p);
    first.transport.connect();
    await waitFor(() => first.statuses.includes('open'), 'the first phone to open');
    const attemptsBefore = first.urls.length;

    const second = startPhone(p);
    second.transport.connect();
    await waitFor(() => second.statuses.includes('open'), 'the second phone to open');
    await waitFor(() => first.statuses.at(-1) === 'closed', 'the first phone to be evicted');

    await new Promise((r) => setTimeout(r, 400));
    expect(first.urls.length).toBe(attemptsBefore);
    expect(second.statuses.at(-1)).toBe('open');

    first.transport.close();
    second.transport.close();
  }, 30_000);
});
