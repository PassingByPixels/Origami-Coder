/**
 * Per-rid replay ring for the remote relay.
 *
 * The relay is blind: a frame is opaque bytes. The ring only needs the sender's
 * role (known from the socket) and the frame `seq` (bytes 2..5 of the header,
 * uint32 big-endian) so a reconnecting peer can ask for `?after=<seq>`.
 *
 * Eviction is by count AND by age, whichever bites first (wire spec v1:
 * "max 256 frames or the ring window, whichever first"). The age window
 * defaults to 90 seconds and is operator-configurable (`--ring-seconds`) —
 * short on purpose, so a socket that connects late with a low `after` can
 * read at most the last window of the other role's traffic, not everything
 * since the pairing began.
 */

export type RelayRole = "desktop" | "phone"

export const RING_MAX_FRAMES = 256
/** Default replay window. Overridden per relay by `RelayOptions.ringMaxAgeMs`. */
export const RING_MAX_AGE_MS = 90 * 1000

export interface RingEntry {
  readonly role: RelayRole
  readonly seq: number
  readonly data: Uint8Array
  readonly at: number
}

export interface RingOptions {
  maxFrames?: number
  maxAgeMs?: number
  /** Injectable clock. Tests pass a fake; production leaves it at Date.now. */
  now?: () => number
}

/**
 * Reads the frame `seq` (bytes 2..5, uint32 BE). A frame shorter than the
 * 6-byte header prefix is still forwarded and stored — the relay does not
 * validate the wire format — it just carries seq 0 and so always replays.
 */
export function frameSeq(data: Uint8Array): number {
  if (data.length < 6) return 0
  return ((data[2] << 24) | (data[3] << 16) | (data[4] << 8) | data[5]) >>> 0
}

export class FrameRing {
  private readonly entries: RingEntry[] = []
  private readonly maxFrames: number
  private readonly maxAgeMs: number
  private readonly now: () => number

  constructor(options: RingOptions = {}) {
    this.maxFrames = options.maxFrames ?? RING_MAX_FRAMES
    this.maxAgeMs = options.maxAgeMs ?? RING_MAX_AGE_MS
    this.now = options.now ?? Date.now
  }

  get size() {
    return this.entries.length
  }

  push(role: RelayRole, data: Uint8Array) {
    this.entries.push({ role, seq: frameSeq(data), data, at: this.now() })
    this.evict()
  }

  /** Frames sent by `role` whose seq is strictly greater than `after`, oldest first. */
  since(role: RelayRole, after: number): RingEntry[] {
    this.evict()
    return this.entries.filter((entry) => entry.role === role && entry.seq > after)
  }

  private evict() {
    const cutoff = this.now() - this.maxAgeMs
    let drop = 0
    while (drop < this.entries.length && this.entries[drop].at <= cutoff) drop++
    if (this.entries.length - drop > this.maxFrames) drop = this.entries.length - this.maxFrames
    if (drop > 0) this.entries.splice(0, drop)
  }
}
