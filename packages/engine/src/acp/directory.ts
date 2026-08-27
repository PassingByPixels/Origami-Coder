import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Provider } from "@/provider/provider"
import { Context, Effect, Layer, SynchronizedRef } from "effect"
import type * as ACPError from "./error"

export type ModelOption = {
  readonly providerID: ProviderV2.ID
  readonly providerName: string
  readonly modelID: ModelV2.ID
  readonly modelName: string
}

export type ModeOption = {
  readonly id: string
  readonly name: string
  readonly description?: string
  /**
   * Off the PICKER, but a valid identity to run a session as.
   *
   * Every definition the Bots pane saves carries `hidden: true` (the
   * extension's collabAgentSerialize.ts writes it on every file), which is what
   * keeps a roster of bots out of the ordinary chat mode list. It never meant
   * "not an agent" - a bot chat is an ordinary chat created AS one of these -
   * so this list carries them and the PICKER filters them, rather than the
   * other way round. Dropping them here is what made "Start session" on a bot
   * refuse with "the engine has not loaded an agent called …" (W8-L1 UAT).
   *
   * The engine's OWN prompt agents (compaction/title/summary) are hidden AND
   * native, and are excluded at the loader instead: they are not identities a
   * human chats as.
   */
  readonly hidden?: boolean
}

/** The one rule both loaders share: which agents may back a session at all. */
export const modeOptionsFrom = (
  agents: readonly { name: string; mode: string; description?: string; hidden?: boolean; native?: boolean }[],
): ModeOption[] =>
  agents
    .filter((agent) => agent.mode !== "subagent" && !(agent.hidden === true && agent.native === true))
    .map((agent) => ({
      id: agent.name,
      name: agent.name,
      ...(agent.description ? { description: agent.description } : {}),
      ...(agent.hidden === true ? { hidden: true } : {}),
    }))

export type ModelVariants = NonNullable<Provider.Model["variants"]>

export type DefaultModel = {
  readonly providerID: ProviderV2.ID
  readonly modelID: ModelV2.ID
}

export type Snapshot = {
  readonly directory: string
  readonly providers: Record<ProviderV2.ID, Provider.Info>
  readonly modelOptions: readonly ModelOption[]
  readonly variantsByModel: Readonly<Record<string, ModelVariants>>
  readonly availableModes: readonly ModeOption[]
  readonly defaultModeID: string
  readonly availableCommands: readonly Command.Info[]
  readonly defaultModel?: DefaultModel
}

export interface LoaderInterface {
  readonly load: (directory: string) => Effect.Effect<Snapshot, ACPError.Error>
}

export interface Interface {
  readonly get: (directory: string) => Effect.Effect<Snapshot, ACPError.Error>
  readonly refresh: (directory: string) => Effect.Effect<Snapshot, ACPError.Error>
  readonly variants: (snapshot: Snapshot, model: DefaultModel) => ModelVariants | undefined
}

export class Loader extends Context.Service<Loader, LoaderInterface>()("@origami/ACPDirectoryLoader") {}

export class Service extends Context.Service<Service, Interface>()("@origami/ACPDirectory") {}

export const modelKey = (model: DefaultModel) => `${model.providerID}/${model.modelID}`

export const variants = (snapshot: Snapshot, model: DefaultModel) => snapshot.variantsByModel[modelKey(model)]

