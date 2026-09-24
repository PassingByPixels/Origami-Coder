/**
 * Caps for the remote relay (wire spec v1, "Caps"):
 *
 *   frame > 65,536 bytes            -> close 4002
 *   per-rid >= 2 MiB per rolling 60s -> close 4003
 *   global daily budget exceeded     -> HTTP 503 for NEW rids only
 *
 * Both clocks are injectable so tests can drive time without sleeping.
 */

export const MAX_FRAME_BYTES = 65_536
export const RID_BYTES_PER_MINUTE = 2 * 1024 * 1024
export const RATE_WINDOW_MS = 60_000
/** Kit default for `--bulk-rid-mb-per-minute` (cloud-session bulk lane, `?lane=bulk`). */
export const DEFAULT_BULK_MB_PER_MINUTE = 20
const DAY_MS = 86_400_000
/** The priority rule: a NEW live rid is refused once the day is this fraction spent, so a bulk rid (refused only at 100%) still gets in. */
const NEAR_EXHAUSTED_FRACTION = 0.9

interface Bucket {
  tokens: number
  at: number
}

/**
 * Token bucket per rid: capacity 2 MiB, refilled at capacity/60s. A charge that
 * would take the rolling total to 2 MiB or more is refused (the spec says
 * ">= 2 MiB per rolling minute" closes the socket), so the caller closes 4003.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly capacity: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options: { capacity?: number; windowMs?: number; now?: () => number } = {}) {
    this.capacity = options.capacity ?? RID_BYTES_PER_MINUTE
    this.windowMs = options.windowMs ?? RATE_WINDOW_MS
    this.now = options.now ?? Date.now
  }

  /** True when the frame is within budget; false means the caller must close 4003. */
  charge(rid: string, bytes: number): boolean {
    const at = this.now()
    const bucket = this.buckets.get(rid)
    if (!bucket) {
      if (bytes >= this.capacity) return false
      this.buckets.set(rid, { tokens: this.capacity - bytes, at })
      return true
    }
    const refill = ((at - bucket.at) / this.windowMs) * this.capacity
    bucket.tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, refill))
    bucket.at = at
    if (bytes >= bucket.tokens) return false
    bucket.tokens -= bytes
    return true
  }

  forget(rid: string) {
    this.buckets.delete(rid)
  }
}

/**
 * Global byte budget for the day. `limitMb <= 0` (or unset) means unlimited.
 * The counter resets at UTC midnight — day index is floor(epochMs / 86_400_000),
 * whose boundaries are exactly UTC midnights.
 */
export class DailyBudget {
  private readonly limitBytes: number
  private readonly now: () => number
  private day: number
  private used = 0

  constructor(options: { limitMb?: number; now?: () => number } = {}) {
    const limitMb = options.limitMb ?? 0
    this.limitBytes = limitMb > 0 ? limitMb * 1024 * 1024 : Number.POSITIVE_INFINITY
    this.now = options.now ?? Date.now
    this.day = Math.floor(this.now() / DAY_MS)
  }

  private roll() {
    const day = Math.floor(this.now() / DAY_MS)
    if (day !== this.day) {
      this.day = day
      this.used = 0
    }
  }

  record(bytes: number) {
    this.roll()
    this.used += bytes
  }

  /** True once today's traffic has reached the budget; new rids are then refused. */
  get exhausted(): boolean {
    this.roll()
    return this.used >= this.limitBytes
  }

  /**
   * True once today's traffic has reached 90% of the budget — the point at
   * which a NEW live (non-bulk) rid is refused so cloud sessions keep the
   * remaining headroom. A bulk rid is unaffected by this; it is refused only
   * once `exhausted` is true (100%).
   */
  get nearExhausted(): boolean {
    this.roll()
    return this.used >= this.limitBytes * NEAR_EXHAUSTED_FRACTION
  }

  /**
   * Bytes charged so far today, for the loopback metrics surface. Rolls the day
   * first, so a reader that samples after UTC midnight sees 0 rather than
   * yesterday's total sitting there until the next frame moves it.
   */
  get usedBytes(): number {
    this.roll()
    return this.used
  }

  /** The configured ceiling; Infinity when no budget was set. */
  get limit(): number {
    return this.limitBytes
  }
}
