import { describe, expect, test } from "bun:test"
import { LLMEvent, ToolFailure, type LLMRequest } from "@origami/llm"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor, type LLMClientShape } from "@origami/llm/route"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { Effect, Fiber, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LLMNative } from "@/session/llm/native-request"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import type { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"

import { OAUTH_DUMMY_KEY } from "@/auth"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

const baseModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "gpt-5-mini",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 128_000,
    input: 128_000,
    output: 32_000,
  },
  status: "active",
  options: {},
  headers: {
    "x-model": "model-header",
  },
  release_date: "2026-01-01",
}

const providerInfo: Provider.Info = {
  id: ProviderV2.ID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: ["OPENAI_API_KEY"],
  options: { apiKey: "test-openai-key" },
  models: {},
}

const it = testEffect(
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)), WebSocketExecutor.layer),
    ),
  ),
)

function responsesStream(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

type NativeRequestInput = Parameters<typeof LLMNative.request>[0]

const sessionText = (text: string) => ({ type: "text" as const, text })

const sessionOpenAIReasoning = (
  text: string,
  options: {
    readonly storedAs: "providerMetadata" | "providerOptions"
    readonly itemId: string
    readonly encryptedContent: string | null
  },
) => {
  const metadata = {
    openai: { itemId: options.itemId, reasoningEncryptedContent: options.encryptedContent },
  }
  if (options.storedAs === "providerMetadata")
    return Object.assign({ type: "reasoning" as const, text }, { providerMetadata: metadata })
  return Object.assign({ type: "reasoning" as const, text }, { providerOptions: metadata })
}

type SessionAssistantPart = ReturnType<typeof sessionText> | ReturnType<typeof sessionOpenAIReasoning>

const storedSession = {
  user: (content: string): ModelMessage => ({ role: "user", content }),
  assistant: (content: SessionAssistantPart[]): ModelMessage => ({ role: "assistant", content }),
  text: sessionText,
  openaiReasoning: sessionOpenAIReasoning,
}

const openAIResponses = {
  user: (text: string) => ({ role: "user", content: [{ type: "input_text", text }] }),
  assistant: (text: string) => ({ role: "assistant", content: [{ type: "output_text", text }] }),
  openaiReasoning: (text: string, encryptedContent: string) => ({
    type: "reasoning",
    encrypted_content: encryptedContent,
    summary: [{ type: "summary_text", text }],
  }),
}

const prepareNativeRequest = (input: NativeRequestInput) => LLMClient.prepare(LLMNative.request(input))

const expectOpenAIResponsesRequest = (input: {
  readonly history: NativeRequestInput["messages"]
  readonly providerOptions?: NativeRequestInput["providerOptions"]
  readonly maxOutputTokens?: NativeRequestInput["maxOutputTokens"]
  readonly headers?: NativeRequestInput["headers"]
  readonly expectedBody: unknown
}) =>
  Effect.gen(function* () {
    expect(
      yield* prepareNativeRequest({
        model: baseModel,
        apiKey: "test-openai-key",
        messages: input.history,
        providerOptions: input.providerOptions,
        maxOutputTokens: input.maxOutputTokens,
        headers: input.headers,
      }),
    ).toMatchObject({
      route: "openai-responses",
      protocol: "openai-responses",
      body: input.expectedBody,
    })
  })

describe("session.llm-native.request", () => {
  test("maps normalized stream inputs to a native LLM request", () => {
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: "system from messages",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerOptions: { openai: { cacheControl: { type: "ephemeral" } } } },
          { type: "file", mediaType: "image/png", filename: "img.png", data: "data:image/png;base64,Zm9v" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: { openai: { encryptedContent: "secret" } } },
          { type: "text", text: "I'll run it" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "ls" },
            providerOptions: { openai: { itemId: "item-1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
            providerOptions: { openai: { outputId: "output-1" } },
          },
        ],
      },
    ]

    const request = LLMNative.request({
      model: baseModel,
      system: ["agent system"],
      messages,
      tools: {
        bash: tool({
          description: "Run a shell command",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
          }),
        }),
      },
      toolChoice: "required",
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 1024,
      providerOptions: { openai: { store: false } },
      headers: { "x-request": "request-header" },
    })

    expect(request.model).toMatchObject({
      id: "gpt-5-mini",
      provider: "openai",
      route: { id: "openai-responses" },
    })
    expect(request.model.route.endpoint.baseURL).toBe("https://api.openai.com/v1")
    expect(request.model.route.defaults.headers).toEqual({
      "x-model": "model-header",
      "x-request": "request-header",
    })
    expect(request.model.route.defaults.limits).toMatchObject({
      context: 128_000,
      output: 32_000,
    })
    expect(request.system).toEqual([
      { type: "text", text: "agent system" },
      { type: "text", text: "system from messages" },
    ])
    expect(request.generation).toMatchObject({
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxTokens: 1024,
    })
    expect(request.providerOptions).toEqual({ openai: { store: false } })
    expect(request.toolChoice).toMatchObject({ type: "required" })
    expect(request.tools).toMatchObject([
      {
        name: "bash",
        description: "Run a shell command",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
      },
    ])
    expect(request.messages).toMatchObject([
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerMetadata: { openai: { cacheControl: { type: "ephemeral" } } } },
          { type: "media", mediaType: "image/png", filename: "img.png", data: "data:image/png;base64,Zm9v" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerMetadata: { openai: { encryptedContent: "secret" } } },
          { type: "text", text: "I'll run it" },
          {
            type: "tool-call",
            id: "call-1",
            name: "bash",
            input: { command: "ls" },
            providerMetadata: { openai: { itemId: "item-1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call-1",
            name: "bash",
            result: { type: "text", value: "ok" },
            providerMetadata: { openai: { outputId: "output-1" } },
          },
        ],
      },
    ])
  })

  test("maps stored provider metadata to native content metadata", () => {
    const reasoning = Object.assign(
      { type: "reasoning" as const, text: "thinking" },
      {
        providerMetadata: {
          openai: {
            itemId: "rs_1",
            reasoningEncryptedContent: "encrypted-state",
          },
        },
      },
    )
    const request = LLMNative.request({
      model: baseModel,
      messages: [
        {
          role: "assistant",
          content: [reasoning],
        },
      ],
    })

    expect(request.messages).toMatchObject([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
          },
        ],
      },
    ])
  })

  test("selects native request routes for provider packages", () => {
    const openai = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/openai" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(openai.route.id).toBe("openai-responses")
    expect(openai.route.endpoint.baseURL).toBe("https://api.openai.com/v1")

    const anthropic = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/anthropic" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(anthropic.route.id).toBe("anthropic-messages")
    expect(anthropic.route.endpoint.baseURL).toBe("https://api.anthropic.com/v1")

    const google = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/google" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(google.route.id).toBe("gemini")
    expect(google.route.endpoint.baseURL).toBe("https://generativelanguage.googleapis.com/v1beta")

    const compatible = LLMNative.model({
      model: {
        ...baseModel,
        providerID: ProviderV2.ID.opencode,
        api: { ...baseModel.api, url: "https://ai.example.test/v1", npm: "@ai-sdk/openai-compatible" },
      },
      apiKey: "test-key",
      messages: [],
    })
    expect(compatible.route.id).toBe("openai-compatible-chat")
    expect(compatible.route.endpoint.baseURL).toBe("https://ai.example.test/v1")

    const openrouter = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@openrouter/ai-sdk-provider" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(openrouter.route.id).toBe("openrouter")
    expect(openrouter.route.endpoint.baseURL).toBe("https://openrouter.ai/api/v1")

    // xAI rides the OpenAI Responses protocol (the AI SDK path calls
    // `sdk.responses(id)` for it), on its OWN provider id and default endpoint.
    const xai = LLMNative.model({
      model: { ...baseModel, providerID: ProviderV2.ID.make("xai"), api: { id: "grok-4", url: "", npm: "@ai-sdk/xai" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(xai.route.id).toBe("openai-responses")
    expect(String(xai.route.provider)).toBe("xai")
    expect(xai.route.endpoint.baseURL).toBe("https://api.x.ai/v1")

    // A configured gateway wins over the default endpoint.
    const xaiGateway = LLMNative.model({
      model: {
        ...baseModel,
        providerID: ProviderV2.ID.make("xai"),
        api: { id: "grok-4", url: "", npm: "@ai-sdk/xai" },
      },
      apiKey: "test-key",
      baseURL: "https://gateway.example.test/v1",
      messages: [],
    })
    expect(xaiGateway.route.endpoint.baseURL).toBe("https://gateway.example.test/v1")
  })

  test("fails fast for unsupported provider packages", () => {
    expect(() =>
      LLMNative.request({
        model: { ...baseModel, api: { ...baseModel.api, npm: "unknown-provider" } },
        messages: [],
      }),
    ).toThrow("Native LLM request adapter does not support provider package unknown-provider")
  })

  test("routes native by provider family, never by provider id", () => {
    // Same package as the OpenAI model above, an unrelated provider id: the
    // family is what decides, so the runtime accepts it (whether it RUNS is the
    // route table's call, see llm-native-route.test.ts).
    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, providerID: ProviderV2.ID.make("myproxy") },
        provider: { ...providerInfo, id: ProviderV2.ID.make("myproxy") },
        auth: undefined,
      }),
    ).toMatchObject({ type: "supported", apiKey: "test-openai-key" })
    // A keyless OpenAI-compatible endpoint (vLLM, LM Studio) is supported with
    // no key at all; the same absence on the OpenAI family stays unsupported.
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("vllm"),
          api: { id: "deepseek", url: "http://127.0.0.1:8000/v1", npm: "@ai-sdk/openai-compatible" },
        },
        provider: { ...providerInfo, id: ProviderV2.ID.make("vllm"), options: { baseURL: "http://127.0.0.1:8000/v1" } },
        auth: undefined,
      }),
    ).toEqual({ type: "supported", apiKey: undefined, baseURL: "http://127.0.0.1:8000/v1" })
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("vllm"),
          api: { id: "deepseek", url: "http://127.0.0.1:8000/v1", npm: "@ai-sdk/openai-compatible" },
        },
        provider: { ...providerInfo, id: ProviderV2.ID.make("vllm"), options: { apiKey: "" } },
        auth: undefined,
      }),
    ).toMatchObject({ type: "supported", apiKey: undefined })
  })

  test("only enables native runtime for supported OpenAI API-key models", () => {
    expect(LLMNativeRuntime.status({ model: baseModel, provider: providerInfo, auth: undefined })).toMatchObject({
      type: "supported",
      apiKey: "test-openai-key",
    })
    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, providerID: ProviderV2.ID.opencode },
        provider: { ...providerInfo, id: ProviderV2.ID.opencode },
        auth: undefined,
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "test-openai-key",
    })
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.opencode,
          api: { ...baseModel.api, npm: "@ai-sdk/openai-compatible" },
        },
        provider: { ...providerInfo, id: ProviderV2.ID.opencode },
        auth: undefined,
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "test-openai-key",
    })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: providerInfo,
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      }),
    ).toEqual({ type: "unsupported", reason: "OAuth auth requires a provider fetch override" })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: { apiKey: OAUTH_DUMMY_KEY, fetch: async () => new Response() } },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      }),
    ).toMatchObject({ type: "supported", apiKey: OAUTH_DUMMY_KEY })

    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, api: { ...baseModel.api, npm: "@ai-sdk/google" } },
        provider: providerInfo,
        auth: undefined,
      }),
    ).toEqual({
      type: "unsupported",
      reason: "provider package has no native route: @ai-sdk/google",
    })

    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: {} },
        auth: undefined,
      }),
    ).toEqual({ type: "unsupported", reason: "API key is not configured" })
  })

  test("enables native runtime for Anthropic API-key models", () => {
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("anthropic"),
          api: { ...baseModel.api, npm: "@ai-sdk/anthropic", url: "https://api.anthropic.com/v1" },
        },
        provider: {
          ...providerInfo,
          id: ProviderV2.ID.make("anthropic"),
          name: "Anthropic",
          env: ["ANTHROPIC_API_KEY"],
          options: { apiKey: "test-anthropic-key" },
        },
        auth: undefined,
      }),
    ).toMatchObject({ type: "supported", apiKey: "test-anthropic-key" })
  })

  // Gate B admits the OpenRouter package by name, not by provider id: the same
  // endpoint reached through @ai-sdk/openai-compatible is a different family
  // and a different lowering (native-request.ts routes it to OpenRouter.configure).
  test("enables native runtime for OpenRouter API-key models", () => {
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("openrouter"),
          api: { ...baseModel.api, npm: "@openrouter/ai-sdk-provider", url: "https://openrouter.ai/api/v1" },
        },
        provider: {
          ...providerInfo,
          id: ProviderV2.ID.make("openrouter"),
          name: "OpenRouter",
          env: ["OPENROUTER_API_KEY"],
          options: { apiKey: "test-openrouter-key" },
        },
        auth: undefined,
      }),
    ).toMatchObject({ type: "supported", apiKey: "test-openrouter-key" })
  })

  test("prefers console provider api key over stored origami auth", () => {
    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, providerID: ProviderV2.ID.opencode },
        provider: {
          ...providerInfo,
          id: ProviderV2.ID.opencode,
          options: { apiKey: "console-token" },
          key: "zen-token",
        },
        auth: { type: "api", key: "zen-token" },
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "console-token",
    })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: {}, key: "provider-key" },
        auth: undefined,
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "provider-key",
    })
  })

  it.effect("native tool wrapper converts thrown errors into typed ToolFailure", () =>
    Effect.gen(function* () {
      const wrapped = LLMNativeRuntime.nativeTools(
        {
          explode: {
            description: "always throws",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => {
              throw new Error("boom")
            },
          } satisfies Tool,
        },
        { messages: [] as ModelMessage[], abort: new AbortController().signal },
      )

      const failure = yield* Effect.flip(wrapped.explode.execute({}, { id: "call-1", name: "explode" }))
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toBe("boom")
    }),
  )

  it.effect("native tool wrapper raises ToolFailure when the source tool has no execute handler", () =>
    Effect.gen(function* () {
      // The AI SDK Tool shape allows execute to be omitted (e.g., client-side / MCP tools).
      // The native runtime owns execution, so encountering such a tool here means upstream
      // wiring is wrong; we want a typed failure, not a silent skip or unhandled exception.
      const wrapped = LLMNativeRuntime.nativeTools(
        { incomplete: { description: "no execute", inputSchema: jsonSchema({ type: "object" }) } satisfies Tool },
        { messages: [] as ModelMessage[], abort: new AbortController().signal },
      )

      const failure = yield* Effect.flip(wrapped.incomplete.execute({}, { id: "call-1", name: "incomplete" }))
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toContain("incomplete")
    }),
  )

  it.effect("emits native tool calls before overlapping local settlements complete", () =>
    Effect.gen(function* () {
      const observed: string[] = []
      const started: string[] = []
      let release: (() => void) | undefined
      let notifyStarted: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const bothStarted = new Promise<void>((resolve) => {
        notifyStarted = resolve
      })
      const lookup = {
        description: "Lookup data",
        inputSchema: jsonSchema({ type: "object" }),
        execute: async (_args: unknown, options: { toolCallId: string }) => {
          started.push(options.toolCallId)
          if (started.length === 2) notifyStarted?.()
          await gate
          return { output: options.toolCallId }
        },
      } satisfies Tool
      const llmClient = {
        prepare: () => Effect.die("unused"),
        stream: () =>
          Stream.fromIterable([
            LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {} }),
            LLMEvent.toolCall({ id: "call-2", name: "lookup", input: {} }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ]),
        generate: () => Effect.die("unused"),
      } as LLMClientShape
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [],
        tools: { lookup },
        headers: {},
        abort: new AbortController().signal,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)

      const fiber = yield* native.stream.pipe(
        Stream.runForEach((event) => Effect.sync(() => observed.push(event.type))),
        Effect.forkScoped,
      )
      yield* Effect.promise(() => bothStarted)

      expect(started).toEqual(["call-1", "call-2"])
      expect(observed).toEqual(["tool-call", "tool-call", "finish"])

      release?.()
      yield* Fiber.join(fiber)
      expect(observed).toEqual(["tool-call", "tool-call", "finish", "tool-result", "tool-result"])
    }),
  )

  /**
   * Parity with `experimental_repairToolCall` on the AI SDK path
   * (session/llm.ts). A model that garbles one call must cost ONE tool error,
   * not the turn: the native runtime rewrites the announced call into the
   * repair-only `invalid` tool so the model gets a result and continues.
   */
  it.effect("repairs an invalid native tool call into the invalid tool", () =>
    Effect.gen(function* () {
      const observed: Array<{ type: string; name?: string }> = []
      const executed: unknown[] = []
      const tools = {
        webmcp_call: {
          description: "Call a site tool",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async () => ({ ran: true }),
        },
        invalid: {
          description: "Do not use",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async (args: unknown) => {
            executed.push(args)
            return { output: "rejected" }
          },
        },
      } satisfies Record<string, Tool>
      const raw = '{"site": "https://origami.gratis/folio/", "tool": "search_docs", "args": {"query": "Origami'
      const llmClient = {
        prepare: () => Effect.die("unused"),
        stream: () =>
          Stream.fromIterable([
            LLMEvent.toolCall({
              id: "call_3",
              name: "webmcp_call",
              input: raw,
              invalid: true,
              error: "Invalid JSON input for openai-chat tool call webmcp_call",
            }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ]),
        generate: () => Effect.die("unused"),
      } as LLMClientShape
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [],
        tools,
        activeTools: ["webmcp_call"],
        headers: {},
        abort: new AbortController().signal,
      })
      if (native.type === "unsupported") throw new Error(native.reason)

      const events = Array.from(yield* native.stream.pipe(Stream.runCollect))
      for (const event of events) observed.push({ type: event.type, name: "name" in event ? event.name : undefined })

      expect(observed).toEqual([
        { type: "tool-call", name: "invalid" },
        { type: "finish", name: undefined },
        { type: "tool-result", name: "invalid" },
      ])
      const call = events.find((event) => event.type === "tool-call")
      expect(call).toMatchObject({
        id: "call_3",
        name: "invalid",
        input: { tool: "webmcp_call", error: "Invalid JSON input for openai-chat tool call webmcp_call" },
      })
      // The repaired call carries no leftover failure marker: the session
      // stores it as an ordinary call to a tool that answers with the error.
      expect(call && "invalid" in call ? call.invalid : undefined).toBeUndefined()
      expect(executed).toEqual([
        { tool: "webmcp_call", error: "Invalid JSON input for openai-chat tool call webmcp_call" },
      ])
    }),
  )

  it.effect("repairs a tool name that differs only by case", () =>
    Effect.gen(function* () {
      const executed: string[] = []
      const tools = {
        lookup: {
          description: "Lookup data",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async (_args: unknown, options: { toolCallId: string }) => {
            executed.push(options.toolCallId)
            return { ok: true }
          },
        },
      } satisfies Record<string, Tool>
      const llmClient = {
        prepare: () => Effect.die("unused"),
        stream: () =>
          Stream.fromIterable([
            LLMEvent.toolCall({ id: "call_1", name: "Lookup", input: {} }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ]),
        generate: () => Effect.die("unused"),
      } as LLMClientShape
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [],
        tools,
        headers: {},
        abort: new AbortController().signal,
      })
      if (native.type === "unsupported") throw new Error(native.reason)

      const events = Array.from(yield* native.stream.pipe(Stream.runCollect))

      expect(events.find((event) => event.type === "tool-call")).toMatchObject({ id: "call_1", name: "lookup" })
      expect(events.find((event) => event.type === "tool-result")).toMatchObject({ name: "lookup" })
      expect(executed).toEqual(["call_1"])
    }),
  )

  it.effect("repairs a call that is BOTH mis-cased and unreadable all the way to the invalid tool", () =>
    Effect.gen(function* () {
      // The two repairs used to be exclusive: the casing branch RETURNED, so a
      // call that was mis-cased AND unreadable was renamed and then dispatched
      // to the real tool still carrying `invalid: true` and the raw argument
      // STRING. Two things went wrong at once — the model was told "bad input"
      // by the tool instead of by `invalid`, and a marker the session is never
      // meant to store reached stored content. A model that truncates its
      // arguments is exactly the model most likely to also mis-type the name,
      // so the combination is not exotic.
      const executed: unknown[] = []
      const dispatched: unknown[] = []
      const tools = {
        lookup: {
          description: "Lookup data",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async (args: unknown) => {
            dispatched.push(args)
            return { ok: true }
          },
        },
        invalid: {
          description: "Do not use",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async (args: unknown) => {
            executed.push(args)
            return { output: "rejected" }
          },
        },
      } satisfies Record<string, Tool>
      const llmClient = {
        prepare: () => Effect.die("unused"),
        stream: () =>
          Stream.fromIterable([
            LLMEvent.toolCall({
              id: "call_9",
              name: "Lookup",
              input: '{"query": "weath',
              invalid: true,
              error: "Invalid JSON input for openai-chat tool call Lookup",
            }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ]),
        generate: () => Effect.die("unused"),
      } as LLMClientShape
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [],
        tools,
        activeTools: ["lookup"],
        headers: {},
        abort: new AbortController().signal,
      })
      if (native.type === "unsupported") throw new Error(native.reason)

      const events = Array.from(yield* native.stream.pipe(Stream.runCollect))
      const call = events.find((event) => event.type === "tool-call")

      // The casing fix still applies — the tool the model MEANT is named in the
      // report — but the call ends at `invalid`, never at the real tool.
      expect(call).toMatchObject({
        id: "call_9",
        name: "invalid",
        input: { tool: "lookup", error: "Invalid JSON input for openai-chat tool call Lookup" },
      })
      // No leftover marker, and no raw string handed to a real tool.
      expect(call && "invalid" in call ? call.invalid : undefined).toBeUndefined()
      expect(dispatched).toEqual([])
      expect(executed).toEqual([
        { tool: "lookup", error: "Invalid JSON input for openai-chat tool call Lookup" },
      ])
    }),
  )

  it.effect("leaves a mixed-case tool alone when that IS its real name", () =>
    Effect.gen(function* () {
      // The AI SDK hook only runs on an already-failed call, so it needs no
      // such guard; this one runs on every call, so the guard is load-bearing.
      const executed: string[] = []
      const tools = {
        Lookup: {
          description: "Lookup data",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async (_args: unknown, options: { toolCallId: string }) => {
            executed.push(options.toolCallId)
            return { ok: true }
          },
        },
      } satisfies Record<string, Tool>
      const llmClient = {
        prepare: () => Effect.die("unused"),
        stream: () =>
          Stream.fromIterable([
            LLMEvent.toolCall({ id: "call_1", name: "Lookup", input: {} }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ]),
        generate: () => Effect.die("unused"),
      } as LLMClientShape
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [],
        tools,
        headers: {},
        abort: new AbortController().signal,
      })
      if (native.type === "unsupported") throw new Error(native.reason)

      const events = Array.from(yield* native.stream.pipe(Stream.runCollect))

      expect(events.find((event) => event.type === "tool-call")).toMatchObject({ id: "call_1", name: "Lookup" })
      expect(executed).toEqual(["call_1"])
    }),
  )

  it.effect("compiles through the native OpenAI Responses route", () =>
    expectOpenAIResponsesRequest({
      history: [storedSession.user("hello")],
      providerOptions: { openai: { store: false, instructions: "You are concise." } },
      maxOutputTokens: 512,
      headers: { "x-request": "request-header" },
      expectedBody: {
        model: "gpt-5-mini",
        instructions: "You are concise.",
        input: [openAIResponses.user("hello")],
        max_output_tokens: 512,
        store: false,
        stream: true,
      },
    }),
  )

  it.effect("omits non-persisted OpenAI reasoning ids without encrypted state", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.user("What changed?"),
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerOptions",
            itemId: "rs_1",
            encryptedContent: null,
          }),
          storedSession.text("The parser changed."),
        ]),
        storedSession.user("Summarize it."),
      ],
      providerOptions: { openai: { store: false } },
      expectedBody: {
        input: [
          openAIResponses.user("What changed?"),
          openAIResponses.assistant("The parser changed."),
          openAIResponses.user("Summarize it."),
        ],
        store: false,
      },
    }),
  )

  it.effect("preserves encrypted OpenAI reasoning state through native request lowering", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.user("What changed?"),
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
          storedSession.text("The parser changed."),
        ]),
        storedSession.user("Summarize it."),
      ],
      providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
      expectedBody: {
        input: [
          openAIResponses.user("What changed?"),
          openAIResponses.openaiReasoning("Checked the previous diff.", "encrypted-state"),
          openAIResponses.assistant("The parser changed."),
          openAIResponses.user("Summarize it."),
        ],
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    }),
  )

  it.effect("preserves empty encrypted OpenAI reasoning items before tool output", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.assistant([
          storedSession.openaiReasoning("", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
        ]),
      ],
      providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
      expectedBody: {
        input: [{ type: "reasoning", summary: [], encrypted_content: "encrypted-state" }],
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    }),
  )

  it.effect("references stored OpenAI reasoning items by id", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: null,
          }),
        ]),
      ],
      providerOptions: { openai: { store: true } },
      expectedBody: {
        input: [{ type: "item_reference", id: "rs_1" }],
        store: true,
      },
    }),
  )

  it.effect("uses provider fetch override for native OpenAI OAuth requests", () =>
    Effect.gen(function* () {
      const captures: Array<{ url: string; body: unknown }> = []
      const customFetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          const request = input instanceof Request ? input : new Request(input, init)
          captures.push({ url: request.url, body: await request.clone().json() })
          return responsesStream([
            { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ])
        },
        { preconnect: () => undefined },
      ) satisfies typeof fetch

      const llmClient = yield* LLMClient.Service
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: { ...providerInfo, options: { apiKey: OAUTH_DUMMY_KEY, fetch: customFetch } },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        providerOptions: { instructions: "You are concise." },
        headers: {},
        abort: new AbortController().signal,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)
      const events = Array.from(yield* native.stream.pipe(Stream.runCollect))

      expect(captures).toHaveLength(1)
      expect(captures[0]).toMatchObject({
        url: "https://api.openai.com/v1/responses",
        body: {
          model: "gpt-5-mini",
          instructions: "You are concise.",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        },
      })
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text-delta", text: "Hello" }),
          expect.objectContaining({ type: "finish" }),
        ]),
      )
    }),
  )
})

