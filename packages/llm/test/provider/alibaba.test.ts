import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Ref } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../../src"
import { LLMClient } from "../../src/route"
import * as Alibaba from "../../src/providers/alibaba"
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
    const model = Alibaba.configure().model("qwen3-omni-flash")
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

describe("Alibaba", () => {
  it.effect("prepares Alibaba models through the OpenAI-compatible Chat route with the default base URL", () =>
    Effect.gen(function* () {
      const model = Alibaba.configure({ apiKey: "test-key" }).model("qwen3-omni-flash")

      expect(model).toMatchObject({
        id: "qwen3-omni-flash",
        provider: "alibaba",
        route: { id: "openai-compatible-chat" },
      })
      expect(model.route.endpoint.baseURL).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1")

      const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "Say hello." }))

      expect(prepared.route).toBe("openai-compatible-chat")
      expect(prepared.body).toMatchObject({
        model: "qwen3-omni-flash",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      })
    }),
  )

  it.effect("sends bearer auth from the apiKey option to the default endpoint", () =>
    Effect.gen(function* () {
      const model = Alibaba.configure({ apiKey: "test-key" }).model("qwen3-omni-flash")

      yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions")
              expect(web.headers.get("authorization")).toBe("Bearer test-key")
              return input.respond(successBody(), { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("resolves the API key from the catalog's DASHSCOPE_API_KEY when no apiKey option is given", () =>
    Effect.gen(function* () {
      expect(yield* authHeaderFor({ DASHSCOPE_API_KEY: "env-key" })).toBe("Bearer env-key")
    }),
  )

  it.effect("falls back to ALIBABA_API_KEY (the @ai-sdk/alibaba package default) when DASHSCOPE_API_KEY is unset", () =>
    Effect.gen(function* () {
      expect(yield* authHeaderFor({ ALIBABA_API_KEY: "fallback-key" })).toBe("Bearer fallback-key")
    }),
  )

  it.effect("honors a baseURL override", () =>
    Effect.gen(function* () {
      const model = Alibaba.configure({
        apiKey: "test-key",
        baseURL: "https://custom.alibaba.test/v1",
      }).model("qwen3-omni-flash")

      expect(model.route.endpoint.baseURL).toBe("https://custom.alibaba.test/v1")
    }),
  )
})
