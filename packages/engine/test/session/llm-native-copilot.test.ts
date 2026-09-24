/**
 * GitHub Copilot on the native `@origami/llm` runtime.
 *
 * Copilot is not one endpoint but three: `/chat/completions` and `/responses`
 * for its OpenAI-family rows (`@ai-sdk/github-copilot`), and a `/v1/messages`
 * Anthropic shim for its Claude rows (`@ai-sdk/anthropic` at `<base>/v1`).
 * All three carry the SAME plugin-signed OAuth bearer and the same Copilot-only
 * request headers, and all three bill in AIU rather than in tokens.
 *
 * Every wire assertion below drives the REAL `CopilotAuthPlugin` hooks — the
 * auth loader's signing fetch, `chat.headers`, `chat.params` — because the
 * defects this lane is guarding against live in what the native runtime hands
 * those hooks, not in the hooks themselves.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { LLMEvent, Usage } from "@origami/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@origami/llm/route"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { CopilotAuthPlugin, resetSessionTokensForTests } from "@/plugin/github-copilot/copilot"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Session as SessionNs } from "@/session/session"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { LLMNative } from "@/session/llm/native-request"
import { LLMNativeRoute } from "@/session/llm/native-route"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)), WebSocketExecutor.layer),
    ),
  ),
)

/** Not a credential: a fabricated string, so a leak of it costs nothing. */
const TOKEN = "gho_parity_fixture_token"
/** The session token the fixture's `/copilot_internal/v2/token` hands back. */
const SESSION = "gho_parity_fixture_session"
const AUTH = { type: "oauth" as const, refresh: TOKEN, access: TOKEN, expires: 0 }
const API_VERSION = "2026-06-01"
/** The amount llm.test.ts uses for the AI SDK path, so both paths cost the same. */
const NANO_AIU = 4_473_525_000
const COPILOT_TOKEN_PATH = "/copilot_internal/v2/token"
/** The three headers `INTEGRATION_HEADERS` in copilot.ts sends, as the fixture sees them (lower-cased by `Headers`). */
const INTEGRATION_HEADER_NAMES = ["copilot-integration-id", "editor-version", "editor-plugin-version"]

// The exchange now runs on every request (copilot.ts no longer gates it on
// the request host), so every test that drives the wrapped fetch must point
// `ORIGAMI_COPILOT_TOKEN_URL` at its own fixture server, and every test must
// drop the cached exchange afterwards so the next test's fixture is not
// bypassed by a stale entry.
afterEach(() => {
  delete process.env["ORIGAMI_COPILOT_TOKEN_URL"]
  resetSessionTokensForTests()
})

/** Points the plugin's session-token exchange at this fixture server. */
function useTokenFixture(origin: string) {
  process.env["ORIGAMI_COPILOT_TOKEN_URL"] = `${origin}${COPILOT_TOKEN_PATH}`
}

const sse = (chunks: ReadonlyArray<unknown>) =>
  new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })

const capabilities: Provider.Model["capabilities"] = {
  temperature: true,
  reasoning: true,
  attachment: true,
  toolcall: true,
  input: { text: true, audio: false, image: true, video: false, pdf: false },
  output: { text: true, audio: false, image: false, video: false, pdf: false },
  interleaved: false,
}

/**
 * `api.endpoint` is written by `plugin/github-copilot/models.ts` from GitHub's
 * `supported_endpoints`, and is not on the `Model` schema — both runtimes read
 * it off the object (`provider.ts` "github-copilot" `getModel` does
 * `"endpoint" in model.api`). `Object.assign` keeps it without tripping excess
 * property checking on a fresh literal.
 */
const copilotApi = (id: string, url: string, endpoint?: "chat" | "responses"): Provider.Model["api"] =>
  Object.assign({ id, url, npm: "@ai-sdk/github-copilot" }, endpoint ? { endpoint } : {})