/**
 * The tool-choice default is applied by `LLMNativeRuntime.stream`, not by
 * `LLMNative.request`, so the only way to see it is to let the runtime build
 * the request. A stub client captures it; preparing that request gives the
 * wire body the protocol would send.
 */
const nativeRuntimeBody = (input: {
  readonly model: Provider.Model
  readonly tools: Record<string, Tool>
  readonly toolChoice?: "auto" | "required" | "none"
}) =>
  Effect.gen(function* () {
    let captured: LLMRequest | undefined
    const llmClient = {
      prepare: () => Effect.die("unused"),
      stream: (request: LLMRequest) => {
        captured = request
        return Stream.make(LLMEvent.finish({ reason: "stop" }))
      },
      generate: () => Effect.die("unused"),
    } as unknown as LLMClientShape
    const native = LLMNativeRuntime.stream({
      model: input.model,
      provider: providerInfo,
      auth: undefined,
      llmClient,
      messages: [{ role: "user", content: "hello" }],
      tools: input.tools,
      toolChoice: input.toolChoice,
      headers: {},
      abort: new AbortController().signal,
    })
    if (native.type === "unsupported") throw new Error(native.reason)
    yield* native.stream.pipe(Stream.runDrain)
    if (!captured) throw new Error("the native runtime never handed a request to the client")
    const prepared = yield* LLMClient.prepare<Record<string, unknown>>(captured)
    return prepared.body
  })

