// @vitest-environment node
//
// Origami Remote — the pairing handshake against the REAL hosted relay.
//
// Every other remote test fakes at least one of the three lanes. This one fakes
// nothing but the phone's UI: a real RemoteController, a real WebSocket to
// wss://relay.origamilabs.nl, and a scripted phone that derives its key from
// the QR the desktop just minted and seals a real `remote/hello`.
//
// It exists for ONE claim that no offline test can make: with a live relay the
// desktop's own socket opens in milliseconds, so `connected` is true almost
// immediately after Show code — and the pairing must STILL read as unconfirmed
// until the phone answers. That is the bug this lane fixes, and it only shows
// itself against a relay that is actually up.
//
// OFF BY DEFAULT. The suite must stay offline and deterministic, so this file
// skips unless ORIGAMI_REMOTE_RELAY_E2E=1 is set. It writes nothing to disk,
// touches no SecretStorage, and leaves no pairing behind: the rid is random,
// the offer is revoked in the finally, and the relay is told nothing about who
// ran it.
import { describe, expect, it, vi } from 'vitest';

// DashboardPanel is imported by the hand-over test below, for the REAL
// hydration. Nothing else in this file touches vscode.
vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: <T,>(_k: string, d: T) => d, inspect: () => undefined }),
  },
  window: { activeTextEditor: undefined },
}));
import { REPAIR_TEXT } from '../../remote/repair';
import { deriveKey } from '../../../src/remote/crypto';
import { ROLE_PHONE } from '../../../src/remote/frame';
import { FrameCodec } from '../../../src/remote/frameCodec';
import { claimLease, registerOwnerLease, resetOwnerLease, takeLease, type LeaseStore } from '../../../src/remote/ownerLease';
import { registerRemoteSeq, resetRemoteSeq, type SeqMemento } from '../../../src/remote/seqStore';
import { makePanelHarness } from './remotePanelHarness';
import { fakeDevice, openPhonePage, type PhonePage } from './remoteLivePhone';
import { b64urlEncode } from '../../../src/remote/crypto';
import { SECRET_DEVICE } from '../../../src/remote/deviceAuth';
import {
  PairingManager,
  SECRET_CONFIRMED,
  parseQrPayload,
  type SecretStore,
} from '../../../src/remote/pairing';
import { RemoteController } from '../../../src/remote/remoteController';
import { SUPERSEDED_REASON, type RemoteSocket, type TransportDeps } from '../../../src/remote/transport';

const RELAY = process.env['ORIGAMI_REMOTE_RELAY_URL'] ?? 'wss://relay.origamilabs.nl';
const LIVE = process.env['ORIGAMI_REMOTE_RELAY_E2E'] === '1';
if (!LIVE) {
  console.warn(
    '[remoteRelayLive] SKIPPED: set ORIGAMI_REMOTE_RELAY_E2E=1 to drive the real relay ' +
      `(${RELAY}). The default suite stays offline.`,
  );
}

async function waitFor(pred: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function memorySecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => Promise.resolve(void map.set(k, v)),
    delete: (k) => Promise.resolve(void map.delete(k)),
  };
}

/** Node's global WebSocket, shimmed onto the transport's injected interface.
 *  No framing and no crypto here — those must come from the production lanes
 *  or the test proves nothing. */