const copilotModel = (input: {
  readonly id: string
  readonly url: string
  readonly endpoint?: "chat" | "responses"
  readonly npm?: string
}): Provider.Model => ({
  id: ModelV2.ID.make(input.id),
  providerID: ProviderV2.ID.make("github-copilot"),
  api:
    input.npm === "@ai-sdk/anthropic"
      ? { id: input.id, url: input.url, npm: "@ai-sdk/anthropic" }
      : copilotApi(input.id, input.url, input.endpoint),
  name: input.id,
  capabilities,
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 4_096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

/** A signer stand-in for the status checks, which never call it. */
const stubSigner = Object.assign(async () => new Response(), {
  preconnect: () => undefined,
}) satisfies typeof globalThis.fetch

/** What the Copilot auth loader really returns: NO api key, only a signer. */
const copilotProvider = (fetch?: typeof globalThis.fetch): Provider.Info => ({
  id: ProviderV2.ID.make("github-copilot"),
  name: "GitHub Copilot",
  source: "custom",
  env: [],
  options: fetch ? { apiKey: "", fetch } : { apiKey: "" },
  models: {},
})

/**
 * Enough of a `PluginInput` for the three hooks under test. `chat.headers`
 * asks the server for the message and the session; both reject here, and the
 * hook's own `.catch(() => undefined)` is what makes that the "ordinary turn"
 * case rather than an error.
 */
const pluginInput = {
  client: {
    session: {
      message: async () => {
        throw new Error("no session server in this test")
      },
      get: async () => {
        throw new Error("no session server in this test")
      },
    },
  },
  directory: "",
} as never

const loadPlugin = () => Effect.promise(() => CopilotAuthPlugin(pluginInput))

const signerFor = (hooks: Awaited<ReturnType<typeof CopilotAuthPlugin>>) =>
  Effect.gen(function* () {
    const loaded = yield* Effect.promise(() => hooks.auth!.loader!(async () => AUTH as never, {} as never))
    return loaded.fetch! as typeof globalThis.fetch
  })

/** The headers `session/llm/request.ts` would hand the runtime for this model. */
const preparedHeaders = (hooks: Awaited<ReturnType<typeof CopilotAuthPlugin>>, model: Provider.Model) =>
  Effect.gen(function* () {
    const output = { headers: {} as Record<string, string> }
    yield* Effect.promise(() =>
      hooks["chat.headers"]!(
        {
          sessionID: "ses_copilot",
          agent: "build",
          model: model as never,
          provider: {} as never,
          message: { id: "msg_copilot", sessionID: "ses_copilot" } as never,
        },
        output,
      ),
    )
    return output.headers
  })

/** The options `session/llm/request.ts` would hand the runtime for this model. */
const preparedOptions = (hooks: Awaited<ReturnType<typeof CopilotAuthPlugin>>, model: Provider.Model) =>
  Effect.gen(function* () {
    const output = {
      temperature: 0,
      topP: 1,
      topK: 0,
      maxOutputTokens: ProviderTransform.maxOutputTokens(model),
      options: ProviderTransform.options({ model, sessionID: "ses_copilot" }),
    }
    yield* Effect.promise(() =>
      hooks["chat.params"]!(
        {
          sessionID: "ses_copilot",
          agent: "build",
          model: model as never,
          provider: {} as never,
          message: { id: "msg_copilot", sessionID: "ses_copilot" } as never,
        },
        output,
      ),
    )
    return output
  })

type Captured = { path: string; headers: Record<string, string>; body: Record<string, unknown> }

/**
 * Every fixture server also answers the session-token exchange, since the
 * wrapped fetch now runs it on every request regardless of host.
 * `useTokenFixture` is called here (not by each test) so no call site can
 * forget it and leak a request to the real api.github.com.
 */
const captureServer = (respond: () => Response) => {
  const seen: Captured[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const text = await request.text()
      const path = new URL(request.url).pathname
      seen.push({
        path,
        headers: Object.fromEntries(request.headers.entries()),
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      })
      if (path === COPILOT_TOKEN_PATH) {
        return Response.json({
          token: SESSION,
          expires_at: Math.floor(Date.now() / 1000) + 1800,
          endpoints: { api: new URL(request.url).origin },
        })
      }
      return respond()
    },
  })
  useTokenFixture(server.url.origin)
  return { server, seen }
}

/** The request the fixture recorded at `path`, asserting there was exactly one. */
const requestAt = (seen: ReadonlyArray<Captured>, path: string): Captured => {
  const matches = seen.filter((entry) => entry.path === path)
  expect(matches.length, `expected exactly one request to ${path}, saw ${matches.length}`).toBe(1)
  return matches[0]!
}

/** Asserts the fixture's session-token exchange was signed the way copilot.ts signs it. */
const expectExchangeRequest = (seen: ReadonlyArray<Captured>) => {
  const exchange = requestAt(seen, COPILOT_TOKEN_PATH)
  expect(exchange.headers["authorization"]).toBe(`token ${TOKEN}`)
  for (const name of INTEGRATION_HEADER_NAMES) expect(exchange.headers[name]).toBeDefined()
}

