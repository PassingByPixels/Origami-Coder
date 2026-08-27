import { LayerNode } from "@origami/core/effect/layer-node"
import { serviceUse } from "@origami/core/effect/service-use"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { FlockConfigV1 } from "@origami/core/v1/config/flock"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Context, Effect, Layer } from "effect"

/** A resolved connection: one provider/model pair the binding may run on. */
export interface Binding {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
}

export interface Active {
  name: string
  profile: FlockConfigV1.Profile
}

export type IssueCode = "unknown_profile" | "malformed_binding" | "unknown_binding"

export interface Issue {
  code: IssueCode
  message: string
}

export interface Report {
  errors: Issue[]
  warnings: Issue[]
}

export interface Interface {
  /** The active profile, or undefined when Flock routing is off. */
  readonly active: () => Effect.Effect<Active | undefined>
  /**
   * Ordered candidate bindings for subagent sessions — `use` first, then each
   * `fallback`. `undefined` means "no opinion": Flock is off, the profile binds
   * no subagent model, or every entry was malformed. Callers fall through to the
   * session's own model (D10). Resolution never fails.
   */
  readonly resolveSubagents: () => Effect.Effect<Binding[] | undefined>
  /** Sanity report for a named profile. Never fails. */
  readonly validate: (profileName: string) => Effect.Effect<Report>
}

export class Service extends Context.Service<Service, Interface>()("@origami/FlockRouting") {}

export const use = serviceUse(Service)

/**
 * Split a "provider/model" reference with `Provider.parseModel`'s semantics
 * (first segment is the provider, the rest is the model id, slashes and all)
 * but report a reference that has no usable halves instead of manufacturing an
 * empty one.
 */
export function parseBinding(reference: string): Binding | undefined {
  const [providerID, ...rest] = reference.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return undefined
  return { providerID: ProviderV2.ID.make(providerID), modelID: ModelV2.ID.make(modelID) }
}

/** A binding's references in the order they are tried: `use`, then each fallback. */
const chainOf = (binding: FlockConfigV1.Binding) => [binding.use, ...(binding.fallback ?? [])]

/**
 * Profile names come from user config, so an ordinary lookup answers "toString"
 * or "constructor" with an inherited member and Flock reports itself active on
 * a profile that does not exist.
 */
function profileNamed(profiles: Record<string, FlockConfigV1.Profile> | undefined, name: string) {
  if (!profiles || !Object.hasOwn(profiles, name)) return undefined
  return profiles[name]
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const warned = new Set<string>()
    const migrated = new Set<string>()

    const section = Effect.fnUntraced(function* () {
      return (yield* config.get()).flock
    })

    const active = Effect.fn("FlockRouting.active")(function* () {
      const flock = yield* section()
      const name = flock?.profile
      if (!name) return undefined
      const profile = profileNamed(flock.profiles, name)
      if (!profile) {
        if (!warned.has(name)) {
          warned.add(name)
          yield* Effect.logWarning("flock profile not found, routing is off", { profile: name })
        }
        return undefined
      }
      return { name, profile }
    })

    /**
     * The profile's subagent binding, migrating the pre-E1 shape on the way past
     * and saying so ONCE per profile. Said once rather than never because half
     * of that profile — scout, workhorse, the per-role overrides — now routes
     * nothing, and a user who is not told will read the surviving half as proof
     * the whole file still works.
     *
     * The louder of the two notices is the one for a profile that carried no
     * `executor` at all: it maps to NOTHING, so without this line its owner sees
     * a profile that is selected, reports itself active, and quietly routes
     * every subagent back to the session's own model.
     */
    const subagentsOf = Effect.fnUntraced(function* (name: string, profile: FlockConfigV1.Profile) {
      const found = FlockConfigV1.subagentsOf(profile)
      const legacy = found ? found.legacy : FlockConfigV1.hasLegacyShape(profile)
      if (legacy && !migrated.has(name)) {
        migrated.add(name)
        if (found) {
          yield* Effect.logInfo(
            "flock profile uses the old routing shape; its `executor` binding now routes subagents and the other slots and roles are ignored",
            { profile: name, binding: found.binding.use },
          )
        } else {
          yield* Effect.logWarning(
            "flock profile uses the old routing shape and names no `executor`, so it now routes nothing; move the model you want subagents on to a `subagents` binding",
            { profile: name },
          )
        }
      }
      return found?.binding
    })

    const resolveSubagents = Effect.fn("FlockRouting.resolveSubagents")(function* () {
      const current = yield* active()
      if (!current) return undefined
      const entry = yield* subagentsOf(current.name, current.profile)
      if (!entry) return undefined

      const bindings: Binding[] = []
      for (const reference of chainOf(entry)) {
        const binding = parseBinding(reference)
        if (!binding) {
          yield* Effect.logWarning("flock binding is not in provider/model form, skipping", { binding: reference })
          continue
        }
        bindings.push(binding)
      }
      return bindings.length ? bindings : undefined
    })

    const lookup = Effect.fnUntraced(function* (reference: string) {
      const binding = parseBinding(reference)
      if (!binding) return { binding: undefined, model: undefined }
      const model = yield* provider
        .getModel(binding.providerID, binding.modelID)
        .pipe(Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)))
      return { binding, model }
    })

    const validate = Effect.fn("FlockRouting.validate")(function* (profileName: string) {
      const flock = yield* section()
      const report: Report = { errors: [], warnings: [] }

      const profile = profileNamed(flock?.profiles, profileName)
      if (!profile) {
        report.errors.push({
          code: "unknown_profile",
          message: `Flock profile "${profileName}" is not defined`,
        })
        return report
      }

      const entry = yield* subagentsOf(profileName, profile)
      if (!entry) return report

      for (const reference of chainOf(entry)) {
        const { binding, model } = yield* lookup(reference)
        if (!binding) {
          report.warnings.push({
            code: "malformed_binding",
            message: `Binding "${reference}" is not in provider/model form`,
          })
          continue
        }
        if (!model) {
          report.warnings.push({
            code: "unknown_binding",
            message: `Subagents are bound to ${binding.providerID}/${binding.modelID}, which is not available. Work routed there will fall through to the session's model`,
          })
        }
      }

      return report
    })

    return Service.of({ active, resolveSubagents, validate })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Provider.node],
})

export * as FlockRouting from "./routing"
