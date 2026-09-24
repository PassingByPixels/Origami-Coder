import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { SessionCacheState, type CacheStatePush } from "../../src/session/cache-state"
import { SessionCachePolicy } from "../../src/session/cache-policy"

// A fake clock, so "cold when the window runs out" is an assertion about a
// NUMBER rather than a sleep. Nothing here reaches a provider.
function fakeClock() {
  let next = 1
  const timers = new Map<number, { fn: () => void; at: number }>()
  let now = 1_000_000
  return {
    clock: {
      now: () => now,
      setTimeout(fn: () => void, ms: number) {
        const id = next++
        timers.set(id, { fn, at: now + ms })
        return { id }
      },
      clearTimeout(handle: { id: unknown }) {
        timers.delete(handle.id as number)
      },
    },
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    get now() {
      return now
    },
    get armed() {
      return timers.size
    },
  }
}

let sent: CacheStatePush[] = []
let timers: ReturnType<typeof fakeClock>

beforeEach(() => {
  SessionCacheState.reset()
  timers = fakeClock()
  SessionCacheState.setClock(timers.clock)
  sent = []
  SessionCacheState.onCacheState((push) => sent.push(push))
})

afterEach(() => {
  SessionCacheState.reset()
})

const SESSION = "ses_badge"

describe("what the badge is allowed to call warm", () => {
  // The rule the whole feature turns on. The warmer arms on EVERY
  // Anthropic-family request; arming is not a measurement, and a badge that lit
  // on it would be lit on almost every session regardless of what the provider
  // kept.
  test("a request armed under a window, and nothing measured yet, says nothing at all", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: 300 })
    expect(sent).toEqual([])
    expect(timers.armed).toBe(0)
  })

  // The warmer fired and the provider gave nothing back. That is a fact about
  // the warm, not evidence the prefix survived.
  test("a warm that read nothing does not turn the badge warm", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: 300 })
    SessionCacheState.warmed({ sessionID: SESSION, cacheRead: 0 })
    SessionCacheState.warmed({ sessionID: SESSION, cacheRead: undefined })
    expect(sent).toEqual([])
  })

  test("a real step that read from cache is warm, with the window it was sent under", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: 300 })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 12_000 })
    expect(sent).toEqual([
      { sessionId: SESSION, state: "warm", until: timers.now + 300_000, ttlSeconds: 300, source: "request" },
    ])
  })

  test("a warm that DID read from cache extends the window", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: 300 })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 12_000 })
    timers.advance(200_000)
    SessionCacheState.warmed({ sessionID: SESSION, cacheRead: 12_000 })
    expect(sent[1]).toEqual({
      sessionId: SESSION,
      state: "warm",
      until: timers.now + 300_000,
      ttlSeconds: 300,
      source: "warm",
    })
  })
})

describe("the three states", () => {
  test("a reported zero read is cold", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: 300 })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 0 })
    expect(sent).toEqual([{ sessionId: SESSION, state: "cold", source: "request" }])
  })

  // A provider that reports no cache tokens says nothing. Calling that cold
  // would be a claim nobody made.
  test("a provider that reports no cache tokens is unmeasured, not cold", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: undefined })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: undefined })
    expect(sent).toEqual([{ sessionId: SESSION, state: "unmeasured", source: "request" }])
  })

  test("a compaction goes cold and cancels the pending expiry", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: 300 })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 12_000 })
    SessionCacheState.compacted(SESSION)
    expect(sent[1]).toEqual({ sessionId: SESSION, state: "cold", source: "compaction" })
    expect(timers.armed).toBe(0)
    timers.advance(400_000)
    expect(sent).toHaveLength(2)
  })

  test("a model change goes cold", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: 300 })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 12_000 })
    SessionCacheState.modelChanged(SESSION)
    expect(sent[1]).toEqual({ sessionId: SESSION, state: "cold", source: "model" })
    expect(timers.armed).toBe(0)
  })
})

