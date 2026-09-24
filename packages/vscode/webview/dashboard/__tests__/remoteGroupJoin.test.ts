// THE JOIN HANDSHAKE, v2 (t-sj32zl acceptance 1-4).
//
// Real controllers, real keychains (Maps), real derivation and real frames over
// the LoopbackRelay (one relay per rid, the three rules of the wire spec). The
// invite window's 10-minute timer is the one thing captured, so "after expiry"
// is a call, not a wait.
//
// Bugs these catch: a key that still carries Kg; a key that works a second
// time, after its window, or after a Decline; every invite on one rendezvous;
// a welcome sent before the owner clicked Accept; a Decline that carries a
// secret; and a welcome that a holder of the leaked key could open.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoopbackRelay, settle } from './remoteLoopback';
import { GroupController } from '../../../src/remote/groupController';
import { GroupRosterStore } from '../../../src/remote/groupMembers';
import { registerRemoteSeq, resetRemoteSeq } from '../../../src/remote/seqStore';
import { parseGroupKey, SECRET_KG } from '../../../src/remote/deviceGroup';
import { deriveJoinKey, deriveJoinRid, generateDeviceId } from '../../../src/remote/groupCrypto';
import { GROUP_INVITE_WINDOW_MS } from '../../../src/remote/groupInvite';
import { GroupLink } from '../../../src/remote/groupLink';
import { ephemeralKeys, openKg } from '../../../src/remote/groupWelcomeSeal';
import { b64urlEncode } from '../../../src/remote/crypto';
import { ROLE_PHONE } from '../../../src/remote/frame';
import type { SecretStore } from '../../../src/remote/pairing';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';

const RELAY = 'wss://relay.test';

function keychain(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => Promise.resolve(map.get(k)),
    store: async (k, v) => { map.set(k, v); },
    delete: async (k) => { map.delete(k); },
  };
}

function memento(): { get<T>(k: string, d: T): T; update(k: string, v: unknown): PromiseLike<void> } {
  const bag = new Map<string, unknown>();
  return { get: <T,>(k: string, d: T) => (bag.has(k) ? (bag.get(k) as T) : d), update: async (k, v) => { bag.set(k, v); } };
}

class RelayFleet {
  public readonly byRid = new Map<string, LoopbackRelay>();
  public relay(rid: string): LoopbackRelay {
    let found = this.byRid.get(rid);
    if (!found) this.byRid.set(rid, (found = new LoopbackRelay()));
    return found;
  }
  public connect = (url: string): RemoteSocket => {
    const rid = decodeURIComponent(/\/r\/([^?]+)/.exec(url)?.[1] ?? '');
    return this.relay(rid).connect(url) as unknown as RemoteSocket;
  };
}

interface Desk { ctl: GroupController; keys: ReturnType<typeof keychain>; expire: Array<() => void> }

function deps(fleet: RelayFleet, expire: Array<() => void>): TransportDeps {
  return {
    connect: fleet.connect,
    // The invite window is captured; every other timer (reconnect) is real.
    setTimer: (fn, ms) => (ms === GROUP_INVITE_WINDOW_MS ? (expire.push(fn), -1) : setTimeout(fn, ms)),
    clearTimer: (h) => { if (h !== -1) clearTimeout(h as ReturnType<typeof setTimeout>); },
  };
}

function desk(name: string, fleet: RelayFleet): Desk {
  const keys = keychain();
  const expire: Array<() => void> = [];
  const ctl = new GroupController({
    config: () => ({ enabled: true, relayUrl: RELAY }), secrets: keys, deps: deps(fleet, expire), deviceName: name,
    roster: new GroupRosterStore(memento()),
  });
  return { ctl, keys, expire };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await settle(2);
  expect(cond(), what).toBe(true);
}

const kgOf = (d: Desk) => (d.ctl as unknown as { group: { current: { kg: Uint8Array } | null } }).group.current?.kg ?? null;

