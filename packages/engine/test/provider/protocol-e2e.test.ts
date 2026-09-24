// origami_change: a provider declared ONLY by wire protocol and base URL must
// reach that URL, on the runtime the engine picks for it, with the auth header
// that protocol uses.
//
// Nothing here is stubbed above the wire: a real server on 127.0.0.1 records
// the method, path, headers and body of the request the engine sent, so a
// resolution that looks right in `provider.options` but never reaches the
// socket still fails.
//
// The two default routes are both covered on purpose:
//   openai-chat        -> the NATIVE runtime (native-route.ts: on by default)
//   anthropic-messages -> the AI SDK runtime (that family is still off)
// and a third test forces anthropic onto native, so the declared URL is proven
// on BOTH runtimes. The remaining three protocols are proven as far as the
// socket: request line, path and auth header.

import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import { SessionV1 } from "@origami/core/v1/session"
import { Effect, Stream } from "effect"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { LLM } from "@/session/llm"
import { Provider } from "@/provider/provider"
import { SessionID, MessageID } from "@/session/schema"
import type { Agent } from "@/agent/agent"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node])))

type Capture = {
  url: URL
  method: string
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{ response: Response; resolve: (value: Capture) => void }>,
  seen: [] as Capture[],
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    // Loopback only. A test must never open a port the rest of the network
    // can reach.
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      const body = await req.json().catch(() => ({}))
      const capture = { url, method: req.method, headers: req.headers, body: body as Record<string, unknown> }
      state.seen.push(capture)
      const next = state.queue.shift()
      if (!next) return new Response('{"error":"unexpected request"}', { status: 500 })
      next.resolve(capture)
      return next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
  state.seen.length = 0
})

afterAll(() => {
  void state.server?.stop(true)
})

const origin = () => state.server!.url.origin

function expectRequest(response: Response) {
  let resolve!: (value: Capture) => void
  const promise = new Promise<Capture>((r) => {
    resolve = r
  })
  state.queue.push({ response, resolve })
  return promise
}

