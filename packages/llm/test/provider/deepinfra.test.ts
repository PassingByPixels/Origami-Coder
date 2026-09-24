import { describe, expect } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../../src"
import { LLMClient } from "../../src/route"
import * as DeepInfra from "../../src/providers/deepinfra"
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

describe("DeepInfra", () => {
  it.effect("prepares DeepInfra models through the OpenAI-compatible Chat route with the default base URL", () =>
    Effect.gen(function* () {
      const model = DeepInfra.configure({ apiKey: "test-key" }).model("meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8")

      expect(model).toMatchObject({
        id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
        provider: "deepinfra",
        route: { id: "openai-compatible-chat" },
      })
      expect(model.route.endpoint.baseURL).toBe("https://api.deepinfra.com/v1/openai")

      const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "Say hello." }))

      expect(prepared.route).toBe("openai-compatible-chat")
      expect(prepared.body).toMatchObject({
        model: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      })
    }),
  )

  it.effect("sends bearer auth from the apiKey option to the default endpoint", () =>
    Effect.gen(function* () {
      const model = DeepInfra.configure({ apiKey: "test-key" }).model("meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8")

      yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.deepinfra.com/v1/openai/chat/completions")
              expect(web.headers.get("authorization")).toBe("Bearer test-key")
              return input.respond(successBody(), { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("resolves the API key from DEEPINFRA_API_KEY when no apiKey option is given", () =>
    Effect.gen(function* () {
      const model = DeepInfra.configure().model("meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8")

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
        withEnv({ DEEPINFRA_API_KEY: "env-key" }),
      )
    }),
  )

  it.effect("honors a baseURL override", () =>
    Effect.gen(function* () {
      const model = DeepInfra.configure({
        apiKey: "test-key",
        baseURL: "https://custom.deepinfra.test/v1",
      }).model("meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8")

      expect(model.route.endpoint.baseURL).toBe("https://custom.deepinfra.test/v1")
    }),
  )
})