function liveDeps(urls: string[], sockets: WebSocket[] = [], sent = { frames: 0 }): TransportDeps {
  return {
    connect: (url) => {
      urls.push(url);
      const ws = new WebSocket(url);
      sockets.push(ws);
      ws.binaryType = 'arraybuffer';
      const shim: RemoteSocket = {
        binaryType: 'arraybuffer',
        send: (data) => {
          sent.frames++;
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
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

describe.skipIf(!LIVE)('remote pairing — against the LIVE relay', () => {
  it('a shown code is PENDING while the desktop socket is open, and only a hello pairs it', async () => {
    const secrets = memorySecrets();
    const urls: string[] = [];
    const attaches: unknown[] = [];
    const statuses: string[] = [];
    const controller = new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY }),
      secrets,
      deps: liveDeps(urls),
      attach: (host) => void attaches.push(host),
      onStatus: (s) => statuses.push(s),
      deviceName: 'relay-e2e',
    });

    let phoneWs: WebSocket | undefined;
    try {
      const offer = await controller.pair();

      // 1. The desktop's own socket really does come up against a live relay.
      await waitFor(() => controller.connected, `the desktop socket to open on ${RELAY}`);

      // 2. ...and that is NOT a pairing. This is the whole bug: `connected` was
      //    being read as "a phone is paired", so the pane announced a device and
      //    hid the QR the owner was about to scan.
      expect(controller.connected).toBe(true);
      expect(controller.rid).toBe(offer.rid);
      expect(controller.confirmedAt).toBeNull();
      expect(attaches).toHaveLength(0);

      // 3. The phone: it gets its key from the QR the desktop minted, the way a
      //    real scan does, and seals a real remote/hello.
      const scanned = parseQrPayload(offer.qr);
      expect(scanned.rid).toBe(offer.rid);
      const phone = new FrameCodec(await deriveKey(scanned.ks), scanned.rid, ROLE_PHONE);
      phoneWs = new WebSocket(`${RELAY}/r/${encodeURIComponent(scanned.rid)}?role=phone&after=0`);
      phoneWs.binaryType = 'arraybuffer';
      await new Promise<void>((resolve, reject) => {
        phoneWs!.addEventListener('open', () => resolve());
        phoneWs!.addEventListener('error', () => reject(new Error(`the phone could not reach ${RELAY}`)));
      });
      phoneWs.send(await phone.encode(JSON.stringify({ type: 'remote/hello', v: 1, device: 'relay-e2e-phone' })));

      // 4. NOW it is a pairing — end to end, over the real relay.
      await waitFor(() => controller.confirmedAt !== null, "the phone's hello to confirm the pairing");
      expect(controller.confirmedAt).toBeGreaterThan(0);
      // The hello hydrates: a confirmed phone is handed the dashboard's view.
      await waitFor(() => attaches.length > 0, 'the dashboard to be attached to the phone');

      // 5. And it survives a reload, because it was CONFIRMED.
      const reloaded = await new PairingManager(secrets).load();
      expect(reloaded?.rid).toBe(offer.rid);
      expect(reloaded?.confirmedAt).toBe(controller.confirmedAt);

      console.warn(`[remoteRelayLive] transcript\n  relay      ${RELAY}\n  desktop    ${urls[0]}\n  statuses   ${statuses.join(' | ')}\n  confirmed  ${controller.confirmedAt}`);
    } finally {
      phoneWs?.close();
      await controller.revoke('relay e2e finished');
      controller.dispose();
    }
  }, 60_000);
});

// TWO WINDOWS, ONE RID, THE REAL RELAY.
//
// The offline tests fake the socket, so "the second window never connects" is
// asserted against a factory. This one asserts it against wss://relay.origamilabs.nl
// itself: if the lease did not hold, the relay would accept the second desktop
// and hand the first a close 4001, which is the eviction the owner reported.
describe.skipIf(!LIVE)('two desktops on one rid — against the LIVE relay', () => {
  it('the non-owner never connects, and the owner holds `open` with no 4001', async () => {
    const raw = new Map<string, unknown>();
    const machine: LeaseStore = {
      get: <T>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
      update: (key, value) => Promise.resolve(void raw.set(key, value)),
    };

    const secretsA = memorySecrets();
    const urlsA: string[] = [];
    const statusesA: string[] = [];
    resetOwnerLease();
    registerOwnerLease(machine, 'window-a');
    const owner = new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY }),
      secrets: secretsA,
      deps: liveDeps(urlsA),
      attach: () => {},
      onStatus: (s) => statusesA.push(s),
      deviceName: 'window-a',
      claim: (rid) => claimLease(rid),
    });

    let follower: RemoteController | undefined;
    try {
      const offer = await owner.pair();
      await waitFor(() => owner.connected, `window-a's socket to open on ${RELAY}`);

      // The SECOND window: same machine, same keychain, its own window id. It
      // is the pairing a phone already confirmed, so without the lease it would
      // restore and take the relay slot.
      const secretsB = memorySecrets();
      for (const key of secretsA.map.keys()) secretsB.map.set(key, secretsA.map.get(key)!);
      secretsB.map.set(SECRET_CONFIRMED, String(Date.now()));
      const urlsB: string[] = [];
      registerOwnerLease(machine, 'window-b');
      follower = new RemoteController({
        config: () => ({ enabled: true, relayUrl: RELAY }),
        secrets: secretsB,
        deps: liveDeps(urlsB),
        attach: () => {},
        onStatus: () => {},
        deviceName: 'window-b',
        claim: (rid) => claimLease(rid),
      });
      await follower.restore();

      // 1. It read the same pairing...
      expect(follower.rid).toBe(offer.rid);
      // 2. ...and opened NOTHING. No URL reached the socket factory at all.
      expect(urlsB).toEqual([]);
      expect(follower.connected).toBe(false);

      // 3. Ten seconds of the real relay, with no second desktop to evict the
      //    first: the owner stays open and is never handed a 4001.
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        expect(owner.connected).toBe(true);
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(urlsA).toHaveLength(1);
      expect(urlsB).toEqual([]);
      expect(statusesA.filter((s) => s.includes('another desktop claimed this pairing'))).toEqual([]);

      console.warn(
        `[remoteRelayLive] two-window transcript
  relay      ${RELAY}
  rid        ${offer.rid}
` +
          `  window-a   ${urlsA[0]}
  window-b   (no socket)
  statuses   ${statusesA.join(' | ')}`,
      );
    } finally {
      follower?.dispose();
      await owner.revoke('two-window relay e2e finished');
      owner.dispose();
      resetOwnerLease();
    }
  }, 90_000);
});

