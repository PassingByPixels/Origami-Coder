// t-w2qlop: the idle report reads the REAL owners of each piece of live state.
//
// ext-methods.test.ts drives the report through hand-made probes. This file
// proves the owners themselves register them: a real permission ask, a real
// question, real background jobs and a real session status write each show up
// in `ElasticIdle.report()`, and each clears when the state does. A reason that
// no owner feeds would pass the first file and fail here.
import { afterEach, beforeEach, expect } from "bun:test"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { ElasticActivity } from "@/elastic/activity"
import { ElasticIdle } from "@/elastic/idle"
import { ElasticOs } from "@/elastic/os"
import { ElasticState } from "@/elastic/state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Question } from "@/question"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { ShellID } from "@/tool/shell/id"
import { testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node,
      Question.node,
      BackgroundJob.node,
      SessionStatus.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [[InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)

const applied: string[] = []
beforeEach(() => {
  applied.length = 0
  ElasticOs.setForTest({
    apply: (cls) => {
      applied.push(cls)
      return { priority: "normal", ecoqos: false }
    },
    trim: () => ({ trimmed: false, reason: "fake" }),
  })
})
afterEach(() => {
  ElasticState.resetForTest()
  ElasticIdle.resetForTest()
  ElasticOs.setForTest(undefined)
})

const reasons = () => ElasticIdle.report().reasons

/** Poll a condition the forked fiber reaches on its own schedule. */
const until = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200 && !check(); i++) yield* Effect.sleep("5 millis")
    expect(check()).toBe(true)
  })

it.instance(
  "a pending permission ask is a reason until it is answered",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const fiber = yield* permission
        .ask({
          sessionID: SessionID.make("ses_ask"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        })
        .pipe(Effect.forkScoped)
      yield* until(() => reasons().includes("permission-pending"))
      for (const request of yield* permission.list()) yield* permission.reply({ requestID: request.id, reply: "reject" })
      yield* Fiber.await(fiber)
      expect(reasons()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "a pending question is a reason until it is answered",
  () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      const fiber = yield* question
        .ask({
          sessionID: SessionID.make("ses_q"),
          questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }] }],
        })
        .pipe(Effect.forkScoped)
      yield* until(() => reasons().includes("question-pending"))
      for (const request of yield* question.list()) yield* question.reject(request.id)
      yield* Fiber.await(fiber)
      expect(reasons()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "a running shell job is a background job, a running agent job is a sub-agent, and both clear when they finish",
  () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const release = yield* Deferred.make<void>()
      const shell = yield* jobs.start({ type: ShellID.ToolID, run: Deferred.await(release).pipe(Effect.as("ok")) })
      const child = yield* jobs.start({
        id: "ses_child",
        type: "general",
        run: Deferred.await(release).pipe(Effect.as("ok")),
      })
      expect(reasons()).toEqual(["subagent-running", "background-job"])
      yield* Deferred.succeed(release, undefined)
      yield* jobs.wait({ id: shell.id })
      yield* jobs.wait({ id: child.id })
      expect(reasons()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "a busy session status is a running turn, and it holds a requested idle at background",
  () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const session = SessionID.make("ses_turn")
      ElasticIdle.setClass("idle")
      expect(applied).toEqual(["idle"])

      yield* status.set(session, { type: "busy" })
      expect(reasons()).toEqual(["turn-running"])
      expect(ElasticState.effectiveClass()).toBe("background")
      expect(applied).toEqual(["idle", "background"])

      yield* status.set(session, { type: "idle" })
      expect(reasons()).toEqual([])
      expect(ElasticState.effectiveClass()).toBe("idle")
      expect(applied).toEqual(["idle", "background", "idle"])
    }),
  { git: true },
)

it.instance(
  "the probes of a disposed instance go with it",
  () =>
    Effect.gen(function* () {
      yield* SessionStatus.Service.use((status) => status.get(SessionID.make("ses_x")))
      const during = ElasticActivity.probeCount("session-busy")
      expect(during).toBeGreaterThan(0)
      yield* InstanceStore.Service.use((store) => store.disposeAll())
      expect(ElasticActivity.probeCount("session-busy")).toBeLessThan(during)
    }),
  { git: true },
)