describe('device group — the v2 join handshake (t-sj32zl)', () => {
  let fleet: RelayFleet;
  let A: Desk;
  let B: Desk;
  let C: Desk;

  beforeEach(() => {
    registerRemoteSeq(memento());
    fleet = new RelayFleet();
    A = desk('The 5090', fleet);
    B = desk('Surface', fleet);
    C = desk('Thief', fleet);
  });

  afterEach(() => {
    for (const d of [A, B, C]) d.ctl.dispose();
    resetRemoteSeq();
  });

  it('the key carries a one-time secret and the inviter id, and no Kg byte string', async () => {
    const { key } = await A.ctl.invite();
    const kg = kgOf(A)!;
    const parsed = parseGroupKey(key);
    expect(parsed.inviterId).toBe(A.ctl.deviceId);
    expect(parsed.secret).toHaveLength(16);
    expect(key).not.toContain(b64urlEncode(kg));
    // No 16-byte window of Kg appears in the secret either.
    for (let i = 0; i + 16 <= kg.length; i++) expect([...parsed.secret]).not.toEqual([...kg.slice(i, i + 16)]);
  });

  it('a second invite from the same desk opens a different rendezvous', async () => {
    const first = parseGroupKey((await A.ctl.invite()).key);
    const second = parseGroupKey((await A.ctl.invite()).key);
    const ridOne = await deriveJoinRid(first.secret, first.inviterId);
    const ridTwo = await deriveJoinRid(second.secret, second.inviterId);
    expect(ridTwo).not.toBe(ridOne);
    expect(fleet.byRid.has(ridOne) && fleet.byRid.has(ridTwo)).toBe(true);
  });

  it('Kg travels only after Accept; both desks show the joining desk and ONE code', async () => {
    const { key } = await A.ctl.invite();
    await B.ctl.join(key);
    await until(() => A.ctl.snapshot().joinCheck !== null, 'A shows the request');
    const onA = A.ctl.snapshot().joinCheck!;
    const onB = B.ctl.snapshot().joinCheck!;
    expect(onA).toMatchObject({ side: 'inviter', name: 'Surface' });
    expect(onB).toMatchObject({ side: 'joiner', name: 'Surface' });
    expect(onA.code).toMatch(/^\d{3} \d{3}$/);
    expect(onB.code).toBe(onA.code);
    // Waiting for the owner: nothing secret has reached B, and A lists nobody new.
    await settle(10);
    expect(B.keys.map.has(SECRET_KG)).toBe(false);
    expect(B.ctl.snapshot().active).toBe(false);
    expect(A.ctl.snapshot().devices).toHaveLength(1);

    await A.ctl.answerJoin(true);
    await until(() => kgOf(B) !== null, 'B holds the group secret');
    expect([...kgOf(B)!]).toEqual([...kgOf(A)!]);
    await until(() => B.ctl.snapshot().devices.some((d) => d.id === A.ctl.deviceId && d.online), 'B sees A online');
    // Single use: the invite and the wait are both gone.
    expect(A.ctl.snapshot().inviteKey).toBe(null);
    expect(A.ctl.snapshot().joinCheck).toBe(null);
    expect(B.ctl.snapshot().joinCheck).toBe(null);
  });

  it('a key used once cannot join again', async () => {
    const { key } = await A.ctl.invite();
    await B.ctl.join(key);
    await until(() => A.ctl.snapshot().joinCheck !== null, 'A shows the request');
    await A.ctl.answerJoin(true);
    await until(() => kgOf(B) !== null, 'B joined');
    await C.ctl.join(key);
    await settle(30);
    expect(kgOf(C)).toBe(null);
    expect(C.keys.map.has(SECRET_KG)).toBe(false);
    expect(A.ctl.snapshot().joinCheck).toBe(null);
    expect(A.ctl.snapshot().devices.map((d) => d.name).sort()).toEqual(['Surface', 'The 5090']);
  });

  it('a key cannot join after the window ran out', async () => {
    const { key } = await A.ctl.invite();
    A.expire.shift()!();
    expect(A.ctl.snapshot().inviteKey).toBe(null);
    await B.ctl.join(key);
    await settle(30);
    expect(A.ctl.snapshot().joinCheck).toBe(null);
    expect(kgOf(B)).toBe(null);
    // B's own wait runs out too, and says so.
    B.expire.shift()!();
    expect(B.ctl.snapshot().joinCheck).toBe(null);
    expect(B.ctl.snapshot().joinNotice).toMatch(/No answer in 10 minutes/);
  });

  it('Decline tells the joiner, sends no secret, and the key is dead after it', async () => {
    const { key } = await A.ctl.invite();
    await B.ctl.join(key);
    await until(() => A.ctl.snapshot().joinCheck !== null, 'A shows the request');
    await A.ctl.answerJoin(false);
    await until(() => B.ctl.snapshot().joinNotice !== null, 'B hears the decline');
    expect(B.ctl.snapshot().joinNotice).toMatch(/declined/);
    expect(kgOf(B)).toBe(null);
    expect(A.ctl.snapshot().inviteKey).toBe(null);
    await C.ctl.join(key);
    await settle(30);
    expect(A.ctl.snapshot().joinCheck).toBe(null);
    expect(kgOf(C)).toBe(null);
  });

  it('refuses a v1 key, which carried Kg, by name', async () => {
    await expect(B.ctl.join(`origami-group-v1.${b64urlEncode(new Uint8Array(32))}.AAAAAAAAAAA`))
      .rejects.toThrow('This key is from an older Origami Code; make a new invite');
  });

  describe('what crosses the join rendezvous, read by a hand-made joiner', () => {
    async function joiner(key: string, got: Array<Record<string, unknown>>) {
      const { secret, inviterId } = parseGroupKey(key);
      const link = new GroupLink({
        relayUrl: RELAY, rid: await deriveJoinRid(secret, inviterId), key: await deriveJoinKey(secret, inviterId),
        role: ROLE_PHONE, deps: deps(fleet, []), onMessage: (m) => void got.push(m),
      });
      link.start();
      const mine = await ephemeralKeys();
      const id = generateDeviceId();
      await link.send({ type: 'group/join', from: id, name: 'Hand', pub: b64urlEncode(mine.pub) });
      return { link, mine, id, secret };
    }

    it('Decline: one group/declined, and no key material in it', async () => {
      const got: Array<Record<string, unknown>> = [];
      const { link } = await joiner((await A.ctl.invite()).key, got);
      await until(() => A.ctl.snapshot().joinCheck !== null, 'A shows the request');
      await A.ctl.answerJoin(false);
      await until(() => got.length > 0, 'the joiner hears the answer');
      expect(got).toEqual([{ type: 'group/declined', from: A.ctl.deviceId }]);
      expect(JSON.stringify(got)).not.toContain(b64urlEncode(kgOf(A)!));
      link.stop();
    });

    it('Accept: Kg is not in the welcome in the clear, and only the asking desk\'s key opens it', async () => {
      const got: Array<Record<string, unknown>> = [];
      const { link, mine, id, secret } = await joiner((await A.ctl.invite()).key, got);
      await until(() => A.ctl.snapshot().joinCheck !== null, 'A shows the request');
      await A.ctl.answerJoin(true);
      await until(() => got.some((m) => m['type'] === 'group/welcome'), 'the welcome arrives');
      const welcome = got.find((m) => m['type'] === 'group/welcome')!;
      const kg = kgOf(A)!;
      expect(JSON.stringify(welcome)).not.toContain(b64urlEncode(kg));
      expect([...(await openKg(welcome, mine, id, secret))!]).toEqual([...kg]);
      // A thief with the leaked key has the secret and the join key, so it can
      // read this frame off the relay ring. It still cannot open Kg.
      expect(await openKg(welcome, await ephemeralKeys(), id, secret)).toBe(null);
      link.stop();
    });
  });
});
