// The goal record has to SURVIVE - a completion condition that vanishes when
// the row is re-read is a loop that stops silently and never says so. These
// drive the real Session service against the real `SessionTable.metadata`
// column, so they catch what a pure round-trip of the helpers cannot: a write
// that never reaches the row, a read that decodes it back into a different
// shape, and a fork that drops it.
import { describe, expect } from "bun:test"
import { SessionProjector } from "@origami/core/session/projector"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Todo.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const goal = (over: Partial<Session.Goal> = {}): Session.Goal => ({
  text: "bun test packages/engine passes",
  active: true,
  rounds: 0,
  maxRounds: 10,
  createdAt: 1_700_000_000_000,
  ...over,
})

describe("the goal record on the session row", () => {
  it.instance("survives a write and a re-read of the row", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      expect(Session.goal(chat)).toBeUndefined()

      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: Session.withGoal(chat.metadata, goal({ rounds: 2 })),
      })

      const reread = yield* sessions.get(chat.id)
      expect(Session.goal(reread)).toEqual(goal({ rounds: 2 }))
    }),
  )

  it.instance("carries every other metadata key through a goal write", () =>
    Effect.gen(function* () {
      // The bag is shared with `subagentModel`, `compactionThreshold` and
      // `visionProfile`. A writer that rebuilt it would silently delete the
      // chat's model override the first time a goal was set.
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat", metadata: { visionProfile: "eyes" } })

      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: Session.withGoal((yield* sessions.get(chat.id)).metadata, goal()),
      })
      const withBoth = yield* sessions.get(chat.id)
      expect(Session.visionProfile(withBoth)).toBe("eyes")
      expect(Session.goal(withBoth)?.text).toBe("bun test packages/engine passes")

      // ...and clearing the goal leaves the neighbour alone.
      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: Session.withGoal(withBoth.metadata, undefined),
      })
      const cleared = yield* sessions.get(chat.id)
      expect(Session.goal(cleared)).toBeUndefined()
      expect(Session.visionProfile(cleared)).toBe("eyes")
    }),
  )

  it.instance("is copied onto a fork, so a branched chat keeps working toward it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: Session.withGoal(chat.metadata, goal({ rounds: 4, maxRounds: 6 })),
      })

      const forked = yield* sessions.fork({ sessionID: chat.id })
      expect(forked.id).not.toBe(chat.id)
      expect(Session.goal(forked)).toEqual(goal({ rounds: 4, maxRounds: 6 }))

      // Deep-copied, not shared: advancing the fork's round count must not move
      // the original's.
      yield* sessions.setMetadata({
        sessionID: forked.id,
        metadata: Session.withGoal(forked.metadata, goal({ rounds: 5, maxRounds: 6 })),
      })
      expect(Session.goal(yield* sessions.get(chat.id))?.rounds).toBe(4)
    }),
  )

  it.instance("reads a half-written record as NO goal rather than a broken one", () =>
    Effect.gen(function* () {
      // Fail-closed on purpose. A record with no text would start a loop that
      // asks a critic to verify the empty string, and a NaN budget would never
      // reach its limit - the failure mode of this loop is spend.
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      for (const broken of [{}, { text: "   ", active: true }, { active: true }, "a string", 7, null]) {
        yield* sessions.setMetadata({ sessionID: chat.id, metadata: { goal: broken } })
        expect(Session.goal(yield* sessions.get(chat.id))).toBeUndefined()
      }
    }),
  )

  it.instance("clamps a nonsense round budget instead of trusting it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: { goal: { text: "x", active: true, rounds: -4, maxRounds: 0, createdAt: "nope" } },
      })
      const read = Session.goal(yield* sessions.get(chat.id))!
      expect(read.rounds).toBe(0)
      expect(read.maxRounds).toBe(1)
      expect(read.createdAt).toBe(0)
    }),
  )
})
