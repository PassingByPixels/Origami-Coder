import type { McpServer } from "@agentclientprotocol/sdk"
import type { Message, Part } from "@origami/sdk/v2"
import { LayerNode } from "@origami/core/effect/layer-node"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Context, Effect, Layer, Ref } from "effect"
import { AgentBroker } from "@/origami/agent-broker"
import * as ACPError from "./error"

export type SelectedModel = {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
}

export type KnownMessagePartMetadata = {
  messageId: string
  partId: string
  partType?: Part["type"]
  role?: Message["role"]
  ignored?: boolean
  toolCallId?: string
  metadata?: unknown
}

export type Info = {
  id: string
  cwd: string
  mcpServers: readonly McpServer[]
  createdAt: Date
  model?: SelectedModel
  /** Per-chat SUB-AGENT model override — what every sub-agent this session
   *  spawns runs on, whatever the flock profile or the agent pins. Mirrored onto
   *  the engine's session row (that is where the task tool reads it); held here
   *  so the ACP layer can answer for it without a round trip. */
  subagentModel?: SelectedModel
  variant?: string
  modeId?: string
  permissionMode?: string
  /** Per-chat VISION PROFILE — the slug of the agent this chat hands an image
   *  to when its own model cannot see one. Mirrored onto the engine's session
   *  row (that is where the prompt loop reads it); held here so the ACP layer
   *  can answer for it without a round trip, exactly as `subagentModel` is. */
  visionProfile?: string
  temperature?: number
  topP?: number
  knownParts: ReadonlyMap<string, KnownMessagePartMetadata>
}

export type StoreInput = {
  id: string
  cwd: string
  mcpServers?: readonly McpServer[]
  createdAt?: Date
  model?: SelectedModel
  subagentModel?: SelectedModel
  variant?: string
  modeId?: string
  permissionMode?: string
  visionProfile?: string
  temperature?: number
  topP?: number
}

export type RecordPartMetadataInput = {
  sessionId: string
  messageId: string
  partId: string
  partType?: Part["type"]
  role?: Message["role"]
  ignored?: boolean
  toolCallId?: string
  metadata?: unknown
}

export type PartMetadataLookupInput = {
  sessionId: string
  messageId: string
  partId: string
}