/** The `_noop` tool `session/llm/request.ts` adds for a Copilot tool replay. */
const noopTool: Record<string, Tool> = {
  _noop: aiTool({
    description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
    inputSchema: jsonSchema({ type: "object", properties: { reason: { type: "string", description: "Unused" } } }),
    execute: async () => ({ output: "", title: "", metadata: {} }),
  }),
}

const drive = (input: Omit<Parameters<typeof LLMNativeRuntime.stream>[0], "llmClient" | "abort">) =>
  Effect.gen(function* () {
    const llmClient = yield* LLMClient.Service
    const native = LLMNativeRuntime.stream({ ...input, llmClient, abort: new AbortController().signal })
    if (native.type === "unsupported") throw new Error(native.reason)
    return Array.from(yield* native.stream.pipe(Stream.runCollect))
  })

const stepFinish = (events: ReadonlyArray<LLMEvent>) => events.find(LLMEvent.is.stepFinish)

describe("session.llm-native.copilot routing", () => {
  test("Copilot is its own family, and on now that its cassettes replay", () => {
    expect(LLMNativeRoute.family("@ai-sdk/github-copilot")).toBe("copilot")
    expect(LLMNativeRoute.DEFAULTS.copilot).toBe(true)
    // Copilot's Claude rows are declared @ai-sdk/anthropic by models.ts, so
    // they are gated by the ANTHROPIC flag, not by this one.
    expect(LLMNativeRoute.family("@ai-sdk/anthropic")).toBe("anthropic")
    expect(
      LLMNativeRoute.enabled(copilotModel({ id: "gpt-4.1", url: "https://api.githubcopilot.com" }), {
        experimentalNativeLlm: false,
        nativeLlmFamilies: "",
      }),
    ).toBe(true)
    expect(
      LLMNativeRoute.enabled(copilotModel({ id: "gpt-4.1", url: "https://api.githubcopilot.com" }), {
        experimentalNativeLlm: false,
        nativeLlmFamilies: "copilot",
      }),
    ).toBe(true)
    // The family list still overrides the default in both directions - that
    // is how the parity harness runs the AI SDK side of a family that is on.
    expect(
      LLMNativeRoute.enabled(copilotModel({ id: "gpt-4.1", url: "https://api.githubcopilot.com" }), {
        experimentalNativeLlm: false,
        nativeLlmFamilies: "none",
      }),
    ).toBe(false)
  })

  test("the signer alone authenticates Copilot: it stores no api key of its own", () => {
    const model = copilotModel({ id: "gpt-4.1", url: "https://api.githubcopilot.com" })
    // The loader returns `apiKey: ""`, unlike codex/xai which return a dummy
    // bearer. Refusing that for "no key" would pin Copilot to the AI SDK path.
    expect(
      LLMNativeRuntime.status({ model, provider: copilotProvider(stubSigner), auth: AUTH }),
    ).toMatchObject({ type: "supported" })
    expect(LLMNativeRuntime.status({ model, provider: copilotProvider(), auth: AUTH })).toEqual({
      type: "unsupported",
      reason: "OAuth auth requires a provider fetch override",
    })
    // No OAuth and no key is still unsupported — nothing would sign it.
    expect(LLMNativeRuntime.status({ model, provider: copilotProvider(), auth: undefined })).toEqual({
      type: "unsupported",
      reason: "API key is not configured",
    })
  })

  test("the Claude shim rows bridge the signer; other Anthropic OAuth does not", () => {
    const shim = copilotModel({
      id: "claude-sonnet-4.6",
      url: "https://api.githubcopilot.com/v1",
      npm: "@ai-sdk/anthropic",
    })
    expect(
      LLMNativeRuntime.status({ model: shim, provider: copilotProvider(stubSigner), auth: AUTH }),
    ).toMatchObject({ type: "supported" })

    // The Claude Pro/Max subscription installs the same { fetch } shape on an
    // anthropic-family model. It has no cassette, so it must keep falling back.
    const subscription: Provider.Model = { ...shim, providerID: ProviderV2.ID.make("anthropic") }
    expect(
      LLMNativeRuntime.status({
        model: subscription,
        provider: {
          ...copilotProvider(stubSigner),
          id: ProviderV2.ID.make("anthropic"),
          options: { apiKey: "", fetch: stubSigner },
        },
        auth: AUTH,
      }),
    ).toEqual({ type: "unsupported", reason: "OAuth auth requires a provider fetch override" })
  })

  test("the engine's copilot-keyed options are re-keyed onto the namespace the protocols read", () => {
    // ProviderTransform.sdkKey maps @ai-sdk/github-copilot -> "copilot"; the
    // native OpenAI Chat and Responses protocols read providerOptions.openai
    // and nothing else. Same field names, different namespace.
    const model = copilotModel({ id: "gpt-5.4", url: "https://api.githubcopilot.com", endpoint: "responses" })
    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "high" })).toEqual({
      copilot: { reasoningEffort: "high" },
    })
    expect(LLMNativeRuntime.nativeOptions(model, { reasoningEffort: "high" })).toEqual({
      providerOptions: { openai: { reasoningEffort: "high" } },
    })
  })

  test("the _noop compatibility tool survives the offered-tool filter", () => {
    // `session/llm/request.ts` adds `_noop` for a Copilot turn that replays
    // tool calls with no tools enabled; `llm.ts` then declares only the names
    // `offeredToolNames` returns. A filtered `_noop` would mean the workaround
    // silently stops working on the native path.
    expect(SessionPromptCapture.offeredToolNames(noopTool)).toEqual(["_noop"])
  })
})

