// ONE HYDRATION PER SOCKET, AND THE TASK STRIP THAT SURVIVES A REOPEN.
//
// Three things meet here, because they are three halves of one bill:
//
//   C. `announce()` on the socket opening, the phone's `remote/hello` and its
//      `remote/snapshot` all mean "hydrate me", and all three land inside a few
//      milliseconds of ONE socket. The keyless page paid for all three.
//   D. A phone that flaps — away and back inside PRESENCE_FLAP_MS — is not a
//      reconnect. The timings are proven on the gate itself, with an injected
//      clock, because a test that waits three seconds proves the wall clock.
//   E. Four broadcasts (the model catalogue, the per-session modelStatus, the
//      activity feed, the spend glidepath) re-fire for the life of a socket and
//      no part of the phone reads them.
//
// ...plus the owner's own bug: "todos are empty after the app is reopened".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: <T>(_k: string, d: T) => d, inspect: () => undefined }),
  },
  window: { activeTextEditor: undefined },
}));

import { HydrateGate, PRESENCE_FLAP_MS } from '../../../src/remote/hydrateGate';
import { RemoteController } from '../../../src/remote/remoteController';
import { RemoteView } from '../../../src/remote/remoteView';
import { parseQrPayload, type SecretStore } from '../../../src/remote/pairing';
import { registerRemoteSeq, resetRemoteSeq, type SeqMemento } from '../../../src/remote/seqStore';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';
import { LoopbackRelay, settle } from './remoteLoopback';
import { makePanelHarness, type HarnessSession } from './remotePanelHarness';
import { bootPhone, type Phone } from './remotePhoneHarness';

const CUR = 'chat-current';

function chats(): HarnessSession[] {
  return [
    { id: 'chat-old', number: 1, title: 'yesterday', log: [] },
    { id: CUR, number: 2, title: 'today', log: [{ kind: 'user', text: 'hello', timestamp: 1 }] },
  ];
}

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

async function until(pred: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Nothing crossed the relay and no hydration ran for a real quiet window. */
async function quiet(relay: LoopbackRelay, attaches: number[], ms = 8_000): Promise<void> {
  const shot = (): string => `${relay.forwarded.length}|${relay.controls.length}|${attaches.length}`;
  const end = Date.now() + ms;
  let last = '';
  let still = 0;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 12));
    const now = shot();
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 4) return;
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

async function pair(enrolKey: boolean) {
  const relay = new LoopbackRelay();
  const harness = makePanelHarness(chats(), CUR);
  const attaches: number[] = [];
  const statuses: string[] = [];
  const controller = new RemoteController({
    config: () => ({ enabled: true, relayUrl: 'wss://loopback' }),
    secrets: memorySecrets(),
    deps: loopbackDeps(relay),
    attach: (host) => {
      attaches.push(Date.now());
      harness.panel.attachView(host, 'chat');
    },
    onStatus: (s) => statuses.push(s),
    deviceName: 'harness desktop',
  });
  desks.push(controller);
  const offer = await controller.pair();
  const scanned = parseQrPayload(offer.qr);
  const phone = await bootPhone({ relay, ks: scanned.ks, rid: offer.rid, enrolKey });
  phones.push(phone);
  await until(() => attaches.length > 0, 'the first hydration');
  await quiet(relay, attaches);
  return { relay, controller, harness, attaches, statuses, phone, ks: scanned.ks, rid: offer.rid };
}

