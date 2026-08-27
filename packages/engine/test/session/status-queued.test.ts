// The queued-prompt counter on session status.
//
// `SessionRunState.ensureRunning` JOINS a run already in flight and DISCARDS
// the work it was handed (see effect/runner.ts and the note at
// session/prompt.ts:171). A user's second message therefore does nothing and
// says nothing until the current step ends. This counter is what makes that
// visible, and these tests pin the two properties that make it worth having:
// it survives the processor's own repeated `busy` writes, and it reaches the
// wire.

import { describe, expect } from "bun:test"
import { Effect, Ref } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// EventV2Bridge is named as well as depended on: the second test listens on the
// same bus the status service publishes to, which needs it as an OUTPUT of the
// layer, not just an internal dependency of SessionStatus.
const it = testEffect(
  LayerNode.compile(LayerNode.group([SessionStatus.node, EventV2Bridge.node, CrossSpawnSpawner.node])),
)

describe("SessionStatus queued", () => {
  it.instance("counts joined prompts and is NOT erased by the next busy write of the same turn", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const sessionID = SessionID.make("ses_queued")

      expect(yield* status.queued(sessionID)).toBe(0)
      yield* status.set(sessionID, { type: "busy" })

      expect(yield* status.bumpQueued(sessionID)).toBe(1)
      expect(yield* status.bumpQueued(sessionID)).toBe(2)

      // SessionProcessor writes `{type:"busy"}` at EVERY step of a turn. A
      // count carried inside the status union would be gone after this line,
      // which is the whole reason it is kept beside it instead.
      yield* status.set(sessionID, { type: "busy" })
      expect(yield* status.queued(sessionID)).toBe(2)

      // A retry status is still the same turn, so the queue behind it stands.
      yield* status.set(sessionID, { type: "retry", attempt: 1, message: "rate limited", next: 1000 })
      expect(yield* status.queued(sessionID)).toBe(2)

      // Idle is the drain: the turn ended, so nothing is behind it any more.
      yield* status.set(sessionID, { type: "idle" })
      expect(yield* status.queued(sessionID)).toBe(0)
    }),
  )

  it.instance("puts the count on the published session.status event, where the API and UI read it", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const events = yield* EventV2Bridge.Service
      const sessionID = SessionID.make("ses_queued_wire")
      const seen = yield* Ref.make<number[]>([])

      const unsubscribe = yield* events.listen((event) =>
        event.type === "session.status"
          ? Ref.update(seen, (all) => [...all, ((event.data as { queued?: number }).queued ?? -1)])
          : Effect.void,
      )

      yield* status.set(sessionID, { type: "busy" })
      yield* status.bumpQueued(sessionID)
      yield* status.bumpQueued(sessionID)
      yield* status.set(sessionID, { type: "idle" })
      yield* unsubscribe

      // busy(0), bump(1), bump(2), idle(0) - the idle event must not claim a
      // queue that has just drained.
      expect(yield* Ref.get(seen)).toEqual([0, 1, 2, 0])
    }),
  )
})