describe("the window, and what happens without one", () => {
  test("the engine's own timer turns the badge cold when the window runs out", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: 300 })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 12_000 })
    timers.advance(299_000)
    expect(sent).toHaveLength(1)
    timers.advance(2_000)
    expect(sent[1]).toEqual({ sessionId: SESSION, state: "cold", source: "expired" })
  })

  // The badge must never claim a countdown the provider never published.
  test("a provider with no published window is warm with NO until and NO ttlSeconds", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: undefined })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 12_000 })
    expect(sent).toEqual([{ sessionId: SESSION, state: "warm", source: "request" }])
    expect("until" in sent[0]!).toBe(false)
    expect("ttlSeconds" in sent[0]!).toBe(false)
    // Nothing to expire, so nothing is armed: the badge stays warm until a real
    // step, a compaction or a model change says otherwise.
    expect(timers.armed).toBe(0)
    timers.advance(3_600_000)
    expect(sent).toHaveLength(1)
  })

  test("a later hit re-arms the expiry from the new reading, not the old one", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: 300 })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 12_000 })
    timers.advance(250_000)
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 12_000 })
    timers.advance(60_000)
    // The first window would have expired by now. The second reading replaced it.
    expect(sent.some((p) => p.source === "expired")).toBe(false)
  })

  test("a repeated cold is not re-sent every step of a tool loop", () => {
    SessionCacheState.request({ sessionID: SESSION, ttlSeconds: 300 })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 0 })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 0 })
    SessionCacheState.measured({ sessionID: SESSION, cacheRead: 0 })
    expect(sent).toHaveLength(1)
  })

  test("each session's window is its own", () => {
    SessionCacheState.request({ sessionID: "ses_a", ttlSeconds: 600 })
    SessionCacheState.request({ sessionID: "ses_b", ttlSeconds: undefined })
    SessionCacheState.measured({ sessionID: "ses_a", cacheRead: 5 })
    SessionCacheState.measured({ sessionID: "ses_b", cacheRead: 5 })
    expect(sent[0]).toEqual({
      sessionId: "ses_a",
      state: "warm",
      until: timers.now + 600_000,
      ttlSeconds: 600,
      source: "request",
    })
    expect(sent[1]).toEqual({ sessionId: "ses_b", state: "warm", source: "request" })
  })
})

// ONE table, shared with the step's `idle` cause (cache-policy.ts, t-rylleg).
// These are the values the badge's countdown rests on, so a change to them is a
// change to what the badge promises - which is what this asserts.
describe("the provider window table the badge counts against", () => {
  test("the published windows, and undefined for everything else", () => {
    expect(SessionCachePolicy.windowSeconds({ providerID: "anthropic" })).toBe(300)
    // OpenAI: the LOW end (300 s) without a model id; a known family gets its
    // published window (lane D, t-rz0amv).
    expect(SessionCachePolicy.windowSeconds({ providerID: "openai" })).toBe(300)
    expect(SessionCachePolicy.windowSeconds({ providerID: "openai", modelID: "gpt-5.6" })).toBe(1800)
    expect(SessionCachePolicy.windowSeconds({ providerID: "azure" })).toBe(300)
    expect(SessionCachePolicy.windowSeconds({ providerID: "openrouter" })).toBeUndefined()
    expect(SessionCachePolicy.windowSeconds({ providerID: "vllm" })).toBeUndefined()
    expect(SessionCachePolicy.windowSeconds({ providerID: "opencode-go" })).toBeUndefined()
  })

  // The badge must count against the window the request was actually sent
  // under: an hour-long hint and a five-minute one are different promises.
  test("the inline 1-hour hint is what makes the window an hour", () => {
    expect(SessionCachePolicy.windowSeconds({ providerID: "anthropic", hintTtlSeconds: 3600 })).toBe(3600)
    expect(SessionCachePolicy.windowSeconds({ providerID: "anthropic", hintTtlSeconds: 300 })).toBe(300)
    // A hint from a provider that publishes no window buys nothing: there is
    // still no countdown to show.
    expect(SessionCachePolicy.windowSeconds({ providerID: "vllm", hintTtlSeconds: 3600 })).toBeUndefined()
  })
})
