// Origami Remote — the iOS shell bridge.
//
// The native shell injects `window.__ORIGAMI_NATIVE__` at document start. A
// plain browser never defines it, so every function here falls back to "no
// shell" and the phone web layer behaves exactly as it did before: one
// global, checked once per call site.
//
// `nativePairing()` and `nativeForget()` live here rather than in
// `pairing.ts` because that file is a capped leaf with no room for a second
// source of truth for a pairing.

import { b64urlDecode, b64urlEncode } from './crypto';
import type { Pairing } from './pairing';

/** The Secure Enclave (or software-fallback) identity of one pairing. §4. */
export interface DeviceKey {
  alg: 'ES256';
  /** base64url of the 65-byte X9.63 uncompressed point (04 || X || Y). */
  pub: string;
  /** base64url of SHA-256(pub bytes), the fingerprint the owner compares. */
  fp: string;
  backend: 'secure-enclave' | 'software';
}

/** What the shell keeps in the Keychain. §4. */
export interface NativePairing {
  rid: string;
  /** base64url of 32 bytes. */
  ks: string;
  relayUrl: string;
  lanUrl?: string;
  /** True on the first getPairing() after a scan, then false. */
  fresh: boolean;
  deviceKey: DeviceKey;
}

export interface SignRequest {
  /** base64url of the exact bytes to sign. */
  payload: string;
  reason: string;
  biometric: boolean;
}

export interface SignResult {
  /** base64url of the 64-byte raw r||s signature (IEEE P1363), ECDSA-SHA256. */
  sig: string;
  pub: string;
}

export interface DeviceInfo {
  name: string;
  model: string;
  system: string;
}

export interface OrigamiNative {
  platform: 'ios';
  appVersion: string;
  getPairing(): Promise<NativePairing | null>;
  forgetPairing(): Promise<true>;
  signWithDevice(req: SignRequest): Promise<SignResult>;
  deviceInfo(): Promise<DeviceInfo>;
  /** The v2 signature and the ECDH secret (`z`) in one call. Optional: an
   *  older build signs v1 and stays on v1 frames. */
  deviceAuth?(req: { challenge: string; rid: string; ephPub: string }): Promise<{ sig: string; pub: string; z: string }>;
}

/** The shell, or undefined in a plain browser. */
export function native(): OrigamiNative | undefined {
  return (globalThis as { __ORIGAMI_NATIVE__?: OrigamiNative }).__ORIGAMI_NATIVE__;
}

/** The pairing the shell holds. Inside the shell the secret lives in the
 *  Keychain and there's no QR fragment to read (the scanner is native).
 *  Neither localStorage nor the fragment is touched on this path. */
export async function nativePairing(shell: OrigamiNative): Promise<Pairing | undefined> {
  const p = await shell.getPairing();
  if (!p) return undefined;
  let ks: Uint8Array;
  try {
    ks = b64urlDecode(p.ks);
  } catch {
    return undefined;
  }
  if (ks.length !== 32) return undefined;
  return { rid: p.rid, ks, lanUrl: p.lanUrl, fresh: p.fresh };
}

/** The shell owns the Keychain copy. Fire and forget: the caller already decided the pairing is gone. */
export function nativeForget(): void {
  void native()
    ?.forgetPairing()
    .catch((err: unknown) => console.warn('[remote] native forgetPairing failed', err));
}

/** The phone's half of the handshake. §5.1 */
export interface RemoteHello {
  type: 'remote/hello';
  v: 1;
  device: string;
  platform?: string;
  app?: string;
  deviceKey?: DeviceKey;
  /** What THIS copy of the page can open (`src/remote/phoneCaps.ts`). */
  caps?: string[];
}

/** The wire encodings this page understands. `restoreZ` is the deflated
 *  `restoreMessages` envelope: a page that can't inflate it would paint an
 *  empty transcript, so the desk sends the plain tail until told otherwise. */
export const PAGE_CAPS: readonly string[] = ['restoreZ', 'restoreDelta'];

/** The answer to a `remote/challenge`. §5.2 (v1) / §2.2 (v2, sessionKey.ts). */
export interface ChallengeResponse {
  type: 'remote/challenge-response';
  v: 1 | 2;
  sig: string;
  pub: string;
  fp?: string;
}

/** The hello frame. `caps` rides every hello; the three fields after it
 *  appear only inside the shell. `getPairing()` is read a second time here
 *  on purpose: `loadPairing()` already spent the one-shot `fresh` flag, so
 *  this read costs nothing but the key it came for. */
export async function buildHello(device: string): Promise<RemoteHello> {
  const hello: RemoteHello = { type: 'remote/hello', v: 1, device, caps: [...PAGE_CAPS] };
  const shell = native();
  if (!shell) return hello;
  hello.platform = shell.platform;
  hello.app = shell.appVersion;
  const pairing = await shell.getPairing();
  if (pairing) hello.deviceKey = pairing.deviceKey;
  return hello;
}

/** Domain separator: this key must never sign anything reinterpretable as something else. */
const DEVICE_AUTH_PREFIX = 'origami-remote/v1/device-auth';
/** The challenge is 32 random bytes. Anything else is a malformed desktop. */
const CHALLENGE_LEN = 32;

/** Signed bytes = utf8(prefix) || challenge(32) || utf8(rid). §5.2 */
export function deviceAuthPayload(challenge: Uint8Array, rid: string): Uint8Array {
  const te = new TextEncoder();
  const prefix = te.encode(DEVICE_AUTH_PREFIX);
  const ridBytes = te.encode(rid);
  const out = new Uint8Array(prefix.length + challenge.length + ridBytes.length);
  out.set(prefix, 0);
  out.set(challenge, prefix.length);
  out.set(ridBytes, prefix.length + challenge.length);
  return out;
}

/** Answer one `remote/challenge`, or return undefined. Undefined is normal
 *  in a browser: session binding needs a device key, and without the shell
 *  there is none. No biometric prompt: a Face ID sheet per reconnect is an outage. */
export async function signChallenge(
  msg: unknown,
  rid: string,
  fp?: string,
): Promise<ChallengeResponse | undefined> {
  const shell = native();
  if (!shell) return undefined;
  const raw = (msg as { challenge?: unknown } | null | undefined)?.challenge;
  if (typeof raw !== 'string') {
    console.warn('[remote] ignoring a challenge with no challenge string');
    return undefined;
  }
  let challenge: Uint8Array;
  try {
    challenge = b64urlDecode(raw);
  } catch {
    console.warn('[remote] ignoring a challenge that is not base64url');
    return undefined;
  }
  // A short challenge is a broken desktop; refusing it keeps this key from
  // signing attacker-sized bytes.
  if (challenge.length !== CHALLENGE_LEN) {
    console.warn(`[remote] ignoring a ${challenge.length}-byte challenge, want ${CHALLENGE_LEN}`);
    return undefined;
  }
  // A shell that refuses to sign must not take the socket down with it.
  try {
    const { sig, pub } = await shell.signWithDevice({
      payload: b64urlEncode(deviceAuthPayload(challenge, rid)),
      reason: 'Confirm this phone to the desktop',
      biometric: false,
    });
    return { type: 'remote/challenge-response', v: 1, sig, pub, fp };
  } catch (err: unknown) {
    console.warn('[remote] the shell refused to sign the challenge', err);
    return undefined;
  }
}