// THE HAND-OVER, ON THE REAL RELAY.
//
// The owner opened a second VS Code window and his phone went blank: the pill
// still said `open`, the page had nothing on it. The cause is not the lease —
// the lease worked — but the frame SEQUENCE. A window builds its FrameCodec in
// `open()`, so the window that took the pairing started at seq 1 while the
// phone's replay guard sat in the forties, and every frame it sent (the hello,
// the whole hydration, the stream after it) was thrown away as an attack.
//
// This drives the real thing: a real controller with the REAL
// `DashboardPanel.attachView` behind it, a scripted phone holding a REAL
// FrameCodec with its own replay guard, and `wss://relay.origamilabs.nl` in
// between. If the guard rejects the new owner, `phone.messages` stays empty
// and this goes red — there is no way to fake past it.
describe.skipIf(!LIVE)('hand-over — the new owner hydrates the phone, on the LIVE relay', () => {
  it('a phone paired to window A is hydrated by window B within 5 s', async () => {
    const raw = new Map<string, unknown>();
    const machine = {
      get: <T,>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
      update: (key: string, value: unknown) => Promise.resolve(void raw.set(key, value)),
    };
    resetOwnerLease();
    resetRemoteSeq();
    registerOwnerLease(machine as LeaseStore, 'window-a');
    registerRemoteSeq(machine as SeqMemento);

    const secrets = memorySecrets();
    const TRANSCRIPT = [
      { kind: 'user', text: 'what did the wrap arc land?', timestamp: 1 },
      { kind: 'agent', text: 'Three commits and one revert.', timestamp: 2 },
    ];
    const chats = () => [{ id: 'chat-1', number: 1, title: 'live-e2e', log: [...TRANSCRIPT] }];

    const harnessA = makePanelHarness(chats(), 'chat-1');
    const statusesA: string[] = [];
    const windowA = new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY }),
      secrets,
      deps: liveDeps([]),
      attach: (host) => harnessA.panel.attachView(host, 'chat'),
      onStatus: (s) => statusesA.push(s),
      deviceName: 'window-a',
      claim: (rid) => claimLease(rid),
    });

    let ws: WebSocket | undefined;
    let windowB: RemoteController | undefined;
    try {
      const offer = await windowA.pair();
      const scanned = parseQrPayload(offer.qr);
      const phone = new FrameCodec(await deriveKey(scanned.ks), scanned.rid, ROLE_PHONE);
      const messages: Array<{ type?: string }> = [];
      const rejected: string[] = [];

      ws = new WebSocket(`${RELAY}/r/${encodeURIComponent(scanned.rid)}?role=phone&after=0`);
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('message', (ev) => {
        // Serialised: decodes resolve out of order and the guard is ordered.
        void (async () => {
          try {
            const { json } = await phone.decode(new Uint8Array((ev as MessageEvent).data as ArrayBuffer));
            messages.push(JSON.parse(json) as { type?: string });
          } catch (e) {
            rejected.push(e instanceof Error ? e.message : String(e));
          }
        })();
      });
      await new Promise<void>((resolve, reject) => {
        ws!.addEventListener('open', () => resolve());
        ws!.addEventListener('error', () => reject(new Error(`the phone could not reach ${RELAY}`)));
      });
      ws.send(await phone.encode(JSON.stringify({ type: 'remote/hello', v: 1, device: 'handover-e2e' })));

      // 1. Window A hydrates it, over the real relay.
      await waitFor(() => messages.some((m) => m.type === 'restoreMessages'), "window A's hydration");
      const fromA = messages.length;

      // 2. The owner opens a second window and presses Take over. A stands down
      //    the way `activateRemote`'s onLost hook makes it.
      windowA.dispose();
      const harnessB = makePanelHarness(chats(), 'chat-1');
      registerOwnerLease(machine as LeaseStore, 'window-b');
      await takeLease(offer.rid);
      windowB = new RemoteController({
        config: () => ({ enabled: true, relayUrl: RELAY }),
        secrets,
        deps: liveDeps([]),
        attach: (host) => harnessB.panel.attachView(host, 'chat'),
        deviceName: 'window-b',
        claim: (rid) => claimLease(rid),
      });
      await windowB.restore();

      // 3. Within five seconds the phone has a FULL hydration from B — and it
      //    ACCEPTED it: a rejected frame never reaches `messages`.
      await waitFor(
        () => messages.slice(fromA).some((m) => m.type === 'restoreMessages'),
        "window B's hydration to reach the phone",
        5_000,
      );
      const fromB = messages.slice(fromA);
      expect(fromB.map((m) => m.type)).toContain('modelStatus');
      expect(fromB.map((m) => m.type)).toContain('sessionCreated');
      expect(fromB.map((m) => m.type)).toContain('restoreActiveSession');
      const restore = fromB.find((m) => m.type === 'restoreMessages') as { messages?: unknown[] };
      // Non-empty: the owner gets his transcript back, not a blank page.
      expect(restore.messages).toHaveLength(2);
      expect(rejected.filter((r) => r.includes('not newer'))).toEqual([]);

      console.warn(
        `[remoteRelayLive] hand-over transcript
  relay      ${RELAY}
  rid        ${offer.rid}
` +
          `  from A     ${fromA} messages
  from B     ${fromB.map((m) => m.type).join(', ')}
` +
          `  rejected   ${rejected.length === 0 ? 'none' : rejected.join(' | ')}`,
      );
    } finally {
      ws?.close();
      await (windowB ?? windowA).revoke('hand-over relay e2e finished');
      windowB?.dispose();
      windowA.dispose();
      resetOwnerLease();
      resetRemoteSeq();
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// REVOKE, THEN PAIR AGAIN — the owner's first report.
//
// "After Revoke the new QR shows, the phone page cycles connecting/open, and
// the desktop pill never reaches paired." Everything offline says this must
// work: the rid is new, the key is new, the seq marks for a rid nobody has
// used are zero. So drive it on the real relay with the REAL phone lane and
// watch what actually happens.
describe.skipIf(!LIVE)('revoke then pair again — on the LIVE relay', () => {
  it('the next phone pairs and is hydrated, with no reconnect cycling', async () => {
    const raw = new Map<string, unknown>();
    const machine = {
      get: <T,>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
      update: (key: string, value: unknown) => Promise.resolve(void raw.set(key, value)),
    };
    resetOwnerLease();
    resetRemoteSeq();
    registerOwnerLease(machine as LeaseStore, 'window-a');
    registerRemoteSeq(machine as SeqMemento);

    const secrets = memorySecrets();
    const chats = () => [
      { id: 'chat-1', number: 1, title: 'revoke-repair', log: [{ kind: 'user', text: 'still there?', timestamp: 1 }] },
    ];
    const harness = makePanelHarness(chats(), 'chat-1');
    const statuses: string[] = [];
    const controller = new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY }),
      secrets,
      deps: liveDeps([]),
      attach: (host) => harness.panel.attachView(host, 'chat'),
      onStatus: (s) => statuses.push(s),
      deviceName: 'window-a',
      claim: (rid) => claimLease(rid),
    });

    let first: PhonePage | undefined;
    let second: PhonePage | undefined;
    try {
      const offer1 = await controller.pair();
      const scan1 = parseQrPayload(offer1.qr);
      // ONE device across both pairings: the owner rescans with the same phone,
      // so the same localStorage carries into the second pairing.
      const device = fakeDevice();
      first = await openPhonePage({ relay: RELAY, rid: scan1.rid, ks: scan1.ks, device, deviceName: 'iPhone' });
      await waitFor(() => controller.confirmedAt !== null, 'the first phone to pair');
      await waitFor(() => first!.messages.some((m) => m.type === 'restoreMessages'), 'the first hydration');

      // The owner presses Revoke, then Pair.
      await controller.revoke('revoked from the Remote pane');
      const offer2 = await controller.pair();
      expect(offer2.rid).not.toBe(offer1.rid);
      expect(controller.confirmedAt).toBeNull();

      const scan2 = parseQrPayload(offer2.qr);
      second = await openPhonePage({ relay: RELAY, rid: scan2.rid, ks: scan2.ks, device, deviceName: 'iPhone' });

      await waitFor(() => controller.confirmedAt !== null, 'the SECOND phone to pair after a revoke', 5_000);
      await waitFor(
        () => second!.messages.some((m) => m.type === 'restoreMessages'),
        'the second hydration to reach the phone',
        5_000,
      );
      // The cycling the owner saw: one socket, opened once, is the whole story.
      expect(second.opens).toBe(1);
      expect(second.statuses.filter((s) => s === 'closed')).toEqual([]);

      console.warn(
        `[remoteRelayLive] revoke-repair transcript
  rid 1      ${offer1.rid}
  rid 2      ${offer2.rid}
  phone 2    opens=${second.opens} statuses=${second.statuses.join(',')} msgs=${second.messages.map((m) => m.type).join(',')}
  rejects    ${second.rejects.length === 0 ? 'none' : second.rejects.join(' | ')}
  desktop    ${statuses.join(' | ')}`,
      );
    } finally {
      first?.close();
      second?.close();
      await controller.revoke('revoke-repair relay e2e finished');
      controller.dispose();
      resetOwnerLease();
      resetRemoteSeq();
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// THE SAME REVOKE, WITH A SECOND WINDOW ALIVE THROUGH IT.
//
// The owner runs more than one VS Code window, they share ONE SecretStorage and
// ONE globalState, and `globalState` does not propagate between windows the
// instant it is written. So the second window is the first suspect for a
// re-pair that never lands: if it restored the new pairing and opened a socket
// of its own, the relay's one-socket rule would evict the window holding the QR.
describe.skipIf(!LIVE)('revoke then pair with a second window alive — on the LIVE relay', () => {
  it('the second window opens nothing and the new phone still pairs with the first', async () => {
    const raw = new Map<string, unknown>();
    const machine = {
      get: <T,>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
      update: (key: string, value: unknown) => Promise.resolve(void raw.set(key, value)),
    };
    resetOwnerLease();
    resetRemoteSeq();
    registerRemoteSeq(machine as SeqMemento);
    // ONE keychain, as a real machine has: window B reads whatever A last wrote.
    const secrets = memorySecrets();
    const chats = () => [
      { id: 'chat-1', number: 1, title: 'two-window-repair', log: [{ kind: 'user', text: 'ping', timestamp: 1 }] },
    ];
    const harnessA = makePanelHarness(chats(), 'chat-1');
    const statusesA: string[] = [];
    const urlsB: string[] = [];

    registerOwnerLease(machine as LeaseStore, 'window-a');
    const windowA = new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY }),
      secrets,
      deps: liveDeps([]),
      attach: (host) => harnessA.panel.attachView(host, 'chat'),
      onStatus: (s) => statusesA.push(s),
      deviceName: 'window-a',
      claim: (rid) => claimLease(rid),
    });
    const windowB = new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY }),
      secrets,
      deps: liveDeps(urlsB),
      attach: () => {},
      onStatus: () => {},
      deviceName: 'window-b',
      // The lease module is a per-PROCESS singleton, so a second window is
      // modelled by naming it around the call — the same trick the two-desktop
      // test above uses. `claim` is the only place the id is read.
      claim: async (rid) => {
        registerOwnerLease(machine as LeaseStore, 'window-b');
        const ok = await claimLease(rid);
        registerOwnerLease(machine as LeaseStore, 'window-a');
        return ok;
      },
    });

    let phone: PhonePage | undefined;
    try {
      const first = await windowA.pair();
      const scan1 = parseQrPayload(first.qr);
      const device = fakeDevice();
      const p1 = await openPhonePage({ relay: RELAY, rid: scan1.rid, ks: scan1.ks, device });
      await waitFor(() => windowA.confirmedAt !== null, 'the first phone to pair');
      // Window B comes up on the pairing A owns and stands down.
      await windowB.restore();
      expect(urlsB).toEqual([]);
      p1.close();

      // Revoke and re-pair in A, with B still alive.
      await windowA.revoke('revoked from the Remote pane');
      const second = await windowA.pair();
      // ...and B tries again, the way a window does when it is nudged.
      await windowB.restore();

      const scan2 = parseQrPayload(second.qr);
      phone = await openPhonePage({ relay: RELAY, rid: scan2.rid, ks: scan2.ks, device });
      await waitFor(() => windowA.confirmedAt !== null, 'the new phone to pair with window A', 5_000);
      await waitFor(
        () => phone!.messages.some((m) => m.type === 'restoreMessages'),
        'window A to hydrate the new phone',
        5_000,
      );
      // B never took the slot, so A was never handed a 4001.
      expect(urlsB).toEqual([]);
      expect(statusesA.filter((s) => s.includes(SUPERSEDED_REASON))).toEqual([]);
      expect(phone.opens).toBe(1);

      console.warn(
        `[remoteRelayLive] two-window repair transcript
  rid 1      ${first.rid}
  rid 2      ${second.rid}
  window-b   ${urlsB.length === 0 ? 'no socket' : urlsB.join(', ')}
  phone      opens=${phone.opens} msgs=${phone.messages.map((m) => m.type).join(',')}
  window-a   ${statusesA.join(' | ')}`,
      );
    } finally {
      phone?.close();
      windowB.dispose();
      await windowA.revoke('two-window repair e2e finished');
      windowA.dispose();
      resetOwnerLease();
      resetRemoteSeq();
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// THE PAGE THAT CAME BACK LONG AFTER THE RING FORGOT IT.
//
// The owner closed the phone page and opened it an hour later: no transcript,
// "as if the pairing were temporary". An hour is far outside the relay's replay
// ring, so the reopened page cannot be caught up by `?after=` — it must be
// hydrated by the DESKTOP, off the back of the `remote/hello` and
// `remote/snapshot` it sends on every open.
//
// The ring evicts by COUNT as well as by age (256 frames, 10 minutes, whichever
// bites first) through the same `evict()`, so this drives the count: 300 frames
// while the page is away puts the phone's `after=` behind everything the relay
// still holds, in seconds instead of eleven minutes. The device — the
// localStorage carrying Ks and the seq marks — is the SAME object across the
// two page loads, which is the whole point.
describe.skipIf(!LIVE)('a phone page reopened after the ring forgot it — on the LIVE relay', () => {
  it('is hydrated by the desktop, not by the replay ring', async () => {
    const raw = new Map<string, unknown>();
    const machine = {
      get: <T,>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
      update: (key: string, value: unknown) => Promise.resolve(void raw.set(key, value)),
    };
    resetOwnerLease();
    resetRemoteSeq();
    registerRemoteSeq(machine as SeqMemento);
    const harness = makePanelHarness(
      [{ id: 'chat-1', number: 1, title: 'came-back', log: [{ kind: 'user', text: 'what did I miss?', timestamp: 1 }] }],
      'chat-1',
    );
    const statuses: string[] = [];
    const controller = new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY }),
      secrets: memorySecrets(),
      deps: liveDeps([]),
      attach: (host) => harness.panel.attachView(host, 'chat'),
      onStatus: (s) => statuses.push(s),
      deviceName: 'window-a',
    });

    let before: PhonePage | undefined;
    let after: PhonePage | undefined;
    try {
      const offer = await controller.pair();
      const scan = parseQrPayload(offer.qr);
      const device = fakeDevice();
      before = await openPhonePage({ relay: RELAY, rid: scan.rid, ks: scan.ks, device });
      await waitFor(() => controller.confirmedAt !== null, 'the phone to pair');
      await waitFor(() => before!.messages.some((m) => m.type === 'restoreMessages'), 'the first hydration');

      // The page is closed. The desktop keeps working, and the ring rolls right
      // past where this device got to.
      before.close();
      await new Promise((r) => setTimeout(r, 300));
      for (let i = 0; i < 300; i++) harness.stream({ type: 'agentDelta', sessionId: 'chat-1', text: `t${i} ` });
      await new Promise((r) => setTimeout(r, 1_000));

      // The owner opens the page again. Same device, so the same Ks and the
      // same seq marks come back out of localStorage.
      after = await openPhonePage({ relay: RELAY, rid: scan.rid, ks: scan.ks, device });
      await waitFor(
        () => after!.messages.some((m) => m.type === 'restoreMessages'),
        'the reopened page to be hydrated',
        5_000,
      );
      const restore = after.messages.find((m) => m.type === 'restoreMessages') as { messages?: unknown[] };
      expect(restore.messages).toHaveLength(1);
      expect(after.messages.map((m) => m.type)).toContain('restoreActiveSession');
      expect(after.opens).toBe(1);

      console.warn(
        `[remoteRelayLive] reopened-page transcript
  rid        ${offer.rid}
  after url  ${after.urls[0]}
  msgs       ${after.messages.map((m) => m.type).slice(0, 12).join(',')}
  rejects    ${after.rejects.length}`,
      );
    } finally {
      before?.close();
      after?.close();
      await controller.revoke('reopened-page e2e finished');
      controller.dispose();
      resetRemoteSeq();
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// THE DESKTOP'S OWN SOCKET BLIPS.
//
// The phone never learns that the desktop's socket dropped — its own is still
// open. So a reconnect on the desktop side must be invisible: the next thing
// the host posts has to reach the phone, and it has to be ACCEPTED, which is
// the seq resuming across the new socket rather than starting again.
describe.skipIf(!LIVE)("the desktop's socket drops and comes back — on the LIVE relay", () => {
  it('the phone keeps getting data, with nothing rejected as a replay', async () => {
    const raw = new Map<string, unknown>();
    const machine = {
      get: <T,>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
      update: (key: string, value: unknown) => Promise.resolve(void raw.set(key, value)),
    };
    resetOwnerLease();
    resetRemoteSeq();
    registerRemoteSeq(machine as SeqMemento);
    const harness = makePanelHarness(
      [{ id: 'chat-1', number: 1, title: 'blip', log: [{ kind: 'user', text: 'hold on', timestamp: 1 }] }],
      'chat-1',
    );
    const sockets: WebSocket[] = [];
    const controller = new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY }),
      secrets: memorySecrets(),
      deps: liveDeps([], sockets),
      attach: (host) => harness.panel.attachView(host, 'chat'),
      onStatus: () => {},
      deviceName: 'window-a',
    });

    let phone: PhonePage | undefined;
    try {
      const offer = await controller.pair();
      const scan = parseQrPayload(offer.qr);
      phone = await openPhonePage({ relay: RELAY, rid: scan.rid, ks: scan.ks, device: fakeDevice() });
      await waitFor(() => controller.confirmedAt !== null, 'the phone to pair');
      await waitFor(() => phone!.messages.some((m) => m.type === 'restoreMessages'), 'the hydration');

      // The blip: the desktop's socket dies under it, with no 4001.
      expect(sockets).toHaveLength(1);
      const beforeReconnectHydrations = phone.messages.filter((m) => (m as { type?: unknown }).type === 'remote/mode-state').length;
      sockets[0]!.close();
      await waitFor(() => sockets.length === 2, "the desktop's socket to come back", 10_000);
      await waitFor(() => controller.connected, 'the desktop to report open again', 10_000);
      // The reconnect's OWN hydration burst (hello, device-key challenge, mode
      // report — remote_wire_spec_v1.md "Hydration") must land before we race a
      // fresh delta against it, or this races the burst instead of proving
      // anything about a message sent once hydration is done (t-3j5281: this
      // was the actual bug — `controller.connected` only means the socket
      // opened, not that the burst finished; racing a delta right behind it
      // caught the mode report still in flight, same class as t-2ek0o9).
      await waitFor(
        () => phone!.messages.filter((m) => (m as { type?: unknown }).type === 'remote/mode-state').length > beforeReconnectHydrations,
        "the reconnect's own mode-state report",
        10_000,
      );

      const seen = phone.messages.length;
      harness.stream({ type: 'agentDelta', sessionId: 'chat-1', text: 'still here' });
      await waitFor(() => phone!.messages.length > seen, 'the phone to get data after the blip', 5_000);
      // The hydration burst is done, so a message queued after it is the
      // trailing frame — but a report queued behind a LIVE crypto seal
      // (remote/mode-state, remote/hello, remote/mode-challenge) is not
      // guaranteed to win a real relay hop over a plain delta queued a moment
      // later, so the assertion is the trailing SET, not one exact message
      // (t-3j5281 acceptance #3).
      const trailing = phone.messages.slice(seen);
      expect(trailing.some((m) => (m as { type?: unknown; text?: unknown }).type === 'agentDelta' && (m as { text?: unknown }).text === 'still here')).toBe(true);
      expect(trailing.every((m) => ['agentDelta', 'remote/mode-state'].includes((m as { type?: unknown }).type as string))).toBe(true);
      expect(phone.rejects.filter((r) => r.includes('replayed'))).toEqual([]);
      // The phone never noticed: one socket, still open.
      expect(phone.opens).toBe(1);

      console.warn(
        `[remoteRelayLive] desktop-blip transcript
  rid        ${offer.rid}
  desktop    ${sockets.length} sockets
  phone      opens=${phone.opens} rejects=${phone.rejects.length}
  last       ${JSON.stringify(phone.messages.at(-1))}`,
      );
    } finally {
      phone?.close();
      await controller.revoke('desktop-blip e2e finished');
      controller.dispose();
      resetRemoteSeq();
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// PRESENCE, AGAINST THE REAL RELAY (t-uttzsd).
//
// The offline fixture proves the desktop obeys the control frame. Only the
// hosted relay can prove that IT sends one, on the real socket lifecycle, and
// that the round trip from "the phone page opened" to "the transcript is on
// the phone" fits inside the five seconds the ticket asks for.
describe.skipIf(!LIVE)('presence — the desktop stops and starts with the phone, on the LIVE relay', () => {
  it('uploads nothing while no phone is attached, and hydrates within 5 s of one arriving', async () => {
    const raw = new Map<string, unknown>();
    const machine = {
      get: <T,>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
      update: (key: string, value: unknown) => Promise.resolve(void raw.set(key, value)),
    };
    resetOwnerLease();
    resetRemoteSeq();
    registerRemoteSeq(machine as SeqMemento);
    const harness = makePanelHarness(
      [{ id: 'chat-1', number: 1, title: 'presence', log: [{ kind: 'user', text: 'are you there?', timestamp: 1 }] }],
      'chat-1',
    );
    const sent = { frames: 0 };
    const statuses: string[] = [];
    const controller = new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY }),
      secrets: memorySecrets(),
      deps: liveDeps([], [], sent),
      attach: (host) => harness.panel.attachView(host, 'chat'),
      onStatus: (s) => statuses.push(s),
      deviceName: 'window-a',
    });

    let phone: PhonePage | undefined;
    try {
      const offer = await controller.pair();
      const scan = parseQrPayload(offer.qr);
      // NOBODY IS LISTENING YET. The relay has accepted the desktop's socket
      // and told it so; a whole turn's fan-out must not leave the machine.
      await waitFor(() => statuses.some((s) => s.includes('phone absent')), 'the relay to say the phone is absent');
      // LET THE OPENING FRAMES SETTLE FIRST. The desktop's hello and its
      // device-key challenge are sealed asynchronously, so `peer:absent` can
      // arrive while they are still in flight; snapshotting the counter here
      // read 0 and then counted them as if the fan-out had leaked. Observed
      // on master with the hello alone, so this is the assertion's own race.
      await new Promise((r) => setTimeout(r, 750));
      const framesBefore = sent.frames;
      for (let i = 0; i < 60; i++) harness.stream({ type: 'agentDelta', sessionId: 'chat-1', text: `t${i} ` });
      await new Promise((r) => setTimeout(r, 1_000));
      expect(sent.frames).toBe(framesBefore);

      // ...and the moment a phone attaches, the desktop resumes AND hydrates,
      // without the phone having to ask twice.
      const opened = Date.now();
      phone = await openPhonePage({ relay: RELAY, rid: scan.rid, ks: scan.ks, device: fakeDevice() });
      await waitFor(() => statuses.some((s) => s.includes('phone present')), 'the relay to say the phone is present');
      await waitFor(() => phone!.messages.some((m) => m.type === 'restoreMessages'), 'the hydration', 5_000);
      const took = Date.now() - opened;
      expect(took).toBeLessThan(5_000);
      expect(sent.frames).toBeGreaterThan(framesBefore);

      console.warn(
        `[remoteRelayLive] presence transcript
  rid        ${offer.rid}
  quiet      ${framesBefore} frames before the phone, ${sent.frames} after
  hydrated   ${took} ms after the page opened
  statuses   ${statuses.filter((s) => s.includes('phone ')).join(' | ')}`,
      );
    } finally {
      phone?.close();
      await controller.revoke('presence e2e finished');
      controller.dispose();
      resetRemoteSeq();
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// THE PHONE THAT LOST ITS SEQ MARKS (t-utufjk).
//
// Reproduced 2026-09-04: the desktop's marks were {"out":4096,"in":2} and a
// page opened with EMPTY localStorage for that rid sent its hello at seq 1.
// Both frames were rejected as replays — correctly — and NOTHING said so on
// either end. The guard is unchanged here; what is asserted is that both ends
// now speak, and that the phone speaks inside five seconds.
describe.skipIf(!LIVE)('a phone whose seq marks are gone — on the LIVE relay', () => {
  it('says "scan the QR again" within 5 s, and the desktop pane says the phone needs re-pairing', async () => {
    const raw = new Map<string, unknown>();
    const machine = {
      get: <T,>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
      update: (key: string, value: unknown) => Promise.resolve(void raw.set(key, value)),
    };
    resetOwnerLease();
    resetRemoteSeq();
    registerRemoteSeq(machine as SeqMemento);
    const harness = makePanelHarness(
      [{ id: 'chat-1', number: 1, title: 'wedged', log: [{ kind: 'user', text: 'still here?', timestamp: 1 }] }],
      'chat-1',
    );
    const statuses: string[] = [];
    const controller = new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY }),
      secrets: memorySecrets(),
      deps: liveDeps([]),
      attach: (host) => harness.panel.attachView(host, 'chat'),
      onStatus: (s) => statuses.push(s),
      deviceName: 'window-a',
    });

    let first: PhonePage | undefined;
    let forgetful: PhonePage | undefined;
    try {
      const offer = await controller.pair();
      const scan = parseQrPayload(offer.qr);
      first = await openPhonePage({ relay: RELAY, rid: scan.rid, ks: scan.ks, device: fakeDevice() });
      await waitFor(() => controller.confirmedAt !== null, 'the phone to pair');
      await waitFor(() => first!.messages.some((m) => m.type === 'restoreMessages'), 'the first hydration');
      first.close();
      await new Promise((r) => setTimeout(r, 300));

      // A FRESH device object carries no marks at all, which is what Safari's
      // ITP eviction (and a refused setItem) leaves behind. `pairingFresh:
      // false` is the other half: this load has no QR fragment, so it is
      // resuming a pairing it can no longer prove it is up to date with.
      const opened = Date.now();
      forgetful = await openPhonePage({
        relay: RELAY,
        rid: scan.rid,
        ks: scan.ks,
        device: fakeDevice(),
        pairingFresh: false,
      });
      await waitFor(() => forgetful!.notices.includes(REPAIR_TEXT), 'the phone to say it lost its pairing state', 5_000);
      expect(Date.now() - opened).toBeLessThan(5_000);

      // The desktop's half: the hello was still REJECTED as a replay (the guard
      // is untouched), and the pane was told what that means.
      await waitFor(
        () => statuses.some((s) => s.includes('needs re-pairing')),
        () => `the pane to name the re-pair (${statuses.slice(-6).join(' | ')})`,
        10_000,
      );
      expect(statuses.some((s) => s.includes('rejected a frame (replay)'))).toBe(true);
      // ...and the phone was sent the desktop's own hello carrying `reset`.
      await waitFor(
        () => forgetful!.messages.some((m) => (m as { reset?: boolean }).reset === true),
        'the reset hello to reach the phone',
        10_000,
      );

      console.warn(
        `[remoteRelayLive] lost-marks transcript
  rid        ${offer.rid}
  notice     ${Date.now() - opened} ms after the page opened
  phone      ${forgetful.notices.join(' | ')}
  desktop    ${statuses.filter((s) => s.includes('re-pair') || s.includes('replay')).join(' | ')}`,
      );
    } finally {
      first?.close();
      forgetful?.close();
      await controller.revoke('lost-marks e2e finished');
      controller.dispose();
      resetRemoteSeq();
    }
  }, 90_000);
});

