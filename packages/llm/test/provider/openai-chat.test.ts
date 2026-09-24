import { describe, expect } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMError, LLMEvent, Message, Model, ToolCallPart, Usage } from "../../src"
import * as Azure from "../../src/providers/azure"
import * as OpenAI from "../../src/providers/openai"
import * as OpenAIChat from "../../src/protocols/openai-chat"
import { ProviderShared } from "../../src/protocols/shared"
import { Auth, LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse, truncatedStream } from "../lib/http"
import { deltaChunk, usageChunk } from "../lib/openai-chunks"
import { sseEvents } from "../lib/sse"

const TargetJson = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeSync(TargetJson)
const decodeJson = Schema.decodeUnknownSync(TargetJson)

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

describe("OpenAI Chat route", () => {
  it.effect("prepares OpenAI Chat payload", () =>
    Effect.gen(function* () {
      // Pass the OpenAIChat payload type so `prepared.body` is statically
      // typed to the route's native shape — the assertions below read field
      // names without `unknown` casts.
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(request)
      const _typed: { readonly model: string; readonly stream: true } = prepared.body

      expect(prepared.body).toEqual({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Say hello." },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 20,
        temperature: 0,
      })
    }),
  )

  it.effect("lowers chronological system updates to escaped user wrappers in order", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Before."),
            Message.system("Treat <admin> & data literally."),
            Message.assistant("After."),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: "Before.\n<system-update>\nTreat &lt;admin&gt; &amp; data literally.\n</system-update>",
        },
        { role: "assistant", content: "After." },
      ])
    }),
  )

  it.effect("replays canonical reasoning as OpenAI-compatible reasoning_content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "thinking" },
              { type: "text", text: "Hello" },
            ]),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([{ role: "assistant", content: "Hello", reasoning_content: "thinking" }])
    }),
  )

  it.effect("maps OpenAI provider options to Chat options", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4o-mini"),
          prompt: "think",
          providerOptions: { openai: { reasoningEffort: "low" } },
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.reasoning_effort).toBe("low")
    }),
  )

  it.effect("adds native query params to the Chat Completions URL", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: Model.update(model, { route: model.route.with({ endpoint: { query: { "api-version": "v1" } } }) }),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://api.openai.test/v1/chat/completions?api-version=v1")
            return input.respond(sseEvents(deltaChunk({}, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("uses Azure api-key header for static OpenAI Chat keys", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: Azure.configure({
          baseURL: "https://origami-test.openai.azure.com/openai/v1/",
          apiKey: "azure-key",
          headers: { authorization: "Bearer stale" },
        }).chat("gpt-4o-mini"),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://origami-test.openai.azure.com/openai/v1/chat/completions?api-version=v1")
            expect(web.headers.get("api-key")).toBe("azure-key")
            expect(web.headers.get("authorization")).toBeNull()
            return input.respond(sseEvents(deltaChunk({}, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("applies serializable HTTP overlays after payload lowering", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: model.route
          .with({ auth: Auth.bearer("fresh-key"), headers: { authorization: "Bearer stale" } })
          .model({ id: model.id }),
        http: {
          body: { metadata: { source: "test" } },
          headers: { authorization: "Bearer request", "x-custom": "yes" },
          query: { debug: "1" },
        },
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://api.openai.test/v1/chat/completions?debug=1")
            expect(web.headers.get("authorization")).toBe("Bearer fresh-key")
            expect(web.headers.get("x-custom")).toBe("yes")
            expect(decodeJson(input.text)).toMatchObject({
              stream: true,
              stream_options: { include_usage: true },
              metadata: { source: "test" },
            })
            return input.respond(sseEvents(deltaChunk({}, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("prepares assistant tool-call and tool-result messages", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_result",
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      )

      expect(prepared.body).toEqual({
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "What is the weather?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: encodeJson({ query: "weather" }) },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: encodeJson({ forecast: "sunny" }) },
        ],
        stream: true,
        stream_options: { include_usage: true },
      })
    }),
  )

  it.effect("preserves structured tool errors for the model", () =>
    Effect.gen(function* () {
      const error = { error: { type: "unknown", message: "Tool execution interrupted" } }
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "bash", input: {} })]),
            Message.tool({ id: "call_1", name: "bash", resultType: "error", result: error }),
          ],
        }),
      )

      expect(prepared.body.messages.at(-1)).toEqual({
        role: "tool",
        tool_call_id: "call_1",
        content: ProviderShared.encodeJson(error),
      })
    }),
  )

  it.effect("continues image tool results as vision input without base64 text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_image", name: "read", input: { path: "pixel.png" } })]),
            Message.tool({
              id: "call_image",
              name: "read",
              result: {
                type: "content",
                value: [
                  { type: "text", text: "Image read successfully" },
                  { type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png", name: "pixel.png" },
                ],
              },
            }),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_image",
              type: "function",
              function: { name: "read", arguments: encodeJson({ path: "pixel.png" }) },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_image", content: "Image read successfully" },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAECAw==" } }],
        },
      ])
      expect(JSON.stringify(prepared.body.messages)).not.toContain('"content":"AAECAw=="')
    }),
  )

  it.effect("orders parallel tool responses before one aggregated vision message", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({ id: "call_1", name: "read", input: {} }),
              ToolCallPart.make({ id: "call_2", name: "read", input: {} }),
            ]),
            Message.make({
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  id: "call_1",
                  name: "read",
                  result: {
                    type: "content",
                    value: [{ type: "file", uri: "data:image/png;base64,AAEC", mime: "image/png" }],
                  },
                },
                {
                  type: "tool-result",
                  id: "call_2",
                  name: "read",
                  result: {
                    type: "content",
                    value: [{ type: "file", uri: "data:image/jpeg;base64,/9j/", mime: "image/jpeg" }],
                  },
                },
              ],
            }),
          ],
        }),
      )
      expect(prepared.body.messages.slice(1)).toEqual([
        { role: "tool", tool_call_id: "call_1", content: "" },
        { role: "tool", tool_call_id: "call_2", content: "" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ])
    }),
  )

  it.effect("aggregates consecutive tool images with a following system update", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.tool({
              id: "call_1",
              name: "read",
              result: {
                type: "content",
                value: [{ type: "file", uri: "data:image/png;base64,AAEC", mime: "image/png" }],
              },
            }),
            Message.tool({
              id: "call_2",
              name: "read",
              result: {
                type: "content",
                value: [{ type: "file", uri: "data:image/webp;base64,UklG", mime: "image/webp" }],
              },
            }),
            Message.system("Inspect both images."),
          ],
        }),
      )
      expect(prepared.body.messages).toEqual([
        { role: "tool", tool_call_id: "call_1", content: "" },
        { role: "tool", tool_call_id: "call_2", content: "" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
            { type: "image_url", image_url: { url: "data:image/webp;base64,UklG" } },
            { type: "text", text: "<system-update>\nInspect both images.\n</system-update>" },
          ],
        },
      ])
    }),
  )

  it.effect("appends system updates without replacing multipart user content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          messages: [
            Message.user({ type: "media", mediaType: "image/png", data: "AAEC" }),
            Message.system("Keep the image."),
          ],
        }),
      )
      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
            { type: "text", text: "<system-update>\nKeep the image.\n</system-update>" },
          ],
        },
      ])
    }),
  )

  for (const [name, media] of [
    ["mismatched data URL MIME", { mediaType: "image/png", data: "data:image/jpeg;base64,/9j/" }],
    ["malformed base64", { mediaType: "image/png", data: "not-base64" }],
    ["unsupported SVG", { mediaType: "image/svg+xml", data: "PHN2Zz4=" }],
  ] as const)
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const error = yield* LLMClient.prepare(
          LLM.request({ model, messages: [Message.user({ type: "media", ...media })] }),
        ).pipe(Effect.flip)
        expect(error.message).toMatch(/does not support|does not match|valid base64/)
      }),
    )

  it.effect("rejects oversized image input", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          model,
          messages: [
            Message.user({
              type: "media",
              mediaType: "image/png",
              data: "A".repeat(ProviderShared.MAX_MEDIA_ENCODED_BYTES + 4),
            }),
          ],
        }),
      ).pipe(Effect.flip)
      expect(error.message).toContain("encoded limit")
    }),
  )

  it.effect("prepares raw and data URL image media as vision input", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          id: "req_media",
          model,
          messages: [
            Message.user([
              { type: "media", mediaType: "image/png", data: "AAECAw==" },
              { type: "media", mediaType: "image/jpeg", data: "data:image/jpeg;base64,/9j/" },
            ]),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAECAw==" } },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } },
          ],
        },
      ])
    }),
  )

  it.effect("lowers reasoning-only assistant history", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          id: "req_reasoning",
          model,
          messages: [Message.assistant({ type: "reasoning", text: "hidden" })],
        }),
      )

      expect(prepared.body.messages).toEqual([{ role: "assistant", content: "", reasoning_content: "hidden" }])
    }),
  )

  it.effect("parses text and usage stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "Hello" }),
        deltaChunk({ content: "!" }),
        deltaChunk({}, "stop"),
        usageChunk({
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
          prompt_tokens_details: { cached_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 2,
        nonCachedInputTokens: 4,
        cacheReadInputTokens: 1,
        reasoningTokens: 0,
        totalTokens: 7,
        providerMetadata: {
          openai: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
            prompt_tokens_details: { cached_tokens: 1 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        },
      })

      expect(response.text).toBe("Hello!")
      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", text: "Hello" },
        { type: "text-delta", id: "text-0", text: "!" },
        { type: "text-end", id: "text-0" },
        { type: "step-finish", index: 0, reason: "stop", usage, providerMetadata: undefined },
        {
          type: "finish",
          reason: "stop",
          usage,
        },
      ])
    }),
  )

  // The owner's vLLM build (`vllm-0.29.0-tp2`, captured in
  // packages/engine/test/fixtures/vllm-usage-capture.md) omits `prompt_tokens_details`
  // entirely from the streamed usage chunk, although its own metrics report the
  // prefix cache serving 78% of that very prompt. The usage still has to decode:
  // a strict read of the missing key would drop the whole object and lose the
  // input count with it.
  it.effect("keeps usage when an OpenAI-compatible server omits prompt_tokens_details", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "OK" }),
        deltaChunk({}, "stop"),
        usageChunk({
          prompt_tokens: 3260,
          completion_tokens: 8,
          total_tokens: 3268,
          completion_tokens_details: { reasoning_tokens: 8 },
        }),
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.usage?.inputTokens).toBe(3260)
      expect(response.usage?.reasoningTokens).toBe(8)
      // No cached figure was reported, so none is invented.
      expect(response.usage?.cacheReadInputTokens).toBeUndefined()
      expect(response.usage?.nonCachedInputTokens).toBe(3260)
    }),
  )

  it.effect("parses OpenAI-compatible reasoning content deltas", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { choices: [{ delta: { reasoning_content: "thinking" } }] },
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      )

      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.reasoning).toBe("thinking")
      expect(response.text).toBe("Hello")
      expect(response.events).toMatchObject([
        { type: "step-start", index: 0 },
        { type: "reasoning-start", id: "reasoning-0" },
        { type: "reasoning-delta", id: "reasoning-0", text: "thinking" },
        { type: "reasoning-end", id: "reasoning-0" },
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", text: "Hello" },
        { type: "text-end", id: "text-0" },
        { type: "step-finish", index: 0, reason: "stop" },
        { type: "finish", reason: "stop" },
      ])
    }),
  )

  it.effect("assembles streamed tool call input", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"query"' } }],
        }),
        deltaChunk({ tool_calls: [{ index: 0, function: { arguments: ':"weather"}' } }] }),
        deltaChunk({}, "tool_calls"),
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "tool-input-start", id: "call_1", name: "lookup", providerMetadata: undefined },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: '{"query"' },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: ':"weather"}' },
        { type: "tool-input-end", id: "call_1", name: "lookup", providerMetadata: undefined },
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: undefined,
        },
        { type: "step-finish", index: 0, reason: "tool-calls", usage: undefined, providerMetadata: undefined },
        { type: "finish", reason: "tool-calls", usage: undefined },
      ])
    }),
  )

  it.effect("degrades a truncated parallel tool call instead of failing the turn", () =>
    Effect.gen(function* () {
      // Replay of a REAL failure, recorded 2026-09-03 from OpenRouter ->
      // Novita -> inclusionai/ling-3.0-flash-fin:free. Four parallel
      // webmcp_call calls; the upstream hit its own output cap partway through
      // the fourth argument string, and OpenRouter still normalised the choice
      // to `finish_reason: "tool_calls"` (its `native_finish_reason` was
      // "length"), so the protocol cannot even see that it was truncated. The
      // three complete calls, the finish reason and the usage must all survive.
      const call = (index: number, id: string, tool: string) => [
        deltaChunk({
          role: "assistant",
          tool_calls: [{ index, id, type: "function", function: { name: "webmcp_call", arguments: "" } }],
        }),
        deltaChunk({
          tool_calls: [
            { index, function: { arguments: `{"site": "https://origami.gratis/folio/", "tool": "${tool}"}` } },
          ],
        }),
      ]
      const truncated = '{"site": "https://origami.gratis/folio/", "tool": "search_docs", "args": {"query": "Origami'
      const body = sseEvents(
        ...call(0, "call_0", "list_themes"),
        ...call(1, "call_1", "list_starters"),
        ...call(2, "call_2", "list_chunks"),
        deltaChunk({
          role: "assistant",
          tool_calls: [{ index: 3, id: "call_3", type: "function", function: { name: "webmcp_call", arguments: "" } }],
        }),
        deltaChunk({ tool_calls: [{ index: 3, function: { arguments: truncated } }] }),
        deltaChunk({}, "tool_calls"),
        usageChunk({ prompt_tokens: 409, completion_tokens: 520, total_tokens: 929 }),
      )
      const input = LLM.updateRequest(request, {
        tools: [{ name: "webmcp_call", description: "Call a site tool", inputSchema: { type: "object" } }],
      })

      const events = Array.from(
        yield* LLMClient.stream(input).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      expect(events.filter((event) => event.type === "tool-call")).toMatchObject([
        { id: "call_0", name: "webmcp_call", input: { site: "https://origami.gratis/folio/", tool: "list_themes" } },
        { id: "call_1", name: "webmcp_call", input: { site: "https://origami.gratis/folio/", tool: "list_starters" } },
        { id: "call_2", name: "webmcp_call", input: { site: "https://origami.gratis/folio/", tool: "list_chunks" } },
        {
          id: "call_3",
          name: "webmcp_call",
          input: truncated,
          invalid: true,
          error: "Invalid JSON input for openai-chat tool call webmcp_call",
        },
      ])
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" })
      expect(events.filter((event) => event.type === "provider-error")).toEqual([])
    }),
  )

  it.effect("finalizes a streamed tool call as soon as its arguments parse, finish reason or not", () =>
    Effect.gen(function* () {
      // The same timing as @ai-sdk/openai-compatible: a consumer that ran the
      // announced call before the stream died must be able to tell, so the
      // call cannot wait for a finish reason that never comes.
      const body = sseEvents(
        deltaChunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"query"' } }],
        }),
        deltaChunk({ tool_calls: [{ index: 0, function: { arguments: ':"weather"}' } }] }),
      )
      const input = LLM.updateRequest(request, {
        tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
      })
      const events = Array.from(
        yield* LLMClient.stream(input).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )
      const response = yield* LLMClient.generate(input).pipe(Effect.provide(fixedResponse(body)))

      expect(events.slice(0, 6)).toEqual([
        { type: "step-start", index: 0 },
        { type: "tool-input-start", id: "call_1", name: "lookup", providerMetadata: undefined },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: '{"query"' },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: ':"weather"}' },
        { type: "tool-input-end", id: "call_1", name: "lookup", providerMetadata: undefined },
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: undefined,
          invalid: undefined,
          error: undefined,
        },
      ])
      // ...and the turn STILL ends. A body that stops without a `finish_reason`
      // used to leave the stream with no terminal event at all, so the consumer's
      // assistant message never completed. `@ai-sdk/openai-compatible` finishes
      // every flush with reason "unknown", and the engine has a documented
      // recovery for exactly that value (`session/processor.ts` does not mark an
      // "unknown" finish terminal; `session/prompt.ts` continues the turn), which
      // the native path could not reach while it emitted nothing.
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "unknown" })
      expect(response.finishReason).toBe("unknown")
    }),
  )

  it.effect("does not finalize a streamed tool call whose arguments are still incomplete", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        deltaChunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"query"' } }],
        }),
        deltaChunk({ tool_calls: [{ index: 0, function: { arguments: ':"wea' } }] }),
      )
      const input = LLM.updateRequest(request, {
        tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
      })
      const events = Array.from(
        yield* LLMClient.stream(input).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )
      expect(events.filter(LLMEvent.is.toolCall)).toEqual([])
      expect(events.filter(LLMEvent.is.toolInputDelta)).toHaveLength(2)
    }),
  )

  it.effect("fails on malformed stream events", () =>
    Effect.gen(function* () {
      const body = sseEvents(deltaChunk({ content: 123 }))
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)), Effect.flip)

      expect(error.message).toContain("Invalid openai/openai-chat stream event")
    }),
  )

  // ---------------------------------------------------------------------------
  // In-band provider errors and index-less tool deltas
  //
  // Both conditions are OpenAI-Chat-WIRE facts, not OpenAI-endpoint ones:
  // OpenRouter reports every post-header failure inside the 200 body, and some
  // OpenAI-compatible servers omit `tool_calls[].index`. The fixtures below
  // quote the documented shapes; sources are in the lane report.
  // ---------------------------------------------------------------------------

  it.effect("reports a BARE in-band error frame instead of failing the stream", () =>
    Effect.gen(function* () {
      // OpenRouter, https://openrouter.ai/docs/api-reference/errors:
      //   type ErrorResponse = { error: { code: number; message: string;
      //                                   metadata?: Record<string, unknown> } }
      // Rate limits, provider outages, moderation and credit exhaustion all
      // arrive this way once the headers are out, with the status still 200.
      const body = sseEvents(deltaChunk({ role: "assistant", content: "Thinking" }), {
        error: {
          code: 429,
          message: "Rate limit exceeded: free-models-per-day",
          metadata: { error_type: "rate_limit", provider_code: "novita" },
        },
      })

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      // The prose that DID arrive is kept, the provider's own sentence is
      // reported, and the stream still names how it ended.
      expect(events.filter(LLMEvent.is.textDelta).map((event) => event.text)).toEqual(["Thinking"])
      expect(events.filter(LLMEvent.is.providerError)).toEqual([
        {
          type: "provider-error",
          message: "Rate limit exceeded: free-models-per-day",
          classification: undefined,
          retryable: undefined,
          providerMetadata: {
            openai: {
              code: 429,
              message: "Rate limit exceeded: free-models-per-day",
              metadata: { error_type: "rate_limit", provider_code: "novita" },
            },
          },
        },
      ])
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" })
    }),
  )

  it.effect("reports an in-band error frame that ALSO carries choices", () =>
    Effect.gen(function* () {
      // OpenRouter's documented mid-stream shape
      // (https://openrouter.ai/docs/api-reference/streaming): the error sits at
      // the TOP LEVEL beside the ordinary chunk fields, so a decoder that only
      // looks at `choices` reads the frame as a normal empty delta and throws
      // the failure away.
      const body = sseEvents(deltaChunk({ role: "assistant", content: "half a th" }), {
        id: "cmpl-abc123",
        object: "chat.completion.chunk",
        created: 1234567890,
        model: "openai/gpt-4o",
        provider: "openai",
        error: { code: "server_error", message: "Provider disconnected unexpectedly" },
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
      })

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      expect(events.filter(LLMEvent.is.providerError).map((event) => event.message)).toEqual([
        "Provider disconnected unexpectedly",
      ])
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" })
    }),
  )

  it.effect("reports an in-band error whose payload is a BARE SENTENCE, not an object", () =>
    Effect.gen(function* () {
      // Several OpenAI-compatible servers, and proxies in front of them, send
      // `{"error": "..."}` with a string rather than the documented object. The
      // engine's own stream-drop classifier already reads that shape
      // (`session/stream-drop.ts` `frameMessage`: `typeof error === "string"`),
      // but the schema did not, so the frame lost the error member of the union.
      // With `choices` beside it — as here — it then decoded as an ordinary
      // empty delta and the failure was discarded in SILENCE, which is the
      // dangerous half: with no `choices` it at least failed loudly.
      const body = sseEvents(deltaChunk({ role: "assistant", content: "half a th" }), {
        id: "cmpl-string-error",
        object: "chat.completion.chunk",
        error: "Upstream is overloaded, try again",
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
      })

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      expect(events.filter(LLMEvent.is.providerError).map((event) => event.message)).toEqual([
        "Upstream is overloaded, try again",
      ])
      // The prose that arrived before the failure is still delivered.
      expect(
        events
          .filter(LLMEvent.is.textDelta)
          .map((event) => event.text)
          .join(""),
      ).toBe("half a th")
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" })
    }),
  )

  it.effect("keeps the whole payload when the provider's sentence is the word ERROR (t-h8s3xg)", () =>
    Effect.gen(function* () {
      // What `openrouter / stealth/union-alpha` recorded on three sessions:
      // the provider's whole report, about 45 s into a stream, was the word
      // ERROR. No cassette under test/fixtures/recordings has one - this is a
      // synthetic frame in the documented shape, and union-alpha is a paid
      // lane that is not worth a recording run.
      //
      // The PROTOCOL's job here is only to keep it whole: the sentence stays
      // bare (the engine's stream-drop classifier reads these words) and the
      // payload rides on `providerMetadata`, which is what
      // `session/provider-error-frame.ts` then has to work with.
      const body = sseEvents(deltaChunk({ role: "assistant", content: "working" }), {
        id: "cmpl-union-alpha",
        object: "chat.completion.chunk",
        error: { message: "ERROR", type: "ERROR", code: 500 },
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
      })

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      expect(events.filter(LLMEvent.is.providerError)).toEqual([
        {
          type: "provider-error",
          message: "ERROR",
          classification: undefined,
          retryable: undefined,
          providerMetadata: { openai: { message: "ERROR", type: "ERROR", code: 500 } },
        },
      ])
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" })
    }),
  )

  it.effect("an error frame with NO message at all still carries its type (t-h8s3xg)", () =>
    Effect.gen(function* () {
      // The same fault, one field thinner: the provider named a type and wrote
      // no sentence. `providerErrorMessage` falls back to the type, so the
      // engine reads `ERROR` again - and the payload is still whole.
      const body = sseEvents({
        id: "cmpl-union-alpha-2",
        object: "chat.completion.chunk",
        error: { type: "ERROR" },
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
      })

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      expect(events.filter(LLMEvent.is.providerError).map((event) => event.message)).toEqual(["ERROR"])
      expect(events.filter(LLMEvent.is.providerError).map((event) => event.providerMetadata)).toEqual([
        { openai: { type: "ERROR" } },
      ])
    }),
  )

  it.effect("a chunk carrying `error: null` is an ordinary chunk, not a failure", () =>
    Effect.gen(function* () {
      // The false-positive guard on the tolerance above. Providers that include
      // the key on EVERY chunk are common; reading those as failures would turn
      // every turn into an error card.
      const body = sseEvents(
        { error: null, choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
        { error: null, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      )

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      expect(events.filter(LLMEvent.is.providerError)).toEqual([])
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
    }),
  )

  it.effect('a chunk carrying `error: ""` is an ordinary chunk, not a failure', () =>
    Effect.gen(function* () {
      // The same guard for the string member: an empty sentence names nothing,
      // so there is no report to make.
      const body = sseEvents(
        { error: "", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
        { error: "", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      )

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      expect(events.filter(LLMEvent.is.providerError)).toEqual([])
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
    }),
  )

  it.effect('a body that never sends a finish_reason still ends the turn, with reason "unknown"', () =>
    Effect.gen(function* () {
      // A gateway that cuts at the response boundary, or a server that omits the
      // final choice, ends the body cleanly with no `finish_reason` anywhere.
      // The stream used to end with NO terminal event and NO `text-end`, so the
      // consumer's block never closed. `@ai-sdk/openai-compatible` finishes at
      // its flush with "unknown", and the engine has a documented recovery for
      // that exact value (`session/processor.ts` does not mark it terminal).
      const body = sseEvents(deltaChunk({ role: "assistant", content: "half an ans" }))

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      expect(events.map((event) => event.type)).toEqual([
        "step-start",
        "text-start",
        "text-delta",
        "text-end",
        "step-finish",
        "finish",
      ])
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "unknown" })
    }),
  )

  it.effect("a multi-byte rune split across two transport chunks arrives whole", () =>
    Effect.gen(function* () {
      // The SSE body is sliced every 7 bytes, which lands inside the 2-, 3- and
      // 4-byte sequences below. A per-chunk (non-streaming) UTF-8 decode would
      // turn each cut rune into U+FFFD and corrupt the answer silently.
      const text = "héllo 🌍 日本語 — ok"
      const bytes = new TextEncoder().encode(sseEvents(deltaChunk({ content: text }), deltaChunk({}, "stop")))
      const chunked = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
          controller.close()
        },
      })

      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(chunked)))

      expect(response.text).toBe(text)
      expect(response.text).not.toContain("�")
    }),
  )

  it.effect("classifies an in-band context-length error as context-overflow", () =>
    Effect.gen(function* () {
      const body = sseEvents({
        error: { code: 400, message: "This model's maximum context length is 128000 tokens." },
      })

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      expect(events.filter(LLMEvent.is.providerError)).toMatchObject([{ classification: "context-overflow" }])
    }),
  )

  it.effect("still fails the stream for a chunk that is neither a choice chunk nor an error", () =>
    Effect.gen(function* () {
      // The BOUNDARY of the tolerance above: only an `error` frame is read as a
      // report. Any other chunk that fails the event schema still kills the
      // stream, because an unreadable chunk may have carried content and
      // skipping it would lose that without saying so.
      const body = sseEvents({ id: "chatcmpl_fixture", object: "chat.completion.chunk" })
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)), Effect.flip)

      expect(error.message).toContain("Invalid openai/openai-chat stream event")
    }),
  )

  it.effect("still fails the stream for a chunk whose choices are malformed", () =>
    Effect.gen(function* () {
      const body = sseEvents({ id: "chatcmpl_fixture", choices: "not-an-array" })
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)), Effect.flip)

      expect(error.message).toContain("Invalid openai/openai-chat stream event")
    }),
  )

  it.effect("starts a FRESH call for a tool delta that carries no index", () =>
    Effect.gen(function* () {
      // `@ai-sdk/openai-compatible` types the field `z.number().nullish()` with
      // the comment "google does not send index", and resolves it as
      // `toolCallDelta.index ?? toolCalls.length`. Two index-less calls must
      // therefore land on two DIFFERENT slots instead of merging into one.
      const call = (id: string, query: string) => ({
        id: "chatcmpl_fixture",
        choices: [
          {
            delta: {
              role: "assistant",
              tool_calls: [{ id, function: { name: "lookup", arguments: JSON.stringify({ query }) } }],
            },
            finish_reason: null,
          },
        ],
      })
      const body = sseEvents(call("call_a", "weather"), call("call_b", "tides"), deltaChunk({}, "tool_calls"))
      const input = LLM.updateRequest(request, {
        tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
      })

      const events = Array.from(
        yield* LLMClient.stream(input).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      expect(events.filter(LLMEvent.is.toolCall)).toMatchObject([
        { id: "call_a", name: "lookup", input: { query: "weather" } },
        { id: "call_b", name: "lookup", input: { query: "tides" } },
      ])
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" })
    }),
  )

  it.effect("keeps two calls apart when the provider DOES send indexes", () =>
    Effect.gen(function* () {
      // The guard on that fallback: a provided index always wins, so the second
      // call's argument deltas can never be appended onto the first.
      const body = sseEvents(
        deltaChunk({
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_a", function: { name: "lookup", arguments: '{"query"' } }],
        }),
        deltaChunk({
          role: "assistant",
          tool_calls: [{ index: 1, id: "call_b", function: { name: "lookup", arguments: '{"query"' } }],
        }),
        deltaChunk({ tool_calls: [{ index: 0, function: { arguments: ':"weather"}' } }] }),
        deltaChunk({ tool_calls: [{ index: 1, function: { arguments: ':"tides"}' } }] }),
        deltaChunk({}, "tool_calls"),
      )
      const input = LLM.updateRequest(request, {
        tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
      })

      const events = Array.from(
        yield* LLMClient.stream(input).pipe(Stream.runCollect, Effect.provide(fixedResponse(body))),
      )

      expect(events.filter(LLMEvent.is.toolCall)).toMatchObject([
        { id: "call_a", name: "lookup", input: { query: "weather" } },
        { id: "call_b", name: "lookup", input: { query: "tides" } },
      ])
    }),
  )

  it.effect("surfaces transport errors that occur mid-stream", () =>
    Effect.gen(function* () {
      const layer = truncatedStream([
        `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello" }))}\n\n`,
      ])
      const error = yield* LLMClient.generate(request).pipe(Effect.provide(layer), Effect.flip)

      expect(error.message).toContain("Failed to read openai/openai-chat stream")
    }),
  )

  it.effect("fails HTTP provider errors before stream parsing", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse('{"error":{"message":"Bad request","type":"invalid_request_error"}}', {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect(error.message).toContain("HTTP 400")
    }),
  )

  it.effect("short-circuits the upstream stream when the consumer takes a prefix", () =>
    Effect.gen(function* () {
      // The body has more chunks than we'll consume. If `Stream.take(1)` did
      // not interrupt the upstream HTTP body the test would hang waiting for
      // the rest of the stream to drain.
      const body = sseEvents(
        deltaChunk({ role: "assistant", content: "Hello" }),
        deltaChunk({ content: " world" }),
        deltaChunk({}, "stop"),
      )

      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.take(1), Stream.runCollect, Effect.provide(fixedResponse(body))),
      )
      expect(events.map((event) => event.type)).toEqual(["step-start"])
    }),
  )
})
