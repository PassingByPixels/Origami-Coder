// The ChatGPT backend refuses sampling parameters, and the strip is ENDPOINT-scoped.
//
// OWNER UAT, 0.3.82: a first message on a fresh ChatGPT sign-in answered
// "Unsupported parameter: temperature". The value came from the config's own
// `agent.build.temperature` (0.8) — and `top_p: 1` from the same block was the
// identical refusal waiting one message behind it. The built-in `title` agent's
// hardcoded 0.5 (agent/agent.ts:284) reaches the same place with no user config
// at all.
//
// WHY THE STRIP IS HERE AND NOT IN THE REQUEST LAYER. The parameter is not
// refused by the model, and not by OAuth: two LIVE recordings sent
// `temperature: 0` and got HTTP 200 —
// test/fixtures/recordings/session/native-openai-oauth-tool-loop.json (OAuth
// bearer, gpt-5.5, api.openai.com/v1/responses) and native-zen-tool-loop.json.
// It is refused by chatgpt.com/backend-api/codex, which is the ONE endpoint this
// wrapper rewrites to. So the test that matters is a differential one: the same
// body, two destinations, one stripped and one not. A request-layer or
// chat.params fix passes the first half and reds both cassettes.

import { describe, expect, test } from "bun:test"
import { CodexAuthPlugin, withoutSampling } from "../../src/plugin/openai/codex"

const oauth = { type: "oauth" as const, refresh: "rt", access: "access-token", expires: Date.now() + 3_600_000 }

const pluginInput = {
  client: { auth: { async set() {} } },
  project: {},
  directory: "",
  worktree: "",
  experimental_workspace: { register() {} },
  serverUrl: new URL("https://example.com"),
  $: {},
} as never

/** A body shaped like the one @ai-sdk/openai's responses model builds. */
const requestBody = () =>
  JSON.stringify({
    model: "gpt-5.4",
    temperature: 0.8,
    top_p: 1,
    input: [{ role: "user", content: "hi" }],
    instructions: "be brief",
    stream: true,
  })

describe("withoutSampling", () => {
  test("drops temperature and top_p, and NOTHING else", () => {
    const out = JSON.parse(withoutSampling(requestBody()) as string)
    expect(out.temperature).toBeUndefined()
    expect(out.top_p).toBeUndefined()
    expect(out).toEqual({
      model: "gpt-5.4",
      input: [{ role: "user", content: "hi" }],
      instructions: "be brief",
      stream: true,
    })
  })

  test("a body carrying neither is returned untouched, byte for byte", () => {
    const body = JSON.stringify({ model: "gpt-5.4", input: [] })
    expect(withoutSampling(body)).toBe(body)
  })

  test("a non-JSON or non-string body is passed straight through", () => {
    // Never throw inside a fetch wrapper: a multipart upload, a stream, or a
    // body this plugin does not understand must reach the server unaltered.
    expect(withoutSampling("not json at all")).toBe("not json at all")
    expect(withoutSampling(JSON.stringify([1, 2, 3]))).toBe("[1,2,3]")
    expect(withoutSampling(undefined)).toBeUndefined()
    expect(withoutSampling(null)).toBeNull()
    const stream = new Uint8Array([1, 2, 3])
    expect(withoutSampling(stream)).toBe(stream)
  })
})

describe("the codex fetch wrapper, end to end", () => {
  test("strips sampling for the REWRITTEN codex endpoint but not for anything else", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = []

    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        seen.push({ path: url.pathname, body: JSON.parse(await request.text()) })
        return new Response("{}", { status: 200 })
      },
    })

    const hooks = await CodexAuthPlugin(pluginInput, {
      codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).toString(),
    })
    const loaded = await hooks.auth!.loader!(async () => oauth as never, {} as never)

    // 1. A Responses call: the wrapper rewrites the URL to the ChatGPT backend.
    await loaded.fetch!("https://api.openai.com/v1/responses", { method: "POST", body: requestBody() })
    // 2. A path the wrapper does NOT rewrite, pointed at the same local server so
    //    the assertion costs no network. This stands in for every request that
    //    still reaches a normal OpenAI-shaped endpoint.
    await loaded.fetch!(new URL("/v1/some-other-route", server.url).toString(), {
      method: "POST",
      body: requestBody(),
    })

    const codex = seen.find((r) => r.path === "/backend-api/codex/responses")
    const plain = seen.find((r) => r.path === "/v1/some-other-route")

    expect(codex, "the responses call was not rewritten to the codex endpoint").toBeDefined()
    expect(codex!.body["temperature"]).toBeUndefined()
    expect(codex!.body["top_p"]).toBeUndefined()
    // The rest of the request has to survive intact — a strip that mangles the
    // body is worse than the 400 it replaces.
    expect(codex!.body["model"]).toBe("gpt-5.4")
    expect(codex!.body["instructions"]).toBe("be brief")
    expect(codex!.body["input"]).toEqual([{ role: "user", content: "hi" }])

    expect(plain, "the non-rewritten request never arrived").toBeDefined()
    expect(plain!.body["temperature"], "sampling must survive where it is accepted").toBe(0.8)
    expect(plain!.body["top_p"]).toBe(1)

    await hooks.dispose?.()
  })
})

describe("the ChatGPT-backend catalog", () => {
  test("gpt-5.3-codex-spark is refused, and the other three still pass", async () => {
    // "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a
    // ChatGPT account" — the backend, on the owner's first message.
    const hooks = await CodexAuthPlugin(pluginInput)
    const limit = { context: 128_000, input: 96_000, output: 32_000 }
    const provider = {
      models: Object.fromEntries(
        ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"].map((id) => [
          id,
          { id, api: { id }, limit, cost: {}, options: {} },
        ]),
      ),
    }

    const models = await hooks.provider!.models!(provider as never, { auth: { type: "oauth" } } as never)

    expect(models["gpt-5.3-codex-spark"]).toBeUndefined()
    expect(Object.keys(models).sort()).toEqual(["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"])
  })
})
