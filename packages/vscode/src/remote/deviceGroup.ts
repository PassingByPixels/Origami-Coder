// Origami device group — the GROUP SECRET and this machine's place in the group.
//
// One Kg for the whole group, in VS Code's SecretStorage (the OS keychain), and
// one random device id per machine beside it. Mint on the first desk; the next
// desk gets Kg inside the sealed welcome after the owner accepts it (the pasted
// key carries only a one-time invite secret, t-sj32zl), and then both desks can
// derive every pairwise rid and key there is (groupCrypto.ts). Nothing is sent to the relay to "create" a group:
// the group exists the moment two machines hold the same Kg.
//
// TWO CARRIERS, ONE STRING. The owner asked for a QR *and* a key to paste,
// because most desks have no camera. So the QR encodes the SAME string the
// paste box takes — there is no second format to keep in step, and a string a
// human can read is a string a human can check.
//
// REVOKING a device is forgetting Kg here and minting a NEW one on the desks
// that stay: every pairwise rid is derived from Kg, so all of them rotate at
// once and the dropped device connects to rendezvous ids nobody is on.

import { b64urlDecode, b64urlEncode } from './crypto';
import { INVITE_SECRET_BYTES, KG_BYTES, generateDeviceId, generateKg, isDeviceId } from './groupCrypto';
import type { SecretStore } from './pairing';

export const SECRET_KG = 'origami.group.kg';
export const SECRET_DEVICE_ID = 'origami.group.deviceId';

/** The prefix is the format check AND what tells the owner what they pasted.
 *  v2 (t-sj32zl): the key carries a one-time invite secret, never Kg. */
export const GROUP_KEY_PREFIX = 'origami-group-v2.';
/** A v1 key CARRIED Kg. It is refused by name, never read. */
const OLD_KEY_PREFIX = 'origami-group-v1.';

export interface GroupIdentity {
  kg: Uint8Array;
  /** THIS machine's id. Random, minted once, kept across leave and re-join
   *  (t-t7l3pa); the pairwise rids derive from it and Kg together. */
  deviceId: string;
}

/** What the QR draws and the paste box takes: ONE invite's one-time secret AND
 *  the id of the desk that is inviting. Base64url, so it survives every chat
 *  window, mail client and terminal it will be copied through. The secret names
 *  the join rendezvous (`groupCrypto.deriveJoinRid`) and dies with the invite:
 *  a leaked key is useless once the invite closes. */
export function groupKeyString(secret: Uint8Array, inviterId: string): string {
  if (!isDeviceId(inviterId)) throw new Error('origami group: the inviter id is not a device id');
  return `${GROUP_KEY_PREFIX}${b64urlEncode(secret)}.${inviterId}`;
}

/** Inverse of groupKeyString. Whitespace anywhere is forgiven — a key pasted
 *  out of a chat window arrives wrapped. Every other fault is NAMED, because
 *  "join failed" on a mistyped key is the one place this feature can waste an
 *  afternoon. */
export function parseGroupKey(text: unknown): { secret: Uint8Array; inviterId: string } {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, '') : '';
  if (clean.startsWith(OLD_KEY_PREFIX)) {
    throw new Error('This key is from an older Origami Code; make a new invite');
  }
  if (!clean.startsWith(GROUP_KEY_PREFIX)) {
    throw new Error(`origami group: a group key starts with "${GROUP_KEY_PREFIX}"`);
  }
  const fields = clean.slice(GROUP_KEY_PREFIX.length).split('.');
  if (fields.length !== 2) throw new Error('origami group: a group key is <secret>.<device id>');
  const secret = b64urlDecode(fields[0]!);
  if (secret.length !== INVITE_SECRET_BYTES) {
    throw new Error(`origami group: a group key carries ${INVITE_SECRET_BYTES} bytes, this one has ${secret.length}`);
  }
  if (!isDeviceId(fields[1])) throw new Error('origami group: the group key names no device id');
  return { secret, inviterId: fields[1]! };
}

/**
 * Kg and this machine's device id, in the keychain. Host-free: the SecretStore
 * shape is pairing.ts's, so the tests drive it with a Map.
 */
export class DeviceGroup {
  private identity: GroupIdentity | null = null;

  constructor(private readonly secrets: SecretStore) {}

  public get current(): GroupIdentity | null {
    return this.identity;
  }

  public get deviceId(): string | null {
    return this.identity?.deviceId ?? null;
  }

  /** Bring a stored group back up. A Kg with no device id (a half-written
   *  keychain) mints the id rather than failing: the id is not a secret and a
   *  new one only means the other desks see a new device. */
  public async load(): Promise<GroupIdentity | null> {
    const kgText = await this.secrets.get(SECRET_KG);
    if (!kgText) {
      this.identity = null;
      return null;
    }
    const kg = b64urlDecode(kgText);
    if (kg.length !== KG_BYTES) {
      await this.forget();
      return null;
    }
    this.identity = { kg, deviceId: await this.ownId() };
    return this.identity;
  }

  /** Start a group on this desk. Any previous group is forgotten first, so the
   *  string the owner is about to show belongs to exactly one Kg. */
  public async mint(): Promise<GroupIdentity> {
    await this.forget();
    const kg = generateKg();
    await this.secrets.store(SECRET_KG, b64urlEncode(kg));
    this.identity = { kg, deviceId: await this.ownId() };
    return this.identity;
  }

  /** Read a scanned or pasted key. NOTHING is stored: the key holds no Kg, and
   *  the group this desk has now stays until a welcome arrives (`adopt`). THIS
   *  desk's id is the stored one, minted only when none is stored, and never
   *  taken from the key (t-t7l3pa): the engine records a chat's writer by this
   *  id, so a new id on re-join left the desk's own chats owned by a stranger. */
  public async prepareJoin(keyText: unknown): Promise<{ secret: Uint8Array; inviterId: string; deviceId: string }> {
    const { secret, inviterId } = parseGroupKey(keyText);
    const stored = await this.secrets.get(SECRET_DEVICE_ID);
    // A desk that pastes the key it is showing would wait on its own invite.
    if (stored === inviterId) throw new Error('origami group: that invitation was made on this machine');
    return { secret, inviterId, deviceId: isDeviceId(stored) ? stored : generateDeviceId() };
  }

  /** The welcome came: hold its Kg under the id this desk announced. Any
   *  previous group is forgotten first. */
  public async adopt(kg: Uint8Array, deviceId: string): Promise<GroupIdentity> {
    if (kg.length !== KG_BYTES || !isDeviceId(deviceId)) throw new Error('origami group: a welcome with no group secret');
    await this.forget();
    await this.secrets.store(SECRET_KG, b64urlEncode(kg));
    await this.secrets.store(SECRET_DEVICE_ID, deviceId);
    this.identity = { kg, deviceId };
    return this.identity;
  }

  /** Forget the group. Every pairwise rid died with Kg. The device id STAYS
   *  (t-t7l3pa): it is not a secret, and the next group derives new rids from
   *  its own Kg. */
  public async forget(): Promise<void> {
    this.identity = null;
    await this.secrets.delete(SECRET_KG);
  }

  /** This machine's id, minted on first use and kept for the life of the machine. */
  private async ownId(): Promise<string> {
    const stored = await this.secrets.get(SECRET_DEVICE_ID);
    if (isDeviceId(stored)) return stored;
    const id = generateDeviceId();
    await this.secrets.store(SECRET_DEVICE_ID, id);
    return id;
  }
}