export type Interface = {
  readonly create: (input: StoreInput) => Effect.Effect<Info>
  readonly load: (input: StoreInput) => Effect.Effect<Info>
  readonly list: (cwd?: string) => Effect.Effect<readonly Info[]>
  readonly get: (sessionId: string) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly tryGet: (sessionId: string) => Effect.Effect<Info | undefined>
  readonly remove: (sessionId: string) => Effect.Effect<Info | undefined>
  readonly setModel: (
    sessionId: string,
    model: SelectedModel | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly getModel: (sessionId: string) => Effect.Effect<SelectedModel | undefined, ACPError.SessionNotFoundError>
  readonly setSubagentModel: (
    sessionId: string,
    model: SelectedModel | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly getSubagentModel: (
    sessionId: string,
  ) => Effect.Effect<SelectedModel | undefined, ACPError.SessionNotFoundError>
  readonly setVariant: (
    sessionId: string,
    variant: string | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly getVariant: (sessionId: string) => Effect.Effect<string | undefined, ACPError.SessionNotFoundError>
  readonly setMode: (
    sessionId: string,
    modeId: string | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly getMode: (sessionId: string) => Effect.Effect<string | undefined, ACPError.SessionNotFoundError>
  readonly setPermissionMode: (
    sessionId: string,
    permissionMode: string | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly setVisionProfile: (
    sessionId: string,
    visionProfile: string | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly setTemperature: (
    sessionId: string,
    temperature: number | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly setTopP: (
    sessionId: string,
    topP: number | undefined,
  ) => Effect.Effect<Info, ACPError.SessionNotFoundError>
  readonly recordPartMetadata: (
    input: RecordPartMetadataInput,
  ) => Effect.Effect<KnownMessagePartMetadata, ACPError.SessionNotFoundError>
  readonly getPartMetadata: (
    input: PartMetadataLookupInput,
  ) => Effect.Effect<KnownMessagePartMetadata | undefined, ACPError.SessionNotFoundError>
  readonly tryGetPartMetadata: (input: PartMetadataLookupInput) => Effect.Effect<KnownMessagePartMetadata | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@origami/ACP/Session") {}

type State = Map<string, Info>

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Ref.make<State>(new Map())

    const store = Effect.fn("ACP.Session.store")(function* (input: StoreInput) {
      const session = makeSession(input)
      yield* Ref.update(sessions, (state) => new Map(state).set(session.id, session))
      // origami_change (t-kgu05m): this map IS the set the peer broker
      // publishes, so a change to it has to reach the heartbeat file now and
      // not on the next twenty-second beat. Hooked here, at the ONE mutation
      // both `create` and `load` go through, rather than at the five places in
      // service.ts that call them — a sixth caller added later would silently
      // miss a per-call-site version of this. A no-op in a process that never
      // registered, which is every test that builds this layer.
      AgentBroker.refresh()
      return snapshot(session)
    })

    const tryGet = Effect.fn("ACP.Session.tryGet")(function* (sessionId: string) {
      const session = (yield* Ref.get(sessions)).get(sessionId)
      if (!session) return
      return snapshot(session)
    })

    const get = Effect.fn("ACP.Session.get")(function* (sessionId: string) {
      const session = yield* tryGet(sessionId)
      if (session) return session
      return yield* new ACPError.SessionNotFoundError({ sessionId })
    })

    const update = Effect.fn("ACP.Session.update")(function* (sessionId: string, fn: (session: Info) => Info) {
      const result = yield* Ref.modify(sessions, (state) => {
        const session = state.get(sessionId)
        if (!session) return [undefined, state] as const
        const next = fn(session)
        return [snapshot(next), new Map(state).set(sessionId, next)] as const
      })
      if (result) return result
      return yield* new ACPError.SessionNotFoundError({ sessionId })
    })

    const remove = Effect.fn("ACP.Session.remove")(function* (sessionId: string) {
      const removed = yield* Ref.modify(sessions, (state) => {
        const session = state.get(sessionId)
        if (!session) return [undefined, state] as const
        const next = new Map(state)
        next.delete(sessionId)
        return [snapshot(session), next] as const
      })
      // The half that matters most: an entry still advertising a CLOSED session
      // is what makes a peer deliver into a chat that is gone.
      AgentBroker.refresh()
      return removed
    })

    const setModel: Interface["setModel"] = Effect.fn("ACP.Session.setModel")((sessionId, model) =>
      update(sessionId, (session) => ({ ...session, model })),
    )

    const setSubagentModel: Interface["setSubagentModel"] = Effect.fn("ACP.Session.setSubagentModel")(
      (sessionId, subagentModel) => update(sessionId, (session) => ({ ...session, subagentModel })),
    )

    const setVariant: Interface["setVariant"] = Effect.fn("ACP.Session.setVariant")((sessionId, variant) =>
      update(sessionId, (session) => ({ ...session, variant })),
    )

    const setMode: Interface["setMode"] = Effect.fn("ACP.Session.setMode")((sessionId, modeId) =>
      update(sessionId, (session) => ({ ...session, modeId })),
    )

    const setPermissionMode: Interface["setPermissionMode"] = Effect.fn("ACP.Session.setPermissionMode")(
      (sessionId, permissionMode) => update(sessionId, (session) => ({ ...session, permissionMode })),
    )

    const setVisionProfile: Interface["setVisionProfile"] = Effect.fn("ACP.Session.setVisionProfile")(
      (sessionId, visionProfile) => update(sessionId, (session) => ({ ...session, visionProfile })),
    )

    const setTemperature: Interface["setTemperature"] = Effect.fn("ACP.Session.setTemperature")(
      (sessionId, temperature) => update(sessionId, (session) => ({ ...session, temperature })),
    )

    const setTopP: Interface["setTopP"] = Effect.fn("ACP.Session.setTopP")((sessionId, topP) =>
      update(sessionId, (session) => ({ ...session, topP })),
    )

    const recordPartMetadata: Interface["recordPartMetadata"] = Effect.fn("ACP.Session.recordPartMetadata")((input) => {
      const metadata = {
        messageId: input.messageId,
        partId: input.partId,
        partType: input.partType,
        role: input.role,
        ignored: input.ignored,
        toolCallId: input.toolCallId,
        metadata: input.metadata,
      }
      return update(input.sessionId, (session) => ({
        ...session,
        knownParts: new Map(session.knownParts).set(partMetadataKey(input), metadata),
      })).pipe(Effect.as(metadata))
    })

    return Service.of({
      create: store,
      load: store,
      list: Effect.fn("ACP.Session.list")(function* (cwd?: string) {
        return [...(yield* Ref.get(sessions)).values()]
          .filter((session) => !cwd || session.cwd === cwd)
          .map(snapshot)
          .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      }),
      get,
      tryGet,
      remove,
      setModel,
      getModel: Effect.fn("ACP.Session.getModel")(function* (sessionId) {
        return (yield* get(sessionId)).model
      }),
      setSubagentModel,
      getSubagentModel: Effect.fn("ACP.Session.getSubagentModel")(function* (sessionId) {
        return (yield* get(sessionId)).subagentModel
      }),
      setVariant,
      getVariant: Effect.fn("ACP.Session.getVariant")(function* (sessionId) {
        return (yield* get(sessionId)).variant
      }),
      setMode,
      getMode: Effect.fn("ACP.Session.getMode")(function* (sessionId) {
        return (yield* get(sessionId)).modeId
      }),
      setPermissionMode,
      setVisionProfile,
      setTemperature,
      setTopP,
      recordPartMetadata,
      getPartMetadata: Effect.fn("ACP.Session.getPartMetadata")(function* (input) {
        return (yield* get(input.sessionId)).knownParts.get(partMetadataKey(input))
      }),
      tryGetPartMetadata: Effect.fn("ACP.Session.tryGetPartMetadata")(function* (input) {
        return (yield* tryGet(input.sessionId))?.knownParts.get(partMetadataKey(input))
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

function makeSession(input: StoreInput): Info {
  return {
    id: input.id,
    cwd: input.cwd,
    mcpServers: [...(input.mcpServers ?? [])],
    createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
    model: input.model,
    subagentModel: input.subagentModel,
    variant: input.variant,
    modeId: input.modeId,
    permissionMode: input.permissionMode,
    visionProfile: input.visionProfile,
    temperature: input.temperature,
    topP: input.topP,
    knownParts: new Map(),
  }
}

function snapshot(session: Info): Info {
  return {
    ...session,
    mcpServers: [...session.mcpServers],
    createdAt: new Date(session.createdAt),
    knownParts: new Map(session.knownParts),
  }
}

function partMetadataKey(input: { messageId: string; partId: string }) {
  return `${input.messageId}:${input.partId}`
}

export * as ACPSession from "./session"
