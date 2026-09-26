// t-w2txb2: the idle report's cache facts, which the extension's park rule reads
// (owner decision 2026-09-24: cache warming wins while it runs; stop only after the
// provider cache is past its life, measured from max(last request, last warm); a
// provider with no published window is never parked by time alone).
//
// Over the real ACP dispatch, like ext-methods.test.ts. The provider cache facts come
// from `SessionCacheWarm.armed`, the call every real request makes (session/llm.ts).
import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import type { ModelMessage } from "ai"
import { Agent } from "@/acp/agent"
import type * as ACPService from "@/acp/service"
import type { Provider } from "@/provider/provider"
import { SessionCacheWarm } from "@/session/cache-warm"

const agent = () => new Agent({} as unknown as ACPService.Interface)
const report = async () => (await agent().extMethod("_elastic_idle_report", {})) as Record<string, unknown>

const model = (providerID: string, npm: string, id: string) =>
  ({ id, providerID, api: { npm, id } }) as unknown as Provider.Model

const history: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

/** One real request of `sessionID` on `m`, at `at` (epoch ms). Warming off: the facts must
 *  not depend on it. */
function request(sessionID: string, m: Provider.Model, at: number, options: Record<string, unknown> = {}) {
  setSystemTime(new Date(at))
  SessionCacheWarm.armed({ sessionID, model: m, options, messages: history, send: async () => {}, env: { ORIGAMI_DISABLE_CACHE_WARM: "1" } })
}

const T0 = Date.UTC(2026, 8, 25, 10, 0, 0)
const MIN = 60_000

afterEach(() => {
  setSystemTime()
  SessionCacheWarm.reset()
})

describe("_elastic_idle_report: the park guard's cache facts", () => {
  test("no real request from this process: no cache fact at all", async () => {
    const r = await report()
    expect(r["cacheColdAt"]).toBeUndefined()
    expect(r["cacheUntimed"]).toBeUndefined()
  })

  test("Anthropic, default form: cold 5 min after the last real request", async () => {
    request("ses_a", model("anthropic", "@ai-sdk/anthropic", "claude-sonnet-5"), T0)
    expect((await report())["cacheColdAt"]).toBe(T0 + 5 * MIN)
  })

  test("Anthropic, 1 h opt-in form: cold 1 h after", async () => {
    request("ses_a", model("anthropic", "@ai-sdk/anthropic", "claude-sonnet-5"), T0, { cacheControl: { type: "ephemeral", ttl: "1h" } })
    expect((await report())["cacheColdAt"]).toBe(T0 + 60 * MIN)
  })

  test("OpenAI extended-retention family: the LONG end of the range, 24 h", async () => {
    request("ses_o", model("openai", "@ai-sdk/openai", "gpt-5.1"), T0, { promptCacheKey: "ses_o" })
    expect((await report())["cacheColdAt"]).toBe(T0 + 24 * 60 * MIN)
  })

  test("OpenAI gpt-5.6+: 30 min; an in-memory family: up to 1 h", async () => {
    request("ses_new", model("openai", "@ai-sdk/openai", "gpt-5.6"), T0, { promptCacheKey: "ses_new" })
    expect((await report())["cacheColdAt"]).toBe(T0 + 30 * MIN)
    SessionCacheWarm.reset()
    request("ses_old", model("openai", "@ai-sdk/openai", "gpt-4o"), T0, { promptCacheKey: "ses_old" })
    expect((await report())["cacheColdAt"]).toBe(T0 + 60 * MIN)
  })

  test("the latest-living session decides, and a later request moves it", async () => {
    request("ses_a", model("anthropic", "@ai-sdk/anthropic", "claude-sonnet-5"), T0)
    request("ses_b", model("anthropic", "@ai-sdk/anthropic", "claude-sonnet-5"), T0 + 2 * MIN)
    expect((await report())["cacheColdAt"]).toBe(T0 + 7 * MIN)
    request("ses_a", model("anthropic", "@ai-sdk/anthropic", "claude-sonnet-5"), T0 + 10 * MIN)
    expect((await report())["cacheColdAt"]).toBe(T0 + 15 * MIN)
  })

  test("a provider with no published window is untimed (local server, DeepSeek)", async () => {
    request("ses_l", model("lmstudio", "@ai-sdk/openai-compatible", "qwen"), T0)
    let r = await report()
    expect(r["cacheUntimed"]).toBe(true)
    expect(r["cacheColdAt"]).toBeUndefined()
    request("ses_d", model("deepseek", "@ai-sdk/openai-compatible", "deepseek-chat"), T0)
    request("ses_a", model("anthropic", "@ai-sdk/anthropic", "claude-sonnet-5"), T0)
    r = await report()
    expect(r["cacheUntimed"]).toBe(true)
    expect(r["cacheColdAt"]).toBe(T0 + 5 * MIN)
  })

  test("an accepted warm extends the life from the warm, not the request", async () => {
    const sends: Array<() => void> = []
    const clock = {
      setTimeout: (fn: () => void) => {
        sends.push(fn)
        return { id: sends.length }
      },
      clearTimeout: () => {},
    }
    SessionCacheWarm.setClock(clock)
    setSystemTime(new Date(T0))
    SessionCacheWarm.armed({
      sessionID: "ses_w",
      model: model("anthropic", "@ai-sdk/anthropic", "claude-sonnet-5"),
      options: {},
      messages: history,
      send: async () => {},
      env: {},
    })
    // The warm fires at 0.8 x TTL and the provider accepts it.
    setSystemTime(new Date(T0 + 4 * MIN))
    sends[0]!()
    await Bun.sleep(0)
    expect((await report())["cacheColdAt"]).toBe(T0 + 4 * MIN + 5 * MIN)
  })
})
