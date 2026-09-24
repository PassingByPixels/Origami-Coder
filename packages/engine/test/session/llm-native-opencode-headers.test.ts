/**
 * OpenCode Go's gateway reads `x-opencode-{project,session,request,client}`
 * from every request and, from 2026-09-06, may refuse a request without
 * `x-opencode-session` ("Missing OpenCode Go Header", mail of 2026-09-03).
 * `session/llm/request.ts` `prepare` puts those headers on `prepared.headers`
 * for any provider id starting with "opencode", and BOTH runtimes receive the
 * same `prepared.headers`. This proves the NATIVE runtime carries them to the
 * wire together with our own User-Agent — the AI SDK path was never in doubt,
 * the native path had no test naming a single per-request header.
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

const goModel = (url: string): Provider.Model => ({
  id: ModelV2.ID.make("deepseek-v4-flash"),
  providerID: ProviderV2.ID.make("opencode-go"),
  api: { id: "deepseek-v4-flash", url, npm: "@ai-sdk/openai-compatible" },
  name: "DeepSeek V4 Flash",
  capabilities,
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 8_192 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

const goProvider: Provider.Info = {
  id: ProviderV2.ID.make("opencode-go"),
  name: "OpenCode Go",
  source: "config",
  env: [],
  options: { apiKey: "test-go-key" },
  models: {},
}

type Captured = { path: string; headers: Record<string, string> }

const captureServer = () => {
  const seen: Captured[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.text()
      seen.push({ path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers.entries()) })
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  return { server, seen }
}

describe("session.llm-native.opencode headers", () => {
  it.live("the x-opencode-* headers and our User-Agent reach the wire on the native runtime", () =>
    Effect.gen(function* () {
      const captured = captureServer()
      using server = captured.server
      const model = goModel(server.url.origin)

      const llmClient = yield* LLMClient.Service
      const native = LLMNativeRuntime.stream({
        model,
        provider: goProvider,
        auth: undefined,
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        // The shape `prepare` builds for an "opencode*" provider id.
        headers: {
          "x-opencode-project": "prj_test",
          "x-opencode-session": "ses_test",
          "x-opencode-request": "usr_test",
          "x-opencode-client": "vscode",
          "User-Agent": "origami/test",
        },
        abort: new AbortController().signal,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)
      yield* native.stream.pipe(Stream.runDrain)

      expect(captured.seen).toHaveLength(1)
      const sent = captured.seen[0]!
      expect(sent.path).toBe("/chat/completions")
      expect(sent.headers["x-opencode-session"]).toBe("ses_test")
      expect(sent.headers["x-opencode-project"]).toBe("prj_test")
      expect(sent.headers["x-opencode-request"]).toBe("usr_test")
      expect(sent.headers["x-opencode-client"]).toBe("vscode")
      expect(sent.headers["user-agent"]).toBe("origami/test")
      expect(sent.headers["authorization"]).toBe("Bearer test-go-key")
    }),
  )
})
