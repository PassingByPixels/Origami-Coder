import { describe, expect } from "bun:test"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@origami/llm/route"
import type { ModelMessage } from "ai"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { LLMNative } from "@/session/llm/native-request"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

// Anthropic cache breakpoints are decided by the ENGINE, not by the protocol:
// `ProviderTransform.applyCaching` stamps `providerOptions.anthropic.cacheControl`
// on the first two system messages and the last two non-system messages, and
// `@ai-sdk/anthropic` turns each marker into a `cache_control` on that message's
// LAST content block. These tests assert the native path reproduces that wire
// shape from the same markers, and adds none of its own.

const anthropicModel: Provider.Model = {
  id: ModelV2.ID.make("claude-haiku-4-5"),
  providerID: ProviderV2.ID.make("anthropic"),
  api: {
    id: "claude-haiku-4-5",
    url: "https://api.anthropic.com/v1",
    npm: "@ai-sdk/anthropic",
  },
  name: "Claude Haiku 4.5",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200_000, input: 200_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const it = testEffect(
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)), WebSocketExecutor.layer),
    ),
  ),
)

type CacheControl = { readonly type: string; readonly ttl?: string }
type Block = { readonly type: string; readonly text?: string; readonly cache_control?: CacheControl }
type AnthropicBody = {
  readonly system?: ReadonlyArray<Block>
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: ReadonlyArray<Block> }>
  readonly tools?: ReadonlyArray<{ readonly name: string; readonly cache_control?: CacheControl }>
}

const weatherTools = {
  get_weather: {
    description: "Get the current weather for a city.",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
  },
}

const prepare = (messages: ModelMessage[]) =>
  Effect.map(
    LLMClient.prepare<AnthropicBody>(
      LLMNative.request({
        model: anthropicModel,
        apiKey: "test-anthropic-key",
        messages,
        tools: weatherTools,
        maxOutputTokens: 1024,
      }),
    ),
    (prepared) => prepared.body,
  )

/** The same markers `ProviderTransform` puts on a real session turn. */
const transformed = (messages: ModelMessage[]) => ProviderTransform.message(messages, anthropicModel, {})

const toolLoopTurn = (): ModelMessage[] => [
  { role: "system", content: "Answer using tools when appropriate." },
  { role: "user", content: "What is the weather in Paris?" },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: { city: "Paris" } }],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "get_weather",
        output: { type: "json", value: { temperature: 22 } },
      },
    ],
  },
]

const marker = (ttl?: "1h") => ({
  anthropic: { cacheControl: ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" } },
})

const marks = (blocks: ReadonlyArray<Block>) => blocks.map((block) => block.cache_control)

describe("native Anthropic request lowering", () => {
  it.effect("places the engine's breakpoints on the last block of each marked message", () =>
    Effect.gen(function* () {
      const body = yield* prepare(transformed(toolLoopTurn()))

      // System marker survives the split into `system` blocks.
      expect(body.system).toEqual([
        { type: "text", text: "Answer using tools when appropriate.", cache_control: { type: "ephemeral" } },
      ])
      // Last two non-system messages marked; the earlier user turn is not.
      expect(body.messages.map((message) => ({ role: message.role, marks: marks(message.content) }))).toEqual([
        { role: "user", marks: [undefined] },
        { role: "assistant", marks: [{ type: "ephemeral" }] },
        { role: "user", marks: [{ type: "ephemeral" }] },
      ])
      // ...and the marked assistant block is the tool_use, which carries no
      // canonical `cache` field of its own.
      expect(body.messages[1]?.content[0]?.type).toBe("tool_use")
      expect(body.messages[2]?.content[0]?.type).toBe("tool_result")
      // The engine never marks tools, so neither does native.
      expect(body.tools?.map((tool) => tool.cache_control)).toEqual([undefined])
    }),
  )

  it.effect("adds no breakpoint of its own when the engine marked nothing", () =>
    Effect.gen(function* () {
      const body = yield* prepare(toolLoopTurn())

      expect(marks(body.system ?? [])).toEqual([undefined])
      expect(body.messages.flatMap((message) => marks(message.content))).toEqual([undefined, undefined, undefined])
      expect(body.tools?.map((tool) => tool.cache_control)).toEqual([undefined])
    }),
  )

  it.effect("honours a content-part marker on a part that is not the last one", () =>
    Effect.gen(function* () {
      const body = yield* prepare([
        {
          role: "user",
          content: [
            { type: "text", text: "cached prefix", providerOptions: marker() },
            { type: "text", text: "fresh tail" },
          ],
        },
      ])

      expect(body.messages[0]?.content).toEqual([
        { type: "text", text: "cached prefix", cache_control: { type: "ephemeral" } },
        { type: "text", text: "fresh tail" },
      ])
    }),
  )

  it.effect("lets a content-part marker win over the message-level one", () =>
    Effect.gen(function* () {
      const body = yield* prepare([
        {
          role: "user",
          content: [
            { type: "text", text: "cached prefix", providerOptions: marker() },
            { type: "text", text: "fresh tail" },
          ],
          providerOptions: marker(),
        },
      ])

      expect(marks(body.messages[0]?.content ?? [])).toEqual([{ type: "ephemeral" }, { type: "ephemeral" }])
    }),
  )

  it.effect("maps a 1h marker ttl onto the wire ttl", () =>
    Effect.gen(function* () {
      const body = yield* prepare([
        { role: "system", content: "cached system", providerOptions: marker("1h") },
        { role: "user", content: "hi", providerOptions: marker("1h") },
      ])

      expect(body.system).toEqual([
        { type: "text", text: "cached system", cache_control: { type: "ephemeral", ttl: "1h" } },
      ])
      expect(marks(body.messages[0]?.content ?? [])).toEqual([{ type: "ephemeral", ttl: "1h" }])
    }),
  )
})
