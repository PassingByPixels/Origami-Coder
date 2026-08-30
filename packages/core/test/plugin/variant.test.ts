import { describe, expect } from "bun:test"
import { Catalog } from "@origami/core/catalog"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Location } from "@origami/core/location"
import { ModelV2 } from "@origami/core/model"
import { VariantPlugin } from "@origami/core/plugin/variant"
import { ProviderV2 } from "@origami/core/provider"
import { AbsolutePath } from "@origami/core/schema"
import { Effect, Layer } from "effect"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const it = testEffect(AppNodeBuilder.build(Catalog.node, [[Location.node, locationLayer]]))

describe("VariantPlugin", () => {
  it.effect("adds GLM 5.2 variants after catalog sources", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      yield* service.transform((catalog) => {
        catalog.provider.update(ProviderV2.ID.opencode, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible" }
        })
        catalog.model.update(ProviderV2.ID.opencode, ModelV2.ID.make("glm-5.2"), (model) => {
          model.api = {
            id: ModelV2.ID.make("glm-5.2"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
          }
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      expect((yield* service.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("glm-5.2")))?.variants).toEqual([
        expect.objectContaining({ id: "high", body: { reasoning_effort: "high" } }),
        expect.objectContaining({ id: "max", body: { reasoning_effort: "max" } }),
      ])
    }),
  )

  // origami_change: the boundary mirrored from the engine's `ProviderTransform`
  // - 5.3 and later take the standard efforts, everything older still gets
  // nothing here.
  it.effect("adds standard efforts for GLM newer than 5.2 and nothing for older ids", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      const ids = ["glm-5.3-flash-ablit", "glm-5p3", "glm-6", "glm-4.6", "glm-5.1", "glm-130b"]
      yield* service.transform((catalog) => {
        for (const id of ids) {
          catalog.model.update(ProviderV2.ID.opencode, ModelV2.ID.make(id), (model) => {
            model.api = {
              id: ModelV2.ID.make(id),
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
            }
          })
        }
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      const variantsFor = Effect.fn(function* (id: string) {
        const model = yield* service.model.get(ProviderV2.ID.opencode, ModelV2.ID.make(id))
        return model?.variants
      })

      for (const id of ["glm-5.3-flash-ablit", "glm-5p3", "glm-6"]) {
        expect(yield* variantsFor(id), id).toEqual([
          expect.objectContaining({ id: "low", body: { reasoning_effort: "low" } }),
          expect.objectContaining({ id: "medium", body: { reasoning_effort: "medium" } }),
          expect.objectContaining({ id: "high", body: { reasoning_effort: "high" } }),
        ])
      }
      for (const id of ["glm-4.6", "glm-5.1", "glm-130b"]) {
        expect(yield* variantsFor(id), id).toEqual([])
      }
    }),
  )

  it.effect("keeps explicit variants over generated defaults", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      yield* service.transform((catalog) => {
        catalog.model.update(ProviderV2.ID.opencode, ModelV2.ID.make("glm-5.2"), (model) => {
          model.api = {
            id: ModelV2.ID.make("glm-5.2"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
          }
          model.variants = [{ id: ModelV2.VariantID.make("high"), headers: { custom: "true" }, body: {} }]
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      expect((yield* service.model.get(ProviderV2.ID.opencode, ModelV2.ID.make("glm-5.2")))?.variants).toEqual([
        expect.objectContaining({ id: "high", headers: { custom: "true" } }),
        expect.objectContaining({ id: "max", body: { reasoning_effort: "max" } }),
      ])
    }),
  )
})