function sse(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`)
  if (includeDone) lines.push("data: [DONE]")
  return new Response(lines.join("\n\n") + "\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

const anthropicStream = () =>
  sse([
    { type: "message_start", message: { id: "msg-1", model: "my-model", usage: { input_tokens: 3 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 3, output_tokens: 1 },
    },
    { type: "message_stop" },
  ])

const openaiChatStream = () =>
  sse(
    [
      { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
      { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: { content: "ok" } }] },
      { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] },
    ],
    true,
  )

/** A provider the user could paste into origami.json: a protocol and a URL. */
function declaredProvider(protocol: string, baseURL: string) {
  return {
    enabled_providers: ["mine"],
    provider: {
      mine: {
        name: "Mine",
        protocol,
        api: baseURL,
        models: {
          "my-model": {
            id: "my-model",
            name: "My Model",
            tool_call: true,
            limit: { context: 100_000, output: 4_000 },
            cost: { input: 0, output: 0 },
          },
        },
        options: { apiKey: "sk-declared" },
      },
    },
  } as any
}

const step = () =>
  Effect.gen(function* () {
    const model = yield* Provider.use.getModel(ProviderV2.ID.make("mine"), ModelV2.ID.make("my-model"))
    const sessionID = SessionID.make("session-protocol")
    const agent = {
      name: "test",
      mode: "primary",
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    } satisfies Agent.Info
    const user = {
      id: MessageID.make("msg_user_protocol"),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: ProviderV2.ID.make("mine"), modelID: ModelV2.ID.make("my-model") },
    } satisfies SessionV1.User

    yield* LLM.Service.use((svc) =>
      svc
        .stream({
          user,
          sessionID,
          model,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })
        .pipe(Stream.runDrain),
    )
    return model
  })

it.instance(
  "a config-declared anthropic-messages provider reaches its own URL with x-api-key",
  () =>
    Effect.gen(function* () {
      const request = expectRequest(anthropicStream())
      const model = yield* step()
      const capture = yield* Effect.promise(() => request)

      // The declared protocol picked the Anthropic client, so the wire is the
      // Messages API on the DECLARED host, not api.anthropic.com.
      expect(model.api.npm).toBe("@ai-sdk/anthropic")
      expect(capture.url.origin).toBe(origin())
      expect(capture.url.pathname.endsWith("/messages")).toBe(true)
      // Anthropic's key header, not a bearer.
      expect(capture.headers.get("x-api-key")).toBe("sk-declared")
      expect(capture.headers.get("authorization")).toBeNull()
      expect(capture.body["model"]).toBe("my-model")
      expectUserSaidHello(capture)
    }),
  { config: () => declaredProvider("anthropic-messages", `${origin()}/v1`) },
)

it.instance(
  "a config-declared openai-chat provider reaches its own URL with a bearer token",
  () =>
    Effect.gen(function* () {
      const request = expectRequest(openaiChatStream())
      const model = yield* step()
      const capture = yield* Effect.promise(() => request)

      expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(capture.url.origin).toBe(origin())
      expect(capture.url.pathname.endsWith("/chat/completions")).toBe(true)
      expect(capture.headers.get("authorization")).toBe("Bearer sk-declared")
      expect(capture.body["model"]).toBe("my-model")
      expectUserSaidHello(capture)
    }),
  { config: () => declaredProvider("openai-chat", `${origin()}/v1`) },
)

// The runtime is chosen per family, and the family list is read when the flags
// layer is BUILT - before the test body runs - so the switch lives in a hook,
// not in the body.
describe("native runtime", () => {
  let previous: string | undefined

  beforeAll(() => {
    previous = process.env["ORIGAMI_NATIVE_LLM_FAMILIES"]
    process.env["ORIGAMI_NATIVE_LLM_FAMILIES"] = "anthropic"
  })

  afterAll(() => {
    if (previous === undefined) delete process.env["ORIGAMI_NATIVE_LLM_FAMILIES"]
    else process.env["ORIGAMI_NATIVE_LLM_FAMILIES"] = previous
  })

  it.instance(
    "the declared URL and key reach the wire on the native runtime too",
    () =>
      Effect.gen(function* () {
        const request = expectRequest(anthropicStream())
        yield* step()
        const capture = yield* Effect.promise(() => request)

        expect(capture.url.origin).toBe(origin())
        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(capture.headers.get("x-api-key")).toBe("sk-declared")
        expectUserSaidHello(capture)
      }),
    { config: () => declaredProvider("anthropic-messages", `${origin()}/v1`) },
  )
})

// The two protocols above are proven end to end. These two are proven only as
// far as the socket: the declared URL and the declared key must reach the
// endpoint. The reply is deliberately not a valid stream, so the turn fails
// after the request - which is enough for the claim being made here.
for (const [protocol, path, header] of [
  ["openai-responses", "/responses", "authorization"],
  ["gemini", ":streamGenerateContent", "x-goog-api-key"],
  ["bedrock-converse", "/converse", "authorization"],
] as const) {
  it.instance(
    `a config-declared ${protocol} provider reaches its own URL`,
    () =>
      Effect.gen(function* () {
        yield* step().pipe(Effect.exit)

        const capture = state.seen.at(0)
        expect(capture).toBeDefined()
        expect(capture!.url.origin).toBe(origin())
        expect(capture!.url.pathname).toContain(path)
        expect(capture!.headers.get(header)).toContain("sk-declared")
      }),
    { config: () => declaredProvider(protocol, `${origin()}/v1`) },
  )
}

/**
 * The prompt has to be IN the body, whatever cache markers wrap it. The system
 * prompt sits in `messages` on the OpenAI protocols and in its own field on
 * Anthropic, so this looks for the user turn rather than at an index.
 */
function expectUserSaidHello(capture: Capture) {
  const messages = capture.body["messages"] as Array<{ role: string }> | undefined
  expect(Array.isArray(messages)).toBe(true)
  const user = messages!.filter((message) => message.role === "user")
  expect(user.length).toBe(1)
  expect(JSON.stringify(user)).toContain("Hello")
}
