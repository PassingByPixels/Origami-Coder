// Origami Remote — ONE SOCKET'S FRAMING STATE: the replay marks, the outbound
// counter, and (wire v1.3) WHICH KEY a frame's version byte names. §4's rule:
//   - we seal with K' from the first frame after `useSessionKey()`, and with K
//     before that (and for ever, on a socket whose phone is an old build);
//   - we open with the key the version byte names; a v2 frame arriving before
//     we hold K' is rejected, not guessed at;
//   - once a v2 frame from the peer is ACCEPTED, a later v1 from it is rejected
//     for the rest of the socket; a v1 still in flight before the first v2 is
//     tolerated, since that is the switch, not an attack.

import type { RemoteKey } from './crypto';
import {
  FRAME_VERSION,
  FRAME_VERSION_V2,
  FrameError,
  ROLE_DESKTOP,
  ROLE_PHONE,
  decodeFrame,
  encodeFrame,
  maxJsonFor,
  type DecodedFrame,
  type Role,
} from './frame';

/** Per-role high-water mark. The rule is "seq <= last seen seq from that role"
 *  — LESS-THAN-OR-EQUAL, so a duplicate of the newest frame is a replay too. */
export class SeqGuard {
  private readonly last = new Map<Role, number>();

  /** Highest seq accepted from `role`; 0 before the first frame, as `?after=` expects. */
  public seen(role: Role): number { return this.last.get(role) ?? 0; }

  public accept(role: Role, seq: number): boolean {
    if (seq <= this.seen(role)) return false;
    this.last.set(role, seq);
    return true;
  }
}

/**
 * One pairing's framing state: our outbound counter, the peer's high-water mark
 * and the key(s) both are bound to. Thrown away on revoke, so a rotated pairing
 * cannot inherit a sequence number. Both counters RESUME from `seqStore.ts` —
 * a seq is per SENDER per PAIRING and the pairing outlives the process. The seq
 * is NOT reset when the socket switches to K'.
 */
export class FrameCodec {
  private readonly guard = new SeqGuard();
  /** K', or null until the socket has proved the enrolled device key. */
  private session: RemoteKey | null = null;
  /** Set by the first ACCEPTED v2 frame; a later v1 from the peer is a downgrade. */
  private peerOnV2 = false;

  constructor(
    private readonly key: RemoteKey,
    public readonly rid: string,
    public readonly role: Role,
    private outSeq = 0,
    startIn = 0,
    /** Each outbound seq, so the store persists the mark without this file knowing it. */
    private readonly onOutSeq?: (seq: number) => void,
  ) {
    if (startIn > 0) this.guard.accept(this.peerRole, startIn);
  }

  /** The last seq we used — the store compares its watermark against it. */
  public get sent(): number { return this.outSeq; }

  private get peerRole(): Role { return this.role === ROLE_DESKTOP ? ROLE_PHONE : ROLE_DESKTOP; }

  /** The relay's `?after=` value: the last seq accepted from the OTHER role. */
  public get afterSeq(): number {
    return this.guard.seen(this.peerRole);
  }

  /** Wire v1.3: from here on we seal with K'. `null` is a NEW SOCKET and is not
   *  optional — the codec outlives the socket, so a stale K' would seal with the
   *  previous socket's key and the `peerOnV2` latch would refuse a fresh hello. */
  public useSessionKey(key: RemoteKey | null): void {
    this.session = key;
    if (!key) this.peerOnV2 = false;
  }

  /** Which version this codec is sealing with — the pane's one status line. */
  public get outVersion(): number {
    return this.session ? FRAME_VERSION_V2 : FRAME_VERSION;
  }

  public async encode(json: string): Promise<Uint8Array> {
    const version = this.outVersion;
    if (new TextEncoder().encode(json).length > maxJsonFor(version)) {
      throw new FrameError('short', `message JSON is over ${maxJsonFor(version)} bytes — chunk it first`);
    }
    const seq = ++this.outSeq;
    this.onOutSeq?.(seq);
    return encodeFrame(this.session ?? this.key, this.rid, this.role, seq, json, undefined, version);
  }

  /** Decode AND enforce replay rejection. A frame from our OWN role is rejected
   *  too: the relay only forwards the other side's frames. */
  public async decode(frame: Uint8Array): Promise<DecodedFrame> {
    const key = this.openingKey(frame[0]);
    const decoded = await decodeFrame(key, this.rid, frame);
    if (decoded.role !== this.peerRole) {
      throw new FrameError('role', `frame carries role ${decoded.role}, expected the peer role ${this.peerRole}`);
    }
    if (!this.guard.accept(decoded.role, decoded.seq)) {
      // Carried, not accepted: it OPENED, so a replayed hello can be told from a ring re-send. Still dropped.
      throw new FrameError('replay', `seq ${decoded.seq} is not newer than ${this.guard.seen(decoded.role)}`, decoded);
    }
    if (decoded.version === FRAME_VERSION_V2) this.peerOnV2 = true;
    return decoded;
  }

  /** §4's receiver rule, decided BEFORE any crypto so a downgrade is named. */
  private openingKey(version: number | undefined): RemoteKey {
    if (version === FRAME_VERSION_V2) {
      if (!this.session) throw new FrameError('version', 'a version 2 frame arrived before this socket derived a session key');
      return this.session;
    }
    if (version === FRAME_VERSION && this.peerOnV2) {
      throw new FrameError('version', 'a version 1 frame arrived after this peer had switched to the session key');
    }
    return this.key;
  }
}
