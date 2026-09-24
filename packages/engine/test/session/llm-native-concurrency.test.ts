import { beforeEach, describe, expect } from "bun:test"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@origami/llm/route"
import { Effect, Fiber, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { ProviderConcurrency } from "@/provider/concurrency"
import { SessionProviderQueue } from "@/session/provider-queue"
import { OAUTH_MAX_CONCURRENT } from "@/plugin/openai/codex"
import type { Provider } from "@/provider/provider"
import { OAUTH_DUMMY_KEY } from "@/auth"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

/**
 * t-52cxcw. `max_concurrent` installs its semaphore on the AI SDK's options
 * copy, so every request the NATIVE runtime made went out ungated — a sub-agent
 * fan-out on the ChatGPT OAuth route ran unbounded.
 *
 * These assert the cap on the native path itself: how many requests are
 * simultaneously INSIDE the provider transport (the permit-protected region),
 * not how many the runtime was asked for. The gate is entered per request, so a
 * leaked permit shows up as a third concurrent entry, and a permit that is never
 * released shows up as a stream that never finishes.
 */

const baseModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: { id: "gpt-5-mini", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const oauth = { type: "oauth" as const, refresh: "refresh", access: "access", expires: Date.now() + 60_000 }

function providerInfo(options: Record<string, unknown>): Provider.Info {
  return {
    id: ProviderV2.ID.make("openai"),
    name: "OpenAI",
    source: "config",
    env: ["OPENAI_API_KEY"],
    options,
    models: {},
  }
}

function responsesStream() {
  const chunks = [
    { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

/**
 * A provider signer that parks inside the request until it is let go, so the
 * window a permit is held for is under the test's control. Every entry is
 * counted on the way in and out, which is what makes "two in flight" an
 * observation rather than an inference.
 */
function parkedFetch() {
  const gates: Array<() => void> = []
  const state = { entered: 0, active: 0, peak: 0, completed: 0 }
  const signer = Object.assign(
    async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      state.entered++
      state.active++
      state.peak = Math.max(state.peak, state.active)
      await new Promise<void>((resolve) => gates.push(resolve))
      state.active--
      state.completed++
      return responsesStream()
    },
    { preconnect: () => undefined },
  ) satisfies typeof fetch
  return {
    state,
    signer,
    /** Let one parked request finish. Returns false when none is parked. */
    releaseOne: () => {
      const gate = gates.shift()
      if (!gate) return false
      gate()
      return true
    },
    releaseAll: () => {
      while (gates.length) gates.shift()!()
    },
  }
}

/** Real-timer settle: `it.live` has no TestClock, and the semaphore hands a
 *  permit on directly rather than on a tick, so a macrotask is enough. */
const settle = (times = 6) =>
  Effect.promise(async () => {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  })

const it = testEffect(
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)), WebSocketExecutor.layer),
    ),
  ),
)

function startStream(input: {
  llmClient: Parameters<typeof LLMNativeRuntime.stream>[0]["llmClient"]
  provider: Provider.Info
  sessionID?: string
  parentSessionID?: string
}) {
  const native = LLMNativeRuntime.stream({
    model: baseModel,
    provider: input.provider,
    auth: oauth,
    llmClient: input.llmClient,
    messages: [{ role: "user", content: "hello" }],
    tools: {},
    headers: {},
    abort: new AbortController().signal,
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
    ...(input.parentSessionID ? { parentSessionID: input.parentSessionID } : {}),
  })
  if (native.type === "unsupported") throw new Error(native.reason)
  return native.stream.pipe(Stream.runCollect)
}

