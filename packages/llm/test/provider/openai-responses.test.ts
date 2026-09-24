import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Stream } from "effect"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMError, Message, Model, ToolCallPart, Usage } from "../../src"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor } from "../../src/route"
import * as Azure from "../../src/providers/azure"
import * as OpenAI from "../../src/providers/openai"
import * as OpenAIResponses from "../../src/protocols/openai-responses"
import * as ProviderShared from "../../src/protocols/shared"
import { continuationRequest, nativeOpenAIResponsesContinuation } from "../continuation-scenarios"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const responsesModel = (id: string) =>
  OpenAIResponses.route
    .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
    .model({ id })

const model = responsesModel("gpt-4.1-mini")

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

const configEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

type OpenAIToolOutput = Extract<
  OpenAIResponses.OpenAIResponsesBody["input"][number],
  { readonly type: "function_call_output" }
>

const expectToolOutput = (body: OpenAIResponses.OpenAIResponsesBody): OpenAIToolOutput => {
  const output = body.input.find(
    (item): item is OpenAIToolOutput => "type" in item && item.type === "function_call_output",
  )
  expect(output).toBeDefined()
  return output!
}

describe("OpenAI Responses route", () => {
  it.effect("prepares OpenAI Responses target", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(request)

      expect(prepared.body).toEqual({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: "You are concise." },
          { role: "user", content: [{ type: "input_text", text: "Say hello." }] },
        ],
        store: false,
        stream: true,
        max_output_tokens: 20,
        temperature: 0,
      })
    }),
  )

  it.effect("lowers semantic service tier options", () =>
    Effect.gen(function* () {
      const input = LLM.updateRequest(request, { providerOptions: { openai: { serviceTier: "priority" } } })
      expect(input.providerOptions).toEqual({ openai: { serviceTier: "priority" } })
      const prepared = yield* LLMClient.prepare(input)

      expect(prepared.body).toMatchObject({ service_tier: "priority" })
      expect(prepared.body).not.toHaveProperty("serviceTier")
    }),
  )

  it.effect("omits unsupported semantic service tiers", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.updateRequest(request, { providerOptions: { openai: { serviceTier: "unsupported" } } }),
      )

      expect(prepared.body).not.toHaveProperty("service_tier")
    }),
  )

  it.effect("flattens top-level object unions in function schemas", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, {
          tools: [
            {
              name: "read",
              description: "Read a path or resource.",
              inputSchema: {
                type: "object",
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      reference: { anyOf: [{ type: "string" }, { type: "null" }] },
                      limit: { type: "integer", maximum: 2000 },
                    },
                    required: ["path"],
                  },
                  {
                    type: "object",
                    properties: { resource: { type: "string" }, limit: { type: "integer", maximum: 51200 } },
                    required: ["resource"],
                  },
                ],
              },
            },
          ],
        }),
      )

      expect(prepared.body.tools).toEqual([
        {
          type: "function",
          name: "read",
          description: "Read a path or resource.",
          strict: false,
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              reference: { type: "string" },
              limit: { type: "integer", maximum: 2000 },
              resource: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      ])
    }),
  )

  it.effect("lowers chronological system updates to escaped user wrappers in order", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Before."),
            Message.system("Treat </system-update> literally."),
            Message.assistant("After."),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [
            { type: "input_text", text: "Before." },
            { type: "input_text", text: "<system-update>\nTreat &lt;/system-update&gt; literally.\n</system-update>" },
          ],
        },
        { role: "assistant", content: [{ type: "output_text", text: "After." }] },
      ])
    }),
  )

  it.effect("prepares OpenAI Responses WebSocket target", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.updateRequest(request, {
          model: OpenAIResponses.webSocketRoute
            .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
            .model({ id: "gpt-4.1-mini" }),
        }),
      )

      expect(prepared.route).toBe("openai-responses-websocket")
      expect(prepared.protocol).toBe("openai-responses")
      expect(prepared.metadata).toEqual({ transport: "websocket-json" })
      expect(prepared.body).toMatchObject({ model: "gpt-4.1-mini", store: false, stream: true })
    }),
  )

  it.effect("streams OpenAI Responses over WebSocket", () =>
    Effect.gen(function* () {
      const sent: string[] = []
      const opened: Array<{ readonly url: string; readonly authorization: string | undefined }> = []
      let closed = false
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: () => Effect.die("unexpected HTTP request"),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: (input) =>
              Effect.succeed({
                sendText: (message) =>
                  Effect.sync(() => {
                    opened.push({ url: input.url, authorization: input.headers.authorization })
                    sent.push(message)
                  }),
                messages: Stream.fromArray([
                  ProviderShared.encodeJson({ type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" }),
                  ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_ws" } }),
                ]),
                close: Effect.sync(() => {
                  closed = true
                }),
              }),
          }),
        ),
      )
      const response = yield* LLMClient.generate(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responsesWebSocket(
            "gpt-4.1-mini",
          ),
          prompt: "Say hello.",
        }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))))

      expect(response.text).toBe("Hi")
      expect(opened).toEqual([{ url: "wss://api.openai.test/v1/responses", authorization: "Bearer test" }])
      expect(closed).toBe(true)
      expect(sent).toHaveLength(1)
      expect(JSON.parse(sent[0])).toEqual({
        type: "response.create",
        model: "gpt-4.1-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
        store: false,
      })
    }),
  )

  it.effect("fails immediately when WebSocket is already closed", () =>
    Effect.gen(function* () {
      const error = yield* WebSocketExecutor.fromWebSocket(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fromWebSocket reads readyState before touching WebSocket methods on this branch.
        { readyState: globalThis.WebSocket.CLOSED } as globalThis.WebSocket,
        { url: "wss://api.openai.test/v1/responses", headers: Headers.empty },
      ).pipe(Effect.flip)

      expect(error.message).toContain("closed before opening")
    }),
  )

  it.effect("adds native query params to the Responses URL", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: Model.update(model, { route: model.route.with({ endpoint: { query: { "api-version": "v1" } } }) }),
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.openai.test/v1/responses?api-version=v1")
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("uses Azure api-key header for static OpenAI Responses keys", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: Azure.configure({
            baseURL: "https://origami-test.openai.azure.com/openai/v1/",
            apiKey: "azure-key",
            headers: { authorization: "Bearer stale" },
          }).responses("gpt-4.1-mini"),
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://origami-test.openai.azure.com/openai/v1/responses?api-version=v1")
              expect(web.headers.get("api-key")).toBe("azure-key")
              expect(web.headers.get("authorization")).toBeNull()
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("loads OpenAI default auth from Effect Config", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/" }).responses("gpt-4.1-mini"),
      }),
    ).pipe(
      configEnv({ OPENAI_API_KEY: "env-key" }),
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.headers.get("authorization")).toBe("Bearer env-key")
            return input.respond(sseEvents({ type: "response.completed", response: {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("lets explicit auth override OpenAI default API key auth", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: OpenAI.configure({
          baseURL: "https://api.openai.test/v1/",
          auth: Auth.bearer("oauth-token"),
        }).responses("gpt-4.1-mini"),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.headers.get("authorization")).toBe("Bearer oauth-token")
            return input.respond(sseEvents({ type: "response.completed", response: {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("prepares function call and function output input items", () =>
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
        model: "gpt-4.1-mini",
        input: [
          { role: "user", content: [{ type: "input_text", text: "What is the weather?" }] },
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"weather"}' },
          { type: "function_call_output", call_id: "call_1", output: '{"forecast":"sunny"}' },
        ],
        store: false,
        stream: true,
        max_output_tokens: undefined,
        temperature: undefined,
        tool_choice: undefined,
        tools: undefined,
        top_p: undefined,
      })
    }),
  )

  it.effect("preserves structured tool errors for the model", () =>
    Effect.gen(function* () {
      const error = {
        error: { type: "unknown", message: "Tool execution interrupted" },
        content: [],
        structured: {},
      }
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "bash", input: { command: "sleep 10" } })]),
            Message.tool({
              id: "call_1",
              name: "bash",
              resultType: "error",
              result: error,
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toBe(ProviderShared.encodeJson(error))
    }),
  )

  it.effect("keeps primitive tool errors as plain text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "bash", input: {} })]),
            Message.tool({ id: "call_1", name: "bash", resultType: "error", result: 503 }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toBe("503")
    }),
  )

  it.effect("keeps non-JSON tool errors as plain text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "bash", input: {} })]),
            Message.tool({ id: "call_1", name: "bash", resultType: "error", result: new Error("boom") }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toBe("Error: boom")
    }),
  )

  // Regression: screenshot/read tool results must stay structured so base64
  // image data is not JSON-stringified into `function_call_output.output`.
  it.effect("lowers image tool-result content as structured input_image items", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_tool_result_image",
          model,
          messages: [
            Message.user("Show me the screenshot."),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: { filePath: "shot.png" } })]),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" },
              ],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_text", text: "Image read successfully" },
        { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
      ])
    }),
  )

  it.effect("lowers single-image tool-result content as structured input_image array", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_tool_result_image_only",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "screenshot", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "screenshot",
              resultType: "content",
              result: [{ type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" }],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
      ])
    }),
  )

  // ===========================================================================
  // Image budget (t-4aqhjb)
  // ===========================================================================
  // Canonical base64 of `n` zero bytes; `validateMedia` re-encodes and compares,
  // so anything less exact is rejected before the budget is ever consulted.
  const base64Of = (byteLength: number) => Buffer.alloc(byteLength).toString("base64")
  const pngUrl = (byteLength: number) => `data:image/png;base64,${base64Of(byteLength)}`

  // The measured poison: a 9.2 MB screenshot the engine's resizer brought down
  // to a 3,753,798-byte data URL, attached to a `read` tool result at 21:52:12
  // on 2026-09-09. Every step after it replayed those bytes and died.
  const POISON_BASE64_BYTES = 3_753_798 - "data:image/png;base64,".length
  const poisonUrl = `data:image/png;base64,${base64Of(Math.floor(POISON_BASE64_BYTES / 4) * 3)}`

  it.effect("replaces a tool-result image over the per-image cap with a note", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_image_cap",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: { filePath: "shot.png" } })]),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: pngUrl(2.5 * 1024 * 1024), mime: "image/png" },
              ],
            }),
          ],
        }),
      )

      // The model is TOLD, not silently starved: one that asked to look at
      // something and got nothing back would only ask again.
      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_text", text: "Image read successfully" },
        {
          type: "input_text",
          text: "[image omitted: 3.3 MB exceeds the 2.0 MB per-image limit for this provider; ask for a smaller capture]",
        },
      ])
    }),
  )

  it.effect("replaces a user image over the per-image cap with a note", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_user_image_cap",
          model,
          messages: [
            Message.user({ type: "media", mediaType: "image/png", data: base64Of(3 * 1024 * 1024) }),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "[image omitted: 4.0 MB exceeds the 2.0 MB per-image limit for this provider; ask for a smaller capture]",
            },
          ],
        },
      ])
    }),
  )

  // t-ub95jp: from 5,505,020 base64 characters the media check refused a VALID
  // image as "invalid base64", before the cap above could replace it, so the
  // whole request failed. Now the cap sees it like any other oversized image.
  it.effect("replaces a user image of 5,505,020+ base64 characters with the cap note", () =>
    Effect.gen(function* () {
      const data = base64Of(4_200_000) // 5,600,000 characters
      expect(data.length).toBeGreaterThanOrEqual(5_505_020)
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_user_image_huge",
          model,
          messages: [Message.user({ type: "media", mediaType: "image/png", data })],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "[image omitted: 5.3 MB exceeds the 2.0 MB per-image limit for this provider; ask for a smaller capture]",
            },
          ],
        },
      ])
    }),
  )

  // Newest is what the model is looking at now; the oldest is history it has
  // already described in prose, so history pays for the budget. The caps come
  // from provider options here so the test states its own arithmetic instead of
  // moving megabytes around.
  it.effect("drops the OLDEST images first when the request is over budget", () =>
    Effect.gen(function* () {
      const first = pngUrl(450)
      const second = pngUrl(450)
      const third = pngUrl(450)
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_image_budget",
          model,
          // 600 base64 bytes each, all under the 1000 cap; 1800 together is
          // over the 1400 budget, and dropping ONE brings it to 1200.
          providerOptions: { openai: { maxImageBytes: 1000, maxRequestImageBytes: 1400 } },
          messages: [
            Message.user({ type: "media", mediaType: "image/png", data: first }),
            Message.user({ type: "media", mediaType: "image/png", data: second }),
            Message.user({ type: "media", mediaType: "image/png", data: third }),
          ],
        }),
      )

      const content = prepared.body.input.map((item) => ("role" in item ? item.content : item))
      expect(content).toEqual([
        [
          {
            type: "input_text",
            text: "[image omitted: 1 KB; this request's images exceed the 1 KB total limit for this provider, and the oldest were dropped first]",
          },
        ],
        [{ type: "input_image", image_url: second }],
        [{ type: "input_image", image_url: third }],
      ])
    }),
  )

  // The self-heal. A session that ALREADY stored an oversized picture replays
  // it on every attempt and can never send a request without it — the engine's
  // recent-image window bounds count, not size. The budget runs on the replayed
  // input, so the next attempt sends the note and the session recovers itself.
  it.effect("un-poisons a stored session whose history carries an oversized image", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_poisoned_replay",
          model,
          messages: [
            Message.user("Look at the screenshot."),
            Message.assistant([
              ToolCallPart.make({ id: "call_1", name: "read", input: { filePath: "screen.png" } }),
            ]),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: poisonUrl, mime: "image/png" },
              ],
            }),
            Message.user("Resume the task."),
          ],
        }),
      )

      const wire = JSON.stringify(prepared.body)
      expect(wire).not.toContain("data:image/png;base64,")
      expect(wire).toContain("[image omitted: 3.6 MB exceeds the 2.0 MB per-image limit")
      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_text", text: "Image read successfully" },
        {
          type: "input_text",
          text: "[image omitted: 3.6 MB exceeds the 2.0 MB per-image limit for this provider; ask for a smaller capture]",
        },
      ])
    }),
  )

  it.effect("rejects non-image media in tool-result content with a clear error", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_result_unsupported_media",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "fetch", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "fetch",
              resultType: "content",
              result: [{ type: "file", uri: "data:audio/mpeg;base64,AAECAw==", mime: "audio/mpeg" }],
            }),
          ],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("OpenAI Responses")
      expect(error.message).toContain("audio/mpeg")
    }),
  )

  it.effect("prepares the composed native continuation request", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        continuationRequest({
          id: "req_native_continuation_openai",
          model,
          features: nativeOpenAIResponsesContinuation,
        }),
      )

      expect(prepared.body).toMatchObject({
        input: [
          { role: "system", content: "You are concise. Continue from the provided history." },
          {
            role: "user",
            content: [
              { type: "input_text", text: "What is shown here?" },
              { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
            ],
          },
          {
            type: "reasoning",
            encrypted_content: "encrypted-continuation-state",
            summary: [{ type: "summary_text", text: "I inspected the previous turn." }],
          },
          { role: "assistant", content: [{ type: "output_text", text: "It shows a small test image." }] },
          { role: "user", content: [{ type: "input_text", text: "Check the weather in Paris before continuing." }] },
          { type: "function_call", call_id: "call_weather_1", name: "get_weather", arguments: '{"city":"Paris"}' },
          { type: "function_call_output", call_id: "call_weather_1", output: '{"temperature":22}' },
          { role: "assistant", content: [{ type: "output_text", text: "Paris is 22 degrees." }] },
          {
            role: "user",
            content: [{ type: "input_text", text: "Continue from this conversation in one short sentence." }],
          },
        ],
        include: ["reasoning.encrypted_content"],
        store: false,
      })
      expect(prepared.body.tools).toEqual([expect.objectContaining({ type: "function", name: "get_weather" })])
    }),
  )

  it.effect("maps OpenAI provider options to Responses options", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.2"),
          prompt: "think",
          providerOptions: {
            openai: {
              promptCacheKey: "session_123",
              reasoningEffort: "high",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          },
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.prompt_cache_key).toBe("session_123")
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
      expect(prepared.body.reasoning).toEqual({ effort: "high", summary: "auto" })
      expect(prepared.body.text).toEqual({ verbosity: "low" })
    }),
  )

  // t-rz0amv: extended retention is what makes an idle prompt cache outlive the
  // in-memory window, so it has to reach the wire body, not just the options.
  it.effect("sends prompt_cache_retention on the wire", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.2"),
          prompt: "think",
          providerOptions: { openai: { promptCacheKey: "session_123", promptCacheRetention: "24h" } },
        }),
      )

      expect(prepared.body.prompt_cache_retention).toBe("24h")
    }),
  )

  it.effect("drops a prompt_cache_retention value the endpoint does not define", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.2"),
          prompt: "think",
          providerOptions: { openai: { promptCacheRetention: "1h" } },
        }),
      )

      expect(prepared.body.prompt_cache_retention).toBeUndefined()
    }),
  )

  it.effect("accepts the full ResponseIncludable union", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          prompt: "hi",
          providerOptions: {
            openai: {
              include: ["reasoning.encrypted_content", "code_interpreter_call.outputs", "web_search_call.results"],
            },
          },
        }),
      )

      expect(prepared.body.include).toEqual([
        "reasoning.encrypted_content",
        "code_interpreter_call.outputs",
        "web_search_call.results",
      ])
    }),
  )

  it.effect("filters unknown includable values out of the include array", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          prompt: "hi",
          // The user passed one invalid entry alongside a valid one. Keep the
          // valid one so the request still succeeds rather than failing on a
          // typo from upstream config.
          providerOptions: { openai: { include: ["reasoning.encrypted_content", "bogus.thing"] } },
        }),
      )

      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
    }),
  )

  it.effect("treats an explicit empty include as no include at all", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model, prompt: "hi", providerOptions: { openai: { include: [] } } }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("treats an all-invalid include as no include at all", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model, prompt: "hi", providerOptions: { openai: { include: ["bogus.thing"] } } }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("omits include when no include is set", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model, prompt: "hi", providerOptions: { openai: { store: false } } }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("requests encrypted reasoning by default for GPT-5 reasoning models", () =>
    Effect.gen(function* () {
      // The native OpenAI facade configures GPT-5 stateless (store: false) with
      // reasoningSummary: "auto" by default. Without `include`, a follow-up
      // turn cannot replay reasoning state, so the facade also opts into
      // `reasoning.encrypted_content` automatically.
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.2"),
          prompt: "hi",
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
      expect(prepared.body.reasoning).toEqual({ effort: "medium", summary: "auto" })
    }),
  )

  it.effect("lets callers opt out of the GPT-5 default include", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.2"),
          prompt: "hi",
          providerOptions: { openai: { include: [] } },
        }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("request OpenAI provider options override route defaults", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({
            baseURL: "https://api.openai.test/v1/",
            apiKey: "test",
            providerOptions: { openai: { promptCacheKey: "model_cache" } },
          }).model("gpt-4.1-mini"),
          prompt: "no cache",
          providerOptions: { openai: { promptCacheKey: "request_cache" } },
        }),
      )

      expect(prepared.body.prompt_cache_key).toBe("request_cache")
    }),
  )

  it.effect("parses text and usage stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "!" },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            service_tier: "default",
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              total_tokens: 7,
              input_tokens_details: { cached_tokens: 1 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
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
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7,
            input_tokens_details: { cached_tokens: 1 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      })

      expect(response.text).toBe("Hello!")
      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "text-start", id: "msg_1" },
        { type: "text-delta", id: "msg_1", text: "Hello" },
        { type: "text-delta", id: "msg_1", text: "!" },
        { type: "text-end", id: "msg_1" },
        {
          type: "step-finish",
          index: 0,
          reason: "stop",
          providerMetadata: { openai: { responseId: "resp_1", serviceTier: "default" } },
          usage,
        },
        {
          type: "finish",
          reason: "stop",
          providerMetadata: { openai: { responseId: "resp_1", serviceTier: "default" } },
          usage,
        },
      ])
    }),
  )

  it.effect("parses reasoning summary stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thinking" },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
        { type: "response.reasoning_summary_text.done", item_id: "rs_1" },
        { type: "response.completed", response: { id: "resp_1" } },
      )

      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.reasoning).toBe("thinking")
      expect(response.text).toBe("Hello")
      expect(response.events).toMatchObject([
        { type: "step-start", index: 0 },
        { type: "reasoning-start", id: "rs_1" },
        { type: "reasoning-delta", id: "rs_1", text: "thinking" },
        { type: "text-start", id: "msg_1" },
        { type: "text-delta", id: "msg_1", text: "Hello" },
        { type: "reasoning-end", id: "rs_1" },
        { type: "text-end", id: "msg_1" },
        { type: "step-finish", index: 0, reason: "stop" },
        { type: "finish", reason: "stop" },
      ])
      expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
      expect(response.message.content).toEqual([
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "Hello" },
      ])
    }),
  )

  it.effect("preserves encrypted reasoning metadata for continuation", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thinking" },
              {
                type: "response.output_item.done",
                item: {
                  type: "reasoning",
                  id: "rs_1",
                  encrypted_content: "encrypted-state",
                  summary: [{ type: "summary_text", text: "thinking" }],
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events).toContainEqual(
        expect.objectContaining({
          type: "reasoning-end",
          id: "rs_1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
      )
    }),
  )

  it.effect("streams each reasoning summary part as a separate block", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, { providerOptions: { openai: { store: false } } }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "First" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "Second" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1 },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-state" },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("FirstSecond")
      expect(response.events).toMatchObject([
        { type: "step-start", index: 0 },
        {
          type: "reasoning-start",
          id: "rs_1:0",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:0", text: "First" },
        { type: "reasoning-end", id: "rs_1:0", providerMetadata: { openai: { itemId: "rs_1" } } },
        {
          type: "reasoning-start",
          id: "rs_1:1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:1", text: "Second" },
        {
          type: "reasoning-end",
          id: "rs_1:1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
        { type: "step-finish", index: 0, reason: "stop" },
        { type: "finish", reason: "stop" },
      ])
    }),
  )

  it.effect("closes reasoning summary parts when storage is not disabled", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, { providerOptions: { openai: { store: true } } }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "First" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "Second" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1 },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "reasoning-end")).toEqual([
        { type: "reasoning-end", id: "rs_1:0", providerMetadata: { openai: { itemId: "rs_1" } } },
        { type: "reasoning-end", id: "rs_1:1", providerMetadata: { openai: { itemId: "rs_1" } } },
      ])
    }),
  )

  it.effect("continues a stateless reasoning conversation", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          id: "req_reasoning_continue",
          model,
          messages: [
            Message.user("What changed?"),
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: "encrypted-state",
                  },
                },
              },
              { type: "text", text: "The parser changed." },
            ]),
            Message.user("Summarize it."),
          ],
          providerOptions: { openai: { store: false } },
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              const body = yield* Effect.promise(() => web.json())
              expect(body).toMatchObject({
                input: [
                  { role: "user", content: [{ type: "input_text", text: "What changed?" }] },
                  {
                    type: "reasoning",
                    encrypted_content: "encrypted-state",
                    summary: [{ type: "summary_text", text: "Checked the previous diff." }],
                  },
                  { role: "assistant", content: [{ type: "output_text", text: "The parser changed." }] },
                  { role: "user", content: [{ type: "input_text", text: "Summarize it." }] },
                ],
              })
              expect(body.input[1]).not.toHaveProperty("id")
              return input.respond(
                sseEvents(
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "Parser now round-trips reasoning." },
                  { type: "response.completed", response: { id: "resp_1" } },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("Parser now round-trips reasoning.")
    }),
  )

  it.effect("preserves assistant content order around reasoning items", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_reasoning_order",
          model,
          messages: [
            Message.assistant([
              { type: "text", text: "Before." },
              {
                type: "reasoning",
                text: "Checked order.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: "encrypted-state",
                  },
                },
              },
              { type: "text", text: "After." },
            ]),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body.input).toEqual([
        { role: "assistant", content: [{ type: "output_text", text: "Before." }] },
        {
          type: "reasoning",
          encrypted_content: "encrypted-state",
          summary: [{ type: "summary_text", text: "Checked order." }],
        },
        { role: "assistant", content: [{ type: "output_text", text: "After." }] },
      ])
    }),
  )

  it.effect("references stored reasoning items by id", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: { openai: { itemId: "rs_1" } },
              },
            ]),
          ],
          providerOptions: { openai: { store: true } },
        }),
      )

      expect(prepared.body.input).toEqual([{ type: "item_reference", id: "rs_1" }])
    }),
  )

  it.effect("references stored provider-executed hosted tool results by id", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "ws_1",
                name: "web_search",
                input: { query: "effect 4" },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              }),
              {
                type: "tool-result",
                id: "ws_1",
                name: "web_search",
                result: { type: "json", value: { type: "web_search_call", id: "ws_1", status: "completed" } },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              },
            ]),
            Message.user("Continue."),
          ],
          providerOptions: { openai: { store: true } },
        }),
      )

      expect(prepared.body.input).toEqual([
        { type: "item_reference", id: "ws_1" },
        { role: "user", content: [{ type: "input_text", text: "Continue." }] },
      ])
    }),
  )

  it.effect("joins streamed summary blocks into one continuation reasoning item", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_multi_summary_continuation",
          model,
          messages: [
            Message.assistant([
              {
                type: "reasoning",
                text: "First",
                providerMetadata: { openai: { itemId: "rs_1" } },
              },
              {
                type: "reasoning",
                text: "Second",
                providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
              },
            ]),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          type: "reasoning",
          encrypted_content: "encrypted-state",
          summary: [
            { type: "summary_text", text: "First" },
            { type: "summary_text", text: "Second" },
          ],
        },
      ])
    }),
  )

  it.effect("skips non-persisted reasoning ids without encrypted state", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_reasoning_without_encrypted_state",
          model,
          messages: [
            Message.user("What changed?"),
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: null,
                  },
                },
              },
              { type: "text", text: "The parser changed." },
            ]),
            Message.user("Summarize it."),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body).toMatchObject({
        input: [
          { role: "user", content: [{ type: "input_text", text: "What changed?" }] },
          { role: "assistant", content: [{ type: "output_text", text: "The parser changed." }] },
          { role: "user", content: [{ type: "input_text", text: "Summarize it." }] },
        ],
        store: false,
      })
    }),
  )

  it.effect("sends the system prompt as a developer message for reasoning models", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_developer_role",
          model: responsesModel("gpt-5.5"),
          system: "You are concise.",
          prompt: "Say hello.",
        }),
      )

      expect(prepared.body.input[0]).toEqual({ role: "developer", content: "You are concise." })
    }),
  )

  it.effect("keeps the system role for non-reasoning ids on the same protocol", () =>
    Effect.gen(function* () {
      // gpt-5-chat is carved out of OpenAI's reasoning family, and xAI's own
      // Responses adapter has no developer-role rule at all — a grok id must
      // never trip the predicate.
      for (const id of ["gpt-4.1-mini", "gpt-5-chat-latest", "grok-4.3"]) {
        const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
          LLM.request({ id: `req_system_role_${id}`, model: responsesModel(id), system: "You are concise.", prompt: "Say hello." }),
        )

        expect(prepared.body.input[0]).toEqual({ role: "system", content: "You are concise." })
      }
    }),
  )

  it.effect("carries reasoning mode and context onto the wire like @ai-sdk/openai", () =>
    Effect.gen(function* () {
      // The engine emits reasoningMode for a config model variant whose body
      // carries reasoning.mode (provider.ts modeOptions); @ai-sdk/openai
      // lowers reasoningMode / reasoningContext into the reasoning block.
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_reasoning_mode",
          model: responsesModel("gpt-5.2"),
          prompt: "Say hello.",
          providerOptions: { openai: { reasoningEffort: "high", reasoningMode: "pro", reasoningContext: "all_turns" } },
        }),
      )
      // (the bare route has no facade defaults, so no summary here)
      expect(JSON.parse(JSON.stringify(prepared.body)).reasoning).toEqual({
        effort: "high",
        mode: "pro",
        context: "all_turns",
      })
    }),
  )

  it.effect("sends no reasoning block on a non-reasoning model, whatever the options say", () =>
    Effect.gen(function* () {
      // @ai-sdk/openai emits the block only for a reasoning model (a warning
      // otherwise); OpenAI rejects it on the others.
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_reasoning_non_reasoning_model",
          model: responsesModel("gpt-4.1-mini"),
          prompt: "Say hello.",
          providerOptions: { openai: { reasoningEffort: "high", reasoningMode: "pro" } },
        }),
      )
      expect(JSON.parse(JSON.stringify(prepared.body))).not.toHaveProperty("reasoning")
    }),
  )

  it.effect("drops temperature and top_p for reasoning models", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_reasoning_sampling",
          model: responsesModel("gpt-5.5"),
          prompt: "Say hello.",
          generation: { temperature: 0, topP: 0.9, maxTokens: 20 },
        }),
      )

      const wire: unknown = JSON.parse(JSON.stringify(prepared.body))
      expect(wire).not.toHaveProperty("temperature")
      expect(wire).not.toHaveProperty("top_p")
      expect(prepared.body.max_output_tokens).toBe(20)
    }),
  )

  it.effect("keeps the sampling knobs when reasoning is switched off on a model that allows it", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_reasoning_none_sampling",
          model: responsesModel("gpt-5.5"),
          prompt: "Say hello.",
          generation: { temperature: 0, topP: 0.9 },
          providerOptions: { openai: { reasoningEffort: "none" } },
        }),
      )

      expect(prepared.body.temperature).toBe(0)
      expect(prepared.body.top_p).toBe(0.9)
    }),
  )

  it.effect("still drops the sampling knobs on a reasoning model that has no non-reasoning mode", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_o3_reasoning_none_sampling",
          model: responsesModel("o3-mini"),
          prompt: "Say hello.",
          generation: { temperature: 0, topP: 0.9 },
          providerOptions: { openai: { reasoningEffort: "none" } },
        }),
      )

      const wire: unknown = JSON.parse(JSON.stringify(prepared.body))
      expect(wire).not.toHaveProperty("temperature")
      expect(wire).not.toHaveProperty("top_p")
    }),
  )

  it.effect("replays an encrypted reasoning item that lost its id", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_reasoning_without_id",
          model,
          messages: [
            Message.user("What changed?"),
            Message.assistant([
              {
                type: "reasoning",
                text: "",
                providerMetadata: { openai: { reasoningEncryptedContent: "encrypted-state" } },
              },
              { type: "text", text: "The parser changed." },
            ]),
            Message.user("Summarize it."),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "What changed?" }] },
        { type: "reasoning", encrypted_content: "encrypted-state", summary: [] },
        { role: "assistant", content: [{ type: "output_text", text: "The parser changed." }] },
        { role: "user", content: [{ type: "input_text", text: "Summarize it." }] },
      ])
      expect(JSON.parse(JSON.stringify(prepared.body)).input[1]).not.toHaveProperty("id")
    }),
  )

  it.effect("keeps two id-less reasoning items apart instead of merging them", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_two_reasoning_without_id",
          model,
          messages: [
            Message.assistant([
              {
                type: "reasoning",
                text: "First",
                providerMetadata: { openai: { reasoningEncryptedContent: "encrypted-one" } },
              },
              {
                type: "reasoning",
                text: "Second",
                providerMetadata: { openai: { reasoningEncryptedContent: "encrypted-two" } },
              },
            ]),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body.input).toEqual([
        { type: "reasoning", encrypted_content: "encrypted-one", summary: [{ type: "summary_text", text: "First" }] },
        { type: "reasoning", encrypted_content: "encrypted-two", summary: [{ type: "summary_text", text: "Second" }] },
      ])
    }),
  )

  it.effect("drops an id-less reasoning part with no encrypted state", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_reasoning_without_id_or_state",
          model,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "Checked it.", providerMetadata: { openai: { reasoningEncryptedContent: null } } },
              { type: "text", text: "The parser changed." },
            ]),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body.input).toEqual([
        { role: "assistant", content: [{ type: "output_text", text: "The parser changed." }] },
      ])
    }),
  )

  it.effect("assembles streamed function call input", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"query"' },
        { type: "response.function_call_arguments.delta", item_id: "item_1", delta: ':"weather"}' },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"query":"weather"}',
          },
        },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 1,
        nonCachedInputTokens: 5,
        cacheReadInputTokens: undefined,
        reasoningTokens: undefined,
        totalTokens: 6,
        providerMetadata: { openai: { input_tokens: 5, output_tokens: 1 } },
      })

      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        {
          type: "tool-input-start",
          id: "call_1",
          name: "lookup",
          providerMetadata: { openai: { itemId: "item_1" } },
        },
        {
          type: "tool-input-delta",
          id: "call_1",
          name: "lookup",
          text: '{"query"',
        },
        {
          type: "tool-input-delta",
          id: "call_1",
          name: "lookup",
          text: ':"weather"}',
        },
        {
          type: "tool-input-end",
          id: "call_1",
          name: "lookup",
          providerMetadata: { openai: { itemId: "item_1" } },
        },
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: { openai: { itemId: "item_1" } },
        },
        { type: "step-finish", index: 0, reason: "tool-calls", usage, providerMetadata: undefined },
        {
          type: "finish",
          reason: "tool-calls",
          providerMetadata: undefined,
          usage,
        },
      ])
    }),
  )

  it.effect("degrades a function call whose authoritative arguments do not parse", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"query"' },
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: '{"query"' },
        },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )

      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      expect(response.toolCalls).toMatchObject([
        {
          id: "call_1",
          name: "lookup",
          input: '{"query"',
          invalid: true,
          error: "Invalid JSON input for openai-responses tool call lookup",
        },
      ])
      expect(response.events.at(-1)).toMatchObject({ type: "finish" })
    }),
  )

  it.effect("decodes web_search_call as provider-executed tool-call + tool-result", () =>
    Effect.gen(function* () {
      const item = {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "effect 4" },
      }
      const body = sseEvents(
        { type: "response.output_item.added", item },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      const callsAndResults = response.events.filter(
        (event) => event.type === "tool-call" || event.type === "tool-result",
      )
      expect(callsAndResults).toEqual([
        {
          type: "tool-call",
          id: "ws_1",
          name: "web_search",
          input: { type: "search", query: "effect 4" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "ws_1" } },
        },
        {
          type: "tool-result",
          id: "ws_1",
          name: "web_search",
          result: { type: "json", value: item },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "ws_1" } },
        },
      ])
    }),
  )

  it.effect("decodes code_interpreter_call as provider-executed events with code input", () =>
    Effect.gen(function* () {
      const item = {
        type: "code_interpreter_call",
        id: "ci_1",
        status: "completed",
        code: "print(1+1)",
        container_id: "cnt_xyz",
        outputs: [{ type: "logs", logs: "2\n" }],
      }
      const body = sseEvents(
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      const toolCall = response.events.find((event) => event.type === "tool-call")
      expect(toolCall).toEqual({
        type: "tool-call",
        id: "ci_1",
        name: "code_interpreter",
        input: { code: "print(1+1)", container_id: "cnt_xyz" },
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "ci_1" } },
      })
      const toolResult = response.events.find((event) => event.type === "tool-result")
      expect(toolResult).toEqual({
        type: "tool-result",
        id: "ci_1",
        name: "code_interpreter",
        result: { type: "json", value: item },
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "ci_1" } },
      })
    }),
  )

  it.effect("lowers user image content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_media",
          model,
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AAECAw==" }],
        },
      ])
    }),
  )

  it.effect("rejects unsupported user media content", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          id: "req_media",
          model,
          messages: [Message.user({ type: "media", mediaType: "application/pdf", data: "AAECAw==" })],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("OpenAI Responses does not support media type application/pdf")
    }),
  )

  it.effect("emits provider-error events for mid-stream provider errors", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "rate_limit_exceeded", message: "Slow down" }))),
      )

      // Prefix the code so consumers see the failure mode, not just the
      // sometimes-generic provider message. The bare message alone meant
      // production errors like rate limits were indistinguishable from
      // unrelated stream failures.
      expect(response.events).toEqual([{ type: "provider-error", message: "rate_limit_exceeded: Slow down" }])
    }),
  )

  it.effect("falls back to error code when no message is present", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "internal_error" }))),
      )

      expect(response.events).toEqual([{ type: "provider-error", message: "internal_error" }])
    }),
  )

  it.effect("falls back to error code when message is empty", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "internal_error", message: "" }))),
      )

      expect(response.events).toEqual([{ type: "provider-error", message: "internal_error" }])
    }),
  )

  // Regression: `response.failed` carries the failure details under
  // `response.error`, not at the top level. The previous handler only
  // checked top-level `message`/`code` and so always emitted the bare
  // "OpenAI Responses response failed" string, hiding the real cause.
  it.effect("surfaces response.failed details from response.error", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "response.failed",
              response: {
                id: "resp_failed_1",
                error: { code: "server_error", message: "Upstream model unavailable" },
              },
            }),
          ),
        ),
      )

      expect(response.events).toEqual([{ type: "provider-error", message: "server_error: Upstream model unavailable" }])
    }),
  )

  it.effect("surfaces response.failed code when no nested message is present", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "response.failed",
              response: { id: "resp_failed_2", error: { code: "invalid_prompt" } },
            }),
          ),
        ),
      )

      expect(response.events).toEqual([{ type: "provider-error", message: "invalid_prompt" }])
    }),
  )

  it.effect("surfaces error event details even when they arrive nested under response.error", () =>
    Effect.gen(function* () {
      // Some OpenAI-compatible proxies and older SDK versions wrap the
      // top-level error fields into a nested `response.error` payload
      // when they bubble up an HTTP error as an SSE `error` event. Honour
      // both shapes so the user still sees the underlying cause instead
      // of the catch-all string.
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "error",
              response: { error: { code: "context_length_exceeded", message: "prompt too long" } },
            }),
          ),
        ),
      )

      expect(response.events).toEqual([
        {
          type: "provider-error",
          message: "context_length_exceeded: prompt too long",
          classification: "context-overflow",
        },
      ])
    }),
  )

  // t-4aqhjb. The ChatGPT (codex) backend nests the reason under a bare
  // `error` envelope, not at the top level and not under `response`. Reading
  // only the two documented places produced the fallback sentence and threw
  // the reason away.
  it.effect("surfaces an error event nested under a bare error envelope", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({ type: "error", error: { code: "usage_limit_reached", message: "weekly limit reached" } }),
          ),
        ),
      )

      expect(response.events).toEqual([
        { type: "provider-error", message: "usage_limit_reached: weekly limit reached" },
      ])
    }),
  )

  // t-4aqhjb: the burst this exists for. Nine turns died on an error event
  // carrying neither message nor code, and the engine reported the fallback
  // sentence alone — no status, no body, nothing the owner could act on. The
  // whole frame now travels with the error, undeclared keys included.
  it.effect("carries the raw event when the backend names neither message nor code", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", sequence_number: 7, detail: "stream closed" }))),
      )

      const [event] = response.events
      expect(event).toMatchObject({ type: "provider-error" })
      const message = (event as { message: string }).message
      expect(message).toStartWith("OpenAI Responses stream error: ")
      // An undeclared key is the whole point: a plain struct would have
      // dropped `detail` and printed `{"type":"error"}`.
      expect(message).toContain(`"detail":"stream closed"`)
      expect(message).toContain(`"sequence_number":7`)
    }),
  )

  it.effect("carries the raw event when response.failed has no error payload", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "response.failed", response: { id: "resp_failed_3" } }))),
      )

      expect(response.events).toEqual([
        {
          type: "provider-error",
          message: `OpenAI Responses response failed: {"type":"response.failed","response":{"id":"resp_failed_3"}}`,
        },
      ])
    }),
  )

  // The raw dump reaches transcripts, stored messages and origami.log, so a
  // frame that echoes a credential back must not carry it there.
  it.effect("redacts credential-shaped fields out of the raw event", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(sseEvents({ type: "error", request: { authorization: "Bearer sk-live-123", api_key: "abc" } })),
        ),
      )

      const message = (response.events[0] as { message: string }).message
      expect(message).not.toContain("sk-live-123")
      expect(message).not.toContain("abc")
      expect(message).toContain(`"authorization":"<redacted>"`)
      expect(message).toContain(`"api_key":"<redacted>"`)
    }),
  )

  it.effect("caps the raw event so one frame cannot flood the transcript", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", detail: "x".repeat(5_000) }))),
      )

      const message = (response.events[0] as { message: string }).message
      const raw = message.slice("OpenAI Responses stream error: ".length)
      expect(raw).toHaveLength(301)
      expect(raw).toEndWith("…")
    }),
  )

  it.effect("fails HTTP provider errors before stream parsing", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse('{"error":{"type":"invalid_request_error","message":"Bad request"}}', {
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
  it.effect("a body that ends before `response.completed` still ends the turn", () =>
    Effect.gen(function* () {
      // The finish is emitted from `response.completed` / `response.failed`. A
      // body that stops before one - a gateway cutting at the response
      // boundary, a proxy dropping the tail - used to leave the stream with no
      // `finish` AND no `text-end`, so the consumer's block never closed and
      // the assistant message never completed. `@ai-sdk/openai` finishes every
      // flush with "unknown", and `session/processor.ts` has a documented
      // recovery for that value.
      const body = `event: response.output_text.delta
data: ${JSON.stringify({
        type: "response.output_text.delta",
        item_id: "msg_1",
        delta: "half an ans",
      })}

`

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

  it.effect("a body that produced NOTHING gets no invented finish", () =>
    Effect.gen(function* () {
      // The boundary of the tolerance above. An empty response is not a turn
      // that ended early, it is a response that never began, and
      // `LLMClient.generate`'s "ended without a terminal finish event" is the
      // honest answer for it.
      const events = Array.from(
        yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(fixedResponse(""))),
      )

      expect(events).toEqual([])
    }),
  )
})
