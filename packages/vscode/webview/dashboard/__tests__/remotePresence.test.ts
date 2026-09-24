// THE DESKTOP STOPS TALKING TO AN EMPTY ROOM.
//
// Measured on relay.origamilabs.nl (2026-09-04): a paired desktop posted every
// dashboard message — each padded to 1,058 bytes, ~317 KB per 300 streamed
// tokens — down its relay socket whether or not the phone page was open. The
// relay dropped every one of them, because there was nobody to forward them to.
//
// The fix is the relay's presence control frame, and this file is the DESKTOP
// half of it: what the controller does when it is told the phone is gone, what
// it does when the phone comes back, and — the part that matters most for a
// relay that is already deployed — what it does when it is told NOTHING.
//
// It also covers the other side of the same "the socket is up but the pairing
// is not what the desktop thinks" family: a phone whose seq marks are gone, and
// therefore whose `remote/hello` is rejected as a replay for ever.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: <T>(_k: string, d: T) => d, inspect: () => undefined }),
  },
  window: { activeTextEditor: undefined },
}));

import { RemoteController } from '../../../src/remote/remoteController';
import { PEER_ABSENT, PEER_PRESENT, PeerState, isHello, readPresence } from '../../../src/remote/presence';
import { parseQrPayload, type SecretStore } from '../../../src/remote/pairing';
import { registerRemoteSeq, resetRemoteSeq, type SeqMemento } from '../../../src/remote/seqStore';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';
import { LoopbackRelay, ROLE_DESKTOP, settle } from './remoteLoopback';
import { makePanelHarness, type HarnessSession } from './remotePanelHarness';
import { bootPhone, type Phone } from './remotePhoneHarness';

