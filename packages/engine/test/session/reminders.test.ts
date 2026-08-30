import { describe, expect } from "bun:test"
import { SessionV1 } from "@origami/core/v1/session"
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
      expect(reminder!).toContain("<task_result>")
      // The ways out, so ending the turn is never the model's only option.
      expect(reminder!).toContain("does not touch the running task's files")
      expect(reminder!).toContain("end your turn")
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
