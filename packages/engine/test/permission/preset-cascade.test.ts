import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { Effect, Exit, Fiber } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { FlockRouting } from "@/flock/routing"
import { Permission } from "@/permission"
import { PermissionPresets } from "@/permission/presets"
import { Provider } from "@/provider/provider"
import { Ripgrep } from "@origami/core/ripgrep"
import { Session } from "@/session/session"
import { writeSessionPermission } from "@/session/permission-write"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

/**
 * The YOLO button, from the button press to the sub-agent's next ask.
 *
 * A `task` child is handed a COPY of the parent's ruleset when it is spawned
 * (tool/task.ts -> deriveSubagentSessionPermission). The copy never moved again:
 * a child spawned while the chat was on `default` kept asking for the rest of
 * its life, even after the user pressed YOLO on the parent, because the preset
 * write only ever landed on the parent's own row. The owner's 2026-09-04 run
 * shows exactly that split - the parent answering `external_directory` with the
 * `*` allow while three explore children were still being asked about
 * `C:\Repos\Origami Coder\...`.
 *
 * These tests drive the real writer (`writeSessionPermission`, what the HTTP
 * `session.update` route and `session/prompt.ts`'s `tools` map both call) over
 * real session rows, and assert the decision the tool gate would reach -
 * `Permission.merge(agent.permission, live.permission)`, the expression
 * session/tools.ts builds per ask.
 */

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    FlockRouting.node,
    Permission.node,
    Provider.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
  ]),
  [[RuntimeFlags.node, RuntimeFlags.layer({})]],
)

const it = testEffect(layer)

/** A path this test's instance directory never contains, so the gate fires. */
const OUTSIDE = process.platform === "win32" ? "C:\\Repos\\Origami Coder\\*" : "/repos/origami-coder/*"

const seed = Effect.fn("PresetCascadeTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Pinned" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    busy: () => Effect.succeed(false),
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input: SessionPrompt.PromptInput) =>
      Effect.sync(() => {
        const id = MessageID.ascending()
        return {
          info: {
            id,
            role: "assistant" as const,
            parentID: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            mode: input.agent ?? "explore",
            agent: input.agent ?? "explore",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: input.model?.modelID ?? ref.modelID,
            providerID: input.model?.providerID ?? ref.providerID,
            time: { created: Date.now() },
            finish: "stop" as const,
          },
          parts: [
            { id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text" as const, text: "done" },
          ],
        }
      }),
  }
}

/** Spawn a REAL explore child off `chat`, the way the model's `task` call does. */
const spawnChild = Effect.fn("PresetCascadeTest.spawnChild")(function* (chat: string, assistant: string) {
  const tool = yield* TaskTool
  const def = yield* tool.init()
  yield* def.execute(
    { description: "read the coder repo", prompt: "read it", subagent_type: "explore" },
    {
      sessionID: chat as never,
      messageID: assistant as never,
      agent: "build",
      abort: new AbortController().signal,
      extra: { promptOps: stubOps() },
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    },
  )
  const sessions = yield* Session.Service
  const kids = yield* sessions.children(chat as never)
  return kids[0]!
})

/** The two real writers call `writeSessionPermission` with their own service
 *  handles; this is the same call with the handles resolved here. */
const press = Effect.fn("PresetCascadeTest.press")(function* (sessionID: string, mode: string) {
  const sessions = yield* Session.Service
  const permissions = yield* Permission.Service
  return yield* writeSessionPermission(
    { sessions, permissions },
    { sessionID: sessionID as never, permission: PermissionPresets.rules(mode) },
  )
})

/** The ruleset session/tools.ts hands `Permission.ask` for a session's next call. */
const effectiveFor = Effect.fn("PresetCascadeTest.effectiveFor")(function* (sessionID: string) {
  const sessions = yield* Session.Service
  const agents = yield* Agent.Service
  const live = yield* sessions.get(sessionID as never)
  const agent = yield* agents.get(live.agent ?? "build")
  return Permission.merge(agent!.permission, live.permission ?? [])
})

