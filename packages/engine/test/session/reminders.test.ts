import { describe, expect } from "bun:test"
import { SessionV1 } from "@origami/core/v1/session"
import type { PermissionV1 } from "@origami/core/v1/permission"
import { FSUtil } from "@origami/core/fs-util"
import { Effect, Layer } from "effect"
import type { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionReminders } from "@/session/reminders"
import type { Todo } from "@/session/todo"
import { testEffect } from "../lib/effect"

const layer = Layer.mergeAll(
  RuntimeFlags.layer({}),
  // apply() takes both services but never calls them on this path.
  Layer.mock(FSUtil.Service)({} as never),
  Layer.mock(Session.Service)({}),
)
const { effect: it } = testEffect(layer)

const sessionID = "ses_reminders"
let seq = 0

function partIds(messageID: string) {
  seq++
  return { id: `prt_${seq}`, sessionID, messageID }
}

function userMessage(): SessionV1.WithParts {
  return {
    info: { id: "msg_u1", sessionID, role: "user", time: { created: 1_000 } },
    parts: [{ ...partIds("msg_u1"), type: "text", text: "do the thing" }],
  } as unknown as SessionV1.WithParts
}

function assistantMessage(parts: unknown[]): SessionV1.WithParts {
  return {
    info: { id: "msg_a1", sessionID, role: "assistant", agent: "build", time: { created: 2_000 } },
    parts,
  } as unknown as SessionV1.WithParts
}

