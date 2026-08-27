// The model-facing half of goal mode, driven through the real tool against the
// real session store. What it has to get right is the state machine a chat sees:
// set writes a record the engine loop will read, clear removes it, status never
// invents one, and a set with no condition changes nothing rather than starting
// a loop against an empty string.
import { describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { SessionProjector } from "@origami/core/session/projector"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { GoalTool } from "@/tool/goal"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { MessageID, type SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Todo.node,
      Truncate.node,
      Agent.node,
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

type Ask = { permission: string }
const context = (sessionID: SessionID, asks: Ask[]) => ({
  sessionID,
  messageID: MessageID.make("msg_goal_test"),
  callID: "call_goal",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (input: { permission: string }) =>
    Effect.sync(() => {
      asks.push({ permission: input.permission })
    }),
})

const tool = Effect.gen(function* () {
  const info = yield* GoalTool
  return yield* info.init()
})

describe("tool.goal", () => {
  it.instance("set writes a record the engine loop can read back off the row", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      const asks: Ask[] = []
      const goal = yield* tool

      const result = yield* goal.execute(
        { action: "set", condition: "  bun test packages/engine passes  ", max_rounds: 4 },
        context(chat.id, asks),
      )

      expect(result.title).toBe("Goal set")
      const stored = Session.goal(yield* sessions.get(chat.id))!
      // Trimmed: a condition with trailing spaces is the same condition, and the
      // reader treats a whitespace-only one as no goal at all.
      expect(stored.text).toBe("bun test packages/engine passes")
      expect(stored.active).toBe(true)
      expect(stored.rounds).toBe(0)
      expect(stored.maxRounds).toBe(4)
      expect(asks.map((ask) => ask.permission)).toEqual(["goal"])
    }),
  )

  it.instance("set with no condition changes nothing", () =>
    Effect.gen(function* () {
      // A goal whose condition is the empty string would send a critic to
      // verify nothing, every turn, until the budget ran out.
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      const goal = yield* tool

      const result = yield* goal.execute({ action: "set", condition: "   " }, context(chat.id, []))
      expect(result.title).toBe("Goal not set")
      expect(Session.goal(yield* sessions.get(chat.id))).toBeUndefined()
    }),
  )

  it.instance("set defaults the budget rather than trusting a nonsense one", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      const goal = yield* tool

      yield* goal.execute({ action: "set", condition: "x", max_rounds: 0 }, context(chat.id, []))
      expect(Session.goal(yield* sessions.get(chat.id))?.maxRounds).toBe(Session.GOAL_MAX_ROUNDS_DEFAULT)
    }),
  )

  it.instance("set RESTARTS the budget, so a re-set never inherits a spent one", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: Session.withGoal(chat.metadata, {
          text: "old",
          active: true,
          rounds: 9,
          maxRounds: 10,
          createdAt: 1,
          criticErrors: 1,
        }),
      })
      const goal = yield* tool

      yield* goal.execute({ action: "set", condition: "new condition" }, context(chat.id, []))
      const stored = Session.goal(yield* sessions.get(chat.id))!
      expect(stored.text).toBe("new condition")
      expect(stored.rounds).toBe(0)
      expect(stored.criticErrors).toBeUndefined()
    }),
  )

  it.instance("clear removes the record", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      const goal = yield* tool
      yield* goal.execute({ action: "set", condition: "the suite is green" }, context(chat.id, []))

      const result = yield* goal.execute({ action: "clear" }, context(chat.id, []))
      expect(result.title).toBe("Goal cleared")
      expect(result.output).toContain("the suite is green")
      expect(Session.goal(yield* sessions.get(chat.id))).toBeUndefined()
    }),
  )

  it.instance("clear on a chat with no goal says so instead of writing one", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      const goal = yield* tool

      const result = yield* goal.execute({ action: "clear" }, context(chat.id, []))
      expect(result.title).toBe("No goal to clear")
      expect(Session.goal(yield* sessions.get(chat.id))).toBeUndefined()
    }),
  )

  it.instance("status reports the live record and asks no permission", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      const asks: Ask[] = []
      const goal = yield* tool

      const empty = yield* goal.execute({ action: "status" }, context(chat.id, asks))
      expect(empty.output).toBe("No goal is set for this session.")

      yield* goal.execute({ action: "set", condition: "the suite is green", max_rounds: 5 }, context(chat.id, []))
      const active = yield* goal.execute({ action: "status" }, context(chat.id, asks))
      expect(active.output).toContain("active, round 0/5")
      expect(active.output).toContain("the suite is green")
      // A read behind a permission prompt teaches people to click through
      // prompts, so `status` never asks. Only the two writes did.
      expect(asks).toHaveLength(0)
    }),
  )

  it.instance("status distinguishes a MET goal from an abandoned one", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "goal chat" })
      const goal = yield* tool
      const base = { text: "the suite is green", active: false, rounds: 3, maxRounds: 3, createdAt: 1 }

      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: Session.withGoal(chat.metadata, { ...base, completed: true, lastVerdict: "success" }),
      })
      expect((yield* goal.execute({ action: "status" }, context(chat.id, []))).output).toContain("met (verified)")

      yield* sessions.setMetadata({
        sessionID: chat.id,
        metadata: Session.withGoal((yield* sessions.get(chat.id)).metadata, {
          ...base,
          lastVerdict: "error_max_turns",
        }),
      })
      const gaveUp = (yield* goal.execute({ action: "status" }, context(chat.id, []))).output
      expect(gaveUp).toContain("error_max_turns")
      expect(gaveUp).not.toContain("met (verified)")
    }),
  )
})