// --- R-2b: THE DEVICE KEY, over the live relay ------------------------------
//
// The claim the iOS app exists to make, made against the real relay rather than
// a fake socket. Both phones run the production phone lane
// (`remoteLivePhone.ts` wires the real transport, the real seq marks and the
// real frame codec); only the Secure Enclave is a software P-256 key, which is
// exactly what the app falls back to on a simulator.
//
// WHAT THIS CANNOT PROVE, and why it is split in two. The relay keeps a per-rid
// RING and replays it to any socket that asks with a low `after`. A phone
// holding a copied Ks therefore still receives whatever the desktop ALREADY
// sent, whatever the desktop decides about NEW traffic — the gate stops the
// desktop from serving, it cannot un-send the ring. Closing that needs a relay
// change, which this lane is forbidden to make (see the lane report). So the
// impersonation scenario below runs on a pairing whose ring is EMPTY, which is
// the shape the MacBook lane demonstrated with `fake-desktop.mjs serve
// --enforce` plus `impersonate`.
describe.skipIf(!LIVE)('device identity — R-2b on the LIVE relay', () => {
  /** A phone-shaped identity: the 65-byte X9.63 point, its base64url SHA-256
   *  fingerprint, and a signer over whatever bytes the desktop asks for. */
  async function deviceKey(): Promise<{ block: Record<string, string>; fp: string; sign(p: Uint8Array): Promise<string> }> {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const pub = b64urlEncode(raw);
    const fp = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
    return {
      fp,
      block: { alg: 'ES256', pub, fp, backend: 'secure-enclave' },
      async sign(payload) {
        return b64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, payload)));
      },
    };
  }

  function deskFor(
    secrets: SecretStore & { map: Map<string, string> },
    statuses: string[],
    harness: ReturnType<typeof makePanelHarness>,
  ): RemoteController {
    const raw = new Map<string, unknown>();
    resetOwnerLease();
    resetRemoteSeq();
    registerRemoteSeq({
      get: <T,>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
      update: (key: string, value: unknown) => Promise.resolve(void raw.set(key, value)),
    } as SeqMemento);
    return new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY, capability: 'full' }),
      secrets,
      deps: liveDeps([]),
      attach: (host) => harness.panel.attachView(host, 'chat'),
      onStatus: (s) => statuses.push(s),
      deviceName: 'window-a',
    });
  }

  const SESSION = [
    { id: 'chat-1', number: 1, title: 'device key', log: [{ kind: 'user' as const, text: 'who are you?', timestamp: 1 }] },
  ];

  it('the keyed phone enrols on the confirming hello, answers the challenge and hydrates', async () => {
    const harness = makePanelHarness(SESSION, 'chat-1');
    const secrets = memorySecrets();
    const statuses: string[] = [];
    const key = await deviceKey();
    const controller = deskFor(secrets, statuses, harness);
    let app: PhonePage | undefined;
    try {
      const offer = await controller.pair();
      const scan = parseQrPayload(offer.qr);
      app = await openPhonePage({ relay: RELAY, rid: scan.rid, ks: scan.ks, device: fakeDevice(), deviceKey: key });
      await waitFor(() => app!.challenges.length > 0, 'the desktop challenge to reach the app', 15_000);
      await waitFor(
        () => statuses.some((s) => s.includes('proved the enrolled device key')),
        () => `the desktop to verify the app (${statuses.slice(-6).join(' | ')})`,
        15_000,
      );
      await waitFor(() => app!.messages.some((m) => m.type === 'restoreMessages'), 'the hydration', 15_000);

      // The key is on file, fingerprint and all, and the pane can show it.
      expect(secrets.map.has(SECRET_DEVICE)).toBe(true);
      expect(controller.device).toMatchObject({ fp: key.fp, backend: 'secure-enclave', platform: 'ios', app: '1.0 (1)' });
      // 43 characters of base64url: the challenge really was 32 bytes.
      expect(app.challenges[0]).toHaveLength(43);

      console.warn(
        `[remoteRelayLive] device-key transcript (the app)
  rid         ${offer.rid}
  fingerprint ${key.fp}
  app         ${app.challenges.length} challenge(s) answered, ${app.messages.length} messages, hydrated
  desktop     ${statuses.filter((s) => s.includes('device key') || s.includes('prove')).join(' | ')}`,
      );
    } finally {
      app?.close();
      await controller.revoke('device-key e2e finished');
      controller.dispose();
      resetRemoteSeq();
    }
  }, 120_000);

  it('a copied-Ks phone with NO key may watch and may not act', async () => {
    const harness = makePanelHarness(SESSION, 'chat-1');
    const statuses: string[] = [];
    // A page with NO device key may only WATCH since 2026-09-06, whatever this
    // desk allows. It is not held before the handshake the way an enrolled
    // phone is, so it DOES hydrate — and that is the whole of what it gets.
    const controller = deskFor(memorySecrets(), statuses, harness);
    let thief: PhonePage | undefined;
    try {
      const offer = await controller.pair();
      const scan = parseQrPayload(offer.qr);
      // A photographed QR: the same Ks, so the same rid and the same frame key,
      // and no device key at all. Nothing has been served on this rid, so what
      // reaches it is exactly what the desktop chose to send.
      thief = await openPhonePage({ relay: RELAY, rid: scan.rid, ks: scan.ks, device: fakeDevice(), deviceName: 'stolen-qr' });
      await waitFor(() => thief!.messages.length > 0, 'the desktop hello to reach the thief', 15_000);
      await new Promise((r) => setTimeout(r, 3_000));

      // It WAS challenged — it simply has no key to answer with, which is the
      // whole difference between this page and the app.
      expect(thief.challenges).toEqual([]);
      expect(controller.device).toBeNull();
      // It can READ. What it cannot do is act: a send is dropped by the desk,
      // named on the status line, and never reaches the host.
      await thief.send({ type: 'send', text: 'rm -rf /', sessionId: 'chat-1' });
      await new Promise((r) => setTimeout(r, 2_000));
      expect(harness.inbound.filter((m) => (m as { type?: string }).type === 'send')).toEqual([]);
      expect(statuses.some((t) => t.includes('refused send'))).toBe(true);

      console.warn(
        `[remoteRelayLive] device-key transcript (the thief)
  rid        ${offer.rid}
  thief      ${thief.messages.length} message(s), ${thief.challenges.length} challenge(s) answered
  desktop    ${statuses.filter((s) => s.includes('prove') || s.includes('device key')).join(' | ')}`,
      );
    } finally {
      thief?.close();
      await controller.revoke('device-key impersonation e2e finished');
      controller.dispose();
      resetRemoteSeq();
    }
  }, 120_000);
});

