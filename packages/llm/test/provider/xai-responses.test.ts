/**
 * Wire-body parity between the native xAI Responses route and `@ai-sdk/xai`.
 *
 * xAI speaks the OpenAI Responses wire, but `@ai-sdk/xai` lowers four things
 * differently from `@ai-sdk/openai`. Each case below pins ONE of those against
 * the body the xAI facade produces, and pairs it with the same assertion on the
 * OpenAI facade so a change that fixes xAI cannot silently move OpenAI.
 *
 * Line references are to the bundled provider that ships with the engine:
 * packages/engine/node_modules/@ai-sdk/xai/dist/index.mjs.
 */
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart, ToolDefinition, ToolResultPart, type LLMEvent } from "../../src"
import { LLMClient } from "../../src/route"
import * as OpenAI from "../../src/providers/openai"
import type * as OpenAIResponses from "../../src/protocols/openai-responses"
import * as XAI from "../../src/providers/xai"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const xaiModel = XAI.configure({ apiKey: "test", baseURL: "https://api.x.ai.test/v1/" }).responses("grok-4.5")
const openaiModel = OpenAI.configure({ apiKey: "test", baseURL: "https://api.openai.test/v1/" }).responses(
  "gpt-4.1-mini",
)

const weatherTool = ToolDefinition.make({
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string" },
      // Nested, so the projection is proven to be recursive rather than a
      // top-level `delete`.
      window: { type: "object", properties: { hours: { type: "integer" } }, additionalProperties: false },
    },
    required: ["city"],
    additionalProperties: false,
  },
})

/** Turn 2 of a tool loop: the reasoning + call the model produced, then its result. */
const toolLoopMessages = (metadataKey: "xai" | "openai") => [
  Message.user("What is the weather in Paris?"),
  Message.assistant([
    {
      type: "reasoning" as const,
      text: "The user asks about Paris.",
      providerMetadata: {
        [metadataKey]: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" },
      },
    },
    ToolCallPart.make({ id: "call_1", name: "get_weather", input: { city: "Paris" } }),
  ]),
  Message.tool(ToolResultPart.make({ id: "call_1", name: "get_weather", result: { temperature: 22 } })),
]

const prepareToolLoop = (model: typeof xaiModel, metadataKey: "xai" | "openai" = "xai") =>
  LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
    LLM.request({
      model,
      messages: toolLoopMessages(metadataKey),
      tools: [weatherTool],
      toolChoice: "auto",
      cache: "none",
    }),
  )

const inputItem = (body: OpenAIResponses.OpenAIResponsesBody, type: string) =>
  body.input.find((item) => "type" in item && item.type === type)

/** Every provider namespace that appears on any event of a stream. */
const metadataNamespaces = (events: ReadonlyArray<LLMEvent>) =>
  events.flatMap((event) =>
    "providerMetadata" in event && event.providerMetadata ? Object.keys(event.providerMetadata) : [],
  )

describe("xAI Responses wire parity", () => {
  // dist/index.mjs:2162-2169 — `if (options.store === false) include = [...
  // "reasoning.encrypted_content"]`. The route pins `store: false`, so every
  // xAI Responses request carries the include.
  it.effect("sends the encrypted-reasoning include on every request", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model: xaiModel, prompt: "hi" }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
    }),
  )

  it.effect("lets a caller's own include replace the default", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: xaiModel,
          prompt: "hi",
          providerOptions: { openai: { include: ["web_search_call.results"] } },
        }),
      )

      expect(prepared.body.include).toEqual(["web_search_call.results"])
    }),
  )

  it.effect("leaves the OpenAI route's include untouched", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model: openaiModel, prompt: "hi" }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  // dist/index.mjs:319-334 + 2047-2048 — `removeAdditionalPropertiesFalse` over
  // the schema, and `strict` only when the tool carries one.
  it.effect("sends tool schemas with neither strict nor additionalProperties", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareToolLoop(xaiModel)

      expect(prepared.body.tools).toEqual([
        {
          type: "function",
          name: "get_weather",
          description: "Get the current weather for a city.",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string" },
              window: { type: "object", properties: { hours: { type: "integer" } } },
            },
            required: ["city"],
          },
        },
      ])
    }),
  )

  it.effect("keeps strict and additionalProperties on the OpenAI route", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareToolLoop(openaiModel)

      expect(prepared.body.tools).toEqual([
        {
          type: "function",
          name: "get_weather",
          description: "Get the current weather for a city.",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string" },
              window: { type: "object", properties: { hours: { type: "integer" } }, additionalProperties: false },
            },
            required: ["city"],
            additionalProperties: false,
          },
          strict: false,
        },
      ])
    }),
  )

  // dist/index.mjs:1185-1210 (reasoning) and 1167-1180 (function_call).
  it.effect("replays reasoning and function_call items with an id and a completed status", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareToolLoop(xaiModel)

      expect(inputItem(prepared.body, "reasoning")).toEqual({
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "The user asks about Paris." }],
        status: "completed",
        encrypted_content: "encrypted-state",
      })
      expect(inputItem(prepared.body, "function_call")).toEqual({
        type: "function_call",
        id: "call_1",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
        status: "completed",
      })
    }),
  )

  // A turn persisted before the metadata key moved to `xai` still replays.
  it.effect("reads continuation metadata stored under the openai namespace", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareToolLoop(xaiModel, "openai")

      expect(inputItem(prepared.body, "reasoning")).toMatchObject({ id: "rs_1", status: "completed" })
    }),
  )

  it.effect("keeps the OpenAI route's id-less, status-less replay items", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareToolLoop(openaiModel, "openai")

      expect(inputItem(prepared.body, "reasoning")).toEqual({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "The user asks about Paris." }],
        encrypted_content: "encrypted-state",
      })
      expect(inputItem(prepared.body, "function_call")).toEqual({
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      })
    }),
  )

  // dist/index.mjs:2353, 2461, 2475, 2504, 3230 — every metadata block the xAI
  // stream emits is namespaced `xai`, not `openai`.
  it.effect("emits stream metadata under the xai namespace", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1", summary: [] } },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "thinking" },
        { type: "response.completed", response: { id: "resp_1" } },
      )
      const response = yield* LLMClient.generate(LLM.request({ model: xaiModel, prompt: "hi" })).pipe(
        Effect.provide(fixedResponse(body)),
      )

      const namespaces = metadataNamespaces(response.events)
      expect(namespaces.length).toBeGreaterThan(0)
      expect([...new Set(namespaces)]).toEqual(["xai"])
    }),
  )

  it.effect("keeps the OpenAI route's stream metadata under openai", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1", summary: [] } },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "thinking" },
        { type: "response.completed", response: { id: "resp_1" } },
      )
      const response = yield* LLMClient.generate(LLM.request({ model: openaiModel, prompt: "hi" })).pipe(
        Effect.provide(fixedResponse(body)),
      )

      const namespaces = metadataNamespaces(response.events)
      expect(namespaces.length).toBeGreaterThan(0)
      expect([...new Set(namespaces)]).toEqual(["openai"])
    }),
  )
})