const lookupTool = {
  lookup: tool({ description: "Look something up", inputSchema: jsonSchema({ type: "object" }) }),
} satisfies Record<string, Tool>

describe("session.llm-native.tool choice", () => {
  it.effect("declared tools carry an explicit auto choice on the wire", () =>
    Effect.gen(function* () {
      const body = yield* nativeRuntimeBody({ model: baseModel, tools: lookupTool })

      expect(body.tool_choice).toBe("auto")
    }),
  )

  it.effect("a request without tools carries no choice at all", () =>
    Effect.gen(function* () {
      const body = yield* nativeRuntimeBody({ model: baseModel, tools: {} })

      expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("tool_choice")
    }),
  )

  it.effect("a caller's own choice still wins", () =>
    Effect.gen(function* () {
      const body = yield* nativeRuntimeBody({ model: baseModel, tools: lookupTool, toolChoice: "required" })

      expect(body.tool_choice).toBe("required")
    }),
  )
})

const compatModel = (providerID: string): Provider.Model => ({
  ...baseModel,
  providerID: ProviderV2.ID.make(providerID),
  api: { id: "deepseek-v4-flash", url: "http://127.0.0.1:8000/v1", npm: "@ai-sdk/openai-compatible" },
})

describe("session.llm-native.openai-compatible auth", () => {
  test("a keyless endpoint gets no auth at all instead of a missing-key failure", () => {
    const keyless = LLMNative.model({ model: compatModel("vllm"), messages: [] })
    expect(keyless.route.auth).toBe(Auth.none)
    const keyed = LLMNative.model({ model: compatModel("vllm"), apiKey: "k", messages: [] })
    expect(keyed.route.auth).not.toBe(Auth.none)
  })
})

