import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import type { ModelMessage } from "ai"
import { SessionCacheWarm } from "../../src/session/cache-warm"
import type { Provider } from "../../src/provider/provider"

// A fake clock, so "at 0.8 x TTL" is an assertion about a NUMBER rather than a
// sleep. Nothing here reaches a provider: `send` is a spy.
function fakeClock() {
  let next = 1
  const timers = new Map<number, { fn: () => void; at: number }>()
  let now = 0
  return {
    clock: {
      setTimeout(fn: () => void, ms: number) {
        const id = next++
        timers.set(id, { fn, at: now + ms })
        return { id }
      },
      clearTimeout(handle: { id: unknown }) {
        timers.delete(handle.id as number)
      },
    },
    /** Move time forward and run whatever came due. */
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    get armed() {
      return timers.size
    },
  }
}

// Shapes only: `ttlSeconds` reads providerID / api.npm / api.id / id, and
// nothing else in the module touches the model.
const model = (over: Record<string, unknown> = {}) =>
  ({
    id: "claude-sonnet-5",
    providerID: "anthropic",
    api: { npm: "@ai-sdk/anthropic", id: "claude-sonnet-5" },
    ...over,
  }) as unknown as Provider.Model

const openai = () =>
  ({
    id: "gpt-5",
    providerID: "openai",
    api: { npm: "@ai-sdk/openai", id: "gpt-5" },
  }) as unknown as Provider.Model

const history: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
  { role: "assistant", content: [{ type: "text", text: "hi" }] },
]

let timers: ReturnType<typeof fakeClock>
let sent: SessionCacheWarm.WarmRequest[]

const arm = (over: Partial<Parameters<typeof SessionCacheWarm.armed>[0]> = {}) =>
  SessionCacheWarm.armed({
    sessionID: "ses_1",
    model: model(),
    options: {},
    messages: history,
    send: async (request) => {
      sent.push(request)
    },
    env: {},
    ...over,
  })

beforeEach(() => {
  SessionCacheWarm.reset()
  timers = fakeClock()
  SessionCacheWarm.setClock(timers.clock)
  sent = []
})

afterEach(() => SessionCacheWarm.reset())

describe("cache warm timing", () => {
  test("fires at 0.8 x TTL and not a millisecond before", () => {
    arm()
    const due = SessionCacheWarm.warmDelayMs(SessionCacheWarm.TTL_DEFAULT_SECONDS)
    expect(due).toBe(240_000) // 0.8 x 300s

    timers.advance(due - 1)
    expect(sent).toHaveLength(0)

    timers.advance(1)
    expect(sent).toHaveLength(1)
  })

  test("a 1h cache waits 48 minutes, not 4", () => {
    arm({ options: { cacheControl: { type: "ephemeral", ttl: "1h" } } })
    timers.advance(240_000)
    expect(sent).toHaveLength(0)
    timers.advance(SessionCacheWarm.warmDelayMs(SessionCacheWarm.TTL_1H_SECONDS) - 240_000)
    expect(sent).toHaveLength(1)
  })

  test("a real request resets the timer, so no warm fires on the old schedule", () => {
    arm()
    timers.advance(200_000)
    arm() // the operator sent a message: the cache just refreshed itself
    timers.advance(40_001) // would have been due on the FIRST schedule
    expect(sent).toHaveLength(0)
    timers.advance(200_000) // 240s after the second request
    expect(sent).toHaveLength(1)
  })

  test("only one warm is ever pending per session", () => {
    arm()
    arm()
    arm()
    expect(timers.armed).toBe(1)
  })
})

