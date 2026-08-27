// origami_change: what the OpenRouter provider actually PUTS ON THE WIRE.
//
// Two claims in this repo depend on it and neither was covered by a test:
//
//   1. `session/degrade.ts`'s Knob doc says "unknown keys are spread into the
//      body verbatim". If that is true, an option key the engine has never
//      heard of - written by hand into a provider block in origami.json - is a
//      zero-code lever on the request.
//   2. `provider/transform.ts` sends a gpt-5 reasoning effort to this gateway
//      as `reasoning: { effort }`, NOT as `reasoningEffort`, because this
//      provider reads the first and treats the second as just another unknown
//      key. If that were backwards the model would silently run on its own
//      default, which from gpt-5.1 on is no reasoning at all.
//
// The fixtures are derived from the EXTERNAL thing, per docs/WORKING_ON_ORIGAMI_CODER.md
// part 6.3: the real `@openrouter/ai-sdk-provider` (a declared dependency of
// this package) builds the body, and a stub `fetch` captures it. Nothing here
// re-implements the vendor's mapping.

import { describe, expect, test } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { streamText } from "ai"
import { ProviderTransform } from "@/provider/transform"

const SESSION = "session-openrouter-body"

/** The shortest event stream this provider accepts: end of stream, no content.
 * The assertions are on the REQUEST, so the response only has to parse. */
function emptyEventStream() {
  return new Response(new Blob(["data: [DONE]\n\n"]).stream(), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

/**
 * Run one real `streamText` call through the real OpenRouter provider and
 * return the JSON body it POSTed.
 */
async function bodyFor(providerOptions: Record<string, any>) {
  let captured: Record<string, any> | undefined
  const openrouter = createOpenRouter({
    apiKey: "test-key",
    baseURL: "https://openrouter.invalid/api/v1",
    fetch: (async (_url: any, init: any) => {
      captured = JSON.parse(String(init?.body))
      return emptyEventStream()
    }) as unknown as typeof globalThis.fetch,
  })

  const result = streamText({
    model: openrouter.chat("openai/gpt-5.1"),
    messages: [{ role: "user", content: "Hello" }],
    providerOptions,
    maxRetries: 0,
  })
  for await (const _ of result.fullStream) void _

  if (!captured) throw new Error("no request body was captured")
  return captured
}

/** An openrouter-hosted gpt-5, shaped the way `Provider.getModel` resolves one. */
const model = {
  id: "openrouter/openai/gpt-5.1",
  providerID: "openrouter",
  api: { id: "openai/gpt-5.1", url: "https://openrouter.ai/api/v1", npm: "@openrouter/ai-sdk-provider" },
  name: "gpt-5.1",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
  limit: { context: 400_000, output: 128_000 },
  status: "active",
  options: {},
  headers: {},
} as any

/** The exact record the engine hands the SDK for this model. */
const engineOptions = (extra: Record<string, any> = {}) =>
  ProviderTransform.providerOptions(model, {
    ...ProviderTransform.options({ model, sessionID: SESSION }),
    ...extra,
  })

describe("openrouter request body", () => {
  test("the engine's options are routed into the block this provider reads", () => {
    // The routing half, checked without a network call: everything lands under
    // `openrouter`, which is the only key `doStream` looks at.
    expect(Object.keys(engineOptions())).toEqual(["openrouter"])
  })

  test("an unknown option key reaches the request body verbatim", async () => {
    // The degrade.ts claim, and the zero-code lever it implies. `include_reasoning`
    // is a real OpenRouter body field that the engine never writes and the
    // provider's settings object has no slot for - so if it arrives, ANY hand
    // written key in a provider block arrives.
    const body = await bodyFor(engineOptions({ include_reasoning: true, made_up_key_xyz: "kept" }))
    expect(body.include_reasoning).toBe(true)
    expect(body.made_up_key_xyz).toBe("kept")
  })

  test("a gpt-5 model is sent an explicit reasoning effort, in this gateway's own field", async () => {
    const body = await bodyFor(engineOptions())
    expect(body.reasoning).toEqual({ effort: "medium" })
  })

  test("the OpenAI spelling alone would NOT set the effort here", async () => {
    // Why `reasoning: { effort }` is not redundant with `reasoningEffort`.
    // `reasoningEffort` survives to the body, but as a plain unknown key -
    // there is no `reasoning` field and no `reasoning_effort` field, so the
    // endpoint is left on the model default. This is the failure the gateway
    // branch in provider/transform.ts exists to prevent.
    const body = await bodyFor({ openrouter: { reasoningEffort: "medium" } })
    expect(body.reasoningEffort).toBe("medium")
    expect(body.reasoning).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })
})
