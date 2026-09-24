// TWO DESKS, ONE PROCESS (t-rz1b14 acceptance 3 and 5).
//
// Both controllers are real: real keychains (Maps), real derivation, real
// frames, real seq marks. What is faked is the relay, and it is faked by
// LoopbackRelay — the same object the phone's hydration tests use, which
// implements the three rules of `remote_wire_spec_v1.md` §Relay rather than
// stubbing them. One relay per RID, because that is what the real one is: a
// rendezvous, not a server the desks log in to.
//
// What this proves that a unit test cannot: the joiner learns the inviter off
// the key string, the inviter learns the joiner off the join rendezvous, they
// then meet on a rid NEITHER of them was told, and each one's hello opens under
// a key derived independently on the other machine.
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { LoopbackRelay, settle } from './remoteLoopback';
import { GroupController } from '../../../src/remote/groupController';
import { GroupRosterStore } from '../../../src/remote/groupMembers';
import { registerRemoteSeq, resetRemoteSeq } from '../../../src/remote/seqStore';
import { derivePairRid } from '../../../src/remote/groupCrypto';
import type { SecretStore } from '../../../src/remote/pairing';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';

const RELAY = 'wss://relay.test';

function secrets(): SecretStore {
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

function memento(): { get<T>(k: string, d: T): T; update(k: string, v: unknown): PromiseLike<void> } {
  const bag = new Map<string, unknown>();
  return {
    get: <T,>(k: string, d: T) => (bag.has(k) ? (bag.get(k) as T) : d),
    update: (k, v) => {
      bag.set(k, v);
      return Promise.resolve();
    },
  };
}

/** One relay per rendezvous id, which is all the real relay is. */
class RelayFleet {
  public readonly byRid = new Map<string, LoopbackRelay>();

  public relay(rid: string): LoopbackRelay {
    let found = this.byRid.get(rid);
    if (!found) {
      found = new LoopbackRelay();
      this.byRid.set(rid, found);
    }
    return found;
  }

  public connect = (url: string): RemoteSocket => {
    const rid = decodeURIComponent(/\/r\/([^?]+)/.exec(url)?.[1] ?? '');
    return this.relay(rid).connect(url) as unknown as RemoteSocket;
  };
}

function deps(fleet: RelayFleet): TransportDeps {
  return {
    connect: fleet.connect,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

function desk(name: string, fleet: RelayFleet, status: string[]): GroupController {
  return new GroupController({
    config: () => ({ enabled: true, relayUrl: RELAY }),
    secrets: secrets(),
    deps: deps(fleet),
    deviceName: name,
    roster: new GroupRosterStore(memento()),
    onStatus: (text) => status.push(text),
  });
}

describe('device group — two desks over a loopback relay', () => {
  let fleet: RelayFleet;
  let status: string[];
  let deskA: GroupController;
  let deskB: GroupController;

  beforeEach(() => {
    // The seq marks are per RID, so one store serves both desks here exactly as
    // one globalState serves one machine.
    registerRemoteSeq(memento());
    fleet = new RelayFleet();
    status = [];
    deskA = desk('The 5090', fleet, status);
    deskB = desk('Surface', fleet, status);
  });

  afterEach(() => {
    deskA.dispose();
    deskB.dispose();
    resetRemoteSeq();
  });

  async function pair(): Promise<string> {
    const offer = await deskA.invite();
    await settle();
    await deskB.join(offer.key);
    // t-sj32zl: the inviting desk's owner accepts before the welcome is sent.
    for (let i = 0; i < 50 && !deskA.snapshot().joinCheck; i++) await settle();
    await deskA.answerJoin(true);
    await settle();
    return offer.key;
  }

  // ONE PAIRING, several questions. The phone lane's presence suite next door
  // is timing-sensitive under full-suite CPU contention (its own header records
  // the incident), so this file pays for as few real sockets as it can: the
  // read-only assertions share one handshake and only the two tests that CHANGE
  // the group pay for their own.
  it('says hello BOTH ways, on opposite roles, on a rid neither desk was told', async () => {
    await pair();
    const a = deskA.snapshot();
    const b = deskB.snapshot();
    expect(a.deviceId).toBeTruthy();
    expect(b.deviceId).toBeTruthy();

    // Each desk lists the other, and lists it ONLINE — which only a hello that
    // opened under the pairwise key can make true.
    const peerOfA = a.devices.find((d) => d.id === b.deviceId);
    const peerOfB = b.devices.find((d) => d.id === a.deviceId);
    expect(peerOfA, 'desk A never learned desk B').toBeTruthy();
    expect(peerOfB, 'desk B never learned desk A').toBeTruthy();
    expect(peerOfA!.online).toBe(true);
    expect(peerOfB!.online).toBe(true);
    // ...and each one shows the name the OTHER machine announced.
    expect(peerOfA!.name).toBe('Surface');
    expect(peerOfB!.name).toBe('The 5090');

    // The pairwise rid is a THIRD rendezvous: not the join one, and used by both.
    const pairRid = await derivePairRid(
      (await (deskA as unknown as { group: { current: { kg: Uint8Array } } }).group.current!.kg),
      a.deviceId!,
      b.deviceId!,
    );
    expect(fleet.byRid.has(pairRid)).toBe(true);
    expect(fleet.relay(pairRid).forwarded.length).toBeGreaterThanOrEqual(2);

    // Both relay roles are occupied. If the device-id order rule were wrong,
    // both desks would have claimed ONE role and evicted each other for ever.
    const roles = new Set(fleet.relay(pairRid).forwarded.map((f) => f.role));
    expect([...roles].sort()).toEqual([1, 2]);

    // The mother base is LOCAL. Desk B hears the claim in the hello and still
    // does not draw it: a machine that could claim to be the home device could
    // claim to hold the sessions that go with it.
    await deskA.markMotherBase(a.deviceId!);
    expect(deskA.snapshot().devices.find((d) => d.id === a.deviceId)!.motherBase).toBe(true);
    expect(deskB.snapshot().devices.every((d) => !d.motherBase)).toBe(true);
  });

  it('evicts a stale socket: a third claim on the same rid and role closes 4001', async () => {
    await pair();
    const ids = [deskA.snapshot().deviceId!, deskB.snapshot().deviceId!].sort();
    const kg = (deskA as unknown as { group: { current: { kg: Uint8Array } } }).group.current!.kg;
    const relay = fleet.relay(await derivePairRid(kg, ids[0]!, ids[1]!));
    status.length = 0;
    // A second window on the lower-id machine restores the same group.
    relay.open(1, 0);
    await settle();
    expect(status.some((s) => /stopped .*another desktop claimed this pairing/.test(s))).toBe(true);
  });

  it('a desk that kept the old Kg lands on a rendezvous nobody is on', async () => {
    await pair();
    const before = new Set(fleet.byRid.keys());
    // The owner forgets the group on desk A and invites again: new Kg.
    await deskA.forget();
    await deskA.invite();
    await settle();
    const joinRids = [...fleet.byRid.keys()].filter((r) => !before.has(r));
    expect(joinRids.length).toBe(1);
    // Desk B still holds the OLD Kg, so its links are all on the old rids and
    // the new invitation's rendezvous has exactly one socket on it: desk A's.
    expect(fleet.relay(joinRids[0]!).forwarded.length).toBe(0);
  });
});
