// Origami Remote — pairing (wire spec v1, "Keys and ids" / "Pairing QR").
//
// One pairing at a time. Its whole identity is Ks: the frame key and the rid
// the relay routes on both derive from it, so "revoke" is nothing more than
// forgetting Ks. Ks lives in VS Code's SecretStorage (the OS keychain), never
// in settings and never in a file; the SecretStorage shape is declared locally,
// so the module is testable with a Map. There is no pairing PIN — the app signs
// every approval with its Secure Enclave key, and a keyless page is watch-only.

import {
  b64urlEncode,
  deriveKey,
  deriveRid,
  generateKs,
  b64urlDecode,
  type RemoteKey,
} from './crypto';

/** Structural subset of `vscode.SecretStorage`; keeps this file host-free. */
export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export const SECRET_KS = 'origami.remote.ks';
/** The key an older build stored the pairing PIN's PBKDF2 hash under. NOTHING
 *  reads it: `load()` deletes it, since a secret store has no wildcard delete. */
export const LEGACY_PIN_SECRET = 'origami.remote.pinHash';
/** Written by confirm() and nothing else; its value is the epoch ms of the
 *  phone's hello. Ks exists from the moment a code is minted, so this says "a
 *  phone paired" where Ks only says "a code was shown". */
export const SECRET_CONFIRMED = 'origami.remote.confirmedAt';

/** The QR shows for 60 s; no `remote/hello` inside it invalidates the pairing. */
export const PAIRING_WINDOW_MS = 60_000;

export interface ActivePairing {
  ks: Uint8Array;
  rid: string;
  key: RemoteKey;
  /** Epoch ms of the phone's hello, null while this is only an OFFER. */
  confirmedAt: number | null;
}

export interface PairingOffer {
  rid: string;
  /** The string the QR encodes. The SECRET rides in the fragment only. */
  qr: string;
  expiresAt: number;
}

/** The relay is a WEBSOCKET url; the phone loads the shell over HTTP(S). */
export function relayHttpUrl(relayUrl: string): string {
  const base = relayUrl.replace(/\/+$/, '');
  if (base.startsWith('wss://')) return `https://${base.slice(6)}`;
  if (base.startsWith('ws://')) return `http://${base.slice(5)}`;
  return base;
}

/**
 * `<relayHttpUrl>/app/#v1.<rid>.<base64url(Ks)>[.<base64url(lanUrl)>]`
 *
 * Everything secret is after the `#`, which browsers never put in a Referer and
 * servers never see — the relay learns the rid from the socket URL and no more.
 */
export function qrPayload(relayUrl: string, rid: string, ks: Uint8Array, lanUrl?: string): string {
  const tail = lanUrl ? `.${b64urlEncode(new TextEncoder().encode(lanUrl))}` : '';
  return `${relayHttpUrl(relayUrl)}/app/#v1.${rid}.${b64urlEncode(ks)}${tail}`;
}

/** Inverse of qrPayload, for tests and for a paste-the-link fallback. */
export function parseQrPayload(payload: string): { rid: string; ks: Uint8Array; lanUrl?: string } {
  const hash = payload.indexOf('#');
  if (hash < 0) throw new Error('origami remote: pairing payload has no fragment');
  const fields = payload.slice(hash + 1).split('.');
  if (fields.length < 3 || fields.length > 4 || fields[0] !== 'v1') {
    throw new Error('origami remote: unrecognised pairing payload');
  }
  const lanUrl = fields[3] ? new TextDecoder().decode(b64urlDecode(fields[3])) : undefined;
  return { rid: fields[1]!, ks: b64urlDecode(fields[2]!), lanUrl };
}

export class PairingManager {
  private current: ActivePairing | null = null;
  private pendingUntil: number | null = null;

  constructor(
    private readonly secrets: SecretStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public get active(): ActivePairing | null {
    return this.current;
  }

  /** Load a pairing a previous window stored. Null unless BOTH Ks and the
   *  confirmation are there, and any fragment found is FORGOTTEN or the next
   *  window resurrects the same phantom. Also deletes the retired PIN hash on
   *  every load, whether or not the pairing survives. */
  public async load(): Promise<ActivePairing | null> {
    await this.secrets.delete(LEGACY_PIN_SECRET);
    const ksText = await this.secrets.get(SECRET_KS);
    const confirmed = await this.secrets.get(SECRET_CONFIRMED);
    const confirmedAt = Number(confirmed);
    const usable = !!ksText && Number.isFinite(confirmedAt) && confirmedAt > 0;
    if (!usable) {
      if (ksText || confirmed) await this.revoke();
      return null;
    }
    const ks = b64urlDecode(ksText!);
    this.current = { ks, rid: await deriveRid(ks), key: await deriveKey(ks), confirmedAt };
    this.pendingUntil = null;
    return this.current;
  }

  /** Start a pairing: a new Ks, rid and key, and a 60-second window. Any previous pairing is
   *  revoked FIRST. */
  public async begin(relayUrl: string, lanUrl?: string): Promise<PairingOffer> {
    await this.revoke();
    const ks = generateKs();
    const rid = await deriveRid(ks);
    const key = await deriveKey(ks);
    await this.secrets.store(SECRET_KS, b64urlEncode(ks));
    this.current = { ks, rid, key, confirmedAt: null };
    this.pendingUntil = this.now() + PAIRING_WINDOW_MS;
    return { rid, qr: qrPayload(relayUrl, rid, ks, lanUrl), expiresAt: this.pendingUntil };
  }

  /** True while the QR is showing and no phone has said hello yet. */
  public get pending(): boolean {
    return this.pendingUntil !== null;
  }

  /** The only honest "is a phone paired": `active` is also true for a mere offer. */
  public get confirmedAt(): number | null {
    return this.current?.confirmedAt ?? null;
  }

  public get expired(): boolean {
    return this.pendingUntil !== null && this.now() >= this.pendingUntil;
  }

  /** The phone's `remote/hello`. Inside the window it confirms; outside it REVOKES and returns
   *  false. */
  public async confirm(): Promise<boolean> {
    if (this.pendingUntil === null) return this.current !== null; // already confirmed
    if (this.expired) {
      await this.revoke();
      return false;
    }
    this.pendingUntil = null;
    // The offer becomes a pairing HERE and only here.
    const at = this.now();
    if (this.current) this.current.confirmedAt = at;
    await this.secrets.store(SECRET_CONFIRMED, String(at));
    return true;
  }

  /** The window elapsed with no hello. Same effect as revoke, named for the log. */
  public async expire(): Promise<void> {
    if (this.pendingUntil !== null) await this.revoke();
  }

  /** Forget everything. The next begin() derives a DIFFERENT rid and key, so a
   *  revoked phone cannot even find the pairing on the relay. */
  public async revoke(): Promise<void> {
    this.current = null;
    this.pendingUntil = null;
    await this.secrets.delete(SECRET_KS);
    await this.secrets.delete(LEGACY_PIN_SECRET);
    await this.secrets.delete(SECRET_CONFIRMED);
  }
}
