// TWO VS CODE WINDOWS, ONE PHONE — the whole bug, end to end.
//
// remoteOwnerLease.test.ts proves the lease arithmetic. This file proves the
// thing the owner actually reported: with two windows open, exactly one of them
// opens a relay socket, the other says so instead of sitting on "reconnecting",
// Take over moves the phone, and closing the owner hands it back.
//
// It drives the REAL RemoteController against a fake socket factory, so "the
// second window does not open a socket" is asserted against the factory rather
// than against a flag. Both windows share one `globalState`, which is what
// VS Code's really is.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimLease,
  registerOwnerLease,
  releaseLease,
  resetOwnerLease,
  type LeaseStore,
} from '../../../src/remote/ownerLease';
import {
  noteRemoteStatus,
  registerRemoteControl,
  remoteSnapshot,
  remoteTakeOver,
  resetRemoteControl,
} from '../../../src/remote/control';
import { RemoteController } from '../../../src/remote/remoteController';
import { SECRET_CONFIRMED, SECRET_KS, LEGACY_PIN_SECRET, type SecretStore } from '../../../src/remote/pairing';
import {
  CLOSE_SUPERSEDED,
  SUPERSEDED_REASON,
  type RemoteSocket,
  type TransportDeps,
} from '../../../src/remote/transport';

/** One globalState for the machine. */
function machineStore(): LeaseStore {
  const raw = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
    update: (key: string, value: unknown) => Promise.resolve(void raw.set(key, value)),
  };
}

/** One OS keychain, holding a pairing a phone really confirmed — which is what
 *  every window restores on activation. */
function pairedSecrets(): SecretStore {
  const map = new Map<string, string>([
    [SECRET_KS, 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'],
    [LEGACY_PIN_SECRET, 'a-pin-hash'],
    [SECRET_CONFIRMED, '1699999000000'],
  ]);
  return {
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => Promise.resolve(void map.set(k, v)),
    delete: (k) => Promise.resolve(void map.delete(k)),
  };
}

interface Window {
  controller: RemoteController;
  urls: string[];
  sockets: FakeSocket[];
  statuses: string[];
}

class FakeSocket implements RemoteSocket {
  public binaryType = '';
  public onopen: (() => void) | null = null;
  public onmessage: ((ev: { data: unknown }) => void) | null = null;
  public onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  public onerror: ((ev: unknown) => void) | null = null;
  public closed: Array<number | undefined> = [];
  public send(): void {}
  public close(code?: number): void {
    this.closed.push(code);
  }
  /** What the relay does to the OLD socket when a new desktop claims the rid. */
  public evict(): void {
    this.onclose?.({ code: CLOSE_SUPERSEDED, reason: 'superseded' });
  }
}

/** A window, wired the way activate.ts wires one: the same secrets, the same
 *  lease store, and `claim` on the path to every socket. */
function openWindow(store: LeaseStore, secrets: SecretStore, id: string, gated = true): Window {
  const urls: string[] = [];
  const sockets: FakeSocket[] = [];
  const statuses: string[] = [];
  const deps: TransportDeps = {
    connect: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    // No real clock: a reconnect must be something a test SCHEDULES, so a
    // "never reconnects" assertion cannot pass by being too quick to look.
    setTimer: () => 0,
    clearTimer: () => {},
  };
  registerOwnerLease(store, id);
  const controller = new RemoteController({
    config: () => ({ enabled: true, relayUrl: 'wss://relay.test' }),
    secrets,
    deps,
    attach: () => {},
    onStatus: (text) => {
      statuses.push(text);
      noteRemoteStatus(text);
    },
    ...(gated ? { claim: (rid: string) => claimLease(rid) } : {}),
  });
  registerRemoteControl({ target: () => controller, enabled: () => true });
  return { controller, urls, sockets, statuses };
}

beforeEach(() => {
  resetOwnerLease();
  resetRemoteControl();
});

describe('two windows, one pairing', () => {
  it('the SECOND window opens no socket at all, and says which state it is in', async () => {
    const store = machineStore();
    const secrets = pairedSecrets();

    const a = openWindow(store, secrets, 'window-a');
    await a.controller.restore();
    expect(a.urls).toHaveLength(1);
    expect(a.urls[0]).toContain('wss://relay.test/r/');

    const b = openWindow(store, secrets, 'window-b');
    await b.controller.restore();
    expect(b.urls).toEqual([]);
    expect(b.controller.connected).toBe(false);
    expect(b.statuses).toContain('remote: this pairing is active in another window');
    expect(remoteSnapshot().connection).toBe('other-window');
  });

  it('a 4001 on the holder is terminal: it yields, and does NOT reconnect', async () => {
    const store = machineStore();
    const secrets = pairedSecrets();
    const a = openWindow(store, secrets, 'window-a');
    await a.controller.restore();

    // Another desktop claims the rid; the relay evicts this one.
    a.sockets[0]!.evict();

    expect(a.urls).toHaveLength(1); // no second connect attempt — no loop
    expect(a.controller.connected).toBe(false);
    expect(a.statuses.some((s) => s.includes(SUPERSEDED_REASON))).toBe(true);
    // ...and it reads as the state it IS, not as a network fault.
    expect(remoteSnapshot().connection).toBe('other-window');
  });

  it('Take over moves the phone: the taker connects, the holder stands down on its next beat', async () => {
    const store = machineStore();
    const secrets = pairedSecrets();
    const a = openWindow(store, secrets, 'window-a');
    await a.controller.restore();
    const b = openWindow(store, secrets, 'window-b');
    await b.controller.restore();
    expect(b.urls).toEqual([]);

    // The pane's button, through the same seam the webview posts to.
    await remoteTakeOver();
    expect(b.urls).toHaveLength(1);
    expect(remoteSnapshot().connection).not.toBe('other-window');
    // The holder's own stand-down is the heartbeat's job and is proven in
    // remoteOwnerLease.test.ts ("the holder notices it LOST the lease"): this
    // module keeps ONE window's hold, so two live holds cannot exist in one
    // process to assert it from here.
  });

  it('the owner closing hands the pairing over — the next window claims it at once', async () => {
    const store = machineStore();
    const secrets = pairedSecrets();
    const a = openWindow(store, secrets, 'window-a');
    await a.controller.restore();
    expect(a.urls).toHaveLength(1);

    // deactivate(): release the lease, then dispose.
    await releaseLease();
    a.controller.dispose();

    const b = openWindow(store, secrets, 'window-b');
    await b.controller.restore();
    expect(b.urls).toHaveLength(1);
    expect(remoteSnapshot().connection).toBe('connecting');
  });

  // MUTATION PROOF for the gate itself. Build the second window WITHOUT the
  // claim — which is exactly what this file's fix added — and it dials the same
  // rid the first one is holding. That connect is the eviction the owner
  // reported: the relay hands the first socket 4001 and the phone follows
  // whichever window connected last.
  it('MUTATION PROOF — without the claim, the second window dials the SAME rid', async () => {
    const store = machineStore();
    const secrets = pairedSecrets();
    const a = openWindow(store, secrets, 'window-a');
    await a.controller.restore();

    const ungated = openWindow(store, secrets, 'window-b', false);
    await ungated.controller.restore();
    expect(ungated.urls).toHaveLength(1);
    expect(ungated.urls[0]).toBe(a.urls[0]!);
  });
});
