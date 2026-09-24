import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, mergeProviderOptions } from "../src"
import { AnthropicMessages, Gemini, OpenAIChat, OpenAICompatibleChat } from "../src/protocols"
import { Auth, LLMClient } from "../src/route"
import { it } from "./lib/effect"
import { dynamicResponse } from "./lib/http"
import { deltaChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const TargetJson = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownSync(TargetJson)

// The overlay is applied by the TRANSPORT, so the only place the merged body is
// observable is the prepared HTTP request. Read it back off the wire.
const wireBody = (request: Parameters<typeof LLMClient.prepare>[0]) =>
  Effect.gen(function* () {
    const prepared = yield* LLMClient.prepare(request)
    const transport = yield* request.model.route.prepareTransport(prepared.body, request)
    const web = yield* HttpClientRequest.toWeb(
      (transport as { request: HttpClientRequest.HttpClientRequest }).request,
    ).pipe(Effect.orDie)
    return decodeJson(yield* Effect.promise(() => web.text()))
  })

describe("request option precedence", () => {
  test("deep-merges provider option records and replaces arrays, primitives, and null", () => {
    const merged = mergeProviderOptions(
      {
        openai: {
          include: ["route"],
          metadata: { route: true, shared: "route" },
          nullable: "route",
          primitive: "route",
        },
      },
      {
        openai: {
          include: ["model"],
          metadata: { model: true, shared: "model" },
          nullable: null,
          primitive: "model",
        },
      },
      { openai: { metadata: { request: true }, primitive: false } },
    )

    expect(merged).toEqual({
      openai: {
        include: ["model"],
        metadata: { route: true, model: true, request: true, shared: "model" },
        nullable: null,
        primitive: false,
      },
    })
  })

  it.effect("prepares bodies with route defaults, model defaults, and call options in order", () =>
    Effect.gen(function* () {
      const route = OpenAIChat.route.with({
        endpoint: { baseURL: "https://api.openai.test/v1/" },
        auth: Auth.bearer("test"),
        generation: { maxTokens: 10, temperature: 1, stop: ["route"] },
        providerOptions: { openai: { store: false, reasoningEffort: "low" } },
      })
      const model = route.model({
        id: "gpt-4o-mini",
        defaults: {
          generation: { maxTokens: 20, temperature: 0.5, frequencyPenalty: 0.25, stop: ["model"] },
          providerOptions: { openai: { reasoningEffort: "medium" } },
        },
      })
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          prompt: "Say hello.",
          generation: { maxTokens: 30, topP: 0.9, stop: ["request"] },
          providerOptions: { openai: { store: true } },
        }),
      )

      expect(prepared.body).toMatchObject({
        model: "gpt-4o-mini",
        stream: true,
        max_tokens: 30,
        temperature: 0.5,
        top_p: 0.9,
        frequency_penalty: 0.25,
        store: true,
        reasoning_effort: "medium",
      })
      expect(prepared.body.stop).toEqual(["request"])
    }),
  )

  it.effect("applies model HTTP defaults before request HTTP overlays", () =>
    LLMClient.generate(
      LLM.request({
        model: OpenAIChat.route
          .with({
            endpoint: { baseURL: "https://api.openai.test/v1/" },
            auth: Auth.bearer("fresh-key"),
            http: {
              body: { metadata: { route: true, shared: "route" }, value: "route" },
              headers: { "x-route": "route", "x-shared": "route" },
              query: { route: "1", shared: "route" },
            },
          })
          .model({
            id: "gpt-4o-mini",
            defaults: {
              http: {
                body: { metadata: { model: true, shared: "model" }, value: "model" },
                headers: { "x-model": "model", "x-shared": "model" },
                query: { model: "1", shared: "model" },
              },
            },
          }),
        prompt: "Say hello.",
        http: {
          body: { metadata: { request: true }, value: null },
          headers: { "x-request": "request" },
          query: { request: "1" },
        },
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://api.openai.test/v1/chat/completions?route=1&shared=model&model=1&request=1")
            expect(web.headers.get("authorization")).toBe("Bearer fresh-key")
            expect(web.headers.get("x-route")).toBe("route")
            expect(web.headers.get("x-model")).toBe("model")
            expect(web.headers.get("x-request")).toBe("request")
            expect(web.headers.get("x-shared")).toBe("model")
            expect(decodeJson(input.text)).toMatchObject({
              metadata: { route: true, model: true, request: true, shared: "model" },
              value: null,
            })
            return input.respond(sseEvents(deltaChunk({}, "stop")), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("rejects raw body overlays for protocol-owned roots", () =>
    Effect.gen(function* () {
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "gpt-4o-mini" })
      const error = yield* LLMClient.prepare(
        LLM.request({
          model,
          prompt: "Say hello.",
          tools: [{ name: "t1", description: "t1", inputSchema: { type: "object", properties: {} } }],
          http: { body: { model: "gpt-5", messages: [], tools: [] } },
        }),
      ).pipe(Effect.flip)

      expect(error.reason).toMatchObject({
        _tag: "InvalidRequest",
        message: "http.body cannot overlay protocol-owned field(s): model, messages, tools",
      })
    }),
  )

  it.effect("owns a structural key only on the request the protocol actually wrote it into", () =>
    Effect.gen(function* () {
      // Same key, same protocol, two requests: `tools` is refused above because
      // that request declared tools, and passes here because this one did not.
      // Ownership is per request, not per vocabulary.
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "gpt-4o-mini" })
      const overlaidTools = [{ type: "function", function: { name: "raw", parameters: {} } }]
      const wire = yield* wireBody(
        LLM.request({ model, prompt: "Say hello.", http: { body: { tools: overlaidTools } } }),
      )

      expect(wire).toMatchObject({ tools: overlaidTools })
    }),
  )

  it.effect("passes another protocol's structure key through as a plain extra", () =>
    Effect.gen(function* () {
      // `thinking` is Anthropic/Gemini structure. A GLM or zai block on an
      // OpenAI-compatible server legitimately puts it in its extra body, and a
      // single global denylist refused it there on every prompt.
      const model = OpenAICompatibleChat.route
        .with({ endpoint: { baseURL: "https://vllm.test/v1/" }, auth: Auth.none })
        .model({ id: "glm-5.3", provider: "vllm" })
      const wire = yield* wireBody(
        LLM.request({
          model,
          system: "You are concise.",
          prompt: "Say hello.",
          http: { body: { thinking: { type: "enabled" }, system: "raw system" } },
        }),
      )

      expect(wire).toMatchObject({ thinking: { type: "enabled" }, system: "raw system" })
    }),
  )

  it.effect("owns `thinking` on Anthropic Messages only when reasoning built the block", () =>
    Effect.gen(function* () {
      const model = AnthropicMessages.route
        .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
        .model({ id: "claude-sonnet-4-5" })
      const overlay = { thinking: { type: "enabled", budget_tokens: 99 } }
      const reasoningOn = LLM.request({
        model,
        prompt: "Say hello.",
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } },
        http: { body: overlay },
      })
      const reasoningOff = LLM.request({ model, prompt: "Say hello.", http: { body: overlay } })

      const error = yield* LLMClient.prepare(reasoningOn).pipe(Effect.flip)
      expect(error.reason).toMatchObject({
        _tag: "InvalidRequest",
        message: "http.body cannot overlay protocol-owned field(s): thinking",
      })

      // Reasoning off: the protocol wrote no `thinking`, so the configured one
      // rides through untouched.
      expect(yield* wireBody(reasoningOff)).toMatchObject(overlay)
    }),
  )

  it.effect("Anthropic Messages with thinking on drops the samplers and adds the budget to max_tokens", () =>
    Effect.gen(function* () {
      const model = AnthropicMessages.route
        .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
        .model({ id: "claude-haiku-4-5" })
      const generation = { temperature: 0.2, topP: 0.9, topK: 40, maxTokens: 4000 }

      const on = yield* wireBody(
        LLM.request({
          model,
          prompt: "Think first.",
          generation,
          providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } },
        }),
      )
      // The API refuses temperature/top_p/top_k with thinking (400), and the
      // budget must fit inside max_tokens — the AI SDK path does exactly this.
      expect(on).toMatchObject({ thinking: { type: "enabled", budget_tokens: 1024 }, max_tokens: 5024 })
      expect(on).not.toHaveProperty("temperature")
      expect(on).not.toHaveProperty("top_p")
      expect(on).not.toHaveProperty("top_k")

      const off = yield* wireBody(LLM.request({ model, prompt: "Just answer.", generation }))
      expect(off).toMatchObject({ temperature: 0.2, top_p: 0.9, top_k: 40, max_tokens: 4000 })
      expect(off).not.toHaveProperty("thinking")
    }),
  )

  it.effect("owns `system` on Anthropic Messages and never on OpenAI Chat", () =>
    Effect.gen(function* () {
      const anthropic = AnthropicMessages.route
        .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
        .model({ id: "claude-sonnet-4-5" })
      const openai = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "gpt-4o-mini" })

      const error = yield* LLMClient.prepare(
        LLM.request({ model: anthropic, system: "You are concise.", prompt: "hi", http: { body: { system: "raw" } } }),
      ).pipe(Effect.flip)
      expect(error.reason).toMatchObject({
        _tag: "InvalidRequest",
        message: "http.body cannot overlay protocol-owned field(s): system",
      })

      // OpenAI Chat has no top-level `system` at all - it lowers the system
      // prompt into `messages` - so the key is never owned there.
      const wire = yield* wireBody(
        LLM.request({ model: openai, system: "You are concise.", prompt: "hi", http: { body: { system: "raw" } } }),
      )
      expect(wire).toMatchObject({ system: "raw" })
    }),
  )

  it.effect("treats Anthropic `max_tokens` as a knob the overlay wins", () =>
    Effect.gen(function* () {
      // The Messages API requires `max_tokens`, so the protocol always writes
      // one - but it is a sampling knob, not structure. A provider block that
      // sets it in its extra body must keep winning, as it did on the AI SDK
      // path; owning it would be the `frequency_penalty` outage again.
      const model = AnthropicMessages.route
        .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
        .model({ id: "claude-sonnet-4-5", defaults: { limits: { output: 64 } } })
      const wire = yield* wireBody(
        LLM.request({ model, prompt: "hi", generation: { maxTokens: 32 }, http: { body: { max_tokens: 7 } } }),
      )

      expect(wire).toMatchObject({ max_tokens: 7 })
    }),
  )

  it.effect("owns `contents` on Gemini", () =>
    Effect.gen(function* () {
      const model = Gemini.route
        .with({ endpoint: { baseURL: "https://generativelanguage.test/v1beta/" }, auth: Auth.none })
        .model({ id: "gemini-2.5-flash" })
      const error = yield* LLMClient.prepare(
        LLM.request({ model, prompt: "hi", http: { body: { contents: [], thinking: true } } }),
      ).pipe(Effect.flip)

      expect(error.reason).toMatchObject({
        _tag: "InvalidRequest",
        message: "http.body cannot overlay protocol-owned field(s): contents",
      })
    }),
  )

  it.effect("passes sampling knobs and server extras through the overlay, the configured value winning", () =>
    Effect.gen(function* () {
      // A provider block on the owner's box sets `frequency_penalty: 0` on its
      // vLLM models; the AI SDK path spread such keys verbatim and the first
      // native cutover refused them as protocol-owned, which took the whole
      // OpenAI-compatible family down. Only the request's STRUCTURE is owned.
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "gpt-4o-mini" })
      const request = LLM.request({
        model,
        prompt: "Say hello.",
        generation: { topP: 0.5 },
        http: { body: { frequency_penalty: 0, top_p: 0.9, chat_template_kwargs: { thinking: true } } },
      })
      const wire = yield* wireBody(request)
      expect(wire).toMatchObject({ frequency_penalty: 0, top_p: 0.9, chat_template_kwargs: { thinking: true } })
    }),
  )

  it.effect("uses model output limits after route limits and before call maxTokens", () =>
    Effect.gen(function* () {
      const route = AnthropicMessages.route.with({
        endpoint: { baseURL: "https://api.anthropic.test/v1/" },
        auth: Auth.header("x-api-key", "test"),
        limits: { output: 128 },
      })
      const model = route.model({ id: "claude-sonnet-4-5", defaults: { limits: { output: 64 } } })
      const withoutMaxTokens = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({ model, prompt: "Say hello.", cache: "none" }),
      )
      const withMaxTokens = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({ model, prompt: "Say hello.", cache: "none", generation: { maxTokens: 32 } }),
      )

      expect(withoutMaxTokens.body.max_tokens).toBe(64)
      expect(withMaxTokens.body.max_tokens).toBe(32)
    }),
  )
})