describe("session.llm-native.openai-compatible options", () => {
  test("lowers provider-keyed options the way @ai-sdk/openai-compatible does", () => {
    // The engine keys these by provider id; the AI SDK adapter maps three of
    // them to named wire fields and spreads the rest verbatim into the body.
    expect(
      LLMNativeRuntime.nativeOptions(compatModel("vllm"), {
        reasoningEffort: "max",
        textVerbosity: "low",
        user: "u-1",
        chat_template_kwargs: { thinking: true },
        promptCacheKey: "session-1",
      }),
    ).toEqual({
      providerOptions: { openai: { reasoningEffort: "max" } },
      http: { body: { verbosity: "low", user: "u-1", chat_template_kwargs: { thinking: true }, promptCacheKey: "session-1" } },
    })
    expect(LLMNativeRuntime.nativeOptions(compatModel("vllm"), {})).toEqual({
      providerOptions: undefined,
      http: undefined,
    })
    // The OpenAI family is untouched: same keys the native OpenAI options read.
    const openai = LLMNativeRuntime.nativeOptions(baseModel, { reasoningEffort: "high", store: false })
    expect(openai.http).toBeUndefined()
    expect(openai.providerOptions).toMatchObject({ openai: { reasoningEffort: "high", store: false } })
  })
})

