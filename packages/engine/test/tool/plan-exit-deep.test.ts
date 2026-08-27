// PLAN_EXIT IS WHERE THE TWO PLANNING MODES DIVERGE, and it is a one-line
// divergence hiding a product decision. Plan mode's approval is a start order:
// "you can now edit files. Execute the plan". Deep plan's approval is a
// HANDOVER - the user approved a researched, critiqued plan as a deliverable in
// its own right, and reading it as "begin" would start a large piece of work
// nobody commissioned, which is the exact outcome deep plan exists to prevent.
//
// Both branches are driven through the REAL tool against a real session store,
// because the durable half (setAgentModel) and the message half (updatePart)
// are two separate writes and only one of them shows up in the tool's return.
import { describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { SessionProjector } from "@origami/core/session/projector"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Plugin } from "@/plugin"
import { PlanExitTool } from "@/tool/plan"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { Skill } from "@/skill"
import { Todo } from "@/session/todo"
import { Truncate } from "@/tool/truncate"
import { MessageID, type SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

/** What the mocked user picks, and what they were shown when they picked it. */
let answer = "Yes"
let asked: { question: string; options: string[] }[] = []

const question = Layer.succeed(
  Question.Service,
  Question.Service.of({
    ask: (input: { questions: ReadonlyArray<{ question: string; options?: ReadonlyArray<{ label: string }> }> }) =>
      Effect.sync(() => {
        for (const item of input.questions) {
          asked.push({ question: item.question, options: (item.options ?? []).map((option) => option.label) })
        }
        return [[answer]]
      }),
    reply: () => Effect.void,
    reject: () => Effect.void,
    list: () => Effect.succeed([]),
  } as never),
)

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
      Plugin.node,
      Provider.node,
      Auth.node,
      Config.node,
      Skill.node,
      Question.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [Question.node, question],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const context = (sessionID: SessionID, agent: string) => ({
  sessionID,
  messageID: MessageID.make("msg_plan_exit_test"),
  callID: "call_plan_exit",
  agent,
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const tool = Effect.gen(function* () {
  const info = yield* PlanExitTool
  return yield* info.init()
})

/** The synthetic user text plan_exit wrote into the chat, if any. */
const syntheticText = (messages: readonly { info: { role: string }; parts: readonly unknown[] }[]) =>
  messages
    .flatMap((message) => message.parts as { type: string; synthetic?: boolean; text?: string }[])
    .filter((part) => part.type === "text" && part.synthetic === true)
    .map((part) => part.text ?? "")
    .join("\n---\n")

/** A chat with a user message carrying a model, which is what plan_exit reads
 *  to decide which model the build turn runs on. */
const chatWith = (title: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title })
    yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: chat.id,
      role: "user",
      time: { created: Date.now() },
      agent: "deep-plan",
      model: { modelID: "test-model", providerID: "test-provider", variant: "default" },
    } as never)
    return chat
  })

describe("plan_exit in deep-plan mode", () => {
  it.instance("DELIVERS the plan folder and does not order it executed", () =>
    Effect.gen(function* () {
      answer = "Yes"
      asked = []
      const sessions = yield* Session.Service
      const chat = yield* chatWith("deep plan chat")
      const exit = yield* tool

      const result = yield* exit.execute({}, context(chat.id, "deep-plan"))

      // The durable half: the session really is on build now, so the next step
      // runs with build permissions rather than deep-plan's folder-only edit.
      expect((yield* sessions.get(chat.id)).agent).toBe("build")

      const text = syntheticText(yield* sessions.messages({ sessionID: chat.id }))
      // THE ASSERTION THIS FILE EXISTS FOR.
      expect(text).toContain("DELIVERED")
      expect(text).toContain("Do NOT begin executing it")
      expect(text).toContain("stop and wait for the user")
      // Plan mode's start order, verbatim. Inheriting either half of it is the
      // failure: "you can now edit files" is true and harmless, "Execute the
      // plan" is the sentence that would start the work.
      expect(text).not.toContain("Execute the plan")
      expect(text).not.toContain("you can now edit files")
      expect(result.title).toBe("Deep plan delivered")

      // What the USER was shown has to say the same thing. An option labelled
      // "start implementing the plan" is a promise the synthetic message then
      // breaks.
      expect(asked).toHaveLength(1)
      expect(asked[0]!.question).toContain("Deliver it")
      expect(asked[0]!.options).toEqual(["Yes", "No", "Revise"])
    }),
  )

  it.instance("names the FOLDER, not a markdown file", () =>
    Effect.gen(function* () {
      answer = "Yes"
      asked = []
      const sessions = yield* Session.Service
      const chat = yield* chatWith("deep plan chat")
      const exit = yield* tool

      yield* exit.execute({}, context(chat.id, "deep-plan"))

      const stem = `${(yield* sessions.get(chat.id)).time.created}-${(yield* sessions.get(chat.id)).slug}`
      const text = syntheticText(yield* sessions.messages({ sessionID: chat.id }))
      expect(text).toContain(stem)
      // `<stem>.md` is plan mode's deliverable and a different thing entirely.
      expect(text).not.toContain(`${stem}.md`)
    }),
  )

  it.instance("stays in deep-plan mode on Revise", () =>
    Effect.gen(function* () {
      answer = "Revise"
      asked = []
      const sessions = yield* Session.Service
      const chat = yield* chatWith("deep plan chat")
      const exit = yield* tool

      // Rejected, exactly as plan mode's is - the SHELL then sends the user's
      // revision text as the next turn, and the engine only declines the switch.
      const outcome = yield* exit.execute({}, context(chat.id, "deep-plan")).pipe(Effect.exit)
      expect(outcome._tag).toBe("Failure")
      expect((yield* sessions.get(chat.id)).agent).not.toBe("build")
      expect(syntheticText(yield* sessions.messages({ sessionID: chat.id }))).toBe("")
    }),
  )
})

describe("plan_exit in plan mode is unchanged", () => {
  it.instance("still hands the build agent a plan to execute", () =>
    Effect.gen(function* () {
      answer = "Yes"
      asked = []
      const sessions = yield* Session.Service
      const chat = yield* chatWith("plan chat")
      const exit = yield* tool

      const result = yield* exit.execute({}, context(chat.id, "plan"))

      expect((yield* sessions.get(chat.id)).agent).toBe("build")
      const text = syntheticText(yield* sessions.messages({ sessionID: chat.id }))
      expect(text).toContain("you can now edit files. Execute the plan")
      expect(text).not.toContain("DELIVERED")
      expect(result.title).toBe("Switching to build agent")
      expect(asked[0]!.question).toContain("start implementing")
    }),
  )
})

describe("plan_exit outside a planning mode", () => {
  it.instance("no-ops gently rather than asking a confusing question", () =>
    Effect.gen(function* () {
      asked = []
      const sessions = yield* Session.Service
      const chat = yield* chatWith("build chat")
      const exit = yield* tool

      const result = yield* exit.execute({}, context(chat.id, "build"))

      expect(result.title).toBe("Not in plan mode")
      expect(asked).toHaveLength(0)
      // Widening the guard from `!== "plan"` to a two-agent set must not have
      // turned the no-op into a real switch for everyone else.
      expect((yield* sessions.get(chat.id)).agent).not.toBe("build_switched")
      expect(syntheticText(yield* sessions.messages({ sessionID: chat.id }))).toBe("")
    }),
  )
})
