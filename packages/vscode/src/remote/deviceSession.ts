// Origami Remote — DEVICE IDENTITY, the per-socket half. `deviceAuth.ts` says
// what a valid claim and signature ARE; this says WHEN the desktop asks. It is
// a state machine because three of its fields caught real failures:
//   - GENERATED is not DELIVERED. The relay drops a frame sent while it says
//     `peer:absent`, so the retry must re-send the SAME challenge bytes.
//   - HELD is not DROPPED. The phone's `remote/snapshot` rides the same socket
//     open as its hello, so it is held and replayed on the verdict.
//   - VERIFIED is per SOCKET and never persisted: a reconnect starts unverified.

import { DeviceStore, enrolmentFrom, readDeviceKey, type EnrolledDevice, type SessionState, type VerifyResult } from './deviceAuth';
// Wire v1.3: the ephemeral key, challenge bytes and K' live in `sessionKey.ts`.
import { SessionExchange, type SessionDeps } from './sessionKey';

/** The per-socket trust state machine. `reset()` is a new socket. */
export class DeviceSession {
  private enrolled: EnrolledDevice | null = null;
  private readonly exchange = new SessionExchange();
  /** DELIVERED is not GENERATED: the relay drops a frame sent while it says
   *  `peer:absent`, so the retry must re-send the SAME bytes. */
  private delivered = false;
  private verified = false;
  private held = false;

  constructor(private readonly store: DeviceStore, private readonly d: SessionDeps = {}) {}

  /** What the pane's one line reports: `on`, `off (old app)`, `off`. */
  public get sessionState(): SessionState { return this.exchange.status; }

  public get device(): EnrolledDevice | null {
    return this.enrolled;
  }

  public get isVerified(): boolean {
    return this.verified;
  }

  /** Nothing the phone says may be acted on while this is true. Only an
   *  ENROLLED pairing blocks; a keyless page is clamped to `watch` by inbound.ts. */
  public get blocked(): boolean {
    if (this.verified) return false;
    return this.enrolled !== null;
  }

  public async load(): Promise<void> {
    this.enrolled = await this.store.load();
  }

  /** A new socket: a new challenge, and nothing proved. */
  public reset(): void {
    this.exchange.reset();
    this.d.onSessionKey?.(null);
    this.delivered = false;
    this.verified = false;
    this.held = false;
  }

  /** The pairing is gone. Forget the device with it. */
  public async forget(): Promise<void> {
    this.enrolled = null;
    this.reset();
    await this.store.clear();
  }

  /** The phone (re)appeared. The frame never says WHOSE socket attached, so a
   *  peer arriving on a VERIFIED socket drops the verdict and RE-MINTS the
   *  challenge (a replacement with a copied Ks could have read the old pair off
   *  the relay ring). An UNVERIFIED socket keeps its challenge. */
  public peerArrived(): boolean {
    const replaced = this.verified;
    if (replaced) {
      this.verified = false;
      this.exchange.reset();
    }
    // UNCONDITIONAL. v1.3's latch belongs to the HANDSHAKE EPOCH, not the relay
    // socket: a surviving latch would refuse the returning phone's v1 hello.
    this.d.onSessionKey?.(null);
    this.delivered = false;
    return replaced;
  }

  /** Generate once per socket, send when the relay says the phone can hear it. */
  public async offer(send: (msg: unknown) => Promise<void>, deliverable: boolean): Promise<void> {
    if (this.verified || this.delivered) return;
    const body = await this.exchange.offer();
    if (!deliverable) return;
    this.delivered = true;
    await send(body);
  }

  /** The fingerprint of a device that is NOT the enrolled one, else null. */
  public foreignKey(msg: unknown): string | null {
    const claim = readDeviceKey(msg);
    const known = this.enrolled;
    if (!known || !claim) return null;
    return claim.pub === known.pub ? null : claim.fp;
  }

  /** Store the FIRST key seen on a confirmed pairing; a keyless hello may watch. */
  public async enrol(msg: unknown): Promise<boolean> {
    if (this.enrolled) return false;
    const record = enrolmentFrom(msg);
    if (!record) return false;
    this.enrolled = record;
    await this.store.save(record);
    return true;
  }

  /** One `remote/challenge-response`. */
  public async accept(msg: unknown, rid: string | null): Promise<VerifyResult> {
    if (this.verified) return { ok: false, duplicate: true, reason: 'a second response on a socket that is already verified' };
    const m = msg as { sig?: unknown; pub?: unknown } | null;
    if (typeof m?.sig !== 'string' || typeof m?.pub !== 'string') return { ok: false, reason: 'the response is malformed' };
    if (this.enrolled && m.pub !== this.enrolled.pub) return { ok: false, reason: 'a key that is not the enrolled device' };
    const result = await this.exchange.accept({ sig: m.sig, pub: m.pub, rid: rid ?? '', enrolled: this.enrolled, ks: this.d.ks?.() ?? null });
    if (result.ok) { this.verified = true; if (result.key) this.d.onSessionKey?.(result.key); }
    return { ok: result.ok, reason: result.reason };
  }

  /** A hydration the phone asked for before it could prove itself. */
  public hold(): void {
    this.held = true;
  }

  public takeHold(): boolean {
    const had = this.held;
    this.held = false;
    return had;
  }
}