/** A finished tool call exactly as the engine stores it. */
function toolCall(tool: string, input: Record<string, unknown>, output = "ok") {
  return {
    ...partIds("msg_a1"),
    type: "tool",
    callID: `call_${seq}`,
    tool,
    state: {
      status: "completed",
      input,
      output,
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

function runningToolCall(tool: string, input: Record<string, unknown>) {
  return {
    ...partIds("msg_a1"),
    type: "tool",
    callID: `call_${seq}`,
    tool,
    state: { status: "running", input, title: tool, time: { start: 1 } },
  }
}

const sleepCall = (seconds = 5) => toolCall("bash", { command: `sleep ${seconds}` })
const TIMED_OUT =
  "(no output)\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 500 ms. Decide which of these it is..."

const apply = (parts: unknown[], agentName = "build") =>
  Effect.gen(function* () {
    const messages = [userMessage(), assistantMessage(parts)]
    const applied = yield* SessionReminders.apply({
      messages,
      agent: { name: agentName } as Agent.Info,
      session: {} as Session.Info,
      todos: [],
    })
    // The TRAILING lane, not the user's message. Reminders must never be
    // written into a message the model has already been sent.
    expect(messages[0]!.parts).toHaveLength(1)
    return applied.reminders
  })

/** The reminder is the only synthetic text this suite can produce. */
function reminders(texts: readonly string[]) {
  return texts.filter((text) => text.includes("blocking shell calls in a row"))
}

describe("SessionReminders wait loops", () => {
  it("stays quiet while the waiting is still occasional", () =>
    Effect.gen(function* () {
      const parts = yield* apply([sleepCall(), sleepCall()])
      expect(reminders(parts)).toHaveLength(0)
    }))

  it("pushes back once the third blocking wait lands in a row", () =>
    Effect.gen(function* () {
      const parts = yield* apply([sleepCall(), sleepCall(), sleepCall()])
      const [reminder] = reminders(parts)
      expect(reminder).toBeDefined()
      expect(reminder!).toContain("3 blocking shell calls in a row")
      // The three ways out, so the model is never left with waiting again as
      // its only option.
      expect(reminder!).toContain("timeout sized to how long it really takes")
      expect(reminder!).toContain("background task with the task tool")
      expect(reminder!).toContain("tell the user what you are waiting for")
    }))

  // THE %-3 GATE, STEP BY STEP. `apply` is called once per model step on a
  // window re-read from the store, so what it answers is a pure function of the
  // streak - it fires at 3, goes quiet at 4 and 5, and fires again at 6 with a
  // new count. That toggle is exactly why this text may not be written into the
  // conversation: on the fake provider it rewrote the head of the request on 4
  // of 8 requests and threw the prefix cache away each time. It is delivered in
  // the trailing lane instead, where it can flip as often as it likes.
  it("fires at three, goes quiet at four and five, and escalates at six", () =>
    Effect.gen(function* () {
      const run = (count: number) => apply(Array.from({ length: count }, () => sleepCall()))

      expect(reminders(yield* run(3))).toHaveLength(1)
      expect(reminders(yield* run(4))).toHaveLength(0)
      expect(reminders(yield* run(5))).toHaveLength(0)
      const six = reminders(yield* run(6))
      expect(six).toHaveLength(1)
      expect(six[0]!).toContain("6 blocking shell calls in a row")
    }))

  it("answers the same bytes twice for the same step, so a re-render cannot move the prompt", () =>
    Effect.gen(function* () {
      // The lane is rebuilt on every step. If two calls on identical state
      // disagreed by so much as a byte, the trailing block would differ for
      // free - harmless where it sits now, and the reason it may not sit
      // anywhere else.
      const parts = [sleepCall(), sleepCall(), sleepCall()]
      expect(yield* apply(parts)).toEqual(yield* apply(parts))
    }))

  it("resets the streak when real work happens between the waits", () =>
    Effect.gen(function* () {
      const parts = yield* apply([
        sleepCall(),
        sleepCall(),
        toolCall("read", { filePath: "/tmp/x" }),
        sleepCall(),
        sleepCall(),
      ])
      expect(reminders(parts)).toHaveLength(0)
    }))

  it("counts only the trailing run, so waits after real work still add up", () =>
    Effect.gen(function* () {
      const parts = yield* apply([
        sleepCall(),
        toolCall("read", { filePath: "/tmp/x" }),
        sleepCall(),
        sleepCall(),
        sleepCall(),
      ])
      expect(reminders(parts)).toHaveLength(1)
    }))

  it("does not count a shell call that has not finished", () =>
    Effect.gen(function* () {
      const parts = yield* apply([sleepCall(), sleepCall(), runningToolCall("bash", { command: "sleep 5" })])
      expect(reminders(parts)).toHaveLength(0)
    }))

  it("treats re-running the same command as waiting on it", () =>
    Effect.gen(function* () {
      const poll = () => toolCall("bash", { command: "  GIT   status  " })
      // Three repeats of the one before it - the first call of the run is work,
      // not a repeat.
      const parts = yield* apply([poll(), poll(), poll(), poll()])
      const [reminder] = reminders(parts)
      expect(reminder!).toContain("3 blocking shell calls in a row")

      const shorter = yield* apply([poll(), poll(), poll()])
      expect(reminders(shorter)).toHaveLength(0)
    }))

  it("leaves real work alone when a wait word appears inside the command", () =>
    Effect.gen(function* () {
      const parts = yield* apply([
        toolCall("bash", { command: "npm run watch:build" }),
        toolCall("bash", { command: "bun test --timeout 30000" }),
        toolCall("bash", { command: "grep -n sleep src/tool/shell.ts" }),
      ])
      expect(reminders(parts)).toHaveLength(0)
    }))

  it("counts a command the shell tool killed on timeout", () =>
    Effect.gen(function* () {
      const parts = yield* apply([
        toolCall("bash", { command: "bun test" }, TIMED_OUT),
        toolCall("bash", { command: "bun run build" }, TIMED_OUT),
        toolCall("bash", { command: "bun test --watch" }, TIMED_OUT),
      ])
      expect(reminders(parts)).toHaveLength(1)
    }))

  it("fires for every agent, not just build", () =>
    Effect.gen(function* () {
      const parts = yield* apply([sleepCall(), sleepCall(), sleepCall()], "plan")
      expect(reminders(parts)).toHaveLength(1)
    }))
})

// A model that watches a background sub-agent by re-listing it. The result is
// PUSHED into the conversation when the task settles, so a poll loop cannot make
// it arrive sooner - it only burns the window. The tool description already says
// so and gets ignored, so the wait-loop channel has to say it instead.
describe("SessionReminders task_list polling", () => {
  const poll = () => toolCall("task_list", {}, "- tsk_1 [running] build the thing (12s running)")

  /** The poll reminder is the only synthetic text naming the tool. */
  function pollReminders(texts: readonly string[]) {
    return texts.filter((text) => text.includes("times in a row"))
  }

  it("stays quiet while the model is only checking occasionally", () =>
    Effect.gen(function* () {
      const parts = yield* apply([poll(), poll()])
      expect(pollReminders(parts)).toHaveLength(0)
    }))

  it("pushes back once the third poll in a row lands", () =>
    Effect.gen(function* () {
      const parts = yield* apply([poll(), poll(), poll()])
      const [reminder] = pollReminders(parts)
      expect(reminder).toBeDefined()
      expect(reminder!).toContain("called task_list 3 times in a row")
      // Why polling is pointless, in mechanism terms rather than as an order.
      // origami_change (t-41dz9f): this used to assert the literal `<task_result>`
      // tag, which named the SUB-AGENT shape only. Background shell jobs now
      // push their endings too, in a `<shell>` block, so the sentence names the
      // mechanism instead of one of its two spellings - and the claim it makes
      // is finally true of both.
      expect(reminder!).toContain("background task or command settles")
      expect(reminder!).toContain("writes its output into this conversation by itself")
      expect(reminder!).toContain("mid-turn it reaches you at your next tool call")
      // The ways out, so ending the turn is never the model's only option.
      expect(reminder!).toContain("does not touch the running task's files")
      // origami_change (t-46a74d): the menu option is the same - hand back to
      // the user - but it no longer spells it "end your turn" inside a reminder
      // injected exactly when the model is already idling.
      expect(reminder!).toContain("hand back to the user now")
      expect(reminder!).not.toContain("end your turn")
      expect(reminder!).toContain("task_stop")
    }))

  it("fires at three, goes quiet at four and five, and escalates at six", () =>
    Effect.gen(function* () {
      const run = (count: number) => apply(Array.from({ length: count }, () => poll()))

      expect(pollReminders(yield* run(3))).toHaveLength(1)
      expect(pollReminders(yield* run(4))).toHaveLength(0)
      expect(pollReminders(yield* run(5))).toHaveLength(0)
      const six = pollReminders(yield* run(6))
      expect(six).toHaveLength(1)
      expect(six[0]!).toContain("called task_list 6 times in a row")
    }))

  it("says nothing when real work happens between the checks", () =>
    Effect.gen(function* () {
      const parts = yield* apply([poll(), toolCall("read", { filePath: "/tmp/x" }), poll(), poll()])
      expect(pollReminders(parts)).toHaveLength(0)
    }))

  it("does not count a poll that has not returned yet", () =>
    Effect.gen(function* () {
      const parts = yield* apply([poll(), poll(), runningToolCall("task_list", {})])
      expect(pollReminders(parts)).toHaveLength(0)
    }))

  it("keeps the two loops apart: polls do not earn the shell wording, or vice versa", () =>
    Effect.gen(function* () {
      // Three sleeps and three polls in one run. Each detector must report its
      // own count - a shared counter would tell the model it made six blocking
      // shell calls, which is false, and hand it the wrong way out.
      const parts = yield* apply([sleepCall(), sleepCall(), sleepCall(), poll(), poll(), poll()])
      const [shell] = reminders(parts)
      const [polls] = pollReminders(parts)
      expect(shell).toBeUndefined()
      expect(polls!).toContain("called task_list 3 times in a row")
      expect(polls!).not.toContain("blocking shell calls")
    }))

  it("fires for every agent, not just build", () =>
    Effect.gen(function* () {
      const parts = yield* apply([poll(), poll(), poll()], "plan")
      expect(pollReminders(parts)).toHaveLength(1)
    }))
})

// What the model can see of its own task list after the window has been
// rebuilt. Compaction replaces the head of the conversation with a summary, so
// every todowrite call in that head is gone; the list itself is durable (its
// own table, keyed by session), and these tests pin that the durable copy is
// handed back exactly when the visible one is missing or stale.
describe("SessionReminders todo list", () => {
  const stored: Todo.Info[] = [
    { content: "reproduce the failure", status: "completed", priority: "high" },
    { content: "fix the parser", status: "in_progress", priority: "high" },
    { content: "run the suite", status: "pending", priority: "medium" },
  ]

  const todoCall = (todos: readonly Todo.Info[]) => toolCall("todowrite", { todos: [...todos] }, "3 todos")

  /** The todo reminder is the only synthetic text carrying the stored list. */
  function todoReminders(texts: readonly string[]) {
    return texts.filter((text) => text.includes(SessionReminders.TODO_REMINDER_HEAD))
  }

  const applyWith = (parts: unknown[], todos: readonly Todo.Info[]) =>
    Effect.gen(function* () {
      const messages = [userMessage(), assistantMessage(parts)]
      const applied = yield* SessionReminders.apply({
        messages,
        agent: { name: "build" } as Agent.Info,
        session: {} as Session.Info,
        todos,
      })
      expect(messages[0]!.parts).toHaveLength(1)
      return applied.reminders
    })

  it("hands the stored list back when compaction took the todowrite call with it", () =>
    Effect.gen(function* () {
      // The post-compaction window: a summary and whatever tail survived. The
      // todowrite call that wrote this list is NOT in it.
      const parts = yield* applyWith([toolCall("read", { filePath: "/tmp/x" })], stored)
      const [reminder] = todoReminders(parts)
      expect(reminder).toBeDefined()
      // Every item, with its state - a list the model has to guess the status
      // of is no better than no list.
      expect(reminder!).toContain("- [completed] reproduce the failure (priority: high)")
      expect(reminder!).toContain("- [in_progress] fix the parser (priority: high)")
      expect(reminder!).toContain("- [pending] run the suite (priority: medium)")
      expect(reminder!).toContain("Keep it current with todowrite.")
    }))

  // The reminder renders nesting as INDENTATION, and a model rebuilding the
  // list from it re-sends the text without the `depth` field that produced the
  // indent - so the tree it just described is flattened by its own next write
  // (owner-reproduced on ses_fae2ce20afferpNfEuYnUJtCYF). The store now carries
  // a dropped depth forward, but a model told to keep the field is cheaper than
  // a repair on every write, so the instruction says it out loud.
  it("tells the model that the indentation is nesting and must be re-sent as depth", () =>
    Effect.gen(function* () {
      const nested: Todo.Info[] = [
        { content: "the major", status: "in_progress", priority: "high", depth: 0 },
        { content: "the sub-task", status: "pending", priority: "high", depth: 1 },
      ]
      const parts = yield* applyWith([toolCall("read", { filePath: "/tmp/x" })], nested)
      const [reminder] = todoReminders(parts)
      expect(reminder).toBeDefined()
      // The indent is what the sentence is ABOUT, so both have to be there.
      expect(reminder!).toContain("  - [pending] the sub-task (priority: high)")
      expect(reminder!).toContain("depth")
      expect(reminder!.toLowerCase()).toContain("nested")
    }))

  it("stays quiet while the model can still see the same list", () =>
    Effect.gen(function* () {
      const parts = yield* applyWith([todoCall(stored), toolCall("read", { filePath: "/tmp/x" })], stored)
      expect(todoReminders(parts)).toHaveLength(0)
    }))

  it("corrects a STALE visible list, not just an absent one", () =>
    Effect.gen(function* () {
      // The retained tail can hold an OLD todowrite while a newer one sat in the
      // dropped head - the model would otherwise work from a list that is two
      // steps behind and never know.
      const old: Todo.Info[] = [{ content: "fix the parser", status: "pending", priority: "high" }]
      const parts = yield* applyWith([todoCall(old)], stored)
      const [reminder] = todoReminders(parts)
      expect(reminder).toBeDefined()
      expect(reminder!).toContain("- [in_progress] fix the parser (priority: high)")
    }))

  it("reads the visible list off the tool INPUT, so a pruned output still counts", () =>
    Effect.gen(function* () {
      // Pruning replaces an old tool output with a placeholder and leaves the
      // input alone; the model can still see the list, so re-stating it would
      // only burn context.
      const pruned = toolCall("todowrite", { todos: [...stored] }, "[Old tool result content cleared]")
      const parts = yield* applyWith([pruned], stored)
      expect(todoReminders(parts)).toHaveLength(0)
    }))

  it("says nothing when the session has no todos", () =>
    Effect.gen(function* () {
      const parts = yield* applyWith([toolCall("read", { filePath: "/tmp/x" })], [])
      expect(todoReminders(parts)).toHaveLength(0)
    }))

  it("says it once per step, never twice", () =>
    Effect.gen(function* () {
      const parts = [toolCall("read", { filePath: "/tmp/x" })]
      expect(todoReminders(yield* applyWith(parts, stored))).toHaveLength(1)
      // ...and a second step on the same state answers the same single block,
      // byte for byte, so the trailing lane holds still while the state does.
      expect(yield* applyWith(parts, stored)).toEqual(yield* applyWith(parts, stored))
    }))

  // A LIST EDITED MID-TURN. The stored list is durable and has writers outside
  // the turn (the todowrite tool, and the HTTP session route), so its text can
  // change between two steps with no tool call in between. Measured on the fake
  // provider before this moved: the head of the request went 294 bytes -> 335
  // and took the cached body with it. The change must still REACH the model -
  // it just may not be written into a message already sent.
  it("tracks a list that changed since the last step", () =>
    Effect.gen(function* () {
      const parts = [toolCall("read", { filePath: "/tmp/x" })]
      const later: Todo.Info[] = [
        ...stored,
        { content: "write it up", status: "pending", priority: "low" },
      ]
      const before = todoReminders(yield* applyWith(parts, stored))
      const after = todoReminders(yield* applyWith(parts, later))

      expect(before[0]!).not.toContain("write it up")
      expect(after[0]!).toContain("- [pending] write it up (priority: low)")
    }))

  it("fires for every agent, not just build", () =>
    Effect.gen(function* () {
      const messages = [userMessage(), assistantMessage([toolCall("read", { filePath: "/tmp/x" })])]
      const applied = yield* SessionReminders.apply({
        messages,
        agent: { name: "plan" } as Agent.Info,
        session: {} as Session.Info,
        todos: stored,
      })
      expect(todoReminders(applied.reminders)).toHaveLength(1)
      expect(messages[0]!.parts).toHaveLength(1)
    }))
})

// THE TWO NUDGES. Both are about a list that is NOT being kept: the reconcile
// nudge for a stored list the model walked past, the creation nudge for a
// session that never wrote one. Neither restates the list - the reminder above
// does that - so neither can be recognised by TODO_REMINDER_HEAD.
describe("SessionReminders todo nudges", () => {
  const open: Todo.Info[] = [
    { content: "ship the export button", status: "in_progress", priority: "high", depth: 0 },
    { content: "wire the click handler", status: "pending", priority: "high", depth: 1 },
  ]
  const closed: Todo.Info[] = [
    { content: "ship the export button", status: "completed", priority: "high", depth: 0 },
    { content: "wire the click handler", status: "cancelled", priority: "high", depth: 1 },
  ]

  const todoCall = (todos: readonly Todo.Info[]) => toolCall("todowrite", { todos: [...todos] }, "2 todos")
  const work = () => toolCall("read", { filePath: "/tmp/x" })

  const reconciles = (texts: readonly string[]) =>
    texts.filter((text) => text.includes("you did not update it in your previous turn"))
  const creations = (texts: readonly string[]) => texts.filter((text) => text.includes("No todo list exists for this session"))

  /** `messages` verbatim, so a test can end the window on the user's own turn
   *  (step 1) or on an assistant message (step 2+). */
  const applyTo = (messages: SessionV1.WithParts[], todos: readonly Todo.Info[]) =>
    Effect.gen(function* () {
      const applied = yield* SessionReminders.apply({
        messages,
        agent: { name: "build" } as Agent.Info,
        session: {} as Session.Info,
        todos,
      })
      // NEITHER nudge may be written into a stored message: they are recomputed
      // every step and the user's turn is the head of the request.
      for (const message of messages) {
        for (const part of message.parts) {
          const text = (part as { text?: string }).text ?? ""
          expect(text).not.toContain("you did not update it in your previous turn")
          expect(text).not.toContain("No todo list exists for this session")
        }
      }
      return applied.reminders
    })

  /** Step 1 of a turn, with `before` as the PREVIOUS turn's assistant message.
   *  The window ends on the user's message because the step loop calls apply()
   *  before it creates that step's assistant message. With no `before` there is
   *  no previous user message either: the first turn of a session. */
  const firstStep = (todos: readonly Todo.Info[], before?: unknown[]) =>
    applyTo(before ? [userMessage(), assistantMessage(before), userMessage()] : [userMessage()], todos)

  it("asks for a reconcile when the previous turn left the list alone", () =>
    Effect.gen(function* () {
      const [nudge] = reconciles(yield* firstStep(open, [work(), work()]))
      expect(nudge).toBeDefined()
      expect(nudge!).toContain("your todo list still has open items")
      // The three things to check, and the order: reconcile, then resume.
      expect(nudge!).toContain("done, stale, or need new sub-steps")
      expect(nudge!).toContain("update the list with todowrite")
      expect(nudge!).toContain("then resume with the user's request")
    }))

  // THE CLAIM AND THE CHECK MUST NAME THE SAME SPAN. Reading the CURRENT turn
  // instead made this fire on every new turn with anything open: on step 1 the
  // current turn is empty by definition, so "nothing touched the list" was true
  // of every first step there has ever been - including one that follows a turn
  // which did update the list, where the words are simply false.
  it("stays quiet when the previous turn did write the list", () =>
    Effect.gen(function* () {
      expect(reconciles(yield* firstStep(open, [todoCall(open), work()]))).toHaveLength(0)
    }))

  it("still asks when the previous turn's todowrite never finished", () =>
    Effect.gen(function* () {
      // A call that did not return wrote nothing, so the list is as stale as if
      // it had never been called.
      const before = [work(), runningToolCall("todowrite", { todos: [...open] })]
      expect(reconciles(yield* firstStep(open, before))).toHaveLength(1)
    }))

  it("stays quiet on the first turn of a session", () =>
    Effect.gen(function* () {
      // No previous turn, so there is no write the model can have skipped. A
      // list can be stored before the first turn (a resumed or seeded session).
      expect(reconciles(yield* firstStep(open))).toHaveLength(0)
    }))

  it("stays quiet when the model wrote the list earlier in this same turn", () =>
    Effect.gen(function* () {
      // Step 2+: the window holds this turn's assistant message, so the model is
      // mid-answer and was already asked at the top of the turn.
      const messages = [userMessage(), assistantMessage([todoCall(open), work()])]
      expect(reconciles(yield* applyTo(messages, open))).toHaveLength(0)
    }))

  it("stays quiet on the second step of the same turn", () =>
    Effect.gen(function* () {
      // Step 2: the step-1 assistant message is back in the window. The model is
      // mid-answer - it was asked once at the top of the turn and that is enough.
      const messages = [userMessage(), assistantMessage([work()])]
      expect(reconciles(yield* applyTo(messages, open))).toHaveLength(0)
    }))

  it("stays quiet when every item is completed or cancelled", () =>
    Effect.gen(function* () {
      expect(reconciles(yield* firstStep(closed, [work()]))).toHaveLength(0)
    }))

  // `failed` is terminal in packages/core/src/session/todo-reconcile.ts, where a
  // failed child does NOT hold its parent open. Counting it as open work here
  // would nudge forever over an item nothing intends to work again.
  it("treats a failed item as closed, not as open work", () =>
    Effect.gen(function* () {
      const failed: Todo.Info[] = [
        { content: "ship the export button", status: "completed", priority: "high", depth: 0 },
        { content: "wire the click handler", status: "failed", priority: "high", depth: 1 },
      ]
      expect(reconciles(yield* firstStep(failed, [work()]))).toHaveLength(0)
    }))

  it("stays quiet when the session has no list at all", () =>
    Effect.gen(function* () {
      expect(reconciles(yield* firstStep([], [work()]))).toHaveLength(0)
    }))

  it("asks for a list once the turn is four tool calls deep with none stored", () =>
    Effect.gen(function* () {
      const deep = (count: number) =>
        applyTo([userMessage(), assistantMessage(Array.from({ length: count }, () => work()))], [])

      expect(creations(yield* deep(3))).toHaveLength(0)
      const [nudge] = creations(yield* deep(4))
      expect(nudge).toBeDefined()
      expect(nudge!).toContain("several tool calls into this task")
      // The shape it must write, and the way out if the work really is small.
      expect(nudge!).toContain("waves at the top level, steps beneath")
      expect(nudge!).toContain("genuinely single-step")
      // ...and it keeps asking while the list stays empty, unlike the streak
      // reminders, which go quiet between multiples.
      expect(creations(yield* deep(5))).toHaveLength(1)
    }))

  it("stops asking the moment a todowrite call lands in the turn", () =>
    Effect.gen(function* () {
      const parts = [work(), work(), work(), work(), todoCall(open)]
      expect(creations(yield* applyTo([userMessage(), assistantMessage(parts)], []))).toHaveLength(0)
      // Even while that call is still running - the model is answering.
      const running = [work(), work(), work(), work(), runningToolCall("todowrite", { todos: [] })]
      expect(creations(yield* applyTo([userMessage(), assistantMessage(running)], []))).toHaveLength(0)
    }))

  it("counts only the current turn, so calls before the user spoke do not add up", () =>
    Effect.gen(function* () {
      const messages = [
        userMessage(),
        assistantMessage([work(), work(), work(), work()]),
        userMessage(),
        assistantMessage([work()]),
      ]
      expect(creations(yield* applyTo(messages, []))).toHaveLength(0)
    }))

  // A finished background sub-agent injects a whole turn through `ops.prompt`,
  // so it lands as a real user message whose one part is `synthetic: true`.
  // Nothing here filters on `synthetic` - the coarse `role === "user"` rule is
  // what `apply` already uses - and that is deliberate: a result arriving is a
  // new instruction, and the best moment to reconcile a list against it.
  it("treats an injected task-result turn as the user speaking", () =>
    Effect.gen(function* () {
      const injected = {
        info: { id: "msg_u2", sessionID, role: "user", time: { created: 3_000 } },
        parts: [{ ...partIds("msg_u2"), type: "text", synthetic: true, text: "<task_result>done</task_result>" }],
      } as unknown as SessionV1.WithParts

      // The turn before it went four calls deep with no list; the injected turn
      // starts a fresh one, so the count restarts...
      const messages = [userMessage(), assistantMessage([work(), work(), work(), work()]), injected]
      expect(creations(yield* applyTo(messages, []))).toHaveLength(0)
      // ...and an open list untouched since that turn began earns the reconcile.
      expect(reconciles(yield* applyTo(messages, open))).toHaveLength(1)
    }))

  it("does not count a tool call that has not finished", () =>
    Effect.gen(function* () {
      const parts = [work(), work(), work(), runningToolCall("read", { filePath: "/tmp/x" })]
      expect(creations(yield* applyTo([userMessage(), assistantMessage(parts)], []))).toHaveLength(0)
    }))

  it("never fires both, and answers the same bytes twice for the same step", () =>
    Effect.gen(function* () {
      const messages = () => [userMessage(), assistantMessage([work(), work(), work(), work()])]
      const withList = yield* applyTo(messages(), open)
      expect(creations(withList)).toHaveLength(0)
      const withoutList = yield* applyTo(messages(), [])
      expect(reconciles(withoutList)).toHaveLength(0)
      // The trailing lane is rebuilt every step; identical state must render
      // identical text or the block moves for free.
      expect(yield* applyTo(messages(), [])).toEqual(yield* applyTo(messages(), []))
    }))
})

// t-di2u7z. THE TOOL THE TEXT NAMES HAS TO EXIST FOR THE READER. A sub-agent is
// denied `todowrite` by agent/subagent-permissions.ts unless its own definition
// names it, and the native `general` agent denies it outright - so every text
// above was being sent to children that cannot act on it. The window fixtures
// are the SAME ones the suites above use; only the ruleset differs.
describe("SessionReminders when todowrite is denied", () => {
  const open: Todo.Info[] = [
    { content: "ship the export button", status: "in_progress", priority: "high", depth: 0 },
    { content: "wire the click handler", status: "pending", priority: "high", depth: 1 },
  ]
  const work = () => toolCall("read", { filePath: "/tmp/x" })
  const deny = (permission: string): PermissionV1.Rule[] => [{ permission, pattern: "*", action: "deny" }]

  /** One step's reminders for an agent/session pair, over `messages` verbatim. */
  const applyAs = (
    messages: SessionV1.WithParts[],
    todos: readonly Todo.Info[],
    agent: Partial<Agent.Info>,
    session: Partial<Session.Info> = {},
  ) =>
    Effect.gen(function* () {
      const applied = yield* SessionReminders.apply({
        messages,
        agent: { name: "general", ...agent } as Agent.Info,
        session: session as Session.Info,
        todos,
      })
      return applied.reminders
    })

  const mentionsTodo = (texts: readonly string[]) => texts.filter((text) => text.includes("todowrite"))

  it("says nothing about todowrite to a child whose AGENT ruleset denies it", () =>
    Effect.gen(function* () {
      // The exact window that earns the creation nudge: four finished calls, no list.
      const messages = [userMessage(), assistantMessage([work(), work(), work(), work()])]
      expect(mentionsTodo(yield* applyAs(messages, [], { permission: deny("todowrite") }))).toEqual([])
      // ...and the same window still earns it when the tool is there.
      expect(mentionsTodo(yield* applyAs(messages, [], { permission: [] }))).toHaveLength(1)
    }))

  it("says nothing when the SESSION row denies it, agent ruleset silent", () =>
    Effect.gen(function* () {
      // deriveSubagentSessionPermission writes the deny onto the child SESSION,
      // not onto the agent, so this is the shape the UAT child actually ran with.
      const messages = [userMessage(), assistantMessage([work(), work(), work(), work()])]
      expect(
        mentionsTodo(yield* applyAs(messages, [], { permission: [] }, { permission: deny("todowrite") })),
      ).toEqual([])
    }))

  it("withholds the stored list and the reconcile nudge too", () =>
    Effect.gen(function* () {
      const session = { permission: deny("todowrite") }
      // A stored list the window cannot show would normally be re-injected...
      const stale = [userMessage(), assistantMessage([work()])]
      expect(mentionsTodo(yield* applyAs(stale, open, { permission: [] }, session))).toEqual([])
      // ...and a previous turn that never wrote would normally earn a reconcile.
      const step1 = [userMessage(), assistantMessage([work(), work()]), userMessage()]
      expect(mentionsTodo(yield* applyAs(step1, open, { permission: [] }, session))).toEqual([])
    }))

  it("leaves the unrelated reminders alone", () =>
    Effect.gen(function* () {
      // A wait-loop streak still fires under the same deny: this gate is about
      // one tool, not about silencing the lane.
      const messages = [userMessage(), assistantMessage([sleepCall(), sleepCall(), sleepCall()])]
      const texts = yield* applyAs(messages, [], { permission: deny("todowrite") })
      expect(texts.filter((text) => text.includes("blocking shell calls in a row"))).toHaveLength(1)
    }))
})
