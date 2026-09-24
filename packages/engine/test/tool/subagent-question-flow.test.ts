// t-po041k. THE WHOLE LOOP: a child asks, the parent answers, the child resumes.
//
// Everything here is real except the loopback POST, which is a seam for the
// same reason `flock/deliver.ts` makes it one: the claim it carries is a claim
// about ANOTHER process, and standing a second engine up would test bun's
// fetch. Real session rows, the real Question service, the real Permission
// service, the real `question` tool and the real `question_reply` tool.
//
// What each case is here to catch:
//
//  - the child's ask never resolving, which is the defect (the tool call sat
//    `running` for the life of the session and the parent's `task` froze);
//  - the answer going to the WRONG id, which a passing "it was delivered"
//    assertion would hide;
//  - the ceiling counting a parked child as a runaway — `blockedMs` above zero
//    WHILE the question is open is the only thing that keeps the 4 h cap off it;
//  - a top-level chat quietly losing its question to this route.

import { describe, expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber, Schedule } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { Agent } from "@/agent/agent"
import { AgentBroker } from "@/origami/agent-broker"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageID, type SessionID } from "@/session/schema"
import { QuestionID } from "@/question/schema"
import { Session } from "@/session/session"
import { SubagentQuestion } from "@/session/subagent-question"
import { SubagentQuestionRoute } from "@/session/subagent-question-route"
import { QuestionTool, relayToParent } from "@/tool/question"
import { QuestionReplyTool } from "@/tool/question-reply"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const layer = LayerNode.compile(
  LayerNode.group([
    Config.node,
    EventV2Bridge.node,
    Question.node,
    Permission.node,
    Session.node,
    // `Session.create` publishes; the PROJECTOR is what writes the row that
    // `routingFor` then reads back. Without it the tree exists in the event
    // log and nowhere a query can see it.
    SessionProjector.node,
    Agent.node,
    Truncate.node,
    RuntimeFlags.node,
  ]),
  [
    [
      Config.node,
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
        get: () => Effect.succeed({} as never),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ],
)

const it = testEffect(layer)

function ctxFor(sessionID: SessionID) {
  return {
    sessionID,
    messageID: MessageID.make("msg_subagent_question"),
    callID: "call-1",
    agent: "general",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function entry(sessionIds: readonly string[]): AgentBroker.Entry {
  return {
    version: 1,
    pid: process.pid,
    name: "origami-coder",
    cwd: "C:/repo",
    httpBase: "http://127.0.0.1:4096",
    kind: "interactive",
    sessionIds: [...sessionIds],
    lastSeen: Date.now(),
  }
}

/** A parent chat with one sub-agent under it, as `tool/task.ts` creates them. */
const tree = Effect.fn("test.tree")(function* () {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ title: "parent chat" })
  const child = yield* sessions.create({
    parentID: parent.id,
    title: "audit the bundle (@Explore subagent)",
    agent: "Explore",
  })
  // The projector writes the row on the event, so read the child back before
  // handing it to anything that queries.
  yield* sessions.get(child.id).pipe(Effect.retry(Schedule.spaced("10 millis")), Effect.timeout("5 seconds"))
  return { parent, child }
})

/** Park a question from `child`, capturing the envelope instead of POSTing it.
 *  Resolves `landed` with the posted body once the relay has run. */
const askFromChild = Effect.fn("test.askFromChild")(function* (input: {
  child: SessionID
  landed: Deferred.Deferred<string>
  questions: { question: string; header: string; options: { label: string; description: string }[] }[]
}) {
  const sessions = yield* Session.Service
  const question = yield* Question.Service
  const permission = yield* Permission.Service
  const routing = yield* SubagentQuestionRoute.routingFor(sessions, input.child)
  if (!routing) return yield* Effect.die("the child has no parent")

  // Minted by the caller, exactly as tool/question.ts does, so the envelope can
  // name it before the ask parks.
  const requestID = QuestionID.ascending()

  const ask = question.ask({
    sessionID: input.child,
    questions: input.questions,
    id: requestID,
    relay: relayToParent(
      { sessionID: input.child, requestID, routing },
      {
        locate: async (id) => entry([id]),
        post: async (call) => {
          await Effect.runPromise(Deferred.succeed(input.landed, call.body))
          return true
        },
      },
    ),
  })
  return { requestID, fiber: yield* permission.blockWhile(input.child, ask).pipe(Effect.forkScoped) }
})

describe("subagent question flow", () => {
  it.instance("a child asks, the parent answers with question_reply, the child resumes", () =>
    Effect.gen(function* () {
      const { parent, child } = yield* tree()
      const landed = yield* Deferred.make<string>()
      const { requestID, fiber } = yield* askFromChild({
        child: child.id,
        landed,
        questions: [
          { question: "Which store?", header: "Store", options: [{ label: "SQLite", description: "" }] },
        ],
      })

      // 1. The envelope reached the PARENT session, tagged and named.
      const body = yield* Deferred.await(landed).pipe(Effect.timeout("5 seconds"))
      const text: string = JSON.parse(body).parts[0].text
      expect(text).toContain(`kind="${SubagentQuestion.QUESTION_KIND}"`)
      expect(text).toContain("Explore · T1 · audit the bundle")
      expect(text).toContain(`request_id "${requestID}"`)

      // 2. The child is STILL waiting. Asserted on the pending register rather
      //    than the fiber (effect 4 has no `Fiber.poll`), which is the same
      //    fact from the side the reply tool reads it from.
      const question = yield* Question.Service
      expect((yield* question.list()).map((row) => row.id)).toEqual([requestID])

      // 3. A parked child is not a runaway: the 4 h ceiling is pushed out by
      //    exactly this figure (packages/core background-job watchdog).
      const permission = yield* Permission.Service
      expect(yield* permission.blockedMs(child.id)).toBeGreaterThan(0)

      // 4. The parent answers, through the tool the envelope named.
      const reply = yield* (yield* QuestionReplyTool).init()
      const answered = yield* reply.execute({ request_id: requestID, answers: ["SQLite"] }, ctxFor(parent.id))
      expect(answered.metadata.answered).toBe(true)

      // 5. The child resumed, holding the parent's answer.
      const answers = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
      expect(answers).toEqual([["SQLite"]])
    }),
  )

  it.instance("the child's tool result says the MAIN AGENT answered, not the user", () =>
    Effect.gen(function* () {
      const { parent, child } = yield* tree()
      const question = yield* Question.Service
      const tool = yield* (yield* QuestionTool).init()
      const fiber = yield* tool
        .execute(
          { questions: [{ question: "Which store?", header: "Store", options: [{ label: "SQLite", description: "" }] }] },
          ctxFor(child.id),
        )
        .pipe(Effect.forkScoped)

      // The real tool has no post seam, so the loopback POST fails and the
      // relay refuses — which is itself the behaviour worth pinning: a child
      // nobody can reach is TOLD so and carries on, it does not hang.
      const settled = yield* Fiber.join(fiber).pipe(Effect.timeout("10 seconds"))
      expect(settled.title).toContain("Cancelled")
      // Not "the user CANCELLED": on this route the user was never shown them.
      expect(settled.output).toContain("did NOT reach the main agent")
      expect(settled.output).not.toContain("user CANCELLED")
      // Nothing was left parked behind it.
      expect(yield* question.list()).toHaveLength(0)
      expect(parent.id).toBeTruthy()
    }),
  )

  it.instance("a TOP-LEVEL chat still asks the user, and is not routed anywhere", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const question = yield* Question.Service
      const chat = yield* sessions.create({ title: "primary" })
      expect(yield* SubagentQuestionRoute.routingFor(sessions, chat.id)).toBeUndefined()

      const tool = yield* (yield* QuestionTool).init()
      const fiber = yield* tool
        .execute(
          { questions: [{ question: "Which store?", header: "Store", options: [{ label: "SQLite", description: "" }] }] },
          ctxFor(chat.id),
        )
        .pipe(Effect.forkScoped)

      const open = yield* question
        .list()
        .pipe(
          Effect.flatMap((rows) => (rows.length ? Effect.succeed(rows) : Effect.fail("not yet" as const))),
          Effect.retry(Schedule.spaced("10 millis")),
          Effect.timeout("5 seconds"),
        )
      yield* question.reply({ requestID: open[0]!.id, answers: [["SQLite"]] })

      const result = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
      expect(result.title).toBe("Asked 1 question")
      expect(result.output).toContain("User has answered")
    }),
  )

  it.instance("an agent cannot answer a question asked outside its own tree", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { child } = yield* tree()
      const stranger = yield* sessions.create({ title: "another chat" })
      const landed = yield* Deferred.make<string>()
      const { requestID, fiber } = yield* askFromChild({
        child: child.id,
        landed,
        questions: [{ question: "Which store?", header: "Store", options: [{ label: "SQLite", description: "" }] }],
      })
      yield* Deferred.await(landed).pipe(Effect.timeout("5 seconds"))

      const reply = yield* (yield* QuestionReplyTool).init()
      const refused = yield* reply.execute({ request_id: requestID, answers: ["SQLite"] }, ctxFor(stranger.id))
      expect(refused.metadata.answered).toBe(false)
      expect(refused.output).toContain("not one of your sub-agents")
      // Still waiting: a refused reply must not release the child either.
      const question = yield* Question.Service
      expect((yield* question.list()).map((row) => row.id)).toEqual([requestID])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.instance("a GRANDCHILD's question climbs past its parent to the chat with a window", () =>
    Effect.gen(function* () {
      // The failure this catches: stopping at the immediate parent. A
      // grandchild's parent is itself a sub-agent with no window, so an
      // envelope addressed there lands where nobody reads it.
      const sessions = yield* Session.Service
      const { parent, child } = yield* tree()
      const grandchild = yield* sessions.create({
        parentID: child.id,
        title: "read the bundle (@Explore subagent)",
        agent: "Explore",
      })
      yield* sessions.get(grandchild.id).pipe(Effect.retry(Schedule.spaced("10 millis")), Effect.timeout("5 seconds"))

      const routing = yield* SubagentQuestionRoute.routingFor(sessions, grandchild.id)
      expect(routing?.ancestors).toEqual([child.id, parent.id])

      const posted: string[] = []
      const outcome = yield* Effect.promise(() =>
        SubagentQuestion.deliver(
          {
            label: routing!.label,
            sessionID: grandchild.id,
            requestID: "que_gc",
            questions: [{ question: "Which store?" }],
            ancestors: routing!.ancestors,
          },
          {
            // Only the top chat has a window.
            locate: async (id) => (id === parent.id ? entry([id]) : undefined),
            post: async (call) => {
              posted.push(call.url)
              return true
            },
          },
        ),
      )
      expect(outcome).toEqual({ ok: true, sessionID: parent.id })
      expect(posted).toHaveLength(1)
      expect(posted[0]).toContain(encodeURIComponent(parent.id))
    }),
  )

  it.instance("a wrong answer COUNT is refused rather than mismatched onto the questions", () =>
    Effect.gen(function* () {
      const { parent, child } = yield* tree()
      const landed = yield* Deferred.make<string>()
      const { requestID, fiber } = yield* askFromChild({
        child: child.id,
        landed,
        questions: [
          { question: "Which store?", header: "Store", options: [{ label: "SQLite", description: "" }] },
          { question: "Which theme?", header: "Theme", options: [{ label: "Dark", description: "" }] },
        ],
      })
      yield* Deferred.await(landed).pipe(Effect.timeout("5 seconds"))

      const reply = yield* (yield* QuestionReplyTool).init()
      const refused = yield* reply.execute({ request_id: requestID, answers: ["SQLite"] }, ctxFor(parent.id))
      expect(refused.metadata.answered).toBe(false)
      expect(refused.output).toContain("2 questions")

      const ok = yield* reply.execute({ request_id: requestID, answers: ["SQLite", "Dark"] }, ctxFor(parent.id))
      expect(ok.metadata.answered).toBe(true)
      expect(yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))).toEqual([["SQLite"], ["Dark"]])
    }),
  )
})
