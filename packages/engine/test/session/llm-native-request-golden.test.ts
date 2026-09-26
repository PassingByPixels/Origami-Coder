// The request the native runtime builds, pinned per route (t-vs5p1y).
//
// `LLMNativeRuntime.stream` builds the `@origami/llm` request and hands it to
// the client. The per-step cost of that build is being cut (one construction
// instead of two); the request must not change. A stub client captures the
// request, `LLMClient.prepare` compiles it, and the route's transport renders
// the body it would send. Both are recorded as SHA-256; the recording was made
// on master f9d49f6b70, before the change.
//
// Record again (only when a byte change is intended and understood):
//   GOLDEN_RECORD=1 bun test test/session/llm-native-request-golden.test.ts

import { afterEach, describe, expect } from "bun:test"
import { LLMEvent, type LLMRequest } from "@origami/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor, type LLMClientShape } from "@origami/llm/route"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "path"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { ClaudeSubscription } from "@/provider/claude-subscription"
import type { Provider } from "@/provider/provider"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)), WebSocketExecutor.layer),
    ),
  ),
)

const GOLDEN = path.join(import.meta.dir, "fixtures", "llm-native-request-golden.json")

const model = (input: { providerID: string; npm: string; id: string; url: string }): Provider.Model => ({
  id: ModelV2.ID.make(input.id),
  providerID: ProviderV2.ID.make(input.providerID),
  api: { id: input.id, url: input.url, npm: input.npm },
  name: input.id,
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
  limit: { context: 200_000, input: 200_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

const provider = (id: string): Provider.Info => ({
  id: ProviderV2.ID.make(id),
  name: id,
  source: "config",
  env: [],
  options: { apiKey: "test-key" },
  models: {},
})

/** Every route the native runtime takes today, with the facade it resolves to. */
const ROUTES = [
  { name: "openai-compatible", providerID: "vllm", npm: "@ai-sdk/openai-compatible", id: "glm-5.3", url: "http://127.0.0.1:9/v1" },
  { name: "anthropic", providerID: "anthropic", npm: "@ai-sdk/anthropic", id: "claude-sonnet-4-5", url: "https://api.anthropic.test/v1" },
  { name: "openai-responses", providerID: "openai", npm: "@ai-sdk/openai", id: "gpt-5-mini", url: "https://api.openai.test/v1" },
  { name: "copilot-chat", providerID: "github-copilot", npm: "@ai-sdk/github-copilot", id: "gpt-4.1", url: "https://api.githubcopilot.test" },
  { name: "copilot-responses", providerID: "github-copilot", npm: "@ai-sdk/github-copilot", id: "gpt-5", url: "https://api.githubcopilot.test" },
  { name: "copilot-anthropic", providerID: "github-copilot", npm: "@ai-sdk/anthropic", id: "claude-sonnet-4.5", url: "https://api.githubcopilot.test/v1" },
  { name: "openrouter", providerID: "openrouter", npm: "@openrouter/ai-sdk-provider", id: "anthropic/claude-sonnet-4.5", url: "https://openrouter.test/api/v1" },
  { name: "xai", providerID: "xai", npm: "@ai-sdk/xai", id: "grok-4", url: "https://api.x.test/v1" },
  { name: "claude-cli", providerID: ClaudeSubscription.PROVIDER_ID, npm: ClaudeSubscription.NPM, id: "claude-sonnet-4-5", url: "" },
] as const

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

/** A settled history with every content kind the session layer sends. */
const MESSAGES: ModelMessage[] = [
  { role: "system", content: "You are a careful engineer." },
  {
    role: "user",
    content: [
      { type: "text", text: "Look at this screen." },
      { type: "file", mediaType: "image/png", filename: "screen.png", data: `data:image/png;base64,${IMAGE}` },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "The screen shows a form.", providerOptions: { anthropic: { signature: "sig-1" } } },
      { type: "text", text: "Reading the file." },
      { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: { query: "form.ts" } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call-1", toolName: "lookup", output: { type: "text", value: "[took 1.3 s]\nexport const form = 1" } }],
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Now writing a note." },
      { type: "tool-call", toolCallId: "call-2", toolName: "write_note", input: { text: "Ünïcödé ✓" } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call-2", toolName: "write_note", output: { type: "json", value: { ok: true } } }],
  },
  { role: "assistant", content: [{ type: "text", text: "Done." }] },
  { role: "user", content: "Thanks. Anything else?" },
]

const TOOLS: Record<string, Tool> = {
  lookup: tool({
    description: "Look something up",
    inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
  }),
  write_note: tool({
    description: "Write a note",
    inputSchema: jsonSchema({ type: "object", properties: { text: { type: "string" } } }),
  }),
  invalid: tool({ description: "repair only", inputSchema: jsonSchema({ type: "object" }) }),
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

/** Runs the native runtime with a stub client and renders what it would send. */
const render = (route: (typeof ROUTES)[number]) =>
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
      model: model(route),
      provider: provider(route.providerID),
      auth: undefined,
      llmClient,
      messages: MESSAGES,
      tools: TOOLS,
      activeTools: ["lookup", "write_note"],
      temperature: 0.2,
      maxOutputTokens: 4096,
      providerOptions: {},
      headers: { "x-session-affinity": "ses_golden" },
      abort: new AbortController().signal,
    })
    if (native.type === "unsupported") throw new Error(`${route.name}: ${native.reason}`)
    yield* native.stream.pipe(Stream.runDrain)
    if (!captured) throw new Error(`${route.name}: no request reached the client`)
    const prepared = yield* LLMClient.prepare<Record<string, unknown>>(captured)
    const body = JSON.stringify(prepared.body)
    const transport: unknown = yield* captured.model.route.prepareTransport(prepared.body, captured)
    const request = (transport as { request?: HttpClientRequest.HttpClientRequest }).request
    const wire = request
      ? yield* Effect.promise(async () => {
          const web = await Effect.runPromise(HttpClientRequest.toWeb(request).pipe(Effect.orDie))
          return web.text()
        })
      : undefined
    return { body: sha(body), bodyBytes: body.length, wire: wire === undefined ? null : sha(wire), tools: captured.tools.length }
  })

afterEach(() => ClaudeSubscription.resetMemo())

describe("native runtime request, per route", () => {
  it.effect("each route builds the same request as before the single-build change", () =>
    Effect.gen(function* () {
      ClaudeSubscription.setReadiness({ type: "ready", command: ["claude"] } as never)
      const current: Record<string, unknown> = {}
      for (const route of ROUTES) current[route.name] = yield* render(route)
      if (process.env.GOLDEN_RECORD) {
        mkdirSync(path.dirname(GOLDEN), { recursive: true })
        writeFileSync(GOLDEN, JSON.stringify(current, null, 2) + "\n")
      }
      // The declared tools reach every route, and the repair-only one does not.
      for (const route of ROUTES) expect((current[route.name] as { tools: number }).tools).toBe(2)
      const recorded = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) : undefined
      expect(current).toEqual(recorded)
    }),
  )
})