describe("session.llm-native.openai-compatible wire", () => {
  it.effect("puts extras, the effort tier and stored reasoning on the wire", () =>
    Effect.gen(function* () {
      const options = LLMNativeRuntime.nativeOptions(compatModel("vllm"), {
        reasoningEffort: "max",
        chat_template_kwargs: { thinking: true },
      })
      const llmRequest = LLMNative.request({
          model: compatModel("vllm"),
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              // What ProviderTransform.message leaves behind for a DeepSeek-style
              // model: reasoning stripped from content, parked under the field.
              providerOptions: { openaiCompatible: { reasoning_content: "thought about it" } },
            },
            { role: "user", content: "and?" },
            {
              role: "assistant",
              content: [{ type: "text", text: "sure" }],
              providerOptions: { openaiCompatible: { reasoning: "gpt-oss style" } },
            },
          ],
          providerOptions: options.providerOptions,
          http: options.http,
        })
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(llmRequest)
      expect(prepared.route).toBe("openai-compatible-chat")
      // Extras ride the http.body overlay, which the TRANSPORT applies; only
      // the bytes that leave the box prove they are on the wire.
      const transport: unknown = yield* llmRequest.model.route.prepareTransport(prepared.body, llmRequest)
      if (!isRecord(transport) || !HttpClientRequest.isHttpClientRequest(transport.request))
        throw new Error("transport did not prepare an HttpClientRequest")
      const web = yield* HttpClientRequest.toWeb(transport.request).pipe(Effect.orDie)
      const wire: unknown = JSON.parse(yield* Effect.promise(() => web.text()))
      if (!isRecord(wire)) throw new Error("wire body is not a JSON object")
      expect(wire).toMatchObject({
        reasoning_effort: "max",
        chat_template_kwargs: { thinking: true },
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "ok", reasoning_content: "thought about it" },
          { role: "user", content: "and?" },
          { role: "assistant", content: "sure", reasoning: "gpt-oss style" },
        ],
      })
      const second: unknown = Array.isArray(wire.messages) ? wire.messages[1] : undefined
      expect(isRecord(second) && "reasoning" in second).toBe(false)
    }),
  )
})

