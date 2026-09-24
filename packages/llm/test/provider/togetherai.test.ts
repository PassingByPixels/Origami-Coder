import { describe, expect } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../../src"
import { LLMClient } from "../../src/route"
import * as TogetherAI from "../../src/providers/togetherai"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const withEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

const successBody = () =>
  sseEvents({
    id: "chatcmpl_fixture",
    choices: [{ delta: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
    usage: null,
  })

describe("TogetherAI", () => {
  it.effect("prepares TogetherAI models through the OpenAI-compatible Chat route with the default base URL", () =>
    Effect.gen(function* () {
      const model = TogetherAI.configure({ apiKey: "test-key" }).model("LiquidAI/LFM2-24B-A2B")

      expect(model).toMatchObject({
        id: "LiquidAI/LFM2-24B-A2B",
        provider: "togetherai",
        route: { id: "openai-compatible-chat" },
      })
      expect(model.route.endpoint.baseURL).toBe("https://api.together.xyz/v1")

      const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "Say hello." }))

      expect(prepared.route).toBe("openai-compatible-chat")
      expect(prepared.body).toMatchObject({
        model: "LiquidAI/LFM2-24B-A2B",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      })
    }),
  )

  it.effect("sends bearer auth from the apiKey option to the default endpoint", () =>
    Effect.gen(function* () {
      const model = TogetherAI.configure({ apiKey: "test-key" }).model("LiquidAI/LFM2-24B-A2B")

      yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.together.xyz/v1/chat/completions")
              expect(web.headers.get("authorization")).toBe("Bearer test-key")
              return input.respond(successBody(), { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("resolves the API key from TOGETHER_API_KEY when no apiKey option is given", () =>
    Effect.gen(function* () {
      const model = TogetherAI.configure().model("LiquidAI/LFM2-24B-A2B")

      yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.headers.get("authorization")).toBe("Bearer env-key")
              return input.respond(successBody(), { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
        withEnv({ TOGETHER_API_KEY: "env-key" }),
      )
    }),
  )

  it.effect("honors a baseURL override", () =>
    Effect.gen(function* () {
      const model = TogetherAI.configure({
        apiKey: "test-key",
        baseURL: "https://custom.together.test/v1",
      }).model("LiquidAI/LFM2-24B-A2B")

      expect(model.route.endpoint.baseURL).toBe("https://custom.together.test/v1")
    }),
  )
})