describe("session.llm-native.copilot chat wire", () => {
  it.live("carries the signer's bearer, Copilot's headers and the _noop tool", () =>
    Effect.gen(function* () {
      const captured = captureServer(() =>
        sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
      )
      using server = captured.server
      const hooks = yield* loadPlugin()
      const signer = yield* signerFor(hooks)
      const model = copilotModel({ id: "gpt-4.1", url: server.url.origin, endpoint: "chat" })
      const headers = yield* preparedHeaders(hooks, model)

      yield* drive({
        model,
        provider: copilotProvider(signer),
        auth: AUTH,
        messages: [{ role: "user", content: "hello" }],
        tools: noopTool,
        activeTools: SessionPromptCapture.offeredToolNames(noopTool),
        headers,
      })
      yield* Effect.promise(() => hooks.dispose?.() ?? Promise.resolve())

      expectExchangeRequest(captured.seen)
      const sent = requestAt(captured.seen, "/chat/completions")
      expect(sent.headers["authorization"]).toBe(`Bearer ${SESSION}`)
      // The native Anthropic route would send this one; the signer deletes it.
      expect(sent.headers["x-api-key"]).toBeUndefined()
      // From `chat.headers`, which only reaches the wire if the runtime
      // forwards the prepared headers.
      expect(sent.headers["x-github-api-version"]).toBe(API_VERSION)
      // From the signer, read off the BODY it was handed.
      expect(sent.headers["openai-intent"]).toBe("conversation-edits")
      expect(sent.headers["x-initiator"]).toBe("user")
      expect(sent.headers["copilot-vision-request"]).toBeUndefined()
      expect((sent.body["tools"] as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toEqual([
        "_noop",
      ])
    }),
  )

  it.live("marks a replayed tool turn as agent-initiated and an image turn as vision", () =>
    Effect.gen(function* () {
      const captured = captureServer(() =>
        sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
      )
      using server = captured.server
      const hooks = yield* loadPlugin()
      const signer = yield* signerFor(hooks)
      const model = copilotModel({ id: "gpt-4.1", url: server.url.origin, endpoint: "chat" })

      const replay: ModelMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this picture?" },
            { type: "file", mediaType: "image/png", data: "aGVsbG8=" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "a.png" } }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "read",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
      ]

      yield* drive({
        model,
        provider: copilotProvider(signer),
        auth: AUTH,
        messages: replay,
        tools: {},
        headers: yield* preparedHeaders(hooks, model),
      })
      yield* Effect.promise(() => hooks.dispose?.() ?? Promise.resolve())

      const sent = requestAt(captured.seen, "/chat/completions")
      // Last message is a tool result, not a user turn: agent-initiated.
      expect(sent.headers["x-initiator"]).toBe("agent")
      // The image the signer found has to really be on the wire as one.
      expect(sent.headers["copilot-vision-request"]).toBe("true")
      const first = (sent.body["messages"] as Array<{ content: Array<{ type: string }> }>)[0]!
      expect(first.content.map((part) => part.type)).toEqual(["text", "image_url"])
    }),
  )

  it.live("Copilot's billed amount reaches step-finish, and the session prices the turn from it", () =>
    Effect.gen(function* () {
      const captured = captureServer(() =>
        sse([
          {
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 11_774, completion_tokens: 39, total_tokens: 11_813 },
            copilot_usage: { total_nano_aiu: NANO_AIU },
          },
        ]),
      )
      using server = captured.server
      const hooks = yield* loadPlugin()
      const signer = yield* signerFor(hooks)
      const model = copilotModel({ id: "gpt-4.1", url: server.url.origin, endpoint: "chat" })

      const events = yield* drive({
        model,
        provider: copilotProvider(signer),
        auth: AUTH,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        headers: {},
      })
      yield* Effect.promise(() => hooks.dispose?.() ?? Promise.resolve())

      const finish = stepFinish(events)
      expect(finish?.providerMetadata?.["copilot"]).toEqual({ totalNanoAiu: NANO_AIU })
      // Copilot bills in AIU, so the token arithmetic is NOT the answer: with a
      // zero-cost model the fallback would price this turn at 0.
      expect(
        SessionNs.getUsage({
          model,
          usage: finish?.usage ?? new Usage({}),
          metadata: finish?.providerMetadata,
        }).cost,
      ).toBe(0.04473525)
    }),
  )

  it.live("a garbled billed amount is dropped rather than priced", () =>
    Effect.gen(function* () {
      const captured = captureServer(() =>
        sse([
          {
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            copilot_usage: { total_nano_aiu: -1 },
          },
        ]),
      )
      using server = captured.server
      const hooks = yield* loadPlugin()
      const signer = yield* signerFor(hooks)

      const events = yield* drive({
        model: copilotModel({ id: "gpt-4.1", url: server.url.origin, endpoint: "chat" }),
        provider: copilotProvider(signer),
        auth: AUTH,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        headers: {},
      })
      yield* Effect.promise(() => hooks.dispose?.() ?? Promise.resolve())

      // Same guard as the AI SDK path's `copilotTotalNanoAiu`: a negative or
      // non-finite amount costs the turn its billed figure, not a nonsense cost.
      expect(stepFinish(events)?.providerMetadata?.["copilot"]).toBeUndefined()
    }),
  )

  it.live("a refused exchange falls back to the GitHub token on the chat call, without throwing", () =>
    Effect.gen(function* () {
      let tokenRequests = 0
      let chatAuthorization: string | undefined
      using server = Bun.serve({
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname === COPILOT_TOKEN_PATH) {
            tokenRequests++
            return new Response("boom", { status: 500 })
          }
          chatAuthorization = request.headers.get("authorization") ?? undefined
          return new Response("{}", { status: 200 })
        },
      })
      useTokenFixture(server.url.origin)
      const hooks = yield* loadPlugin()
      const signer = yield* signerFor(hooks)

      const response = yield* Effect.promise(() => signer(new URL("/chat/completions", server.url), { headers: {} }))
      yield* Effect.promise(() => hooks.dispose?.() ?? Promise.resolve())

      expect(tokenRequests).toBe(1)
      expect(response.status).toBe(200)
      expect(chatAuthorization).toBe(`Bearer ${TOKEN}`)
    }),
  )

  it.live("two concurrent requests share one exchange call (single flight)", () =>
    Effect.gen(function* () {
      let tokenRequests = 0
      let chatRequests = 0
      using server = Bun.serve({
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname === COPILOT_TOKEN_PATH) {
            tokenRequests++
            return Response.json({ token: SESSION, expires_at: Math.floor(Date.now() / 1000) + 1800 })
          }
          chatRequests++
          return new Response("{}", { status: 200 })
        },
      })
      useTokenFixture(server.url.origin)
      const hooks = yield* loadPlugin()
      const signer = yield* signerFor(hooks)

      yield* Effect.promise(() =>
        Promise.all([
          signer(new URL("/chat/completions", server.url), { headers: {} }),
          signer(new URL("/chat/completions", server.url), { headers: {} }),
        ]),
      )
      yield* Effect.promise(() => hooks.dispose?.() ?? Promise.resolve())

      expect(tokenRequests).toBe(1)
      expect(chatRequests).toBe(2)
    }),
  )
})