describe("permission preset cascade", () => {
  // H1 - the reported bug. The child exists BEFORE the button is pressed.
  it.instance("YOLO pressed after a subagent is spawned reaches that subagent", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const child = yield* spawnChild(chat.id, assistant.id)

      // Before the press: the child asks, which is correct.
      expect(Permission.evaluate("external_directory", OUTSIDE, yield* effectiveFor(child.id)).action).toBe("ask")

      // The press. Same call the HTTP `session.update` route makes.
      yield* press(chat.id, "bypass")

      // The parent stops asking...
      expect(Permission.evaluate("external_directory", OUTSIDE, yield* effectiveFor(chat.id)).action).toBe("allow")
      // ...and so does the child that was already running.
      expect(Permission.evaluate("external_directory", OUTSIDE, yield* effectiveFor(child.id)).action).toBe("allow")

      // A real ask on the child's ruleset returns instead of parking a request.
      const permission = yield* Permission.Service
      yield* permission.ask({
        sessionID: child.id,
        permission: "external_directory",
        patterns: [OUTSIDE],
        always: [OUTSIDE],
        metadata: {},
        ruleset: yield* effectiveFor(child.id),
      })
      expect(yield* permission.list()).toHaveLength(0)
    }),
  )

  // The other direction: taking the chat back OFF bypass has to reach the child
  // too, or the grant outlives the answer the user changed.
  it.instance("dropping back to default revokes the grant from a live subagent", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      yield* press(chat.id, "bypass")
      const child = yield* spawnChild(chat.id, assistant.id)
      expect(Permission.evaluate("external_directory", OUTSIDE, yield* effectiveFor(child.id)).action).toBe("allow")

      yield* press(chat.id, "default")
      expect(Permission.evaluate("external_directory", OUTSIDE, yield* effectiveFor(child.id)).action).toBe("ask")
    }),
  )

  // H3 - the structural denies a subagent is spawned with sit AFTER the
  // inherited preset rule, and `evaluate` takes the LAST match, so bypass must
  // not hand a subagent the peer tools it was denied.
  it.instance("the cascade does not open the subagent's structural denies", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const child = yield* spawnChild(chat.id, assistant.id)
      yield* press(chat.id, "bypass")

      const effective = yield* effectiveFor(child.id)
      expect(Permission.evaluate("task", "explore", effective).action).toBe("deny")
      expect(Permission.evaluate("send_message", "*", effective).action).toBe("deny")
    }),
  )

  // The walk is PRESET-SCOPED, both ways round. `auto` travels like `bypass`
  // does, and a writer that leaves the preset alone - collab/seal.ts appends its
  // denies to the row it just read - must not touch a child at all.
  it.instance("only a preset change moves a subagent's ruleset", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const permissions = yield* Permission.Service
      const { chat, assistant } = yield* seed()
      const child = yield* spawnChild(chat.id, assistant.id)

      yield* press(chat.id, "auto")
      expect(Permission.evaluate("edit", "src/main.ts", yield* effectiveFor(child.id)).action).toBe("allow")

      // A seal-shaped write: the row it read, plus a deny. Same preset, so the
      // child keeps the ruleset it has and gains nothing from the parent.
      const before = yield* sessions.get(child.id)
      const parent = (yield* sessions.get(chat.id)).permission ?? []
      // A clear millisecond, so an unwanted walk shows up as a moved `updated`.
      yield* Effect.sleep("5 millis")
      yield* writeSessionPermission(
        { sessions, permissions },
        {
          sessionID: chat.id,
          permission: [...parent, { permission: "bash", pattern: "*", action: "deny" as const }],
        },
      )
      const after = yield* sessions.get(child.id)
      expect(after.permission ?? []).toEqual(before.permission ?? [])
      // Not rewritten at all - the walk never reached this row.
      expect(after.time.updated).toBe(before.time.updated)
    }),
  )

  // H4 - the ask that was ALREADY on screen when the button was pressed.
  it.instance("a pending ask is released by the preset write that would allow it", () =>
    Effect.gen(function* () {
      const { chat } = yield* seed()
      const permission = yield* Permission.Service
      const ruleset = yield* effectiveFor(chat.id)

      const asking = yield* permission
        .ask({
          sessionID: chat.id,
          permission: "external_directory",
          patterns: [OUTSIDE],
          always: [OUTSIDE],
          metadata: {},
          ruleset,
        })
        .pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const list = yield* permission.list()
          return list.length > 0 ? list : undefined
        }),
        "the ask never became pending",
      )

      yield* press(chat.id, "bypass")

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const list = yield* permission.list()
          return list.length === 0 ? true : undefined
        }),
        "the pending ask survived the YOLO press",
        "2 seconds",
      )
      yield* Fiber.join(asking)
    }),
  )

  // H5 - the ask that landed one beat too LATE for H4's fix to reach. Unlike
  // H4 (parked BEFORE the press, so refresh's own iteration finds and releases
  // it), this ask is only HANDED the ruleset from before the press - the way a
  // caller that read `live.permission` a moment too early would - and does not
  // reach `pending` until AFTER the press's `refresh` has already run its one
  // pass over it. `refresh` iterates once; a request not in `pending` yet is
  // invisible to it and, without the fix, never gets a second look.
  it.instance("an ask handed the pre-bypass ruleset is not stranded when the refresh it needed already ran", () =>
    Effect.gen(function* () {
      const { chat } = yield* seed()
      const permission = yield* Permission.Service
      // Captured BEFORE the press - "ask" for OUTSIDE, same as H1's assertion.
      const staleRuleset = yield* effectiveFor(chat.id)

      // The press's refresh runs to completion here, over a `pending` map that
      // does not contain this ask yet - it has not even been called.
      yield* press(chat.id, "bypass")

      // Only now does the ask arrive, still carrying the ruleset from before
      // the press. Forked: with the bug, this never resolves (parked with no
      // refresh left to release it), so join it under a bounded timeout rather
      // than hanging the suite on a real regression.
      const asking = yield* permission
        .ask({
          sessionID: chat.id,
          permission: "external_directory",
          patterns: [OUTSIDE],
          always: [OUTSIDE],
          metadata: {},
          ruleset: staleRuleset,
        })
        .pipe(Effect.forkScoped)

      const exit = yield* Fiber.await(asking).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.fail(new Error("the ask parked on the pre-bypass ruleset and was never released")),
        }),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  )
})