describe("session.llm-native.openai-compatible sampling knobs", () => {
  it.effect("a configured sampling knob reaches the wire instead of failing the request", () =>
    Effect.gen(function* () {
      // Passing's vLLM blocks set `frequency_penalty: 0` on the model options.
      // The AI SDK path spread such keys verbatim; the first native cutover
      // refused them as protocol-owned and took the whole lane down.
      const options = LLMNativeRuntime.nativeOptions(compatModel("vllm"), {
        frequency_penalty: 0,
        top_p: 0.9,
        repetition_penalty: 1.05,
      })
      const llmRequest = LLMNative.request({
        model: compatModel("vllm"),
        messages: [{ role: "user", content: "hi" }],
        topP: 0.5,
        providerOptions: options.providerOptions,
        http: options.http,
      })
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(llmRequest)
      const transport: unknown = yield* llmRequest.model.route.prepareTransport(prepared.body, llmRequest)
      if (!isRecord(transport) || !HttpClientRequest.isHttpClientRequest(transport.request))
        throw new Error("transport did not prepare an HttpClientRequest")
      const web = yield* HttpClientRequest.toWeb(transport.request).pipe(Effect.orDie)
      const wire: unknown = JSON.parse(yield* Effect.promise(() => web.text()))
      if (!isRecord(wire)) throw new Error("wire body is not a JSON object")
      expect(wire).toMatchObject({ frequency_penalty: 0, repetition_penalty: 1.05 })
      // A configured knob wins over the engine's own, the way the AI SDK spread it.
      expect(wire.top_p).toBe(0.9)
    }),
  )

  it.effect("another protocol's structural key is a plain extra on an OpenAI-compatible server", () =>
    Effect.gen(function* () {
      // A GLM/zai block sets `thinking` in its model options. It is Anthropic
      // and Gemini structure, never OpenAI Chat structure, and the first
      // native cutover refused it globally - every prompt on such a block
      // failed. Ownership is the SENDING protocol's, per request.
      const options = LLMNativeRuntime.nativeOptions(compatModel("zai"), {
        thinking: { type: "enabled" },
        contents: "not gemini's",
      })
      const llmRequest = LLMNative.request({
        model: compatModel("zai"),
        messages: [{ role: "user", content: "hi" }],
        providerOptions: options.providerOptions,
        http: options.http,
      })
      const prepared = yield* LLMClient.prepare<Record<string, unknown>>(llmRequest)
      const transport: unknown = yield* llmRequest.model.route.prepareTransport(prepared.body, llmRequest)
      if (!isRecord(transport) || !HttpClientRequest.isHttpClientRequest(transport.request))
        throw new Error("transport did not prepare an HttpClientRequest")
      const web = yield* HttpClientRequest.toWeb(transport.request).pipe(Effect.orDie)
      const wire: unknown = JSON.parse(yield* Effect.promise(() => web.text()))
      if (!isRecord(wire)) throw new Error("wire body is not a JSON object")
      expect(wire).toMatchObject({ thinking: { type: "enabled" }, contents: "not gemini's" })
    }),
  )
})

const xaiModel: Provider.Model = {
  ...baseModel,
  id: ModelV2.ID.make("grok-4"),
  providerID: ProviderV2.ID.make("xai"),
  api: { id: "grok-4", url: "", npm: "@ai-sdk/xai" },
}

const xaiProvider: Provider.Info = {
  ...providerInfo,
  id: ProviderV2.ID.make("xai"),
  name: "xAI",
  env: ["XAI_API_KEY"],
  options: { apiKey: "test-xai-key" },
}

describe("session.llm-native.xai", () => {
  test("an api key or an OAuth fetch override both make xai supported", () => {
    expect(LLMNativeRuntime.status({ model: xaiModel, provider: xaiProvider, auth: undefined })).toMatchObject({
      type: "supported",
      apiKey: "test-xai-key",
    })
    // The xai plugin's OAuth loader returns { apiKey: OAUTH_DUMMY_KEY, fetch }:
    // the dummy key rides along and the override is what signs the request.
    // The override is honoured on ANY provider id, not only "openai".
    expect(
      LLMNativeRuntime.status({
        model: xaiModel,
        provider: { ...xaiProvider, options: { apiKey: OAUTH_DUMMY_KEY, fetch: async () => new Response() } },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      }),
    ).toMatchObject({ type: "supported", apiKey: OAUTH_DUMMY_KEY })
    // Without a signer the dummy bearer would go to xAI as the real token.
    expect(
      LLMNativeRuntime.status({
        model: xaiModel,
        provider: { ...xaiProvider, options: { apiKey: OAUTH_DUMMY_KEY } },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      }),
    ).toEqual({ type: "unsupported", reason: "OAuth auth requires a provider fetch override" })
  })

  test("the OAuth signer is honoured for the openai and xai families only", () => {
    // snowflake-cortex installs the same { apiKey: OAUTH_DUMMY_KEY, fetch }
    // shape on an OpenAI-compatible model. That family is on by default, so an
    // open check would carry its OAuth traffic natively with no cassette
    // behind it; it must keep falling back to the AI SDK.
    const compatible: Provider.Model = {
      ...xaiModel,
      providerID: ProviderV2.ID.make("snowflake-cortex"),
      api: { id: "claude-3-5-sonnet", url: "https://acct.snowflakecomputing.com/api/v2/cortex/v1", npm: "@ai-sdk/openai-compatible" },
    }
    expect(
      LLMNativeRuntime.status({
        model: compatible,
        provider: {
          ...xaiProvider,
          id: ProviderV2.ID.make("snowflake-cortex"),
          options: { apiKey: OAUTH_DUMMY_KEY, fetch: async () => new Response() },
        },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      }),
    ).toEqual({ type: "unsupported", reason: "OAuth auth requires a provider fetch override" })
  })

  test("lowers the engine's xai-keyed options onto the key the Responses protocol reads", () => {
    // ProviderTransform keys them under "xai" (what @ai-sdk/xai reads); the
    // native Responses protocol reads providerOptions.openai and nothing else.
    // Same field names, different namespace, so this is a re-key not a mapping.
    expect(LLMNativeRuntime.nativeOptions(xaiModel, { reasoningEffort: "high" })).toEqual({
      providerOptions: { openai: { reasoningEffort: "high" } },
    })
    expect(LLMNativeRuntime.nativeOptions(xaiModel, {})).toEqual({ providerOptions: { openai: {} } })
  })

  it.effect("the lowered reasoning effort reaches the OpenAI Responses body", () =>
    Effect.gen(function* () {
      const options = LLMNativeRuntime.nativeOptions(xaiModel, { reasoningEffort: "high" })
      const prepared = yield* LLMClient.prepare(
        LLMNative.request({
          model: xaiModel,
          apiKey: "test-xai-key",
          messages: [{ role: "user", content: "hi" }],
          providerOptions: options.providerOptions,
        }),
      )
      // Left on the engine's "xai" key this body would carry no effort at all.
      expect(prepared).toMatchObject({
        route: "openai-responses",
        protocol: "openai-responses",
        body: { model: "grok-4", reasoning: { effort: "high" } },
      })
    }),
  )
})