describe("session.llm-native.copilot responses wire", () => {
  it.live("gpt-5.4 lands on /responses, signed, and its billed amount survives", () =>
    Effect.gen(function* () {
      const captured = captureServer(() =>
        sse([
          { type: "response.output_text.delta", item_id: "msg_1", delta: "ok" },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              usage: { input_tokens: 12, output_tokens: 3 },
              copilot_usage: { total_nano_aiu: NANO_AIU },
            },
          },
        ]),
      )
      using server = captured.server
      const hooks = yield* loadPlugin()
      const signer = yield* signerFor(hooks)
      const model = copilotModel({ id: "gpt-5.4", url: server.url.origin, endpoint: "responses" })
      const options = yield* preparedOptions(hooks, model)

      const events = yield* drive({
        model,
        provider: copilotProvider(signer),
        auth: AUTH,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        providerOptions: options.options,
        maxOutputTokens: options.maxOutputTokens,
        headers: yield* preparedHeaders(hooks, model),
      })
      yield* Effect.promise(() => hooks.dispose?.() ?? Promise.resolve())

      expectExchangeRequest(captured.seen)
      const sent = requestAt(captured.seen, "/responses")
      expect(sent.headers["authorization"]).toBe(`Bearer ${SESSION}`)
      expect(sent.headers["x-github-api-version"]).toBe(API_VERSION)
      expect(sent.headers["openai-intent"]).toBe("conversation-edits")
      expect(sent.headers["x-initiator"]).toBe("user")
      // `chat.params` drops maxOutputTokens for gpt ids, and the plugin's
      // "copilot"-keyed store:false has to arrive on the OpenAI namespace.
      expect(sent.body["max_output_tokens"]).toBeUndefined()
      expect(sent.body["store"]).toBe(false)
      expect(stepFinish(events)?.providerMetadata?.["copilot"]).toEqual({ totalNanoAiu: NANO_AIU })
    }),
  )
})

