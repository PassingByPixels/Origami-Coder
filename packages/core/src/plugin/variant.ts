export * as VariantPlugin from "./variant"

import type { ModelV2Info } from "@origami/sdk/v2/types"
import { Effect } from "effect"
import { define } from "./internal"

export const Plugin = define({
  id: "variant",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      for (const record of catalog.provider.list()) {
        for (const model of record.models.values()) {
          catalog.model.update(model.providerID, model.id, (draft) => {
            const generated = generate(draft)
            if (generated.length === 0) return

            const explicit = new Map(draft.variants.map((variant) => [variant.id, variant]))
            const generatedIDs = new Set(generated.map((variant) => variant.id))
            draft.variants = [
              ...generated.map((variant) => explicit.get(variant.id) ?? variant),
              ...draft.variants.filter((variant) => !generatedIDs.has(variant.id)),
            ]
          })
        }
      }
    })
  }),
})

export function generate(model: ModelV2Info): ModelV2Info["variants"] {
  if (model.api.type !== "aisdk" || model.api.package !== "@ai-sdk/openai-compatible") return []
  const ids = `${model.id} ${model.api.id}`.toLowerCase()
  const efforts = (() => {
    // GLM 5.2 exposes native high/max effort.
    if (["glm-5.2", "glm-5-2", "glm-5p2"].some((name) => ids.includes(name))) return ["high", "max"]
    // origami_change: MIRRORS the GLM boundary in
    // `packages/engine/src/provider/transform.ts` - GLM newer than 5.2,
    // including self-hosted vLLM builds, takes the standard OpenAI-compatible
    // efforts. Same single-digit major rule, so `glm-130b` parses as major 1
    // and generates nothing.
    if (
      Array.from(ids.matchAll(/glm-?(\d)(?:[.\-p](\d+))?/g)).some(([, major, minor]) => {
        const version = Number(major)
        return version > 5 || (version === 5 && Number(minor ?? "0") >= 3)
      })
    )
      return ["low", "medium", "high"]
    return []
  })()
  return efforts.map((id) => ({
    id,
    headers: {},
    body: { reasoning_effort: id },
  }))
}
