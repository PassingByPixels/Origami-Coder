// THE APP IS KILLED AND REOPENED — ON THE REAL PATH.
//
// The two halves of this lane meet here, and neither is provable on its own:
//
//   1. the page paints its own cached transcript with NO desktop in existence,
//      which is what "instant" means on a cold cellular link;
//   2. the desktop, told what that page holds, replays the rows it is missing
//      instead of the 80-row tail it has always sent.
//
// Everything below the harness is production: the shell's own MountGate and
// transport, a real LoopbackRelay, a real `DashboardPanel.attachView`, and the
// untouched chat bundle mounted from source. A test that stopped at "the phone
// received a message with `from` on it" would not have caught the rule that
// actually decides whether the owner SEES his transcript — `acceptsReplayedLog`
// drops a replay under rows already on screen, and an instant paint puts rows
// on screen. So the assertions are on `rows()`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: <T>(_k: string, d: T) => d, inspect: () => undefined }),
  },
  window: { activeTextEditor: undefined },
}));

import { PRESENCE_FLAP_MS } from '../../../src/remote/hydrateGate';
import { RemoteController } from '../../../src/remote/remoteController';
import { RemoteView } from '../../../src/remote/remoteView';
import { RESTORE_Z_CAP, markCaps } from '../../../src/remote/phoneCaps';
import {
  DELTA_OVERLAP,
  DESK_NONCE,
  RESTORE_DELTA_CAP,
  markSince,
} from '../../../src/remote/remoteDelta';
import { REMOTE_TAIL_MESSAGES } from '../../../src/remote/remoteTranscript';
import { parseQrPayload, type SecretStore } from '../../../src/remote/pairing';
import { registerRemoteSeq, resetRemoteSeq, type SeqMemento } from '../../../src/remote/seqStore';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';
import { expandRestore } from '../../remote/inflate';
import { LoopbackRelay } from './remoteLoopback';
import { makePanelHarness, type HarnessSession } from './remotePanelHarness';
import { bootPhone, type Phone } from './remotePhoneHarness';

const CHAT = 'session-1';

/** One long chat — the tail has to be worth cutting for the delta to mean
 *  anything, and 150 rows is what `remoteHydrateBudget.test.ts` measures. */
function longChat(): HarnessSession[] {
  return [{
    id: CHAT,
    number: 1,
    title: 'today',
    log: Array.from({ length: 150 }, (_, i) => ({
      kind: i % 2 === 0 ? 'user' : 'agent',
      text: `line ${i}`,
      timestamp: 1_700_000_000_000 + i,
    })),
  }];
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

async function until(pred: () => boolean, what: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function quiet(relay: LoopbackRelay, ms = 6_000): Promise<void> {
  const end = Date.now() + ms;
  let last = '';
  let still = 0;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 12));
    const now = String(relay.forwarded.length);
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 4) return;
  }
  throw new Error('the wire never went quiet');
}

/** Every restore the phone was handed, inflated. */
async function restores(phone: Phone): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of phone.received) {
    const plain = (await expandRestore(msg)) as Record<string, unknown>;
    if (plain?.type === 'restoreMessages') out.push(plain);
  }
  return out;
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

async function pair() {
  const relay = new LoopbackRelay();
  const harness = makePanelHarness(longChat(), CHAT);
  const attaches: number[] = [];
  const controller = new RemoteController({
    config: () => ({ enabled: true, relayUrl: 'wss://loopback' }),
    secrets: memorySecrets(),
    deps: loopbackDeps(relay),
    attach: (host) => {
      attaches.push(Date.now());
      harness.panel.attachView(host, 'chat');
    },
    deviceName: 'harness desktop',
  });
  desks.push(controller);
  const offer = await controller.pair();
  const scanned = parseQrPayload(offer.qr);
  const phone = await bootPhone({ relay, ks: scanned.ks, rid: offer.rid });
  phones.push(phone);
  await until(() => attaches.length > 0, 'the first hydration');
  await until(() => phone.rows().length > 0, 'the first transcript to paint');
  await quiet(relay);
  return { relay, harness, attaches, phone, ks: scanned.ks, rid: offer.rid };
}

