import { describe, expect } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../../src"
import { LLMClient } from "../../src/route"
import * as Mistral from "../../src/providers/mistral"
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

describe("Mistral", () => {
  it.effect("prepares Mistral models through the OpenAI-compatible Chat route with the default base URL", () =>
    Effect.gen(function* () {
      const model = Mistral.configure({ apiKey: "test-key" }).model("mistral-large-latest")

      expect(model).toMatchObject({
        id: "mistral-large-latest",
        provider: "mistral",
        route: { id: "openai-compatible-chat" },
      })
      expect(model.route.endpoint.baseURL).toBe("https://api.mistral.ai/v1")

      const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "Say hello." }))

      expect(prepared.route).toBe("openai-compatible-chat")
      expect(prepared.body).toMatchObject({
        model: "mistral-large-latest",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      })
    }),
  )

  it.effect("sends bearer auth from the apiKey option to the default endpoint", () =>
    Effect.gen(function* () {
      const model = Mistral.configure({ apiKey: "test-key" }).model("mistral-large-latest")

      yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.mistral.ai/v1/chat/completions")
              expect(web.headers.get("authorization")).toBe("Bearer test-key")
              return input.respond(successBody(), { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("resolves the API key from MISTRAL_API_KEY when no apiKey option is given", () =>
    Effect.gen(function* () {
      const model = Mistral.configure().model("mistral-large-latest")

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
        withEnv({ MISTRAL_API_KEY: "env-key" }),
      )
    }),
  )

  it.effect("honors a baseURL override", () =>
    Effect.gen(function* () {
      const model = Mistral.configure({
        apiKey: "test-key",
        baseURL: "https://custom.mistral.test/v1",
      }).model("mistral-large-latest")

      expect(model.route.endpoint.baseURL).toBe("https://custom.mistral.test/v1")
    }),
  )
})