describe("session.llm-native.copilot messages shim", () => {
  const shimModel = (url: string) =>
    copilotModel({ id: "claude-sonnet-4.6", url: `${url}/v1`, npm: "@ai-sdk/anthropic" })

  it.live("the signer's bearer replaces the Anthropic x-api-key, and the billed amount survives", () =>
    Effect.gen(function* () {
      const captured = captureServer(() =>
        sse([
          { type: "message_start", message: { usage: { input_tokens: 5 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 2 },
            copilot_usage: { total_nano_aiu: NANO_AIU },
          },
        ]),
      )
      using server = captured.server
      const hooks = yield* loadPlugin()
      const signer = yield* signerFor(hooks)
      const model = shimModel(server.url.origin)

      const events = yield* drive({
        model,
        provider: copilotProvider(signer),
        auth: AUTH,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        maxOutputTokens: 1024,
        headers: yield* preparedHeaders(hooks, model),
      })
      yield* Effect.promise(() => hooks.dispose?.() ?? Promise.resolve())

      expectExchangeRequest(captured.seen)
      const sent = requestAt(captured.seen, "/v1/messages")
      // Anthropic.configure installs `x-api-key`; the signer deletes it and
      // sets the bearer. Both halves matter: the shim rejects either mistake.
      expect(sent.headers["x-api-key"]).toBeUndefined()
      expect(sent.headers["authorization"]).toBe(`Bearer ${SESSION}`)
      expect(sent.headers["x-github-api-version"]).toBe(API_VERSION)
      expect(sent.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14")
      expect(stepFinish(events)?.providerMetadata?.["copilot"]).toEqual({ totalNanoAiu: NANO_AIU })
    }),
  )

  it.effect("the plugin's toolStreaming=false strips eager_input_streaming from the shim body", () =>
    Effect.gen(function* () {
      const model = shimModel("https://api.githubcopilot.com")
      const tools = {
        read: { description: "Read a file.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      }
      const prepare = (providerOptions?: Record<string, Record<string, unknown>>) =>
        LLMClient.prepare<{ tools?: ReadonlyArray<{ eager_input_streaming?: boolean }> }>(
          LLMNative.request({ model, messages: [{ role: "user", content: "hi" }], tools, providerOptions }),
        )

      // The field IS emitted by default — this is not a vacuous assertion.
      const bare = yield* prepare()
      expect(bare.body.tools?.map((tool) => tool.eager_input_streaming)).toEqual([true])

      const hooks = yield* loadPlugin()
      const options = yield* preparedOptions(hooks, model)
      expect(options.options["toolStreaming"]).toBe(false)
      const lowered = LLMNativeRuntime.nativeOptions(model, options.options)
      const stripped = yield* prepare(lowered.providerOptions)
      expect(stripped.body.tools?.map((tool) => tool.eager_input_streaming)).toEqual([undefined])
      yield* Effect.promise(() => hooks.dispose?.() ?? Promise.resolve())
    }),
  )
})