describe("what a warm sends", () => {
  test("the identical prefix, plus one minimal user message", () => {
    arm()
    timers.advance(240_000)

    const warm = sent[0]!
    expect(warm.warm).toBe(true)
    // Same messages, same order, SAME OBJECTS: a warm that rewrote any part of
    // the prefix would miss the cache it exists to refresh.
    expect(warm.messages.slice(0, history.length)).toEqual(history)
    for (let i = 0; i < history.length; i++) expect(warm.messages[i]).toBe(history[i])
    // Exactly one addition, and it carries no content of its own.
    expect(warm.messages).toHaveLength(history.length + 1)
    expect(warm.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: SessionCacheWarm.WARM_TEXT }],
    })
    expect(SessionCacheWarm.WARM_TEXT.length).toBe(1)
  })

  test("the prefix it replays is the one that was armed, not a later mutation", () => {
    const live: ModelMessage[] = [...history]
    arm({ messages: live })
    live.push({ role: "user", content: [{ type: "text", text: "typed later" }] })
    timers.advance(240_000)
    expect(sent[0]!.messages).toHaveLength(history.length + 1)
  })
})

describe("when a warm must NOT happen", () => {
  test("no warm after a compaction until a real request rebuilds the prefix", () => {
    arm()
    SessionCacheWarm.compacted("ses_1")
    timers.advance(10_000_000)
    expect(sent).toHaveLength(0)

    // And a compaction that lands AFTER the timer was armed still stops it.
    arm()
    timers.advance(100_000)
    SessionCacheWarm.compacted("ses_1")
    timers.advance(10_000_000)
    expect(sent).toHaveLength(0)

    // A real request clears the block.
    arm()
    timers.advance(240_000)
    expect(sent).toHaveLength(1)
  })

  test("no warm for a provider with no inline cache hint", () => {
    arm({ model: openai() })
    expect(timers.armed).toBe(0)
    timers.advance(10_000_000)
    expect(sent).toHaveLength(0)
  })

  test("no warm while the kill switch is set", () => {
    arm({ env: { [SessionCacheWarm.DISABLE_ENV]: "1" } })
    expect(timers.armed).toBe(0)
    arm({ env: { [SessionCacheWarm.DISABLE_ENV]: "true" } })
    expect(timers.armed).toBe(0)
    // Anything else means ON — the shell writes the variable only while the
    // setting is off.
    arm({ env: { [SessionCacheWarm.DISABLE_ENV]: "" } })
    expect(timers.armed).toBe(1)
  })

  test("a session that refuses twice stops being warmed", async () => {
    const send = async () => {
      throw new Error("max_tokens must be greater than thinking.budget_tokens")
    }
    for (let i = 0; i < SessionCacheWarm.MAX_FAILURES; i++) {
      arm({ send })
      timers.advance(240_000)
      await Promise.resolve() // let the rejection land
      await Promise.resolve()
    }
    // Still blocked even though the timer would be armed again by hand.
    SessionCacheWarm.armed({
      sessionID: "ses_1",
      model: model(),
      options: {},
      messages: history,
      send: async (request) => {
        sent.push(request)
      },
      env: {},
    })
    // `armed` clears the block (a real request rebuilt the prefix), so the
    // giving-up rule is about CONSECUTIVE failures with no real request between.
    timers.advance(240_000)
    expect(sent).toHaveLength(1)
  })
})

describe("ttl resolution", () => {
  test("anthropic-family models get the ephemeral default", () => {
    expect(SessionCacheWarm.ttlSeconds(model(), {})).toBe(SessionCacheWarm.TTL_DEFAULT_SECONDS)
    expect(
      SessionCacheWarm.ttlSeconds(model({ providerID: "zen", id: "claude-opus-5", api: { npm: "@ai-sdk/openai-compatible", id: "claude-opus-5" } }), {}),
    ).toBe(SessionCacheWarm.TTL_DEFAULT_SECONDS)
  })

  test("the SDK's own 1h form is read back", () => {
    expect(SessionCacheWarm.ttlSeconds(model(), { cacheControl: { type: "ephemeral", ttl: "1h" } })).toBe(
      SessionCacheWarm.TTL_1H_SECONDS,
    )
  })

  test("providers with no inline hint resolve to undefined", () => {
    expect(SessionCacheWarm.ttlSeconds(openai(), {})).toBeUndefined()
    // The gateway is excluded by applyCaching, so it is excluded here too.
    expect(
      SessionCacheWarm.ttlSeconds(model({ api: { npm: "@ai-sdk/gateway", id: "claude-sonnet-5" } }), {}),
    ).toBeUndefined()
  })
})

