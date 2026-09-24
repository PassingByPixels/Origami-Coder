// Device group — minting, joining and REVOKING (t-rz1b14 acceptance 1 and 4).
//
// The SecretStore is a Map, which is the whole reason deviceGroup.ts declares
// the shape locally instead of importing vscode: what the keychain holds after
// each step is then something a test can read.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeviceGroup,
  GROUP_KEY_PREFIX,
  SECRET_DEVICE_ID,
  SECRET_KG,
  groupKeyString,
  parseGroupKey,
} from '../../../src/remote/deviceGroup';
import { derivePairRid, generateInviteSecret, generateKg, isDeviceId } from '../../../src/remote/groupCrypto';
import { b64urlEncode } from '../../../src/remote/crypto';
import {
  forgetMember,
  registerGroupMembers,
  rememberMember,
  renameMember,
  resetGroupMembers,
  roster,
  setMotherBase,
} from '../../../src/remote/groupMembers';
import type { SecretStore } from '../../../src/remote/pairing';

function store(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
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

describe('device group — mint and join', () => {
  it('mints Kg into the keychain and nowhere else, with a random device id', async () => {
    const secrets = store();
    const group = new DeviceGroup(secrets);
    const minted = await group.mint();
    expect(secrets.map.has(SECRET_KG)).toBe(true);
    expect(isDeviceId(secrets.map.get(SECRET_DEVICE_ID))).toBe(true);
    expect(minted.kg).toHaveLength(32);
    // A reload of the same keychain is the SAME identity — the rids depend on it.
    const again = await new DeviceGroup(secrets).load();
    expect(again?.deviceId).toBe(minted.deviceId);
    expect([...(again?.kg ?? [])]).toEqual([...minted.kg]);
  });

  it('carries a one-time secret AND the inviter id in one string, for the QR and the paste box', async () => {
    const group = new DeviceGroup(store());
    const minted = await group.mint();
    const secret = generateInviteSecret();
    const key = groupKeyString(secret, minted.deviceId);
    expect(key.startsWith(GROUP_KEY_PREFIX)).toBe(true);
    const parsed = parseGroupKey(key);
    expect([...parsed.secret]).toEqual([...secret]);
    expect(parsed.inviterId).toBe(minted.deviceId);
    // A key pasted out of a chat window arrives wrapped.
    expect(parseGroupKey(` ${key.slice(0, 20)}\n${key.slice(20)} `).inviterId).toBe(minted.deviceId);
  });

  it('names the fault on a key that is not one, and refuses a v1 key (it carried Kg) by name', () => {
    expect(() => parseGroupKey('hello')).toThrow(/starts with/);
    expect(() => parseGroupKey(`${GROUP_KEY_PREFIX}AAAA.AAAAAAAAAAA`)).toThrow(/16 bytes/);
    expect(() => parseGroupKey(`${GROUP_KEY_PREFIX}${'A'.repeat(22)}`)).toThrow(/device id/);
    expect(() => parseGroupKey(undefined)).toThrow(/starts with/);
    const v1 = `origami-group-v1.${b64urlEncode(generateKg())}.AAAAAAAAAAA`;
    expect(() => parseGroupKey(v1)).toThrow('This key is from an older Origami Code; make a new invite');
  });

  it('the second desk gets its OWN random id, stores nothing until the welcome, then derives the same rid', async () => {
    const deskA = new DeviceGroup(store());
    const a = await deskA.mint();
    const secretsB = store();
    const deskB = new DeviceGroup(secretsB);
    const asked = await deskB.prepareJoin(groupKeyString(generateInviteSecret(), a.deviceId));
    expect(asked.deviceId).not.toBe(a.deviceId);
    expect(asked.inviterId).toBe(a.deviceId);
    expect(secretsB.map.size).toBe(0); // the key held no Kg, so nothing to keep yet
    const b = await deskB.adopt(a.kg, asked.deviceId);
    expect(secretsB.map.get(SECRET_DEVICE_ID)).toBe(asked.deviceId);
    expect(await derivePairRid(a.kg, a.deviceId, b.deviceId)).toBe(
      await derivePairRid(b.kg, b.deviceId, a.deviceId),
    );
  });

  it('t-t7l3pa: a desk keeps ONE id across forget and a join to another group; forget drops Kg only', async () => {
    const a = await new DeviceGroup(store()).mint();
    const secretsB = store();
    const deskB = new DeviceGroup(secretsB);
    const first = await deskB.adopt(a.kg, (await deskB.prepareJoin(groupKeyString(generateInviteSecret(), a.deviceId))).deviceId);
    await deskB.forget();
    expect(secretsB.map.has(SECRET_KG)).toBe(false);
    expect(secretsB.map.get(SECRET_DEVICE_ID)).toBe(first.deviceId);
    // A NEW group, minted on another desk: the join reuses the stored id.
    const c = await new DeviceGroup(store()).mint();
    const asked = await deskB.prepareJoin(groupKeyString(generateInviteSecret(), c.deviceId));
    expect(asked.deviceId).toBe(first.deviceId);
    const again = await deskB.adopt(c.kg, asked.deviceId);
    expect(again.deviceId).toBe(first.deviceId);
    // The rid is still new: it derives from the new Kg.
    expect(await derivePairRid(c.kg, c.deviceId, again.deviceId)).not.toBe(await derivePairRid(a.kg, a.deviceId, first.deviceId));
    // A desk that leaves and then starts its own group keeps the id as well.
    await deskB.forget();
    expect((await deskB.mint()).deviceId).toBe(first.deviceId);
  });

  it('refuses a desk scanning its own invitation, and keeps the group it had', async () => {
    const secrets = store();
    const group = new DeviceGroup(secrets);
    const a = await group.mint();
    await expect(group.prepareJoin(groupKeyString(generateInviteSecret(), a.deviceId))).rejects.toThrow(/made on this machine/);
    // The refusal costs nothing: the desk still holds the group it is showing.
    expect(secrets.map.get(SECRET_DEVICE_ID)).toBe(a.deviceId);
    expect(secrets.map.has(SECRET_KG)).toBe(true);
  });
});

describe('device group — revocation rotates every rid', () => {
  it('a new Kg moves the pair to a rendezvous the old secret never names', async () => {
    const secrets = store();
    const deskA = new DeviceGroup(secrets);
    const a = await deskA.mint();
    const deskB = new DeviceGroup(store());
    const b = await deskB.adopt(a.kg, (await deskB.prepareJoin(groupKeyString(generateInviteSecret(), a.deviceId))).deviceId);
    const before = await derivePairRid(a.kg, a.deviceId, b.deviceId);

    // The owner forgets the group on the laptop and re-invites from the desk.
    await deskA.forget();
    expect(secrets.map.has(SECRET_KG)).toBe(false); // the id stays (t-t7l3pa); Kg is what rotates
    const fresh = await deskA.mint();
    const after = await derivePairRid(fresh.kg, fresh.deviceId, b.deviceId);
    expect(after).not.toBe(before);
    // The dropped desk still holds the OLD Kg. Asked for the rid of the very
    // pair the desk is now on, it answers a DIFFERENT rendezvous — so it opens
    // a socket nobody else is ever on. That is the whole of revocation. The
    // laptop kept its id (t-t7l3pa), so that rendezvous is the OLD one, which
    // the laptop left when it forgot the old Kg.
    const stale = await derivePairRid(b.kg, b.deviceId, fresh.deviceId);
    expect(fresh.deviceId).toBe(a.deviceId);
    expect(stale).not.toBe(after);
    expect(stale).toBe(before);
  });
});

describe('device group — the roster and the mother base', () => {
  beforeEach(() => registerGroupMembers(memento()));
  afterEach(() => resetGroupMembers());

  it('remembers a desk once, however many times it says hello', async () => {
    await rememberMember('AAAAAAAAAAA', 'Desk', 10);
    await rememberMember('AAAAAAAAAAA', 'Desk', 99);
    // addedAt is the FIRST join; lastSeen follows the latest hello (t-s9jr6u).
    expect(roster().members).toEqual([{ id: 'AAAAAAAAAAA', name: 'Desk', addedAt: 10, os: '', lastSeen: 99, admittedAt: 0 }]);
  });

  it('never lets an empty announcement erase the name the owner typed', async () => {
    await rememberMember('AAAAAAAAAAA', 'Desk', 10);
    await renameMember('AAAAAAAAAAA', '  The 5090  ');
    await rememberMember('AAAAAAAAAAA', '', 20);
    expect(roster().members[0]!.name).toBe('The 5090');
  });

  it('marks ONE home device, and clears it when that desk is dropped', async () => {
    await rememberMember('AAAAAAAAAAA', 'Desk', 10);
    await rememberMember('BBBBBBBBBBB', 'Laptop', 10);
    await setMotherBase('AAAAAAAAAAA');
    await setMotherBase('BBBBBBBBBBB');
    expect(roster().motherBase).toBe('BBBBBBBBBBB');
    await forgetMember('BBBBBBBBBBB');
    expect(roster().motherBase).toBe(null);
    expect(roster().members.map((m) => m.id)).toEqual(['AAAAAAAAAAA']);
  });

  it('treats a globalState record of any other shape as absent, not as truth', () => {
    registerGroupMembers({ get: <T,>(_k: string, _d: T) => ({ members: [{ id: 'x' }, 42], motherBase: 'no' }) as unknown as T, update: () => Promise.resolve() });
    expect(roster()).toEqual({ members: [], motherBase: null, motherBaseAt: 0, removed: [], removedAt: {} });
  });
});