const CUR = 'chat-current';
const TRANSCRIPT = [
  { kind: 'user', text: 'summarise the wrap arc', timestamp: 1 },
  { kind: 'agent', text: 'Three commits, one revert.', timestamp: 2 },
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

async function until(pred: () => boolean, what: string | (() => string), ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  // A function so the message can carry the state at the moment it gave up.
  throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
}

/**
 * FORGET THIS DEVICE — Safari's ITP eviction, or a refused `setItem`.
 *
 * Clearing localStorage is not enough on its own: a frame still in flight at
 * the page we just closed resolves into `noteIn`, which writes the marks back
 * AFTER the clear. The "reopened" page then starts at seq 513 rather than 1,
 * the desktop accepts its hello, and the case under test never happens — which
 * is exactly how this read as a flake under full-suite load. So wait for the
 * wire to stop first, and assert the device really is empty.
 */
async function forgetTheDevice(relay: LoopbackRelay): Promise<void> {
  let last = -1;
  await until(() => {
    const now = relay.forwarded.length;
    const stable = now === last;
    last = now;
    return stable;
  }, 'the wire to go quiet before forgetting the device');
  await settle(10);
  window.localStorage.clear();
  expect(window.localStorage.length).toBe(0);
}

const oneChat = (): HarnessSession[] => [{ id: CUR, number: 1, title: 'Cortex-0836', log: [...TRANSCRIPT] }];

interface Desk {
  controller: RemoteController;
  statuses: string[];
  attaches: number;
  harness: ReturnType<typeof makePanelHarness>;
  ks: Uint8Array;
  rid: string;
}

async function bootDesktop(relay: LoopbackRelay): Promise<Desk> {
  const harness = makePanelHarness(oneChat(), CUR);
  const statuses: string[] = [];
  const desk = { attaches: 0 };
  const controller = new RemoteController({
    config: () => ({ enabled: true, relayUrl: 'wss://loopback', approvals: 'yolo' }),
    secrets: memorySecrets(),
    deps: loopbackDeps(relay),
    attach: (host) => {
      desk.attaches++;
      harness.panel.attachView(host, 'chat');
    },
    onStatus: (s) => void statuses.push(s),
    deviceName: 'harness desktop',
  });
  const offer = await controller.pair('4821');
  const scanned = parseQrPayload(offer.qr);
  return {
    controller,
    statuses,
    harness,
    ks: scanned.ks,
    rid: offer.rid,
    get attaches() {
      return desk.attaches;
    },
  };
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

// ------------------------------------------------------------ the counting --

describe('a desktop with no phone on its rid sends nothing', () => {
  it('streams ZERO dashboard frames while the relay says the phone is absent', async () => {
    const relay = new LoopbackRelay();
    const desk = await bootDesktop(relay);
    desks.push(desk.controller);
    // The desktop's own socket is up and the relay has said "absent" — the
    // exact state the measurement was taken in: paired, phone page closed.
    await until(() => relay.controls.some((c) => c.text === PEER_ABSENT), 'the relay to say the phone is absent');
    // The desktop's own hello was already sealed when "absent" arrived, so it
    // lands whatever we do. Count from AFTER it: what is on trial is the
    // fan-out, not the one frame that opened the socket.
    await settle(10);
    const before = relay.desktopFrames;

    // A whole turn's worth of fan-out, the thing that cost 317 KB per 300
    // tokens. Every one of these used to be sealed, padded and uploaded.
    for (let i = 0; i < 40; i++) desk.harness.stream({ type: 'agentText', sessionId: CUR, text: `token ${i}` });
    await settle(20);

    expect(relay.desktopFrames).toBe(before);
  }, 20_000);

  it('resumes and hydrates when the phone arrives, without being asked', async () => {
    const relay = new LoopbackRelay();
    const desk = await bootDesktop(relay);
    desks.push(desk.controller);
    await until(() => relay.controls.some((c) => c.text === PEER_ABSENT), 'the absent notice');
    await settle(10);
    const before = relay.desktopFrames;
    desk.harness.stream({ type: 'agentText', sessionId: CUR, text: 'while nobody was listening' });
    await settle(8);
    expect(relay.desktopFrames).toBe(before);

    const phone = await bootPhone({ relay, ks: desk.ks, rid: desk.rid });
    phones.push(phone);

    // Presence is what restarts it: the phone's own hello would have done so
    // too, but the desktop must not need to be ASKED — a phone that reconnects
    // mid-turn is the case where the ask arrives after the tokens.
    await until(() => relay.controls.some((c) => c.role === ROLE_DESKTOP && c.text === PEER_PRESENT), 'the present notice');
    await until(() => phone.rows().length === 2, 'the transcript the resumed desktop hydrated');
    expect(desk.attaches).toBeGreaterThan(0);
    expect(phone.hasEmptyState()).toBe(false);
  }, 20_000);

  it('pauses again when the phone goes away mid-stream', async () => {
    const relay = new LoopbackRelay();
    const desk = await bootDesktop(relay);
    desks.push(desk.controller);
    const phone = await bootPhone({ relay, ks: desk.ks, rid: desk.rid });
    phones.push(phone);
    await until(() => phone.rows().length === 2, 'the first hydration');

    // The page is CLOSED, not merely backgrounded: no reconnect follows.
    phone.transport.close();
    await until(
      () => relay.controls.filter((c) => c.role === ROLE_DESKTOP && c.text === PEER_ABSENT).length === 2,
      'the desktop to be told the phone left',
    );
    await settle(10);
    const before = relay.desktopFrames;
    for (let i = 0; i < 20; i++) desk.harness.stream({ type: 'agentText', sessionId: CUR, text: `token ${i}` });
    await settle(20);

    expect(relay.desktopFrames).toBe(before);
  }, 20_000);
});

// ------------------------------------------------------------ sleep / wake --

describe('the phone sleeps and comes back', () => {
  it('hydrates on the reconnect, with no re-pair and nothing rejected as a replay', async () => {
    // A locked screen or a backgrounded Safari tab drops the socket without
    // telling anyone it meant it. The marks survive (same page, same
    // localStorage), so the ONLY thing that has to happen is that the desktop
    // notices and pushes again.
    const relay = new LoopbackRelay();
    const desk = await bootDesktop(relay);
    desks.push(desk.controller);
    const phone = await bootPhone({ relay, ks: desk.ks, rid: desk.rid });
    phones.push(phone);
    await until(() => phone.rows().length === 2, 'the first hydration');
    const hydrationsBefore = desk.attaches;

    relay.dropPhone();
    await until(
      () => relay.controls.filter((c) => c.role === ROLE_DESKTOP && c.text === PEER_ABSENT).length === 2,
      'the desktop to notice the phone went away',
    );
    // ...and the transport's own ladder brings it straight back. The condition
    // is never in doubt — the reconnect is local and unconditional — but the
    // helper's own 5 s default was TIGHTER than the 20 s this test already gave
    // itself below, so under full-suite CPU contention the wait threw its own
    // timeout before the (guaranteed, just slow) reconnect ever landed, and
    // `desk.attaches` was never even sampled again — no expect ever ran, which
    // is why no failing assertion was ever on file for this one (t-ydhbdz).
    // Reproduced under 8-way vitest saturation: consistently THIS wait, never
    // a value mismatch downstream. 15 s brings the helper's budget in line with
    // the test's own declared tolerance instead of quietly overriding it.
    await until(() => desk.attaches > hydrationsBefore, 'the desktop to hydrate the woken phone', 15_000);

    expect(phone.rows()).toEqual(['row user', 'row agent']);
    expect(phone.hasEmptyState()).toBe(false);
    expect(phone.rejects.filter((r) => r.includes('replayed'))).toEqual([]);
    expect(desk.statuses.filter((s) => s.includes('needs re-pairing'))).toEqual([]);
  }, 30_000);
});

// ------------------------------------------------------------------ compat --

describe('compatibility — the frames are injected into an unaware phone page', () => {
  it('an older phone page still pairs and hydrates, and ignores what it cannot read', async () => {
    // `webview/remote/transport.ts` has no arm for a control frame: a
    // non-binary frame goes to `onReject` and the socket stays. That IS the
    // deployed page's behaviour, so booting it against a presence-speaking
    // relay is the compat test rather than a description of one.
    const relay = new LoopbackRelay();
    const desk = await bootDesktop(relay);
    desks.push(desk.controller);
    const phone = await bootPhone({ relay, ks: desk.ks, rid: desk.rid });
    phones.push(phone);

    await until(() => phone.rows().length === 2, 'the transcript to paint through the injected frames');
    expect(phone.chips()).toEqual(['1 · Cortex-0836', '+']);
    // Proof the control frames really did reach it, and really were harmless.
    expect(phone.rejects.filter((r) => r === 'non-binary frame').length).toBeGreaterThan(0);
    expect(phone.rejects.filter((r) => r.includes('replayed'))).toEqual([]);
  }, 20_000);
});

// ------------------------------------------------------- unknown != absent --

describe('a relay that never speaks', () => {
  it('leaves the fan-out running, because unknown is not absent', () => {
    // The relay deployed today sends no control frame. A desktop that read
    // silence as "no phone" would go quiet against it for ever.
    const peer = new PeerState();
    expect(peer.presence).toBe('unknown');
    expect(peer.paused).toBe(false);
    expect(peer.note('something else entirely')).toBeNull();
    expect(peer.paused).toBe(false);
  });

  it('pauses only on the literal absent token, and names the arrival edge', () => {
    const peer = new PeerState();
    expect(peer.note(PEER_ABSENT)).toBeNull();
    expect(peer.paused).toBe(true);
    expect(peer.note(PEER_PRESENT)).toBe('arrived');
    expect(peer.paused).toBe(false);
    // CHANGED with the privilege lane. A second `present` with no `absent` in
    // front of it is no longer "nothing happened": the relay's one-socket rule
    // makes it either a duplicate for the same phone OR a different client that
    // just evicted it, and the frame never says whose socket attached. It is
    // reported as REPLACED so the desktop can throw away a verdict the new peer
    // did not earn, without re-greeting and re-hydrating on every duplicate.
    expect(peer.note(PEER_PRESENT)).toBe('replaced');
    expect(peer.paused).toBe(false);
    // ...and a phone that goes away and comes back is an ARRIVAL again.
    expect(peer.note(PEER_ABSENT)).toBeNull();
    expect(peer.note(PEER_PRESENT)).toBe('arrived');
  });

  it('reads the two tokens and nothing else', () => {
    expect(readPresence(PEER_PRESENT)).toBe('present');
    expect(readPresence(PEER_ABSENT)).toBe('absent');
    expect(readPresence('peer:present ')).toBeNull();
    expect(readPresence('')).toBeNull();
  });
});

// ------------------------------------------- the phone that lost its marks --

describe('a phone whose seq marks are gone', () => {
  it('gets a `reset` hello and puts "needs re-pairing" on the pane, guard untouched', async () => {
    const relay = new LoopbackRelay();
    const desk = await bootDesktop(relay);
    desks.push(desk.controller);
    const phone = await bootPhone({ relay, ks: desk.ks, rid: desk.rid });
    phones.push(phone);
    await until(() => phone.rows().length === 2, 'the first hydration');

    // The page comes back with EMPTY storage for this rid — Safari evicted it,
    // or a setItem was refused — so its transport starts at seq 1 again while
    // the desktop's high-water mark is far above that.
    phone.close();
    document.body.innerHTML = '';
    await forgetTheDevice(relay);
    const reopened = await bootPhone({ relay, ks: desk.ks, rid: desk.rid });
    phones.push(reopened);
    // The precondition, stated rather than assumed: this page reserved the
    // FIRST block, so its hello carries seq 1 and the desktop's guard is above.
    expect(window.localStorage.getItem(`origami-remote/seq/${desk.rid}`)).toBe('{"out":512,"in":0}');

    await until(
      () => desk.statuses.some((s) => s.includes('needs re-pairing')),
      () => `the pane to be told the phone needs re-pairing (${desk.statuses.slice(-6).join(' | ')})`,
    );
    // The guard did its job: the hello was REJECTED, not accepted.
    expect(desk.statuses.some((s) => s.includes('rejected a frame (replay)'))).toBe(true);
    // ...and the phone was told, with a field an older page would ignore.
    await until(
      () => reopened.received.some((m) => (m as { type?: string; reset?: boolean }).reset === true),
      'the reset hello to reach the phone',
    );
  }, 20_000);

  it('says it once per socket, not once per rejected frame', async () => {
    const relay = new LoopbackRelay();
    const desk = await bootDesktop(relay);
    desks.push(desk.controller);
    const phone = await bootPhone({ relay, ks: desk.ks, rid: desk.rid });
    phones.push(phone);
    await until(() => phone.rows().length === 2, 'the first hydration');

    phone.close();
    document.body.innerHTML = '';
    await forgetTheDevice(relay);
    const reopened = await bootPhone({ relay, ks: desk.ks, rid: desk.rid });
    phones.push(reopened);
    expect(window.localStorage.getItem(`origami-remote/seq/${desk.rid}`)).toBe('{"out":512,"in":0}');
    await until(
      () => desk.statuses.some((s) => s.includes('needs re-pairing')),
      () => `the notice (${desk.statuses.slice(-6).join(' | ')})`,
    );
    await settle(20);

    // The phone sends hello AND snapshot on every open, and both are replays.
    expect(desk.statuses.filter((s) => s.includes('needs re-pairing'))).toHaveLength(1);
  }, 20_000);

  it('isHello only answers for the handshake', () => {
    expect(isHello({ type: 'remote/hello', v: 1 })).toBe(true);
    expect(isHello({ type: 'remote/snapshot' })).toBe(false);
    expect(isHello(undefined)).toBe(false);
  });
});