// SIGNED AUTHORITY (spec v1.2) over the real relay. The unit suite proves the
// bytes against the production verifier with a fake socket; what only this can
// prove is that the three new frames - the stamped `requestPermission`, the
// `remote/mode-challenge` and the signed `remote/set-mode` - survive sealing,
// chunking and the relay's ring exactly as every other message does.
describe.skipIf(!LIVE)('privilege - signed Ask and signed YOLO on the LIVE relay', () => {
  async function deviceKey(): Promise<{ block: Record<string, string>; fp: string; sign(p: Uint8Array): Promise<string> }> {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const pub = b64urlEncode(raw);
    const fp = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)));
    return {
      fp,
      block: { alg: 'ES256', pub, fp, backend: 'secure-enclave' },
      async sign(payload) {
        return b64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, payload)));
      },
    };
  }

  /** The spec's byte layout, built here from its words rather than imported. */
  function signedBytes(domain: string, nonceB64: string, fields: string[]): Uint8Array {
    const enc = new TextEncoder();
    const parts = [enc.encode(domain), new Uint8Array(Buffer.from(nonceB64, 'base64url')), ...fields.map((f) => enc.encode(f))];
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  it('a stamped ask, a signed approval and a signed YOLO all cross the relay', async () => {
    const harness = makePanelHarness(
      [{ id: 'chat-1', number: 1, title: 'privilege', log: [{ kind: 'user' as const, text: 'hello', timestamp: 1 }] }],
      'chat-1',
    );
    const secrets = memorySecrets();
    const statuses: string[] = [];
    const key = await deviceKey();
    const raw = new Map<string, unknown>();
    resetOwnerLease();
    resetRemoteSeq();
    registerRemoteSeq({
      get: <T,>(k: string, fallback: T): T => (raw.has(k) ? (raw.get(k) as T) : fallback),
      update: (k: string, value: unknown) => Promise.resolve(void raw.set(k, value)),
    } as SeqMemento);
    let view: { webview: { postMessage(m: unknown): unknown } } | undefined;
    const controller = new RemoteController({
      config: () => ({ enabled: true, relayUrl: RELAY, capability: 'full' }),
      secrets,
      deps: liveDeps([]),
      attach: (host) => {
        view = host as unknown as { webview: { postMessage(m: unknown): unknown } };
        harness.panel.attachView(host, 'chat');
      },
      onStatus: (s) => statuses.push(s),
      deviceName: 'window-a',
    });
    let app: PhonePage | undefined;
    try {
      const offer = await controller.pair();
      const scan = parseQrPayload(offer.qr);
      app = await openPhonePage({ relay: RELAY, rid: scan.rid, ks: scan.ks, device: fakeDevice(), deviceKey: key });
      await waitFor(() => statuses.some((s) => s.includes('proved the enrolled device key')), 'the app to verify', 15_000);
      await waitFor(() => view !== undefined, 'the phone view to be attached', 15_000);

      // R-1 first: the phone's own chat bundle can post this, and it must not
      // reach the host over a real socket any more than over a fake one.
      await app.send({ type: 'setApproveMode', mode: 'bypass', sessionId: 'chat-1' });
      await new Promise((r) => setTimeout(r, 1_500));
      expect(harness.inbound.filter((m) => (m as { type?: string }).type === 'setApproveMode')).toEqual([]);

      // ASK: the desktop's ask reaches the phone carrying a nonce.
      view!.webview.postMessage({ type: 'requestPermission', toolCallId: 'tc-1', kind: 'execute', command: 'ls', sessionId: 'chat-1' });
      await waitFor(() => app!.messages.some((m) => m.type === 'requestPermission'), 'the ask to reach the app', 15_000);
      const ask = app.messages.find((m) => m.type === 'requestPermission') as { approvalNonce?: string };
      expect(typeof ask.approvalNonce).toBe('string');
      expect(Buffer.from(ask.approvalNonce!, 'base64url').length).toBeGreaterThanOrEqual(16);

      await app.send({
        type: 'permission',
        toolCallId: 'tc-1',
        optionId: 'allow_once',
        sig: await key.sign(signedBytes('origami-remote/v1/approve', ask.approvalNonce!, ['tc-1', 'allow_once'])),
        pub: key.block['pub'],
        fp: key.fp,
      });
      await waitFor(
        () => harness.inbound.some((m) => (m as { type?: string }).type === 'permission'),
        'the signed approval to reach the host',
        15_000,
      );

      // YOLO: request, challenge, signed set-mode, and the host is told bypass.
      await app.send({ type: 'remote/set-mode-request', v: 1, mode: 'yolo', sessionId: 'chat-1' });
      await waitFor(() => app!.messages.some((m) => m.type === 'remote/mode-challenge'), 'the mode challenge', 15_000);
      const challenge = app.messages.find((m) => m.type === 'remote/mode-challenge') as { nonce?: string };
      expect(Buffer.from(challenge.nonce!, 'base64url').length).toBe(32);

      await app.send({
        type: 'remote/set-mode',
        v: 1,
        mode: 'yolo',
        sessionId: 'chat-1',
        sig: await key.sign(signedBytes('origami-remote/v1/set-mode', challenge.nonce!, ['chat-1', 'yolo'])),
        pub: key.block['pub'],
        fp: key.fp,
      });
      await waitFor(
        () => harness.inbound.some((m) => (m as { type?: string }).type === 'setApproveMode'),
        'the signed set-mode to reach the host',
        15_000,
      );
      expect(harness.inbound.filter((m) => (m as { type?: string }).type === 'setApproveMode')).toEqual([
        { type: 'setApproveMode', mode: 'bypass', sessionId: 'chat-1' },
      ]);
      expect(controller.modes).toMatchObject([{ sessionId: 'chat-1', mode: 'yolo', fp: key.fp }]);

      console.warn(
        `[remoteRelayLive] privilege transcript
  rid          ${offer.rid}
  fingerprint  ${key.fp}
  ask nonce    ${ask.approvalNonce} (${Buffer.from(ask.approvalNonce!, 'base64url').length} bytes)
  mode nonce   ${challenge.nonce} (${Buffer.from(challenge.nonce!, 'base64url').length} bytes)
  host saw     ${[...new Set(harness.inbound.map((m) => (m as { type?: string }).type))].join(', ')}
  desktop      ${statuses.slice(-5).join(' | ')}`,
      );
    } finally {
      app?.close();
      await controller.revoke('privilege e2e finished');
      controller.dispose();
      resetRemoteSeq();
    }
  }, 120_000);
});