export const build = (input: {
  readonly directory: string
  readonly providers: Record<ProviderV2.ID, Provider.Info>
  readonly modes: readonly ModeOption[]
  readonly defaultModeID: string
  readonly commands: readonly Command.Info[]
  readonly defaultModel?: DefaultModel
}): Snapshot => {
  const modelOptions = Provider.sort(
    Object.values(input.providers).flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        id: model.id,
        providerID: provider.id,
        providerName: provider.name,
        modelID: model.id,
        modelName: model.name,
      })),
    ),
  ).map((model) => ({
    providerID: model.providerID,
    providerName: model.providerName,
    modelID: model.modelID,
    modelName: model.modelName,
  }))

  return {
    directory: input.directory,
    providers: input.providers,
    modelOptions,
    variantsByModel: Object.fromEntries(
      Object.values(input.providers).flatMap((provider) =>
        Object.values(provider.models).flatMap((model) =>
          model.variants ? [[modelKey({ providerID: provider.id, modelID: model.id }), model.variants]] : [],
        ),
      ),
    ),
    availableModes: input.modes,
    // The fallback picks a VISIBLE mode. `modes` carries hidden definitions
    // now, and falling through to one would seed every new chat in the
    // directory as somebody's bot.
    defaultModeID: input.modes.some((mode) => mode.id === input.defaultModeID)
      ? input.defaultModeID
      : (input.modes.find((mode) => !mode.hidden)?.id ?? input.modes[0]?.id ?? input.defaultModeID),
    availableCommands: input.commands,
    ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
  }
}

export const loaderLayer = Layer.effect(
  Loader,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const provider = yield* Provider.Service
    const agent = yield* Agent.Service
    const command = yield* Command.Service

    return Loader.of({
      load: Effect.fn("ACPDirectoryLoader.load")(function* (directory) {
        const ctx = yield* store.load({ directory })
        return yield* Effect.gen(function* () {
          const providers = yield* provider.list()
          const [agents, defaultAgent, commands, defaultModel] = yield* Effect.all(
            [agent.list(), agent.defaultInfo(), command.list(), provider.defaultModel().pipe(Effect.option)],
            { concurrency: "unbounded" },
          )
          return build({
            directory,
            providers,
            modes: modeOptionsFrom(agents),
            defaultModeID: defaultAgent.name,
            commands: commands.toSorted((a, b) => a.name.localeCompare(b.name)),
            ...(defaultModel._tag === "Some" ? { defaultModel: defaultModel.value } : {}),
          })
        }).pipe(Effect.provideService(InstanceRef, ctx))
      }),
    })
  }),
)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const loader = yield* Loader
    const snapshots = yield* SynchronizedRef.make(new Map<string, Effect.Effect<Snapshot, ACPError.Error>>())

    const cached = Effect.fnUntraced(function* (directory: string) {
      return yield* SynchronizedRef.modifyEffect(
        snapshots,
        Effect.fnUntraced(function* (items) {
          const current = items.get(directory)
          if (current) return [current, items] as const
          const next = yield* Effect.cached(
            loader.load(directory).pipe(
              Effect.tapError(() =>
                SynchronizedRef.update(snapshots, (state) => {
                  const next = new Map(state)
                  next.delete(directory)
                  return next
                }),
              ),
            ),
          )
          return [next, new Map(items).set(directory, next)] as const
        }),
      )
    })

    const get = Effect.fn("ACPDirectory.get")(function* (directory: string) {
      return yield* yield* cached(directory)
    })

    const refresh = Effect.fn("ACPDirectory.refresh")(function* (directory: string) {
      return yield* SynchronizedRef.modifyEffect(
        snapshots,
        Effect.fnUntraced(function* (items) {
          const next = yield* Effect.cached(
            loader.load(directory).pipe(
              Effect.tapError(() =>
                SynchronizedRef.update(snapshots, (state) => {
                  const next = new Map(state)
                  next.delete(directory)
                  return next
                }),
              ),
            ),
          )
          return [next, new Map(items).set(directory, next)] as const
        }),
      ).pipe(Effect.flatten)
    })

    return Service.of({
      get,
      refresh,
      variants,
    })
  }),
)

export const loaderNode = LayerNode.make({
  service: Loader,
  layer: loaderLayer,
  deps: [Provider.node, Agent.node, Command.node, InstanceStore.node],
})

export const node = LayerNode.make({ service: Service, layer, deps: [loaderNode] })

export * as Directory from "./directory"