/**
 * The bridge between the native runtime and a provider plugin's `fetch` signer.
 *
 * Every signer under src/plugin/ was written against the AI SDK, which hands a
 * `fetch` override a JSON STRING body. The native runtime reaches the same
 * signer through Effect's fetch client, which sends a `bodyText` request as a
 * Uint8Array — so a signer that reads `init.body` as a string silently does
 * nothing. The owner met that as an HTTP 400 "Unsupported parameter:
 * temperature" from chatgpt.com/backend-api/codex on 2026-09-03: the codex
 * wrapper rewrote the URL but `withoutSampling` returned the bytes untouched.
 *
 * This drives the REAL CodexAuthPlugin loader output, not a stand-in, because
 * the defect lives in what the runtime hands it, not in the plugin.
 */
describe("a plugin fetch signer on the native path", () => {
  const lunaModel: Provider.Model = {
    ...baseModel,
    id: ModelV2.ID.make("gpt-5.6-luna"),
    api: { id: "gpt-5.6-luna", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
    name: "GPT-5.6 Luna",
    headers: {},
  }

  const codexPluginInput = {
    client: { auth: { async set() {} } },
    project: {},
    directory: "",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {},
  } as never

  it.live("gets the body as a string, so the codex wrapper still strips sampling", () =>
    Effect.gen(function* () {
      const upstream: Array<{ path: string; text: string }> = []
      using server = Bun.serve({
        port: 0,
        async fetch(request) {
          upstream.push({ path: new URL(request.url).pathname, text: await request.text() })
          return responsesStream([
            { type: "response.output_text.delta", item_id: "msg_1", delta: "ok" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ])
        },
      })

      const hooks = yield* Effect.promise(() =>
        CodexAuthPlugin(codexPluginInput, {
          codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).toString(),
        }),
      )
      const auth = { type: "oauth" as const, refresh: "rt", access: "access-token", expires: Date.now() + 3_600_000 }
      const loaded = yield* Effect.promise(() => hooks.auth!.loader!(async () => auth as never, {} as never))

      // The signer the runtime actually installs, with a probe in front of it so
      // the SHAPE handed over is observable and not just its consequence.
      const bodyTypes: string[] = []
      const signer = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          bodyTypes.push(init?.body === undefined || init.body === null ? "none" : init.body.constructor.name)
          return loaded.fetch!(input, init)
        },
        { preconnect: () => undefined },
      ) satisfies typeof fetch

      const llmClient = yield* LLMClient.Service
      const native = LLMNativeRuntime.stream({
        model: lunaModel,
        provider: { ...providerInfo, options: { apiKey: OAUTH_DUMMY_KEY, fetch: signer } },
        auth,
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        // Reasoning off on a gpt-5.6 model is exactly the case where the
        // protocol KEEPS temperature (openai-responses.ts `dropSampling`), so
        // the strip has to happen in the wrapper or not at all.
        providerOptions: { reasoningEffort: "none" },
        temperature: 0.8,
        headers: {},
        abort: new AbortController().signal,
      })
      if (native.type === "unsupported") throw new Error(native.reason)
      yield* native.stream.pipe(Stream.runCollect)

      yield* Effect.promise(() => hooks.dispose!())

      expect(upstream.map((r) => r.path)).toEqual(["/backend-api/codex/responses"])
      const body = JSON.parse(upstream[0].text) as Record<string, unknown>
      expect(body["temperature"], "temperature reached the ChatGPT backend — it answers HTTP 400").toBeUndefined()
      expect(body["top_p"]).toBeUndefined()
      expect(body["model"]).toBe("gpt-5.6-luna")
      expect(body["input"]).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }])
      expect(body["reasoning"]).toMatchObject({ effort: "none" })
      // The shape itself, so a regression names the cause and not only the symptom.
      expect(bodyTypes, "the signer was handed bytes, not the AI SDK's JSON string").toEqual(["String"])
    }),
  )

  test("every byte body becomes text; everything else is passed through", () => {
    const json = '{"model":"gpt-5.6-luna","temperature":0.8}'
    const bytes = new TextEncoder().encode(json)
    expect(LLMNativeRuntime.signerBody(bytes)).toBe(json)
    expect(LLMNativeRuntime.signerBody(bytes.buffer)).toBe(json)
    // A view into a larger buffer: decoding the whole buffer would prepend junk.
    const padded = new Uint8Array(bytes.length + 4)
    padded.set(bytes, 4)
    expect(LLMNativeRuntime.signerBody(padded.subarray(4))).toBe(json)
    expect(LLMNativeRuntime.signerBody(new DataView(bytes.buffer))).toBe(json)
    // Multi-byte UTF-8 must survive the round trip: a prompt is user text.
    const unicode = JSON.stringify({ input: "héllo 🌍 日本語" })
    expect(LLMNativeRuntime.signerBody(new TextEncoder().encode(unicode))).toBe(unicode)

    expect(LLMNativeRuntime.signerBody(json)).toBe(json)
    expect(LLMNativeRuntime.signerBody(undefined)).toBeUndefined()
    expect(LLMNativeRuntime.signerBody(null)).toBeNull()
    const form = new FormData()
    expect(LLMNativeRuntime.signerBody(form)).toBe(form)
    const stream = new ReadableStream()
    expect(LLMNativeRuntime.signerBody(stream)).toBe(stream)
  })
})

/**
 * End to end over the REAL openai-chat protocol: raw SSE bytes in, session
 * events out. The stub answers every request with one fixed body, which is all
 * a single turn needs.
 */
const sseClientLayer = (body: string) =>
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        RequestExecutor.layer.pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
                  ),
                ),
              ),
            ),
          ),
        ),
        WebSocketExecutor.layer,
      ),
    ),
  )

