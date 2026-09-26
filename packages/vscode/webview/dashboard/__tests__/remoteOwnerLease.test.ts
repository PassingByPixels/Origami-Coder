// Origami Remote — ONE WINDOW OWNS THE PHONE.
//
// The owner runs several VS Code windows at once. Every one of them ran
// `activateRemote`, every one restored the same pairing, and the relay allows
// exactly one socket per role per rid — so they evicted each other with close
// 4001 in a loop and the phone mirrored whichever window connected last.
//
// The fix is an OWNER LEASE in `context.globalState`, which every window on the
// machine already shares. These are its tests, driven over ONE store with two
// window identities, because a test that gave each window its own store would
// prove nothing about the bug.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HEARTBEAT_MS,
  LEASE_KEY,
  STALE_MS,
  claimLease,
  leaseHeartbeat,
  ownedElsewhere,
  registerOwnerLease,
  releaseLease,
  resetOwnerLease,
  takeLease,
  type LeaseStore,
} from '../../../src/remote/ownerLease';

/** One `globalState` shared by every window on the machine, which is what
 *  VS Code's really is. */
function machineStore(): LeaseStore & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get: <T>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
    update: (key: string, value: unknown) => Promise.resolve(void raw.set(key, value)),
  };
}

const RID = 'rid-one';

/** The lease record for one rid, as it actually sits in globalState. */
function stored(store: { raw: Map<string, unknown> }, rid = RID): { windowId: string; heartbeatAt: number } {
  return (store.raw.get(LEASE_KEY) as Record<string, { windowId: string; heartbeatAt: number }>)[rid]!;
}

beforeEach(() => resetOwnerLease());

