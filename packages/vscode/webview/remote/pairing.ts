// Origami Remote — pairing, per `remote_wire_spec_v1.md` §"Pairing QR".
//
// The QR encodes `<relayHttpsUrl>/app/#v1.<rid>.<b64url(Ks)>[.<b64url(lanUrl)>]`.
// The secret rides in the FRAGMENT, which browsers never put on the wire and
// never send in a Referer — so the phone's whole job here is: read it once,
// move it to localStorage, and scrub it out of the address bar before anything
// (a screenshot, a shared link, the back button) can leak it.

import { b64urlDecode, b64urlEncode, deriveRid } from './crypto';
import { native, nativeForget, nativePairing } from './native';

/** localStorage key for the pairing secret of one room. */
const KS_PREFIX = 'origami-remote/ks/';
/** localStorage key holding the rid of the most recent pairing, so a plain
 *  reload (no fragment) resumes instead of asking to be re-paired. */
const LAST_RID = 'origami-remote/last-rid';
/** localStorage prefix for the chat webview's own getState/setState blob. */
export const VIEW_STATE_PREFIX = 'origami-remote/view-state/';

export interface Pairing {
  rid: string;
  ks: Uint8Array;
  lanUrl?: string;
  /** True when this pairing arrived in the URL fragment on THIS load. */
  fresh: boolean;
}

/**
 * Parse a `#v1.<rid>.<ks>[.<lan>]` fragment. Returns undefined for anything
 * that is not a v1 pairing — an empty hash, a router hash, a future version —
 * rather than throwing, because a phone that lands on `/app/` with no QR is a
 * normal case (a bookmark, a reload) and must fall through to storage.
 */
export function parseFragment(hash: string): Omit<Pairing, 'fresh'> | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return undefined;
  const parts = raw.split('.');
  if (parts.length < 3 || parts.length > 4) return undefined;
  const [version, rid, ksB64, lanB64] = parts;
  if (version !== 'v1') return undefined;
  if (!rid || !ksB64) return undefined;
  let ks: Uint8Array;
  try {
    ks = b64urlDecode(ksB64);
  } catch {
    return undefined;
  }
  // 32 random bytes, per the spec. A short secret is a malformed QR, not a
  // weaker pairing — refuse it rather than deriving a key from it.
  if (ks.length !== 32) return undefined;
  let lanUrl: string | undefined;
  if (lanB64) {
    try {
      lanUrl = new TextDecoder().decode(b64urlDecode(lanB64));
    } catch {
      lanUrl = undefined;
    }
  }
  return { rid, ks, lanUrl };
}

/**
 * Resolve the pairing for this page load: a fresh fragment wins, otherwise the
 * last stored one. A fresh fragment is written to storage and REMOVED from the
 * URL via replaceState, so the secret survives exactly one trip through the
 * address bar.
 */
export async function loadPairing(win: Window = window): Promise<Pairing | undefined> {
  // The native shell keeps the secret in the Keychain and scans natively, so
  // that branch touches neither storage nor the fragment. `native.ts` holds it.
  const shell = native();
  if (shell) return nativePairing(shell);
  const store = win.localStorage;
  const fromHash = parseFragment(win.location.hash);
  if (fromHash) {
    store.setItem(KS_PREFIX + fromHash.rid, b64urlEncode(fromHash.ks));
    store.setItem(LAST_RID, fromHash.rid);
    // The rid is derivable from Ks; a mismatch means our HKDF and the
    // desktop's disagree. The rid the desktop PUT in the QR is the room the
    // relay actually knows, so we route by it either way — but say so loudly,
    // because a mismatch here predicts every frame failing to open.
    const derived = await deriveRid(fromHash.ks);
    if (derived !== fromHash.rid) {
      console.warn(`[remote] rid mismatch: QR says ${fromHash.rid}, Ks derives ${derived}`);
    }
    scrubFragment(win);
    return { ...fromHash, fresh: true };
  }
  const rid = store.getItem(LAST_RID);
  if (!rid) return undefined;
  const ksB64 = store.getItem(KS_PREFIX + rid);
  if (!ksB64) return undefined;
  try {
    const ks = b64urlDecode(ksB64);
    if (ks.length !== 32) return undefined;
    return { rid, ks, fresh: false };
  } catch {
    return undefined;
  }
}

/** Drop the fragment without adding a history entry. */
export function scrubFragment(win: Window = window): void {
  const { pathname, search } = win.location;
  win.history.replaceState(null, '', pathname + search);
}

/** Forget one pairing — used when the desktop revokes it after three bad PINs. */
export function forgetPairing(rid: string, win: Window = window): void {
  // Clearing the (unused, in the shell) localStorage keys as well is harmless
  // and keeps one path.
  nativeForget();
  win.localStorage.removeItem(KS_PREFIX + rid);
  if (win.localStorage.getItem(LAST_RID) === rid) win.localStorage.removeItem(LAST_RID);
}

/** The relay WebSocket URL for a room. `after` replays the ring on reconnect. */
export function socketUrl(base: string, rid: string, after: number): string {
  // `/app/` is served by the relay next to `/r/<rid>`, so an empty base means
  // "the origin that served this page" — which is the LAN and tailnet case as
  // well as the hosted one, and never needs configuring on the phone. A native
  // shell with no `location.origin` worth trusting can set `__ORIGAMI_RELAY__`
  // before this runs; a plain browser never defines it, so nothing changes.
  const globalRelay = (globalThis as { __ORIGAMI_RELAY__?: string }).__ORIGAMI_RELAY__;
  const origin = base || globalRelay || (typeof location !== 'undefined' ? location.origin : '');
  const ws = origin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/+$/, '');
  return `${ws}/r/${encodeURIComponent(rid)}?role=phone&after=${after}`;
}