describe("session.llm-native.in-band provider errors", () => {
  test("reports an OpenRouter mid-stream error instead of killing the stream", async () => {
    // OpenRouter's documented mid-stream shape
    // (https://openrouter.ai/docs/api-reference/streaming): status stays 200 and
    // the error rides at the TOP LEVEL of a chunk that also carries `choices`.
    // Before the fix this whole turn died with `ProviderShared.stream: Invalid
    // openai/openai-chat stream event` — the decoder's name, not the fault.
    const body =
      `data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta: { role: "assistant", content: "one moment" }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({
        id: "gen-1",
        object: "chat.completion.chunk",
        provider: "novita",
        error: { code: 429, message: "Rate limit exceeded: free-models-per-day", metadata: { error_type: "rate_limit" } },
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
      })}\n\n` +
      "data: [DONE]\n\n"

    const program = Effect.gen(function* () {
      const llmClient = yield* LLMClient.Service
      const native = LLMNativeRuntime.stream({
        model: compatModel("openrouter"),
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [{ role: "user", content: "hi" }],
        tools: {},
        headers: {},
        abort: new AbortController().signal,
      })
      if (native.type === "unsupported") throw new Error(native.reason)
      return Array.from(yield* native.stream.pipe(Stream.runCollect))
    })
    const events = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(sseClientLayer(body))))

    // The prose that arrived is kept, the provider's own sentence reaches the
    // consumer as a `provider-error` — the event `session/processor.ts` throws
    // on — and the turn still names how it ended.
    expect(events.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual(["one moment"])
    expect(events.filter((event) => event.type === "provider-error").map((event) => event.message)).toEqual([
      "Rate limit exceeded: free-models-per-day",
    ])
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" })
  })

  test("keeps failing the stream for a chunk that is neither a choice chunk nor an error", async () => {
    // The boundary. Only an `error` frame is read as a report; any other chunk
    // the event schema rejects still kills the stream, because it may have
    // carried content that would otherwise be dropped in silence.
    const body =
      `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk" })}\n\n` + "data: [DONE]\n\n"

    const program = Effect.gen(function* () {
      const llmClient = yield* LLMClient.Service
      const native = LLMNativeRuntime.stream({
        model: compatModel("openrouter"),
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [{ role: "user", content: "hi" }],
        tools: {},
        headers: {},
        abort: new AbortController().signal,
      })
      if (native.type === "unsupported") throw new Error(native.reason)
      return Array.from(yield* native.stream.pipe(Stream.runCollect))
    })
    const exit = await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(sseClientLayer(body)), Effect.exit),
    )

    expect(exit._tag).toBe("Failure")
    // `openai-compatible-chat` reuses `OpenAIChat.protocol` verbatim, so the
    // route id in the message is the compatible one; the decoder is the same.
    expect(JSON.stringify(exit)).toContain("Invalid openrouter/openai-compatible-chat stream event")
  })

  test("an index-less tool delta starts a fresh call and still dispatches", async () => {
    // Some OpenAI-compatible servers omit `tool_calls[].index`
    // (`@ai-sdk/openai-compatible`: "google does not send index"). Two such
    // deltas must run as TWO calls, not merge into one.
    const call = (id: string, query: string) =>
      `data: ${JSON.stringify({
        id: "gen-1",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{ id, function: { name: "lookup", arguments: JSON.stringify({ query }) } }],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`
    const body =
      call("call_a", "weather") +
      call("call_b", "tides") +
      `data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
      "data: [DONE]\n\n"

    const ran: string[] = []
    const tools = {
      lookup: {
        description: "Lookup data",
        inputSchema: jsonSchema({ type: "object" }),
        execute: async (args: unknown) => {
          ran.push(JSON.stringify(args))
          return { ok: true }
        },
      },
    } satisfies Record<string, Tool>

    const program = Effect.gen(function* () {
      const llmClient = yield* LLMClient.Service
      const native = LLMNativeRuntime.stream({
        model: compatModel("openrouter"),
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [{ role: "user", content: "look them up" }],
        tools,
        activeTools: ["lookup"],
        headers: {},
        abort: new AbortController().signal,
      })
      if (native.type === "unsupported") throw new Error(native.reason)
      return Array.from(yield* native.stream.pipe(Stream.runCollect))
    })
    const events = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(sseClientLayer(body))))

    expect(events.filter((event) => event.type === "tool-call").map((event) => event.id)).toEqual([
      "call_a",
      "call_b",
    ])
    expect(ran).toEqual(['{"query":"weather"}', '{"query":"tides"}'])
  })
})

describe("session.llm-native.tool repair end to end", () => {
  test("turns a truncated parallel call into one tool error and keeps the turn", async () => {
      // The bytes of a REAL failure, recorded 2026-09-03 from OpenRouter ->
      // Novita -> inclusionai/ling-3.0-flash-fin:free: three complete
      // webmcp_call calls and a fourth truncated mid-argument, which OpenRouter
      // still reported as `finish_reason: "tool_calls"`. Before the repair this
      // whole turn died with `ProviderShared.stream: Invalid JSON input for
      // openai-chat tool call webmcp_call`.
      const truncated =
        '{"site": "https://origami.gratis/folio/", "tool": "search_docs", "args": {"query": "Origami'
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      const good = (index: number, id: string, name: string) =>
        chunk({
          role: "assistant",
          tool_calls: [{ index, id, type: "function", function: { name: "webmcp_call", arguments: "" } }],
        }) +
        chunk({
          tool_calls: [
            { index, function: { arguments: `{"site": "https://origami.gratis/folio/", "tool": "${name}"}` } },
          ],
        })
      const body =
        good(0, "call_0", "list_themes") +
        good(1, "call_1", "list_starters") +
        good(2, "call_2", "list_chunks") +
        chunk({
          role: "assistant",
          tool_calls: [{ index: 3, id: "call_3", type: "function", function: { name: "webmcp_call", arguments: "" } }],
        }) +
        chunk({ tool_calls: [{ index: 3, function: { arguments: truncated } }] }) +
        chunk({}, "tool_calls") +
        "data: [DONE]\n\n"

      const ran: string[] = []
      const tools = {
        webmcp_call: {
          description: "Call a site tool",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async (args: unknown) => {
            ran.push(JSON.stringify(args))
            return { ok: true }
          },
        },
        invalid: {
          description: "Do not use",
          inputSchema: jsonSchema({ type: "object" }),
          execute: async (args: { tool: string; error: string }) => ({
            output: `The ${args.tool} tool was called with invalid arguments: ${args.error}`,
          }),
        },
      } satisfies Record<string, Tool>

      const program = Effect.gen(function* () {
        const llmClient = yield* LLMClient.Service
        const native = LLMNativeRuntime.stream({
          model: compatModel("openrouter"),
          provider: providerInfo,
          auth: undefined,
          llmClient,
          messages: [{ role: "user", content: "list them all" }],
          tools,
          activeTools: ["webmcp_call"],
          headers: {},
          abort: new AbortController().signal,
        })
        if (native.type === "unsupported") throw new Error(native.reason)
        return Array.from(yield* native.stream.pipe(Stream.runCollect))
      })
      const events = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(sseClientLayer(body))))

      expect(events.filter((event) => event.type === "tool-call").map((event) => event.name)).toEqual([
        "webmcp_call",
        "webmcp_call",
        "webmcp_call",
        "invalid",
      ])
      // The turn still finishes: usage and the finish reason are delivered, and
      // nothing in the stream reports a provider failure.
      expect(events.find((event) => event.type === "finish")).toMatchObject({ reason: "tool-calls" })
      expect(events.filter((event) => event.type === "provider-error")).toEqual([])
      expect(ran).toEqual([
        '{"site":"https://origami.gratis/folio/","tool":"list_themes"}',
        '{"site":"https://origami.gratis/folio/","tool":"list_starters"}',
        '{"site":"https://origami.gratis/folio/","tool":"list_chunks"}',
      ])
      const rejected = events.find((event) => event.type === "tool-result" && event.name === "invalid")
      expect(rejected).toMatchObject({
        name: "invalid",
        result: {
          value: {
            output:
              "The webmcp_call tool was called with invalid arguments: Invalid JSON input for openai-chat tool call webmcp_call",
          },
        },
      })
  })
})
