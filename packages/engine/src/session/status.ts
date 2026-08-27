import { LayerNode } from "@origami/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@origami/schema/session-status-event"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
  /** Prompts that arrived behind the running turn and were joined onto it. */
  readonly queued: (sessionID: SessionID) => Effect.Effect<number>
  /** Counts one more such prompt and republishes the status. Returns the count. */
  readonly bumpQueued: (sessionID: SessionID) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@origami/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    // Two maps, one state entry: the queued count must NOT live inside `Info`.
    // The processor writes `{type:"busy"}` at every step of a turn, so a field
    // on the status itself would be erased by the next step of the same turn.
    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() =>
        Effect.succeed({ status: new Map<SessionID, Info>(), queued: new Map<SessionID, number>() }),
      ),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.status.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map((yield* InstanceState.get(state)).status)
    })

    const queued = Effect.fn("SessionStatus.queued")(function* (sessionID: SessionID) {
      return (yield* InstanceState.get(state)).queued.get(sessionID) ?? 0
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      // Going idle is the moment the queue drains: whatever was waiting behind
      // the turn is either running now or gone. Clear BEFORE publishing so the
      // idle event never carries a count that is already false.
      if (status.type === "idle") data.queued.delete(sessionID)
      yield* events.publish(Event.Status, { sessionID, status, queued: data.queued.get(sessionID) ?? 0 })
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.status.delete(sessionID)
        return
      }
      data.status.set(sessionID, status)
    })

    const bumpQueued = Effect.fn("SessionStatus.bumpQueued")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const next = (data.queued.get(sessionID) ?? 0) + 1
      data.queued.set(sessionID, next)
      // A prompt can only be queued behind a run that is in flight, so `busy`
      // is the honest fallback when no status has been recorded yet - the
      // runner is demonstrably not idle.
      const status = data.status.get(sessionID) ?? ({ type: "busy" } as const)
      yield* events.publish(Event.Status, { sessionID, status, queued: next })
      return next
    })

    return Service.of({ get, list, set, queued, bumpQueued })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as SessionStatus from "./status"
