import { describe, expect, test } from "bun:test"
import { DailyBudget, RATE_WINDOW_MS, RID_BYTES_PER_MINUTE, RateLimiter } from "../../src/relay/limits"

function fakeClock(start = 1_700_000_000_000) {
  let now = start
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
    },
  }
}

const KIB64 = 64 * 1024

describe("relay.limits.rate", () => {
  test("refuses the frame that would take a rid to 2 MiB inside one minute", () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ now: clock.now })
    const frames = RID_BYTES_PER_MINUTE / KIB64

    for (let i = 1; i < frames; i++) expect(limiter.charge("rid-a", KIB64)).toBe(true)
    expect(limiter.charge("rid-a", KIB64)).toBe(false)
  })

  test("buckets are per rid", () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ now: clock.now })
    for (let i = 1; i <= RID_BYTES_PER_MINUTE / KIB64; i++) limiter.charge("rid-a", KIB64)

    expect(limiter.charge("rid-a", KIB64)).toBe(false)
    expect(limiter.charge("rid-b", KIB64)).toBe(true)
  })

  test("the window rolls: capacity comes back as time passes", () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ now: clock.now })
    for (let i = 1; i <= RID_BYTES_PER_MINUTE / KIB64; i++) limiter.charge("rid-a", KIB64)
    expect(limiter.charge("rid-a", KIB64)).toBe(false)

    // Half a window back refills half the capacity, so a 64 KiB frame fits again.
    clock.advance(RATE_WINDOW_MS / 2)
    expect(limiter.charge("rid-a", KIB64)).toBe(true)

    // A whole window back refills to full, so the same 2 MiB budget applies afresh.
    clock.advance(RATE_WINDOW_MS)
    for (let i = 1; i < RID_BYTES_PER_MINUTE / KIB64; i++) expect(limiter.charge("rid-a", KIB64)).toBe(true)
    expect(limiter.charge("rid-a", KIB64)).toBe(false)
  })

  test("forget() drops a rid's bucket", () => {
    const limiter = new RateLimiter({ now: fakeClock().now })
    for (let i = 1; i <= RID_BYTES_PER_MINUTE / KIB64; i++) limiter.charge("rid-a", KIB64)
    expect(limiter.charge("rid-a", KIB64)).toBe(false)

    limiter.forget("rid-a")
    expect(limiter.charge("rid-a", KIB64)).toBe(true)
  })
})

describe("relay.limits.budget", () => {
  test("unlimited when no budget is configured", () => {
    const budget = new DailyBudget()
    budget.record(1024 * 1024 * 1024)
    expect(budget.exhausted).toBe(false)
  })

  test("exhausts at the configured megabytes", () => {
    const budget = new DailyBudget({ limitMb: 1 })
    budget.record(1024 * 1024 - 1)
    expect(budget.exhausted).toBe(false)
    budget.record(1)
    expect(budget.exhausted).toBe(true)
  })

  test("resets at UTC midnight", () => {
    // 23:59:59.000 UTC on 2023-11-14.
    const clock = fakeClock(Date.UTC(2023, 10, 14, 23, 59, 59))
    const budget = new DailyBudget({ limitMb: 1, now: clock.now })
    budget.record(1024 * 1024)
    expect(budget.exhausted).toBe(true)

    clock.advance(500)
    expect(budget.exhausted).toBe(true)

    clock.advance(1000) // crosses 00:00:00 UTC
    expect(budget.exhausted).toBe(false)
  })
})
