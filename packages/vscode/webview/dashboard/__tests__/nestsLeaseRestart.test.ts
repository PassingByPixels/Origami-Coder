// NESTS AFTER AN EXTENSION-HOST RESTART (t-xum9r8).
//
// At a restart VS Code activates the NEW host before the OLD one exits, and the
// old host's `void releaseLease()` is lost among "Channel has been closed"
// errors. The new window's claim on the desk link's rid then finds the old
// window's record still live (< STALE_MS) and is refused. Before the fix the
// group controller said "linked in another window" and never asked again, so
// both desks went stale until the owner toggled Nests off and on.
//
// Everything here is real except the relay (LoopbackRelay) and the clock the
// lease reads: the real ownerLease.ts over one shared globalState, the real
// GroupController, real keys and frames.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoopbackRelay, settle } from './remoteLoopback';
import { GroupController } from '../../../src/remote/groupController';
import { GroupRosterStore } from '../../../src/remote/groupMembers';
import { derivePairRid } from '../../../src/remote/groupCrypto';
import { registerRemoteSeq, resetRemoteSeq } from '../../../src/remote/seqStore';
import {
  HEARTBEAT_MS,
  LEASE_KEY,
  STALE_MS,
  claimLease,
  leaseHeartbeat,
  registerOwnerLease,
  resetOwnerLease,
} from '../../../src/remote/ownerLease';
import type { SecretStore } from '../../../src/remote/pairing';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';

type Memento = { get<T>(k: string, d: T): T; update(k: string, v: unknown): PromiseLike<void> };

function memento(): Memento & { bag: Map<string, unknown> } {
  const bag = new Map<string, unknown>();
  return {
    bag,
    get: <T,>(k: string, d: T) => (bag.has(k) ? (bag.get(k) as T) : d),
    update: (k, v) => Promise.resolve(void bag.set(k, v)),
  };
}

function secrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => Promise.resolve(void map.set(k, v)),
    delete: (k) => Promise.resolve(void map.delete(k)),
  };
}

/** One LoopbackRelay per rid, which is all the real relay is. */
class RelayFleet {
  public readonly byRid = new Map<string, LoopbackRelay>();
  public relay(rid: string): LoopbackRelay {
    let found = this.byRid.get(rid);
    if (!found) this.byRid.set(rid, (found = new LoopbackRelay()));
    return found;
  }
  public connect = (url: string): RemoteSocket =>
    this.relay(decodeURIComponent(/\/r\/([^?]+)/.exec(url)?.[1] ?? '')).connect(url) as unknown as RemoteSocket;
}

interface Desk { secrets: SecretStore; roster: Memento }

function controller(desk: Desk, name: string, fleet: RelayFleet, status: string[], claim?: typeof claimLease): GroupController {
  const deps: TransportDeps = {
    connect: fleet.connect,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  return new GroupController({
    config: () => ({ enabled: true, relayUrl: 'wss://relay.test' }),
    secrets: desk.secrets,
    deps,
    deviceName: name,
    roster: new GroupRosterStore(desk.roster),
    onStatus: (text) => status.push(text),
    ...(claim ? { claim } : {}),
  });
}

function peerOnline(c: GroupController): boolean {
  const snap = c.snapshot();
  return snap.devices.some((d) => !d.self && d.online);
}

describe('Nests desk link after an extension-host restart (t-xum9r8)', () => {
  const live: GroupController[] = [];
  beforeEach(() => {
    resetOwnerLease();
    registerRemoteSeq(memento());
  });
  afterEach(() => {
    for (const c of live) c.dispose();
    live.length = 0;
    resetOwnerLease();
    resetRemoteSeq();
  });

  it('a refused group claim waits, says why, and links on the heartbeat once the old record expires', async () => {
    const fleet = new RelayFleet();
    const status: string[] = [];
    const deskA: Desk = { secrets: secrets(), roster: memento() };
    const deskB: Desk = { secrets: secrets(), roster: memento() };
    const a0 = controller(deskA, 'The 5090', fleet, status);
    const b = controller(deskB, 'MacBook', fleet, status);
    live.push(a0, b);

    // Pair the two desks (the Accept step included).
    const offer = await a0.invite();
    await settle();
    await b.join(offer.key);
    for (let i = 0; i < 50 && !a0.snapshot().joinCheck; i++) await settle();
    await a0.answerJoin(true);
    await settle();
    expect(peerOnline(a0)).toBe(true);
    const kg = (a0 as unknown as { group: { current: { kg: Uint8Array } } }).group.current.kg;
    const pairRid = await derivePairRid(kg, a0.deviceId!, b.deviceId!);

    // The OLD window on desk A holds the link's lease and beats it.
    const lease = memento();
    let clock = 1_000_000;
    registerOwnerLease(lease, 'old-window', { now: () => clock });
    expect(await claimLease(pairRid)).toBe(true);

    // RESTART. The new host activates 1 s after the old one's last beat; the old
    // one's release is lost, then it exits (its socket closes).
    clock += 1_000;
    registerOwnerLease(lease, 'new-window', { now: () => clock });
    a0.dispose();
    await settle();
    status.length = 0;
    const a1 = controller(deskA, 'The 5090', fleet, status, claimLease);
    live.push(a1);
    await a1.restore();
    await settle();

    // Refused: the old record is still live. Not a silent offline.
    expect(status.some((s) => s.includes('waiting for the previous window'))).toBe(true);
    expect(peerOnline(a1)).toBe(false);
    clock += HEARTBEAT_MS;
    await leaseHeartbeat();
    await settle();
    expect(peerOnline(a1)).toBe(false); // still inside STALE_MS: keep waiting

    // The old record goes stale. The next beat links, with no user action.
    clock += STALE_MS;
    await leaseHeartbeat();
    for (let i = 0; i < 20 && !peerOnline(a1); i++) await settle();
    expect(peerOnline(a1)).toBe(true);
    expect(peerOnline(b)).toBe(true);
    const records = lease.bag.get(LEASE_KEY) as Record<string, { windowId: string }>;
    expect(records[pairRid]?.windowId).toBe('new-window');
  }, 30_000);
});