describe('one hydration per socket', () => {
  it('serves the keyless page once, though it asks three times', async () => {
    const { attaches, phone, relay } = await pair(false);
    // The page sent its hello AND its snapshot on the same socket open that
    // `announce()` answered. All three used to attach.
    expect(phone.received.length).toBeGreaterThan(0);
    expect(attaches).toHaveLength(1);

    // The Refresh button, and what every reconnect sends: ask again on the SAME
    // socket. Answered by the ring, not by a second whole transcript.
    await phone.transport.send({ type: 'remote/snapshot' });
    await quiet(relay, attaches);
    expect(attaches).toHaveLength(1);
  }, 30_000);

  it('serves the COMPRESSED envelope to a page whose hello declared it can inflate', async () => {
    // THE END-TO-END OF `phoneCaps.ts`, on the real path: this phone's own
    // `buildHello` names `restoreZ`, the desk records it on the view BEFORE the
    // hydration that hello triggers, and the replay reads the envelope off it.
    // A page that declared nothing — today's shipped iOS app — gets the plain
    // tail instead, which it can already render (remoteHydrateBudget.test.ts).
    const { phone } = await pair(false);
    const types = phone.received.map((m) => (m as { type?: unknown }).type);
    expect(types).toContain('restoreMessagesZ');
    expect(types).not.toContain('restoreMessages');
  }, 30_000);

  it('serves the enrolled app once, and only after the device verdict', async () => {
    const { attaches, statuses } = await pair(true);
    expect(attaches).toHaveLength(1);
    // The hello and the snapshot were HELD, not served, until the key verified.
    expect(statuses).toContain('remote: waiting for the phone to prove the enrolled device key');
    expect(statuses).toContain('remote: the phone proved the enrolled device key');
  }, 30_000);

  it('serves one MORE when the phone really comes back', async () => {
    const { attaches, relay, ks, rid, phone } = await pair(false);
    expect(attaches).toHaveLength(1);

    phone.close();
    relay.dropPhone();
    // A real absence, not a flap. The gate's own timings are proven below with
    // an injected clock; this one waits, because what it is proving is that the
    // controller feeds the gate the real edges.
    await new Promise((r) => setTimeout(r, PRESENCE_FLAP_MS + 200));
    document.body.innerHTML = '';
    const back = await bootPhone({ relay, ks, rid });
    phones.push(back);
    await until(() => attaches.length > 1, 'the reconnect to hydrate');
    await quiet(relay, attaches);
    expect(attaches).toHaveLength(2);
    // ...and the caps are per SOCKET, so the returning page had to declare
    // `restoreZ` again to be served the compressed envelope again.
    expect(back.received.map((m) => (m as { type?: unknown }).type)).toContain('restoreMessagesZ');
    // ...and the shaper forgot the first page's catalogue: the returning page's
    // picker is served `modelOptions` again, not deduped against a page that is gone.
    const types = (p: Phone): unknown[] => p.received.map((m) => (m as { type?: unknown }).type);
    expect(types(phone)).toContain('modelOptions');
    expect(types(back)).toContain('modelOptions');
  }, 30_000);
});

describe('the chat the PHONE is reading survives a hydration', () => {
  it('keeps streaming it with no chip tap, though the desktop window is elsewhere', async () => {
    const { relay, attaches, harness, phone } = await pair(false);
    const words = (): unknown[] =>
      phone.received.filter((m) => (m as { type?: unknown }).type === 'agentText');

    // The owner moves the phone to the chat his desktop window is NOT on. That
    // tap is the ONLY thing that ever told the desk which chat to scope to.
    phone.tap('[data-session-id="chat-old"]');
    await quiet(relay, attaches);
    harness.stream({ type: 'agentText', sessionId: 'chat-old', messageId: 'm1', text: 'before' });
    await until(() => words().length >= 1, 'the first word of the chat the phone tapped');

    // A HYDRATION. `remoteController.hydrate()` calls `shaper.forget()`, which
    // nulls the phone's focus, so the fan-out falls back to the DESKTOP's active
    // chat and `remoteScope.ts` drops every word of every other one.
    relay.dropPhone();
    await until(() => attaches.length > 1, 'the reconnect to hydrate');
    await quiet(relay, attaches);

    const before = words().length;
    harness.stream({ type: 'agentText', sessionId: 'chat-old', messageId: 'm2', text: 'after' });
    // REVERT CHECK: without the page's post-hydration `remote/focus` this word
    // is dropped on the desk. The phone still gets `busy` and `turnDone`, which
    // is exactly what the owner saw — a chat that goes quiet until he taps.
    await until(() => words().length > before, 'the same chat to keep streaming after the hydration');
  }, 40_000);
});

describe('the flap rule, on the gate itself', () => {
  function gateAt(start = 1_000): { gate: HydrateGate; tick: (ms: number) => void } {
    let now = start;
    return { gate: new HydrateGate(() => now, PRESENCE_FLAP_MS), tick: (ms) => void (now += ms) };
  }

  it('opens once per socket and no more', () => {
    const { gate } = gateAt();
    gate.socket();
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
    expect(gate.take()).toBe(false);
  });

  it('a first present on a socket is not a new generation', () => {
    const { gate } = gateAt();
    gate.socket();
    expect(gate.take()).toBe(true);
    // `unknown -> present`: the socket's own generation already covered it.
    expect(gate.arrived()).toBe(false);
    expect(gate.take()).toBe(false);
  });

  it('a return 1 ms under the window is a flap', () => {
    const { gate, tick } = gateAt();
    gate.socket();
    gate.take();
    gate.absent();
    tick(PRESENCE_FLAP_MS - 1);
    expect(gate.arrived()).toBe(false);
    expect(gate.armed).toBe(false);
  });

  it('a return AT the window is a reconnect', () => {
    const { gate, tick } = gateAt();
    gate.socket();
    gate.take();
    gate.absent();
    tick(PRESENCE_FLAP_MS);
    expect(gate.arrived()).toBe(true);
    expect(gate.take()).toBe(true);
  });

  it('a phone that ASKS after a flap is served once — a reload is not a flap', () => {
    const { gate, tick } = gateAt();
    gate.socket();
    gate.take();
    gate.absent();
    tick(10);
    expect(gate.arrived()).toBe(false);
    // `remote/snapshot`: the only sentence the phone has for "I have nothing".
    gate.asked();
    expect(gate.take()).toBe(true);
    gate.asked();
    expect(gate.take()).toBe(false);
  });

  it('an ask with no flap behind it is the burst, and stays a no-op', () => {
    const { gate } = gateAt();
    gate.socket();
    expect(gate.take()).toBe(true);
    gate.asked();
    expect(gate.take()).toBe(false);
  });
});

