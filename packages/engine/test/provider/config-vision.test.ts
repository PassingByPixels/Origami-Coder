// A config block can declare VISION, and the capability decision reads it.
//
// OWNER UAT, 0.3.83: the SGLang block serving Qwen3.8-27B — a native
// vision-language model — was telling the model it had no eyes. The session
// export carries the model relaying the tool layer's own words: "ERROR: Cannot
// read image (this model does not support image input). Inform the user."
//
// THE CHAIN. `provider.ts` builds `capabilities.input.image` from the block's
// `modalities.input`, defaulting to FALSE when a block declares nothing
// (provider.ts:1656). Every vision decision downstream then reads that ONE
// field: `SessionVision.modelSeesImages` (whether to route round the model at
// all) and `ProviderTransform`'s `unsupportedParts` (which replaces the picture
// with that ERROR line before it reaches the wire). A block with no
// `modalities` is therefore a sighted model told it is blind — no code path
// asks the server, and none can.
//
// This locks the declaration→decision link, which is what makes the fix a
// CONFIG edit rather than a code change: `attachment: true` +
// `modalities.input: ["text","image"]` on the model entry, exactly what
// firstFold.writeModelVision writes for a local VLM.

import { describe, expect, test } from "bun:test"
import { SessionVision } from "@/session/vision"

/** A model exactly as `provider.ts` builds one from a config block. */
const makeModel = (input: { apiId: string; npm: string; image: boolean }) =>
  ({
    id: `sglang/${input.apiId}`,
    providerID: "sglang",
    api: { id: input.apiId, url: "http://localhost:30000/v1", npm: input.npm },
    name: input.apiId,
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: input.image,
      toolcall: true,
      input: { text: true, audio: false, image: input.image, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 131072, output: 0 },
    status: "active",
    options: {},
    headers: {},
  }) as any

// Round 5 dropped the turn fixture that used to sit here: arming is the
// profile plus the model's own modality now, and no longer consults the
// messages at all. What a turn CARRIES is tested in test/session/vision.test.ts.

describe("a config-declared vision capability reaches the capability decision", () => {
  test("no declared modalities = blind, which is the reported bug", () => {
    const undeclared = makeModel({ apiId: "qwen38-27b", npm: "@ai-sdk/openai-compatible", image: false })
    expect(SessionVision.modelSeesImages(undeclared)).toBe(false)
  })

  test("a block declaring image input is SIGHTED", () => {
    const declared = makeModel({ apiId: "qwen38-27b", npm: "@ai-sdk/openai-compatible", image: true })
    expect(SessionVision.modelSeesImages(declared)).toBe(true)
  })

  test("...and the vision PROXY stands down for it, even with a profile picked", () => {
    // Both halves matter. Routing an image round a model that can look at it is
    // the same lie in the other direction: a second call, a second bill, and a
    // description where the pixels should have been.
    const declared = makeModel({ apiId: "qwen38-27b", npm: "@ai-sdk/openai-compatible", image: true })
    expect(SessionVision.activeProfile({ profile: "qwen-vision", model: declared })).toBeUndefined()
  })

  test("an undeclared model on the same turn still gets the proxy offered", () => {
    // The guard against over-correcting: a text-only local model must keep the
    // route that lets a sighted agent read the picture for it.
    const undeclared = makeModel({ apiId: "qwen3-coder-30b", npm: "@ai-sdk/openai-compatible", image: false })
    expect(SessionVision.activeProfile({ profile: "qwen-vision", model: undeclared })).toBe(
      "qwen-vision",
    )
  })
})