describe("session.llm-native concurrency", () => {
  beforeEach(() => {
    ProviderConcurrency.resetProviderSemaphores()
    SessionProviderQueue.resetProviderQueueListeners()
  })

  it.live("holds four native streams to max_concurrent 2, and all four complete", () =>
    Effect.gen(function* () {
      const provider = parkedFetch()
      const info = providerInfo({ apiKey: OAUTH_DUMMY_KEY, fetch: provider.signer, max_concurrent: 2 })
      const llmClient = yield* LLMClient.Service

      const fibers = yield* Effect.forEach(
        ["a", "b", "c", "d"],
        (id) => Effect.forkScoped(startStream({ llmClient, provider: info, sessionID: `child-${id}`, parentSessionID: "root" })),
        { concurrency: "unbounded" },
      )

      // Two in flight, two queued: the other two have not entered the transport
      // at all, which is the cap working rather than the server refusing them.
      yield* settle()
      expect(provider.state.entered).toBe(2)
      expect(provider.state.peak).toBe(2)

      // Freeing ONE permit admits exactly one queued request, never both.
      expect(provider.releaseOne()).toBe(true)
      yield* settle()
      expect(provider.state.entered).toBe(3)

      provider.releaseAll()
      yield* settle()
      provider.releaseAll()
      const results = yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber), { concurrency: "unbounded" })

      expect(provider.state.entered).toBe(4)
      expect(provider.state.completed).toBe(4)
      expect(provider.state.peak).toBe(2)
      for (const events of results) {
        expect(Array.from(events)).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: "text-delta", text: "Hello" })]),
        )
      }
    }),
  )

  /**
   * The starvation case the cap creates and must then answer: with every permit
   * held and a queue of children behind them, an ordinary parent step would be
   * served last, and a fan-out that keeps replacing itself would never let it
   * back in. A parent (no `parentSessionID`) jumps the queue instead.
   */
  it.live("serves a parent step ahead of every queued child", () =>
    Effect.gen(function* () {
      const provider = parkedFetch()
      const info = providerInfo({ apiKey: OAUTH_DUMMY_KEY, fetch: provider.signer, max_concurrent: 1 })
      const llmClient = yield* LLMClient.Service

      const child1 = yield* Effect.forkScoped(
        startStream({ llmClient, provider: info, sessionID: "child-1", parentSessionID: "root" }),
      )
      yield* settle()
      expect(provider.state.entered).toBe(1)

      const child2 = yield* Effect.forkScoped(
        startStream({ llmClient, provider: info, sessionID: "child-2", parentSessionID: "root" }),
      )
      const child3 = yield* Effect.forkScoped(
        startStream({ llmClient, provider: info, sessionID: "child-3", parentSessionID: "root" }),
      )
      yield* settle()
      // The parent arrives LAST and still goes next.
      const parent = yield* Effect.forkScoped(startStream({ llmClient, provider: info, sessionID: "root" }))
      yield* settle()
      expect(provider.state.entered).toBe(1)

      expect(provider.releaseOne()).toBe(true)
      yield* settle()
      expect(provider.state.entered).toBe(2)
      // The second entry is the parent's: its stream is the only one that can
      // finish once we let exactly one more request through.
      expect(provider.releaseOne()).toBe(true)
      const parentEvents = yield* Fiber.join(parent)
      expect(Array.from(parentEvents)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text-delta", text: "Hello" })]),
      )

      provider.releaseAll()
      yield* settle()
      provider.releaseAll()
      yield* Effect.forEach([child1, child2, child3], (fiber) => Fiber.join(fiber), { concurrency: "unbounded" })
      expect(provider.state.completed).toBe(4)
    }),
  )

  /**
   * The one live surface a queued sub-agent has: acp/event.ts turns these into a
   * childChunk line on the drawer row. Only a request that ACTUALLY queued may
   * publish — a line on every request would be noise on the common path.
   */
  it.live("publishes a queue wait, with the number ahead, only for a request that queues", () =>
    Effect.gen(function* () {
      const provider = parkedFetch()
      const info = providerInfo({ apiKey: OAUTH_DUMMY_KEY, fetch: provider.signer, max_concurrent: 1 })
      const llmClient = yield* LLMClient.Service
      const seen: Array<string> = []
      SessionProviderQueue.onProviderQueue((event) =>
        seen.push(
          event.state.type === "waiting"
            ? `${event.sessionID}:waiting:${event.state.ahead}`
            : `${event.sessionID}:started`,
        ),
      )

      const first = yield* Effect.forkScoped(
        startStream({ llmClient, provider: info, sessionID: "child-1", parentSessionID: "root" }),
      )
      yield* settle()
      expect(seen).toEqual([])

      const second = yield* Effect.forkScoped(
        startStream({ llmClient, provider: info, sessionID: "child-2", parentSessionID: "root" }),
      )
      const third = yield* Effect.forkScoped(
        startStream({ llmClient, provider: info, sessionID: "child-3", parentSessionID: "root" }),
      )
      yield* settle()
      expect(seen).toEqual(["child-2:waiting:0", "child-3:waiting:1"])

      provider.releaseAll()
      yield* settle()
      provider.releaseAll()
      yield* settle()
      provider.releaseAll()
      yield* Effect.forEach([first, second, third], (fiber) => Fiber.join(fiber), { concurrency: "unbounded" })
      expect(seen).toEqual(["child-2:waiting:0", "child-3:waiting:1", "child-2:started", "child-3:started"])
      expect(SessionProviderQueue.waitingLine(1)).toBe("waiting for a provider slot (1 ahead)\n")
      expect(SessionProviderQueue.waitingLine(0)).toBe("waiting for a provider slot\n")
    }),
  )

  it.live("leaves a provider with no max_concurrent uncapped", () =>
    Effect.gen(function* () {
      const provider = parkedFetch()
      const info = providerInfo({ apiKey: OAUTH_DUMMY_KEY, fetch: provider.signer })
      const llmClient = yield* LLMClient.Service

      const fibers = yield* Effect.forEach(
        ["a", "b", "c", "d"],
        (id) => Effect.forkScoped(startStream({ llmClient, provider: info, sessionID: `child-${id}`, parentSessionID: "root" })),
        { concurrency: "unbounded" },
      )
      yield* settle()
      expect(provider.state.entered).toBe(4)
      provider.releaseAll()
      yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber), { concurrency: "unbounded" })
      expect(provider.state.completed).toBe(4)
    }),
  )

  it.live("reads the limit the ChatGPT OAuth loader installs, and lets a config value win", () =>
    Effect.gen(function* () {
      expect(OAUTH_MAX_CONCURRENT).toBe(4)
      expect(LLMNativeRuntime.concurrencyLimit(providerInfo({ max_concurrent: OAUTH_MAX_CONCURRENT }))).toBe(4)
      // origami.json is merged over the loader's options (provider.ts applies the
      // config pass after the auth loaders), so the user's number is what lands.
      expect(LLMNativeRuntime.concurrencyLimit(providerInfo({ max_concurrent: 12 }))).toBe(12)
      expect(LLMNativeRuntime.concurrencyLimit(providerInfo({}))).toBeUndefined()
      expect(LLMNativeRuntime.concurrencyLimit(providerInfo({ max_concurrent: 0 }))).toBeUndefined()
    }),
  )
})