describe('the task strip survives a reopen', () => {
  /** A view that only records, as `attachView` sees it. */
  function recorder(): { host: unknown; posted: Array<Record<string, unknown>> } {
    const posted: Array<Record<string, unknown>> = [];
    const webview = {
      options: { enableScripts: true },
      html: '',
      cspSource: '',
      onDidReceiveMessage: () => ({ dispose: () => undefined }),
      postMessage: (m: Record<string, unknown>) => { posted.push(m); return Promise.resolve(true); },
      asWebviewUri: (u: unknown) => u,
    };
    return {
      host: {
        webview,
        onDidDispose: () => ({ dispose: () => undefined }),
        reveal: () => undefined,
        dispose: () => undefined,
      },
      posted,
    };
  }

  const TODOS = [
    { id: '1', text: 'read the relay ring', status: 'completed' },
    { id: '2', text: 'cut the hydration', status: 'in_progress' },
  ];

  it('a view attached AFTER a todoUpdate is given the same list', () => {
    const harness = makePanelHarness(chats(), CUR);
    // The live post — the one path every poster (the engine's onTodoUpdate,
    // firstfold, the Claude Code strip) already goes through.
    harness.stream({ type: 'todoUpdate', sessionId: CUR, source: 'model_write', todos: TODOS });

    const view = recorder();
    harness.panel.attachView(view.host, 'chat');
    const replayed = view.posted.filter((m) => m.type === 'todoUpdate');
    expect(replayed).toEqual([
      { type: 'todoUpdate', sessionId: CUR, source: 'model_write', todos: TODOS },
    ]);
    // Only the session that has one. The other chat's strip stays empty.
    expect(replayed.every((m) => m.sessionId === CUR)).toBe(true);
  });

  it('the PHONE gets it too, and gets the newest list, not the first', () => {
    const harness = makePanelHarness(chats(), CUR);
    harness.stream({ type: 'todoUpdate', sessionId: CUR, source: 'model_write', todos: [] });
    harness.stream({ type: 'todoUpdate', sessionId: CUR, source: 'claude-code', todos: TODOS });

    const sent: Array<Record<string, unknown>> = [];
    const view = new RemoteView({ send: (m) => void sent.push(m as Record<string, unknown>) });
    harness.panel.attachView(view.host, 'chat');
    expect(sent.filter((m) => m.type === 'todoUpdate')).toEqual([
      { type: 'todoUpdate', sessionId: CUR, source: 'claude-code', todos: TODOS },
    ]);
  });
});

describe('the rebroadcasts stop at the phone', () => {
  it('drops the feed and the glidepath, and lets the picker’s two through', async () => {
    const harness = makePanelHarness(chats(), CUR);
    const sent: Array<Record<string, unknown>> = [];
    const view = new RemoteView({ send: (m) => void sent.push(m as Record<string, unknown>) });
    harness.panel.attachView(view.host, 'chat');
    sent.length = 0;

    harness.stream({ type: 'modelOptions', current: 'x', options: [{ value: 'x' }] });
    harness.stream({ type: 'modelStatus', sessionId: CUR, ok: true });
    harness.stream({ type: 'feedMessage', busKind: 'cron', payload: {}, sessionId: CUR });
    harness.stream({ type: 'glidepathData', rows: [] });
    // ...and the two the pane really does read, on the same wire.
    harness.stream({ type: 'approveUpdate', mode: 'plan', sessionId: CUR });
    harness.stream({ type: 'permModeUpdate', mode: 'default', text: 'ask' });
    await settle(2);

    // `modelOptions` / `modelStatus` are NOT denied any more: the phone mounts
    // the dashboard bundle, and its ModelPicker reads both by name. Denying
    // them silently blanked the picker the 0.4.104 device pass drove. The
    // rebroadcast they were denied for is answered by the shaper's dedupe
    // instead (remoteController.test.ts, "only when it changes").
    expect(sent.map((m) => m.type)).toEqual([
      'modelOptions', 'modelStatus', 'approveUpdate', 'permModeUpdate',
    ]);
  });
});