describe('the transcript is on screen before any desktop exists', () => {
  it('paints from the device, on a relay no desk is attached to', async () => {
    const { phone, ks, rid } = await pair();
    // Read BEFORE the close: `close()` removes the root this queries.
    const painted = phone.rows();
    expect(painted.length).toBeGreaterThan(0);

    // THE APP IS KILLED. Its localStorage survives, and nothing else does.
    phone.close();
    document.body.innerHTML = '';

    // A relay with NO DESKTOP on it: every row below came from the device.
    const offline = new LoopbackRelay();
    const back = await bootPhone({ relay: offline, ks, rid });
    phones.push(back);
    await until(() => back.rows().length > 0, 'the cached transcript to paint with no desk');
    expect(back.rows()).toEqual(painted);
    expect(back.pinned).toBe(CHAT);
    expect(back.hasEmptyState()).toBe(false);
    // Nothing was received: there was nothing to receive it from.
    expect(await restores(back)).toEqual([]);
  }, 40_000);

  // The mode is NOT part of the transcript, and the instant paint is exactly
  // where that matters: it runs from disk BEFORE the socket opens, so a cached
  // mode would be the one on screen while the desk's real one was still in the
  // post. `remote/mode-state` is the desk's to send, once per hydration, and the
  // cache must never synthesise one.
  it('but NEVER a privilege mode: a yolo the page learned does not survive the kill', async () => {
    const { relay, harness, phone, ks, rid } = await pair();
    harness.stream({ type: 'remote/mode-state', v: 1, modes: { [CHAT]: 'yolo' } });
    await until(() => phone.mode(CHAT) === 'yolo', 'the page to adopt the desk report');
    await quiet(relay);

    phone.close();
    document.body.innerHTML = '';

    const offline = new LoopbackRelay();
    const back = await bootPhone({ relay: offline, ks, rid });
    phones.push(back);
    await until(() => back.rows().length > 0, 'the cached transcript to paint with no desk');

    expect(back.mode(CHAT)).toBe('ask');
    // Nothing came off the wire, so nothing but the cache could have said it.
    expect(back.received).toEqual([]);
  }, 40_000);
});

describe('a reconnect costs the rows it missed, not the tail', () => {
  it('hydrates the returning page with a delta, and it paints the same rows', async () => {
    const { relay, attaches, phone, ks, rid } = await pair();
    const first = await restores(phone);
    expect(first).toHaveLength(1);
    expect(first[0].messages).toHaveLength(REMOTE_TAIL_MESSAGES);
    expect(first[0].from).toBeUndefined();
    const painted = phone.rows();
    expect(painted.length).toBeGreaterThan(0);

    // Gone long enough to be a reconnect and not a flap (hydrateGate.ts).
    phone.close();
    relay.dropPhone();
    await new Promise((r) => setTimeout(r, PRESENCE_FLAP_MS + 200));
    document.body.innerHTML = '';

    const back = await bootPhone({ relay, ks, rid });
    phones.push(back);
    await until(() => attaches.length > 1, 'the reconnect to hydrate');
    await quiet(relay);

    const again = await restores(back);
    expect(again).toHaveLength(1);
    // THE POINT OF THE LANE: the desk sent the overlap and nothing else, where
    // it used to send all 80 rows of the tail again.
    expect(again[0].from).toBe(150 - DELTA_OVERLAP);
    expect(again[0].messages).toHaveLength(DELTA_OVERLAP);
    expect((again[0].messages as unknown[]).length).toBeLessThan(REMOTE_TAIL_MESSAGES);

    // ...and the owner sees the SAME transcript, not eight rows of it and not
    // eighty-eight. This is the assertion the shell's merge has to earn.
    expect(back.rows()).toEqual(painted);
    expect(back.cells()).toBe(1);
    expect(back.hasEmptyState()).toBe(false);
  }, 60_000);
});

describe('what the panel actually posts, per phone', () => {
  /** Attach the production `RemoteView` with the caps and cursor of one phone. */
  function attach(caps: readonly string[], since?: Record<string, number>, desk = DESK_NONCE): object[] {
    const sent: object[] = [];
    const view = new RemoteView({ send: (m) => void sent.push(m as object) });
    markCaps(view.webview, caps);
    if (since) markSince(view.webview, { type: 'remote/snapshot', desk, since });
    makePanelHarness(longChat(), CHAT).panel.attachView(view.host, 'chat');
    return sent;
  }

  async function restore(sent: object[]): Promise<Record<string, unknown>> {
    const z = sent.find((m) => /^restoreMessages/.test(String((m as { type?: unknown }).type)));
    return (await expandRestore(z)) as Record<string, unknown>;
  }

  it('sends the delta only to a page that declared it can splice one', async () => {
    const plain = await restore(attach([RESTORE_Z_CAP, RESTORE_DELTA_CAP], { [CHAT]: 140 }));
    expect(plain.from).toBe(140 - DELTA_OVERLAP);
    expect(plain.messages).toHaveLength(10 + DELTA_OVERLAP);
  });

  it('sends the whole tail, with no `from`, to the shipped iOS app', async () => {
    // The app carries its own copy of the phone web layer: it declares neither
    // cap, and a `from` it has no arm for would leave a hole in its transcript.
    const app = await restore(attach([], { [CHAT]: 140 }));
    expect(app.from).toBeUndefined();
    expect(app.messages).toHaveLength(REMOTE_TAIL_MESSAGES);
    expect(app.omitted).toBe(150 - REMOTE_TAIL_MESSAGES);
    // ...and a page that can inflate but not splice gets the same tail.
    const halfway = await restore(attach([RESTORE_Z_CAP], { [CHAT]: 140 }));
    expect(halfway.from).toBeUndefined();
    expect(halfway.messages).toHaveLength(REMOTE_TAIL_MESSAGES);
  });

  it('sends the whole tail when the cursor names another desk process', async () => {
    const stale = await restore(attach([RESTORE_Z_CAP, RESTORE_DELTA_CAP], { [CHAT]: 140 }, 'yesterday'));
    expect(stale.from).toBeUndefined();
    expect(stale.messages).toHaveLength(REMOTE_TAIL_MESSAGES);
  });
});