describe('remote owner lease — the claim', () => {
  it('an unheld pairing is claimed, and the record names THIS window', async () => {
    const store = machineStore();
    registerOwnerLease(store, 'window-a', { now: () => 1_000 });
    expect(await claimLease(RID)).toBe(true);
    expect(store.raw.get(LEASE_KEY)).toEqual({ [RID]: { windowId: 'window-a', heartbeatAt: 1_000 } });
  });

  it('a SECOND window with a live lease in the store is refused', async () => {
    const store = machineStore();
    registerOwnerLease(store, 'window-a', { now: () => 1_000 });
    await claimLease(RID);

    resetOwnerLease();
    registerOwnerLease(store, 'window-b', { now: () => 1_000 + STALE_MS - 1 });
    expect(await claimLease(RID)).toBe(false);
    expect(ownedElsewhere(RID)).toBe(true);
    expect(stored(store).windowId).toBe('window-a');
  });

  it('a lease nobody has beaten for STALE_MS is dead and the next window takes it', async () => {
    const store = machineStore();
    registerOwnerLease(store, 'window-a', { now: () => 1_000 });
    await claimLease(RID);

    resetOwnerLease();
    registerOwnerLease(store, 'window-b', { now: () => 1_000 + STALE_MS });
    expect(await claimLease(RID)).toBe(true);
    expect(stored(store).windowId).toBe('window-b');
  });

  it('the lease is PER RID: a second pairing is not blocked by the first', async () => {
    const store = machineStore();
    registerOwnerLease(store, 'window-a', { now: () => 1_000 });
    await claimLease(RID);
    resetOwnerLease();
    registerOwnerLease(store, 'window-b', { now: () => 1_000 });
    expect(await claimLease('rid-two')).toBe(true);
    expect(ownedElsewhere('rid-two')).toBe(false);
  });

  it('releasing hands the pairing over within one claim', async () => {
    const store = machineStore();
    registerOwnerLease(store, 'window-a', { now: () => 1_000 });
    await claimLease(RID);
    await releaseLease();
    resetOwnerLease();
    registerOwnerLease(store, 'window-b', { now: () => 1_000 });
    expect(await claimLease(RID)).toBe(true);
  });

  it('takeLease claims a LIVE lease held by another window — that is the Take over button', async () => {
    const store = machineStore();
    registerOwnerLease(store, 'window-a', { now: () => 1_000 });
    await claimLease(RID);
    resetOwnerLease();
    registerOwnerLease(store, 'window-b', { now: () => 1_001 });
    expect(await claimLease(RID)).toBe(false);
    expect(await takeLease(RID)).toBe(true);
    expect(stored(store).windowId).toBe('window-b');
  });

  it('the holder notices it LOST the lease on its next heartbeat, and says so once', async () => {
    const store = machineStore();
    let clock = 1_000;
    const lost: string[] = [];
    registerOwnerLease(store, 'window-a', { now: () => clock, onLost: (rid) => lost.push(rid) });
    await claimLease(RID);
    await store.update(LEASE_KEY, { [RID]: { windowId: 'window-b', heartbeatAt: clock } });

    clock += HEARTBEAT_MS;
    await leaseHeartbeat();
    expect(lost).toEqual([RID]);
    expect(ownedElsewhere(RID)).toBe(true);
    await leaseHeartbeat();
    expect(lost).toEqual([RID]);
  });

  it('a heartbeat REFRESHES the record so another window never reads it as stale', async () => {
    const store = machineStore();
    let clock = 1_000;
    registerOwnerLease(store, 'window-a', { now: () => clock });
    await claimLease(RID);
    clock += HEARTBEAT_MS;
    await leaseHeartbeat();
    expect(stored(store).heartbeatAt).toBe(clock);
  });

  // t-xum9r8: the phone pairing and the desk group link are TWO rids in ONE
  // window. A single `held` slot beat only the rid claimed last, so the other
  // record went stale and the two took turns being refused at each restart.
  it('one window holds and renews the phone rid AND the group rid at the same time', async () => {
    const store = machineStore();
    let clock = 1_000;
    registerOwnerLease(store, 'window-a', { now: () => clock });
    expect(await claimLease('rid-phone')).toBe(true);
    expect(await claimLease('rid-group')).toBe(true);
    for (let i = 0; i < 4; i++) {
      clock += HEARTBEAT_MS;
      await leaseHeartbeat();
    }
    expect(stored(store, 'rid-phone')).toEqual({ windowId: 'window-a', heartbeatAt: clock });
    expect(stored(store, 'rid-group')).toEqual({ windowId: 'window-a', heartbeatAt: clock });

    // A second window at this moment is refused on BOTH, not on one of them.
    resetOwnerLease();
    registerOwnerLease(store, 'window-b', { now: () => clock + 1_000 });
    expect(await claimLease('rid-phone')).toBe(false);
    expect(await claimLease('rid-group')).toBe(false);
  });

  it('a refused claim is retried on the heartbeat and granted once the record expires', async () => {
    const store = machineStore();
    let clock = 1_000;
    registerOwnerLease(store, 'window-a', { now: () => clock });
    await claimLease(RID);
    // Restart: window A's release is lost; B activates 1 s after A's last beat.
    resetOwnerLease();
    clock += 1_000;
    registerOwnerLease(store, 'window-b', { now: () => clock });
    let freed = 0;
    expect(await claimLease(RID, () => freed++)).toBe(false);
    clock += HEARTBEAT_MS;
    await leaseHeartbeat();
    expect(freed).toBe(0); // A's record is still live: keep waiting
    clock += STALE_MS;
    await leaseHeartbeat();
    expect(freed).toBe(1);
    expect(await claimLease(RID)).toBe(true);
    await leaseHeartbeat();
    expect(freed).toBe(1); // granted: the wait is over, no second call
  });

  it('a window with no store — Remote never activated — never claims another window owns it', () => {
    expect(ownedElsewhere(RID)).toBe(false);
    expect(ownedElsewhere(null)).toBe(false);
  });

  it('junk in globalState is treated as ABSENT, not trusted', async () => {
    const store = machineStore();
    await store.update(LEASE_KEY, [{ windowId: 'window-x' }]);
    registerOwnerLease(store, 'window-a', { now: () => 1_000 });
    expect(ownedElsewhere(RID)).toBe(false);
    expect(await claimLease(RID)).toBe(true);
  });

  it('a record with a non-numeric heartbeat is dead material, not an eternal lease', async () => {
    const store = machineStore();
    await store.update(LEASE_KEY, { [RID]: { windowId: 'window-x', heartbeatAt: 'soon' } });
    registerOwnerLease(store, 'window-a', { now: () => 1_000 });
    expect(ownedElsewhere(RID)).toBe(false);
    expect(await claimLease(RID)).toBe(true);
  });

  // FAIL OPEN. A Memento that accepts a write and hands back nothing (a stub, a
  // store the platform refused to persist) must not leave Remote dead in every
  // window at once — that would be a worse bug than the one the lease fixes.
  // Absent means "nobody said otherwise", and the relay's 4001 arbitrates as it
  // did before the lease existed.
  it('a store that does not persist GRANTS the claim rather than refusing every window', async () => {
    const amnesiac: LeaseStore = { get: <T>(_k: string, fallback: T): T => fallback, update: () => Promise.resolve() };
    registerOwnerLease(amnesiac, 'window-a', { now: () => 1_000 });
    expect(await claimLease(RID)).toBe(true);
    expect(ownedElsewhere(RID)).toBe(false);
  });

  // The one race globalState cannot rule out: two windows read "free" in the
  // same tick and both write. The write is followed by a RE-READ, so the loser
  // finds the winner's id in the slot and stands down instead of both opening.
  it('two windows that claim in the same tick do NOT both win', async () => {
    const store = machineStore();
    const racing: LeaseStore = {
      get: store.get,
      update: (key, value) => {
        store.raw.set(key, value);
        store.raw.set(LEASE_KEY, { [RID]: { windowId: 'window-b', heartbeatAt: 1_000 } });
        return Promise.resolve();
      },
    };
    registerOwnerLease(racing, 'window-a', { now: () => 1_000 });
    expect(await claimLease(RID)).toBe(false);
    expect(ownedElsewhere(RID)).toBe(true);
  });
});
