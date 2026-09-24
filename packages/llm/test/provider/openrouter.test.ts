import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { readFileSync } from "node:fs"
import path from "node:path"
import { LLM, Message, ToolCallPart } from "../../src"
import * as OpenAICompatibleChat from "../../src/protocols/openai-compatible-chat"
import * as OpenRouter from "../../src/providers/openrouter"
import { Auth, LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"

/**
 * Verbatim frames from the recorded OpenRouter tool loop
 * (`packages/engine/test/cassettes/openrouter/openrouter-native-tool-loop.json`,
 * turn 1, nvidia/nemotron-3.5-lightning:free): the first two reasoning deltas,
 * the last one, the two tool-call deltas, the finish frame and the usage
 * frame. The 116 reasoning deltas in between are left out; nothing else is
 * changed, so what the parser sees here is what the model sent.
 */
const TOOL_LOOP_SSE = readFileSync(
  path.join(import.meta.dir, "../fixtures/openrouter/tool-loop-reasoning-then-tool-call.sse"),
  "utf8",
)

const CALL_ID = "call-9c26596b-5ad6-4761-8d4d-a2b2122ed128"

const openRouterModel = OpenRouter.configure({ apiKey: "test-key" }).model("nvidia/nemotron-3.5-lightning:free")

const compatibleModel = OpenAICompatibleChat.route
  .with({ endpoint: { baseURL: "https://openrouter.ai/api/v1" }, auth: Auth.bearer("test-key") })
  .model({ id: "nvidia/nemotron-3.5-lightning:free", provider: "openrouter" })

const weatherRequest = (model: typeof openRouterModel | typeof compatibleModel) =>
  LLM.request({
    model,
    system: "Answer using tools when appropriate.",
    prompt: "What is the weather in Paris?",
    tools: [
      {
        name: "get_weather",
        description: "Get the current weather for a city.",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
  })

const types = (events: ReadonlyArray<{ readonly type: string }>) => events.map((event) => event.type)

const collect = (model: typeof openRouterModel | typeof compatibleModel) =>
  LLMClient.stream(weatherRequest(model)).pipe(
    Stream.runCollect,
    Effect.map((events) => Array.from(events)),
    Effect.provide(fixedResponse(TOOL_LOOP_SSE)),
  )

describe("OpenRouter", () => {
  it.effect("prepares OpenRouter models through the OpenAI-compatible Chat route", () =>
    Effect.gen(function* () {
      const model = OpenRouter.configure({ apiKey: "test-key" }).model("openai/gpt-4o-mini")

      expect(model).toMatchObject({
        id: "openai/gpt-4o-mini",
        provider: "openrouter",
        route: { id: "openrouter" },
      })
      expect(model.route.endpoint.baseURL).toBe("https://openrouter.ai/api/v1")

      const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "Say hello." }))

      expect(prepared.route).toBe("openrouter")
      expect(prepared.body).toMatchObject({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      })
    }),
  )

  it.effect("applies OpenRouter payload options from the model helper", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: OpenRouter.configure({
            apiKey: "test-key",
            providerOptions: {
              openrouter: {
                usage: true,
                reasoning: { effort: "high" },
                promptCacheKey: "session_123",
              },
            },
          }).model("anthropic/claude-3.7-sonnet:thinking"),
          prompt: "Think briefly.",
        }),
      )

      expect(prepared.body).toMatchObject({
        usage: { include: true },
        reasoning: { effort: "high" },
        prompt_cache_key: "session_123",
      })
    }),
  )

  // ---------------------------------------------------------------------------
  // Request dialect
  // ---------------------------------------------------------------------------

  it.effect("sends the system prompt as a text-part array and no stream_options", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({ model: openRouterModel, system: "Be brief.", prompt: "Go." }),
      )

      expect(prepared.body).toMatchObject({
        messages: [
          { role: "system", content: [{ type: "text", text: "Be brief." }] },
          { role: "user", content: "Go." },
        ],
      })
      // OpenRouter reports usage on the `usage` extra; its own package sends
      // `stream_options` only in strict OpenAI compatibility mode.
      expect("stream_options" in (prepared.body as Record<string, unknown>)).toBe(false)
    }),
  )

  it.effect("replays a stored assistant turn as reasoning + reasoning_details, and names the tool on the result", () =>
    Effect.gen(function* () {
      const details = [{ type: "reasoning.text", text: "Paris then.", format: "unknown", index: 0 }]
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openRouterModel,
          messages: [
            Message.user("What is the weather in Paris?"),
            Message.assistant([
              {
                type: "reasoning",
                text: "Paris then.",
                providerMetadata: { openrouter: { reasoning_details: details } },
              },
              ToolCallPart.make({ id: CALL_ID, name: "get_weather", input: { city: "Paris" } }),
            ]),
            Message.tool({ id: CALL_ID, name: "get_weather", result: { condition: "sunny" } }),
          ],
        }),
      )

      expect((prepared.body as { readonly messages: ReadonlyArray<Record<string, unknown>> }).messages).toEqual([
        { role: "user", content: "What is the weather in Paris?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: CALL_ID, type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
          reasoning: "Paris then.",
          reasoning_details: details,
        },
        { role: "tool", tool_call_id: CALL_ID, content: '{"condition":"sunny"}', name: "get_weather" },
      ])
    }),
  )

  it.effect("drops a stored reasoning string that has no reasoning_details to carry it", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: openRouterModel,
          messages: [Message.assistant([{ type: "reasoning", text: "unattributed" }, Message.text("done")])],
        }),
      )

      expect((prepared.body as { readonly messages: ReadonlyArray<Record<string, unknown>> }).messages).toEqual([
        { role: "assistant", content: "done" },
      ])
    }),
  )

  // ---------------------------------------------------------------------------
  // Stream dialect
  // ---------------------------------------------------------------------------

  it.effect("ends reasoning AFTER the tool call the turn produced, not at the tool delta", () =>
    Effect.gen(function* () {
      const events = yield* collect(openRouterModel)

      // The order `@openrouter/ai-sdk-provider` produces from these frames: it
      // closes reasoning on content or at the end of the stream, and a tool
      // delta is neither.
      expect(types(events)).toEqual([
        "step-start",
        "reasoning-start",
        "reasoning-delta",
        "reasoning-delta",
        "reasoning-delta",
        "tool-input-start",
        "tool-input-delta",
        "tool-input-end",
        "tool-call",
        "reasoning-end",
        "step-finish",
        "finish",
      ])
    }),
  )

  it.effect("hands the accumulated reasoning_details to the consumer on reasoning-end", () =>
    Effect.gen(function* () {
      const events = yield* collect(openRouterModel)
      const ended = events.find((event) => event.type === "reasoning-end")

      // The three streamed `reasoning.text` entries merge into ONE, keeping the
      // first entry's `format` and `index` — what a later turn replays.
      expect(ended?.providerMetadata).toEqual({
        openrouter: {
          reasoning_details: [
            { type: "reasoning.text", text: "We need.", format: "unknown", index: 0, signature: undefined },
          ],
        },
      })
    }),
  )

  it.effect("numbers its content blocks per response, so two turns do not share a block id", () =>
    Effect.gen(function* () {
      const first = yield* collect(openRouterModel)
      const second = yield* collect(openRouterModel)
      const blockID = (events: ReadonlyArray<{ readonly type: string; readonly id?: unknown }>) =>
        events.find((event) => event.type === "reasoning-start")?.id

      expect(blockID(first)).not.toBe(blockID(second))
    }),
  )

  it.effect("leaves the shared OpenAI Chat reader ending reasoning at the tool delta", () =>
    Effect.gen(function* () {
      const events = yield* collect(compatibleModel)

      // Same bytes, other family: this ordering is what the openai-compatible
      // cassettes are green against and the OpenRouter dialect must not move it.
      expect(types(events).indexOf("reasoning-end")).toBeLessThan(types(events).indexOf("tool-input-start"))
    }),
  )
})
