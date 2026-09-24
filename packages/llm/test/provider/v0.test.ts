import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Ref } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../../src"
import { LLMClient } from "../../src/route"
import * as V0 from "../../src/providers/v0"
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

const authHeaderFor = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const model = V0.configure().model("v0-1.0-md")
    const seen = yield* Ref.make<string | null>(null)

    yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            yield* Ref.set(seen, web.headers.get("authorization"))
            return input.respond(successBody(), { headers: { "content-type": "text/event-stream" } })
          }),
        ),
      ),
      withEnv(env),
    )

    return yield* Ref.get(seen)
  })

describe("V0", () => {
  it.effect("prepares v0 models through the OpenAI-compatible Chat route with the default base URL", () =>
    Effect.gen(function* () {
      const model = V0.configure({ apiKey: "test-key" }).model("v0-1.0-md")

      expect(model).toMatchObject({
        id: "v0-1.0-md",
        provider: "v0",
        route: { id: "openai-compatible-chat" },
      })
      expect(model.route.endpoint.baseURL).toBe("https://api.v0.dev/v1")

      const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "Say hello." }))

      expect(prepared.route).toBe("openai-compatible-chat")
      expect(prepared.body).toMatchObject({
        model: "v0-1.0-md",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      })
    }),
  )

  it.effect("sends bearer auth from the apiKey option to the default endpoint", () =>
    Effect.gen(function* () {
      const model = V0.configure({ apiKey: "test-key" }).model("v0-1.0-md")

      yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.v0.dev/v1/chat/completions")
              expect(web.headers.get("authorization")).toBe("Bearer test-key")
              return input.respond(successBody(), { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("resolves the API key from the catalog's V0_API_KEY when no apiKey option is given", () =>
    Effect.gen(function* () {
      expect(yield* authHeaderFor({ V0_API_KEY: "env-key" })).toBe("Bearer env-key")
    }),
  )

  it.effect("falls back to VERCEL_API_KEY (the @ai-sdk/vercel package default) when V0_API_KEY is unset", () =>
    Effect.gen(function* () {
      expect(yield* authHeaderFor({ VERCEL_API_KEY: "fallback-key" })).toBe("Bearer fallback-key")
    }),
  )

  it.effect("honors a baseURL override", () =>
    Effect.gen(function* () {
      const model = V0.configure({
        apiKey: "test-key",
        baseURL: "https://custom.v0.test/v1",
      }).model("v0-1.0-md")

      expect(model.route.endpoint.baseURL).toBe("https://custom.v0.test/v1")
    }),
  )
})
