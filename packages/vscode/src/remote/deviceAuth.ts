// Origami Remote — DEVICE IDENTITY. The phone proves, on every socket, that it
// holds the key enrolled when the pairing was made: Ks alone is copyable (a
// photographed QR), and the iOS shell's P-256 Secure Enclave key is not. The
// wire (the iOS app's native bridge specification, 5.2):
//   phone hello  -> deviceKey { alg:'ES256', pub, fp, backend }
//   desktop      -> { type:'remote/challenge', v:1, challenge:<b64url 32 bytes> }
//   phone        -> { type:'remote/challenge-response', v:1, sig, pub, fp }
//   signed bytes = utf8("origami-remote/v1/device-auth") || challenge || utf8(rid)
//   sig          = base64url of the 64-byte raw r,s pair (IEEE P1363), no DER.
// FIRST ENROLMENT WINS: a later hello with a DIFFERENT key is dropped and named
// to the owner, never revoked — revoke-by-connecting would be free denial of
// service. WHEN the desktop asks is `deviceSession.ts`.

import { authorityPayload, verifyOver, type SignatureVerdict } from './authority';
import type { SecretStore } from './pairing';

export const DEVICE_AUTH_DOMAIN = 'origami-remote/v1/device-auth';
/** Wire v1.3: the SAME enrolled key, a DIFFERENT domain, plus the desktop's
 *  ephemeral public point — so a v2 signature can never replay as a v1 one. */
export const DEVICE_AUTH_V2_DOMAIN = 'origami-remote/v2/device-auth';
/** 32 random bytes per socket. A shorter one is a broken desktop. */
export const CHALLENGE_BYTES = 32;
/** Beside SECRET_KS in the OS keychain; cleared whenever the pairing is. */
export const SECRET_DEVICE = 'origami.remote.device';

/** What a hello claims. `fp` is base64url SHA-256(pub), the value shown to the owner. */
export interface DeviceKeyClaim {
  alg: string;
  pub: string;
  fp: string;
  backend: string;
}

/** The enrolled device, stored beside Ks. */
export interface EnrolledDevice extends DeviceKeyClaim {
  /** The phone's own name from its hello ("Sam's iPhone"), not the owner's. */
  device: string;
  platform: string;
  app: string;
}

/** Whether THIS socket's frames are sealed with K' (wire v1.3). `old-app` is a
 *  phone that answered the v1 shape to a v2 challenge: its content stays
 *  Ks-sealed. Declared here so the import graph stays acyclic. */
export type SessionState = 'off' | 'on' | 'old-app';

/** What the PANE is given. Deliberately without `pub`. */
export interface DeviceView {
  name: string;
  fp: string;
  platform: string;
  app: string;
  backend: string;
  /** Per SOCKET, not per pairing — `off` again after a reconnect. */
  session: SessionState;
}

export function deviceView(d: EnrolledDevice | null, session: SessionState): DeviceView | null {
  if (!d) return null;
  return { name: d.device, fp: d.fp, platform: d.platform, app: d.app, backend: d.backend, session };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The `deviceKey` block of a hello, or null for a browser page and for
 *  anything malformed — treating a bad claim as one would enrol garbage. */
export function readDeviceKey(msg: unknown): DeviceKeyClaim | null {
  const k = (msg as { deviceKey?: unknown } | null | undefined)?.deviceKey as Record<string, unknown> | undefined;
  if (!k || typeof k !== 'object') return null;
  const pub = str(k['pub']);
  const fp = str(k['fp']);
  if (str(k['alg']) !== 'ES256' || !pub || !fp) return null;
  return { alg: 'ES256', pub, fp, backend: str(k['backend']) || 'software' };
}

/** The record to store, built from the confirming hello. */
export function enrolmentFrom(msg: unknown): EnrolledDevice | null {
  const claim = readDeviceKey(msg);
  if (!claim) return null;
  const m = msg as Record<string, unknown>;
  return { ...claim, device: str(m['device']), platform: str(m['platform']), app: str(m['app']) };
}

/** utf8(domain) || challenge(32) || utf8(rid); the general form is `authority.ts`. */
export function deviceAuthPayload(challenge: Uint8Array, rid: string): Uint8Array {
  return authorityPayload(DEVICE_AUTH_DOMAIN, challenge, [rid]);
}

/** utf8(v2 domain) || challenge(32) || utf8(rid) || ephPub(65). The ephemeral
 *  point is BYTES, not base64url text, exactly as the challenge is. */
export function deviceAuthPayloadV2(challenge: Uint8Array, rid: string, ephPub: Uint8Array): Uint8Array {
  const head = authorityPayload(DEVICE_AUTH_V2_DOMAIN, challenge, [rid]);
  const out = new Uint8Array(head.length + ephPub.length);
  out.set(head, 0);
  out.set(ephPub, head.length);
  return out;
}

export interface VerifyResult extends SignatureVerdict {
  /** A second answer on a socket that already verified. The desktop causes it
   *  by re-offering the challenge on `peer:present`, so it is noise, not attack. */
  duplicate?: boolean;
}

/**
 * Verify one `remote/challenge-response`. NEVER throws: a malformed pub or sig
 * is an INVALID verdict with a reason, the same as a wrong signature.
 */
export function verifyChallengeResponse(args: {
  challengeBytes: Uint8Array;
  rid: string;
  sig: string;
  pub: string;
}): Promise<VerifyResult> {
  return verifyOver(deviceAuthPayload(args.challengeBytes, args.rid), args.sig, args.pub);
}

/** Which SHAPE the phone signed, or null when neither verifies. v2 is tried
 *  first and v1 only as a DETECTOR: an old build stays on v1 frames (§5), and
 *  the pane says so. */
export async function verifyChallengeShape(args: {
  challengeBytes: Uint8Array;
  rid: string;
  ephPub: Uint8Array;
  sig: string;
  pub: string;
}): Promise<{ shape: 'v2' | 'v1' | null; reason: string }> {
  const v2 = await verifyOver(deviceAuthPayloadV2(args.challengeBytes, args.rid, args.ephPub), args.sig, args.pub);
  if (v2.ok) return { shape: 'v2', reason: v2.reason };
  const v1 = await verifyOver(deviceAuthPayload(args.challengeBytes, args.rid), args.sig, args.pub);
  return v1.ok ? { shape: 'v1', reason: v1.reason } : { shape: null, reason: v2.reason };
}

/** The enrolled record in SecretStorage, under its own key beside Ks. */
export class DeviceStore {
  constructor(private readonly secrets: SecretStore) {}

  public async load(): Promise<EnrolledDevice | null> {
    const raw = await this.secrets.get(SECRET_DEVICE);
    if (!raw) return null;
    try {
      return enrolmentFrom(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  /** Stored in the shape `enrolmentFrom` reads, so load() and a hello cannot drift. */
  public async save(d: EnrolledDevice): Promise<void> {
    const deviceKey = { alg: d.alg, pub: d.pub, fp: d.fp, backend: d.backend };
    await this.secrets.store(SECRET_DEVICE, JSON.stringify({ device: d.device, platform: d.platform, app: d.app, deviceKey }));
  }

  public async clear(): Promise<void> {
    await this.secrets.delete(SECRET_DEVICE);
  }
}