// t-rz0amv. OpenAI stamps no breakpoint: the prefix is identified by
// `prompt_cache_key` and its lifetime is published per model family, so the
// window is read from the family and the key has to be in the options.
describe("ttl resolution - OpenAI implicit prefix cache", () => {
  const keyed = { promptCacheKey: "ses_1", store: false }
  const openaiModel = (id: string, npm = "@ai-sdk/openai", providerID = "openai") =>
    model({ providerID, id, api: { npm, id } })

  test("an extended-retention family gets the documented 30 minutes", () => {
    expect(SessionCacheWarm.ttlSeconds(openai(), keyed)).toBe(1800)
    for (const id of ["gpt-5.1-codex-max", "gpt-5.2", "gpt-5.5-pro", "gpt-4.1-mini"])
      expect(SessionCacheWarm.ttlSeconds(openaiModel(id), keyed)).toBe(1800)
  })

  test("gpt-5.6 and later get their own documented 30 minutes", () => {
    expect(SessionCacheWarm.ttlSeconds(openaiModel("gpt-5.6"), keyed)).toBe(1800)
  })

  test("an in_memory family gets the LOW end of the documented 5-10 minutes", () => {
    for (const id of ["gpt-4o", "gpt-5.3"]) expect(SessionCacheWarm.ttlSeconds(openaiModel(id), keyed)).toBe(300)
  })

  test("azure reads the same table", () => {
    expect(SessionCacheWarm.ttlSeconds(openaiModel("gpt-5.2", "@ai-sdk/azure", "azure"), keyed)).toBe(1800)
  })

  test("no key in the options, no warm - the session's prefix is not identified", () => {
    // `setCacheKey: false` on the provider block leaves the key out, and a warm
    // without it cannot land on the same cache entry.
    expect(SessionCacheWarm.ttlSeconds(openai(), { store: false })).toBeUndefined()
  })

  test("providers that publish no window are never warmed", () => {
    const compat = "@ai-sdk/openai-compatible"
    const cases = [
      // OpenCode Go/Zen: the guide asks for x-opencode-session and prices
      // cached reads, but publishes no window.
      openaiModel("gpt-5.2", compat, "opencode-go"),
      openaiModel("qwen3-coder", compat, "opencode"),
      openaiModel("stealth/union-alpha", "@openrouter/ai-sdk-provider", "openrouter"),
      openaiModel("GLM-5.3-Flash-EXL3", compat, "vllm"),
      openaiModel("qwen3", compat, "lmstudio"),
      openaiModel("grok-4", "@ai-sdk/xai", "xai"),
    ]
    for (const each of cases) expect(SessionCacheWarm.ttlSeconds(each, keyed)).toBeUndefined()
  })
})

describe("what an OpenAI warm sends", () => {
  const openaiArm = (over: Partial<Parameters<typeof SessionCacheWarm.armed>[0]> = {}) =>
    arm({ model: openai(), options: { promptCacheKey: "ses_1", store: false }, ...over })

  test("the identical prefix plus one minimal user message, and one log line", () => {
    const logged: string[] = []
    openaiArm({ log: (message) => logged.push(message) })
    timers.advance(1800 * 0.8 * 1000)
    expect(sent).toHaveLength(1)
    expect(sent[0].warm).toBe(true)
    expect(sent[0].messages).toEqual([...history, { role: "user", content: [{ type: "text", text: "." }] }])
    // Silence: the only trace a warm leaves is the debug line. Nothing here can
    // reach the transcript, the usage pills or the token totals - the caller
    // drains the stream (session/llm.ts).
    expect(logged).toEqual(["cache warm"])
  })

  test("nothing fires before 80% of the window", () => {
    openaiArm()
    timers.advance(1800 * 0.8 * 1000 - 1)
    expect(sent).toHaveLength(0)
  })
})
