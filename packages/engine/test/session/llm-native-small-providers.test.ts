/**
 * Wire proof for ONE of the nine small-provider facades (mistral), through
 * the native runtime end to end. The other eight share the exact same
 * `OpenAICompatibleChat` route (see each facade's header comment in
 * packages/llm/src/providers/), so this one fixture-server round trip stands
 * in for the shape all nine send; native-route.test.ts and native-request.ts
 * itself cover the other eight's wiring at the unit level.
 *
 * mistral is off by default (native-route.ts DEFAULTS.mistral = false), so
 * this drives LLMNativeRuntime.stream directly — the same way the
 * off-by-default Copilot wire tests do — rather than going through the
 * family-enabled gate, which is a session-level concern this lane does not
 * touch.
 */

import { describe, expect } from "bun:test"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@origami/llm/route"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { Provider } from "@/provider/provider"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)), WebSocketExecutor.layer),
    ),
  ),
)

const capabilities: Provider.Model["capabilities"] = {
  temperature: true,
  reasoning: false,
  attachment: false,
  toolcall: true,
  input: { text: true, audio: false, image: false, video: false, pdf: false },
  output: { text: true, audio: false, image: false, video: false, pdf: false },
  interleaved: false,
}

const mistralModel = (url: string): Provider.Model => ({
  id: ModelV2.ID.make("mistral-small-latest"),
  providerID: ProviderV2.ID.make("mistral"),
  api: { id: "mistral-small-latest", url, npm: "@ai-sdk/mistral" },
  name: "Mistral Small",
  capabilities,
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 32_000, input: 32_000, output: 8_192 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

const mistralProvider: Provider.Info = {
  id: ProviderV2.ID.make("mistral"),
  name: "Mistral",
  source: "config",
  env: ["MISTRAL_API_KEY"],
  options: { apiKey: "test-mistral-key" },
  models: {},
}

type Captured = { path: string; headers: Record<string, string>; body: Record<string, unknown> }

const captureServer = (respond: () => Response) => {
  const seen: Captured[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const text = await request.text()
      seen.push({
        path: new URL(request.url).pathname,
        headers: Object.fromEntries(request.headers.entries()),
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      })
      return respond()
    },
  })
  return { server, seen }
}

const sse = (chunks: ReadonlyArray<unknown>) =>
  new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })

describe("session.llm-native.small providers wire", () => {
  it.live("mistral hits <baseURL>/chat/completions with a bearer key and an OpenAI chat body", () =>
    Effect.gen(function* () {
      const captured = captureServer(() =>
        sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
      )
      using server = captured.server
      const model = mistralModel(server.url.origin)

      const llmClient = yield* LLMClient.Service
      const native = LLMNativeRuntime.stream({
        model,
        provider: mistralProvider,
        auth: undefined,
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        headers: {},
        abort: new AbortController().signal,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)
      yield* native.stream.pipe(Stream.runDrain)

      expect(captured.seen).toHaveLength(1)
      const sent = captured.seen[0]!
      expect(sent.path).toBe("/chat/completions")
      expect(sent.headers["authorization"]).toBe("Bearer test-mistral-key")
      expect(sent.body).toMatchObject({
        model: "mistral-small-latest",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      })
    }),
  )
})
