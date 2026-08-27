// The nine flock tools, driven as the prompt loop drives them: real Tool.Defs
// (so argument decoding and the wrapper are the shipping ones), a REAL store
// underneath, and a turn context whose `ops` record what the tool asked the
// runner to do.
//
// The refusal paths get the most attention here, because every one of them is a
// thing the room must NOT be told: an ask that cannot run has to come back as a
// note to one model, never as a message the whole roster reads and reacts to.

import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { CollabStore } from "@/collab/store"
import { CollabSystem } from "@/collab/collab-system"
import { FlockTools } from "@/collab/flock-tools"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const truncate = Layer.succeed(Truncate.Service, {
  cleanup: () => Effect.void,
  write: (text: string) => Effect.succeed(text),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50_000 }),
} as unknown as Truncate.Interface)

const agents = Layer.succeed(Agent.Service, {
  get: (name: string) => Effect.succeed({ name, permission: [], options: {} }),
  list: () => Effect.succeed([]),
} as unknown as Agent.Interface)

const it = testEffect(
  Layer.provideMerge(Layer.mergeAll(truncate, agents), LayerNode.compile(LayerNode.group([CollabStore.node]))),
)

type Recorded = {
  readonly handoffs: string[]
  readonly asks: CollabSystem.AskRequest[]
  readonly cancelled: string[]
}

/**
 * A room with two agents, the real store, and a turn context for `alice`.
 * `ops.ask` answers with whatever the test scripted, and every call it and
 * `ops.handoff` receive is recorded.
 */
const room = (options?: {
  answer?: CollabSystem.AskOutcome
  hops?: number | null
  askChain?: readonly string[]
  bobSession?: string | null
  busy?: boolean
  lead?: string
  /** Which half of a COUNCIL round this turn is. Absent = a discuss room. */
  council?: "opinion" | "synthesis"
}) =>
  Effect.gen(function* () {
    const store = yield* CollabStore.Service
    const collab = yield* store.create({ title: "Ship it", agentSlugs: ["alice", "bob"] })
    const recorded: Recorded = { handoffs: [], asks: [], cancelled: [] }
    const bobSession = options?.bobSession === undefined ? "ses_bob" : options.bobSession

    const turn: CollabSystem.TurnContext = {
      base: "[BASE]",
      state: "[ROOM STATE]",
      collabId: collab.id,
      title: collab.title,
      agentSlug: "alice",
      sessionId: "ses_alice",
      lead: options?.lead ?? "alice",
      objective: null,
      roster: [
        { agentSlug: "alice", displayName: "Alice Reviewer", sessionId: "ses_alice" },
        { agentSlug: "bob", displayName: "Bob Builder", sessionId: bobSession },
      ],
      askChain: options?.askChain ?? [],
      hops: { remaining: options?.hops === undefined ? 6 : options.hops },
      stop: { requested: false, summary: "" },
      ...(options?.council ? { council: { phase: options.council } } : {}),
      ops: {
        store,
        append: (input) => store.appendMessage(input),
        session: () => Effect.succeed(bobSession ?? "ses_bob"),
        ask: (request) =>
          Effect.sync(() => {
            recorded.asks.push(request)
            return options?.answer ?? { text: "it is on line 40", trace: [] }
          }),
        handoff: (agentSlug) => Effect.sync(() => void recorded.handoffs.push(agentSlug)),
      },
    }

    const promptOps = {
      cancel: (sessionID: string) => Effect.sync(() => void recorded.cancelled.push(sessionID)),
      resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
      prompt: () => Effect.die("the flock tools never prompt directly"),
      busy: () => Effect.succeed(options?.busy ?? false),
    }

    const defs = yield* FlockTools.defs
    const abort = new AbortController()
    const call = (id: string, args: Record<string, unknown>, callID = `call_${id}_${Math.random()}`) =>
      Effect.gen(function* () {
        const def = defs.find((entry) => entry.id === id)
        if (!def) throw new Error(`no flock tool named ${id}`)
        const ctx = {
          sessionID: "ses_alice",
          messageID: "msg_1",
          agent: "alice",
          abort: abort.signal,
          callID,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } as unknown as Tool.Context
        return yield* def.execute(args, ctx).pipe(Effect.provideService(CollabSystem.Turn, turn))
      })

    const log = () => store.listMessages(collab.id)
    const tasks = () => store.listTasks(collab.id)
    return { store, collab, turn, recorded, call, log, tasks, abort }
  })

describe("ask - the checks, in the order the contract fixes", () => {
  it.live("refuses a name that is not on the roster, and says who is", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const out = yield* flock.call("ask", { to: "carol", task: "look" })
      expect(out.output).toContain("carol")
      expect(out.output).toContain("alice, bob")
      // Nothing is written: a refusal is a note to one model, not a message the
      // whole roster reads.
      expect(yield* flock.log()).toEqual([])
      expect(yield* flock.tasks()).toEqual([])
      expect(flock.recorded.asks).toHaveLength(0)
    }),
  )

  it.live("takes the display name as well as the slug, and ignores a leading @", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      yield* flock.call("ask", { to: "@Bob Builder", task: "look" })
      expect(flock.recorded.asks[0]?.target).toBe("bob")
    }),
  )

  it.live("refuses a CYCLE before it reports the target as busy", () =>
    Effect.gen(function* () {
      // bob is waiting on alice further up this chain, so bob's session is
      // busy BECAUSE it is waiting. Reporting that as "busy, try later" would
      // tell the model to retry the one thing that can never succeed.
      const flock = yield* room({ askChain: ["ses_bob"], busy: true })
      const out = yield* flock.call("ask", { to: "bob", task: "look" })
      expect(out.output).toContain("waiting on you further up this chain")
      expect(out.output).not.toContain("busy")
      expect(flock.recorded.asks).toHaveLength(0)
    }),
  )

  it.live("refuses at depth 3, before it spends a hop", () =>
    Effect.gen(function* () {
      const flock = yield* room({ askChain: ["ses_a", "ses_b", "ses_c"], hops: 4 })
      const out = yield* flock.call("ask", { to: "bob", task: "look" })
      expect(out.output).toContain("3 deep")
      expect(flock.turn.hops.remaining).toBe(4)
      expect(flock.recorded.asks).toHaveLength(0)
    }),
  )

  it.live("refuses once the hop budget is spent", () =>
    Effect.gen(function* () {
      const flock = yield* room({ hops: 0 })
      const out = yield* flock.call("ask", { to: "bob", task: "look" })
      expect(out.output).toContain("out of hops")
      expect(flock.recorded.asks).toHaveLength(0)
      expect(yield* flock.log()).toEqual([])
    }),
  )

  it.live("never refuses on hops when the budget is OFF", () =>
    Effect.gen(function* () {
      const flock = yield* room({ hops: null })
      const out = yield* flock.call("ask", { to: "bob", task: "look" })
      expect(out.output).toBe("it is on line 40")
    }),
  )

  it.live("refuses a target whose session is already running something else", () =>
    Effect.gen(function* () {
      // LOAD-BEARING: a prompt to a busy session JOINS the run in flight and
      // discards this work, so the "answer" would be whatever the other caller
      // asked for.
      const flock = yield* room({ busy: true })
      const out = yield* flock.call("ask", { to: "bob", task: "look" })
      expect(out.output).toContain("busy")
      expect(flock.recorded.asks).toHaveLength(0)
      expect(yield* flock.log()).toEqual([])
    }),
  )

  it.live("cannot be busy when the target has never taken a turn", () =>
    Effect.gen(function* () {
      const flock = yield* room({ bobSession: null, busy: true })
      const out = yield* flock.call("ask", { to: "bob", task: "look" })
      expect(out.output).toBe("it is on line 40")
    }),
  )
})

describe("ask - what it writes when it runs", () => {
  it.live("records the ask, the answer and the task it opened for them", () =>
    Effect.gen(function* () {
      const flock = yield* room({
        answer: { text: "it is on line 40", trace: [{ tool: "read", summary: "sql.ts", status: "ok" }] },
      })
      const out = yield* flock.call("ask", {
        to: "bob",
        task: "where is the migration?",
        context: "the table is collab_task",
        expect: "the line number",
      })
      expect(out.output).toBe("it is on line 40")

      const log = yield* flock.log()
      expect(log.map((message) => message.kind)).toEqual(["ask", "answer"])
      expect(log[0]).toMatchObject({
        authorId: "alice",
        authorKind: "agent",
        kind: "ask",
        mentions: ["bob"],
        text: "where is the migration?\nContext: the table is collab_task\nExpected back: the line number",
      })
      expect(log[1]).toMatchObject({
        authorId: "bob",
        kind: "answer",
        replyToSeq: log[0]!.seq,
        taskId: log[0]!.taskId,
        // The answer carries what bob's tools did, so the room can see the work
        // rather than take the sentence on trust.
        trace: [{ tool: "read", summary: "sql.ts", status: "ok" }],
      })
      // The answer addresses nobody: the asker already holds it as a result.
      expect(log[1]!.mentions).toEqual([])

      const tasks = yield* flock.tasks()
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        title: "where is the migration?",
        owner: "bob",
        createdBy: "alice",
        state: "done",
        result: "it is on line 40",
        originSeq: log[0]!.seq,
      })
    }),
  )

  it.live("moves the target past the ask, so it is not shown the same message twice", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      yield* flock.call("ask", { to: "bob", task: "look" })
      const asked = (yield* flock.log())[0]!
      const bob = (yield* flock.store.participants(flock.collab.id)).find((entry) => entry.agentSlug === "bob")
      expect(bob?.lastSeenSeq).toBe(asked.seq)
    }),
  )

  it.live("hands the auto-task's id down, so the brief can name the board row", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      yield* flock.call("ask", { to: "bob", task: "look" })
      const task = (yield* flock.tasks())[0]!
      // Without this the target is left matching titles against the board to
      // find the id it needs, and a wrong guess completes someone else's task.
      expect(flock.recorded.asks[0]?.taskId).toBe(task.id)
    }),
  )

  it.live("passes the chain and the SAME hop handle down, having spent nothing itself", () =>
    Effect.gen(function* () {
      const flock = yield* room({ askChain: ["ses_root"], hops: 3 })
      yield* flock.call("ask", { to: "bob", task: "look" })
      const request = flock.recorded.asks[0]!
      expect(request.askChain).toEqual(["ses_root", "ses_alice"])
      // The hop is charged by the runner when the nested turn actually starts,
      // so the tool hands its own handle down untouched.
      expect(request.hops).toBe(flock.turn.hops)
    }),
  )

  it.live("reports a silent target as a choice, and leaves its task claimed", () =>
    Effect.gen(function* () {
      const flock = yield* room({ answer: { text: "   ", trace: [] } })
      const out = yield* flock.call("ask", { to: "bob", task: "look" })
      expect(out.output).toBe("@bob chose not to answer.")
      // No answer row: nothing was said, so there is nothing to record.
      expect((yield* flock.log()).map((message) => message.kind)).toEqual(["ask"])
      expect((yield* flock.tasks())[0]?.state).toBe("claimed")
    }),
  )

  it.live("hands a failed target back as the error, not as silence", () =>
    Effect.gen(function* () {
      const flock = yield* room({ answer: { text: "", trace: [], error: "provider is down" } })
      const out = yield* flock.call("ask", { to: "bob", task: "look" })
      expect(out.output).toContain("provider is down")
      expect(out.output).toContain("@bob")
      expect((yield* flock.log()).map((message) => message.kind)).toEqual(["ask"])
    }),
  )

  it.live("says a target ran out of steps rather than passing off the stump as an answer", () =>
    Effect.gen(function* () {
      const flock = yield* room({ answer: { text: "half an answ", trace: [], stepCapped: true } })
      const out = yield* flock.call("ask", { to: "bob", task: "look" })
      expect(out.output).toBe("@bob ran out of steps mid-answer.")
      // The truncated text must not reach the caller at all: it would read as
      // a whole answer and be built on.
      expect(out.output).not.toContain("half an answ")
      expect((yield* flock.log()).map((message) => message.kind)).toEqual(["ask"])
    }),
  )

  it.live("runs the target ONCE when a provider retry replays the same tool call", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const first = yield* flock.call("ask", { to: "bob", task: "look" }, "call_fixed")
      const second = yield* flock.call("ask", { to: "bob", task: "look" }, "call_fixed")
      expect(second.output).toBe(first.output)
      // Without the memo the room would carry two asks for one question, and
      // bob would take two turns for it.
      expect(flock.recorded.asks).toHaveLength(1)
      expect((yield* flock.log()).map((message) => message.kind)).toEqual(["ask", "answer"])
    }),
  )

  it.live("cancels the target when the caller's own turn is aborted", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const abort = flock.abort
      const answered = yield* flock
        .call("ask", { to: "bob", task: "look" })
        .pipe(Effect.tap(() => Effect.sync(() => abort.abort())))
      expect(answered.output).toBe("it is on line 40")
      // The listener is removed once the ask returns, so an abort AFTER it
      // must not reach into a finished exchange.
      expect(flock.recorded.cancelled).toEqual([])
    }),
  )

  it.live("cancels the target session while the ask is still in flight", () =>
    Effect.gen(function* () {
      const store = yield* CollabStore.Service
      const collab = yield* store.create({ title: "Abort", agentSlugs: ["alice", "bob"] })
      const cancelled: string[] = []
      const abort = new AbortController()
      const turn: CollabSystem.TurnContext = {
        base: "",
        state: "",
        collabId: collab.id,
        title: collab.title,
        agentSlug: "alice",
        sessionId: "ses_alice",
        lead: "alice",
        objective: null,
        roster: [
          { agentSlug: "alice", displayName: "alice", sessionId: "ses_alice" },
          { agentSlug: "bob", displayName: "bob", sessionId: "ses_bob" },
        ],
        askChain: [],
        hops: { remaining: 6 },
        stop: { requested: false, summary: "" },
        ops: {
          store,
          append: (input) => store.appendMessage(input),
          session: () => Effect.succeed("ses_bob"),
          // The abort lands DURING the nested turn, which is the only moment
          // cancelling the target does anything.
          ask: () => Effect.sync(() => abort.abort()).pipe(Effect.as({ text: "late", trace: [] })),
          handoff: () => Effect.void,
        },
      }
      const defs = yield* FlockTools.defs
      const ask = defs.find((entry) => entry.id === "ask")!
      const ctx = {
        sessionID: "ses_alice",
        messageID: "msg_1",
        agent: "alice",
        abort: abort.signal,
        callID: "call_abort",
        extra: {
          promptOps: {
            cancel: (sessionID: string) => Effect.sync(() => void cancelled.push(sessionID)),
            resolvePromptParts: (template: string) => Effect.succeed([{ type: "text" as const, text: template }]),
            prompt: () => Effect.die("unused"),
            busy: () => Effect.succeed(false),
          },
        },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } as unknown as Tool.Context
      yield* ask.execute({ to: "bob", task: "look" }, ctx).pipe(Effect.provideService(CollabSystem.Turn, turn))
      expect(cancelled).toEqual(["ses_bob"])
    }),
  )
})

describe("handoff", () => {
  it.live("records the hand-off, passes the baton and ends the caller's turn", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const out = yield* flock.call("handoff", { to: "bob", task: "build it", context: "start from the schema" })
      expect(out.output).toContain("Handed to @bob")

      const log = yield* flock.log()
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({
        kind: "handoff",
        mentions: ["bob"],
        text: "build it\nContext: start from the schema",
      })
      expect((yield* flock.tasks())[0]).toMatchObject({
        title: "build it",
        owner: "bob",
        createdBy: "alice",
        state: "claimed",
        originSeq: log[0]!.seq,
      })
      expect(flock.recorded.handoffs).toEqual(["bob"])
      expect(flock.turn.stop).toEqual({ requested: true, kind: "handoff", summary: "" })
    }),
  )

  it.live("refuses a name off the roster, and refuses handing the work to yourself", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      expect((yield* flock.call("handoff", { to: "carol", task: "x" })).output).toContain("carol")
      expect((yield* flock.call("handoff", { to: "alice", task: "x" })).output).toContain("yourself")
      expect(yield* flock.log()).toEqual([])
      expect(flock.turn.stop.requested).toBe(false)
    }),
  )

  it.live("refuses once the budget is spent, so the baton is never dropped in an empty room", () =>
    Effect.gen(function* () {
      const flock = yield* room({ hops: 0 })
      const out = yield* flock.call("handoff", { to: "bob", task: "x" })
      expect(out.output).toContain("out of hops")
      expect(flock.recorded.handoffs).toEqual([])
      expect(flock.turn.stop.requested).toBe(false)
    }),
  )
})

// --- What the MODEL is told about ask and handoff, and what actually survives
// the call. Both matter and neither proves the other: deepseek's failed rooms
// sent one-line briefs referencing specs that were never written, which is a
// prompt problem, and a brief that was silently clipped on the way through
// would be an engine problem that reads exactly the same from the room.

describe("ask and handoff - the brief the model is told to write", () => {
  const schemaOf = (defs: readonly Tool.Def[], id: string) =>
    ToolJsonSchema.fromTool(defs.find((def) => def.id === id)!) as {
      properties: Record<string, { description?: string }>
    }

  it.live("tells the model plainly that task and context may be long and must stand alone", () =>
    Effect.gen(function* () {
      const defs = yield* FlockTools.defs
      for (const id of ["ask", "handoff"]) {
        for (const field of ["task", "context"]) {
          const description = schemaOf(defs, id).properties[field]?.description ?? ""
          expect(description).toContain("not truncated")
          expect(description).toContain("pages if that is what it takes")
          expect(description).toContain("a spec you did not write down does not exist")
          expect(description).toContain("write it to a file in the workspace")
        }
      }
    }),
  )

  it.live("separates the two tools by whether the answer comes back", () =>
    Effect.gen(function* () {
      const defs = yield* FlockTools.defs
      const ask = defs.find((def) => def.id === "ask")!.description
      const handoff = defs.find((def) => def.id === "handoff")!.description
      expect(ask).toContain("REPORTED BACK")
      expect(ask).toContain("only an ask returns")
      expect(handoff).toContain("Do NOT use it to have something verified or reported back")
    }),
  )

  it.live("carries a PAGES-long task and context through verbatim, clipping only the board title", () =>
    Effect.gen(function* () {
      // The engine truncates tool OUTPUT, never tool arguments. The one bound
      // on this path is the board row's title, which is a label; the brief the
      // target reads is the message text and it has to arrive whole.
      const long = Array.from({ length: 300 }, (_, index) => `spec line ${index}: the table is collab_task`).join("\n")
      const flock = yield* room()
      yield* flock.call("ask", { to: "bob", task: long, context: long })

      expect(long.length).toBeGreaterThan(10_000)
      const request = flock.recorded.asks[0]!
      expect(request.task).toBe(long)
      expect(request.context).toBe(long)
      const asked = (yield* flock.log())[0]!
      expect(asked.text).toContain(long)
      expect(asked.text.length).toBeGreaterThan(2 * long.length)
      // Only the board LABEL is bounded, and it says so with an ellipsis.
      const task = (yield* flock.tasks())[0]!
      expect(task.title.length).toBeLessThanOrEqual(80)
      expect(task.title.endsWith("…")).toBe(true)
    }),
  )

  it.live("carries a PAGES-long hand-off brief through to the room untouched", () =>
    Effect.gen(function* () {
      const long = Array.from({ length: 300 }, (_, index) => `step ${index}: do the thing`).join("\n")
      const flock = yield* room()
      yield* flock.call("handoff", { to: "bob", task: long, context: "and then stop" })

      const handed = (yield* flock.log())[0]!
      expect(handed.text).toBe(`${long}\nContext: and then stop`)
    }),
  )
})

describe("done", () => {
  it.live("ends the turn and marks the summary as the room's closing message", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const out = yield* flock.call("done", { summary: "  migration written  " })
      expect(out.output).toContain("summary")
      expect(flock.turn.stop).toEqual({ requested: true, kind: "done", summary: "migration written" })
      // The tool itself posts nothing: the runner appends the summary as the
      // turn's ONE message, so a `done` cannot produce two.
      expect(yield* flock.log()).toEqual([])
    }),
  )

  it.live("ends the turn in deliberate silence when there is no summary", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const out = yield* flock.call("done", {})
      expect(out.metadata["silent"]).toBe(true)
      expect(flock.turn.stop).toEqual({ requested: true, kind: "done", summary: "" })
    }),
  )
})

describe("the task board tools", () => {
  it.live("opens a task and leaves a typed row for it", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const out = yield* flock.call("task_add", { title: "  write the migration  " })
      const task = (yield* flock.tasks())[0]!
      expect(task).toMatchObject({ title: "write the migration", state: "open", owner: null, createdBy: "alice" })
      expect(out.metadata["taskId"]).toBe(task.id)
      expect((yield* flock.log())[0]).toMatchObject({ kind: "task_open", taskId: task.id, authorId: "alice" })
    }),
  )

  it.live("refuses a task with no title", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      expect((yield* flock.call("task_add", { title: "   " })).output).toContain("title")
      expect(yield* flock.tasks()).toEqual([])
    }),
  )

  it.live("walks a task through claim, done and accept, one typed row each", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const opened = yield* flock.call("task_add", { title: "ship it" })
      const taskId = opened.metadata["taskId"] as string
      yield* flock.call("task_claim", { taskId })
      yield* flock.call("task_done", { taskId, result: "built and tested" })
      yield* flock.call("task_accept", { taskId })

      expect((yield* flock.tasks())[0]).toMatchObject({
        state: "accepted",
        owner: "alice",
        result: "built and tested",
      })
      expect((yield* flock.log()).map((message) => message.kind)).toEqual([
        "task_open",
        "task_claim",
        "task_done",
        "task_accept",
      ])
    }),
  )

  it.live("refuses a task id the board does not have", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      for (const [tool, args] of [
        ["task_claim", {}],
        ["task_done", { result: "x" }],
        ["task_accept", {}],
        ["task_reopen", { note: "x" }],
      ] as const) {
        const out = yield* flock.call(tool, { taskId: "clbt_nope", ...args })
        expect(out.output).toContain("clbt_nope")
      }
      expect(yield* flock.log()).toEqual([])
    }),
  )

  it.live("refuses an illegal move with the reason, and changes nothing", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const opened = yield* flock.call("task_add", { title: "ship it" })
      const taskId = opened.metadata["taskId"] as string
      const out = yield* flock.call("task_done", { taskId, result: "built" })
      expect(out.output).toContain("open")
      expect((yield* flock.tasks())[0]?.state).toBe("open")
      expect((yield* flock.log()).map((message) => message.kind)).toEqual(["task_open"])
    }),
  )

  it.live("lets only the OWNER complete a task", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const task = yield* flock.store.addTask({
        collabId: flock.collab.id,
        title: "bob's job",
        createdBy: "alice",
        owner: "bob",
        state: "claimed",
      })
      const out = yield* flock.call("task_done", { taskId: task.id, result: "done" })
      expect(out.output).toContain("belongs to bob")
      expect((yield* flock.tasks())[0]?.state).toBe("claimed")
    }),
  )

  it.live("lets only the agent that opened a task accept it", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const task = yield* flock.store.addTask({
        collabId: flock.collab.id,
        title: "bob's own",
        createdBy: "bob",
        owner: "bob",
        state: "claimed",
      })
      yield* flock.store.updateTask({ collabId: flock.collab.id, taskId: task.id, action: "done", result: "built" })
      const out = yield* flock.call("task_accept", { taskId: task.id })
      expect(out.output).toContain("opened by bob")
      expect((yield* flock.tasks())[0]?.state).toBe("done")
    }),
  )

  it.live("lets the LEAD accept a task the human opened", () =>
    Effect.gen(function* () {
      const flock = yield* room({ lead: "alice" })
      const task = yield* flock.store.addTask({
        collabId: flock.collab.id,
        title: "the human's ask",
        createdBy: "user",
        owner: "alice",
        state: "claimed",
      })
      yield* flock.store.updateTask({ collabId: flock.collab.id, taskId: task.id, action: "done", result: "built" })
      expect((yield* flock.call("task_accept", { taskId: task.id })).output).toContain("accepted")
      expect((yield* flock.tasks())[0]?.state).toBe("accepted")
    }),
  )

  it.live("keeps a non-lead away from the human's tasks", () =>
    Effect.gen(function* () {
      const flock = yield* room({ lead: "bob" })
      const task = yield* flock.store.addTask({
        collabId: flock.collab.id,
        title: "the human's ask",
        createdBy: "user",
        owner: "alice",
        state: "claimed",
      })
      yield* flock.store.updateTask({ collabId: flock.collab.id, taskId: task.id, action: "done", result: "built" })
      expect((yield* flock.call("task_accept", { taskId: task.id })).output).toContain("opened by user")
    }),
  )

  it.live("sends a completed task back to the same owner, with the note", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const task = yield* flock.store.addTask({
        collabId: flock.collab.id,
        title: "bob's job",
        createdBy: "alice",
        owner: "bob",
        state: "claimed",
      })
      yield* flock.store.updateTask({ collabId: flock.collab.id, taskId: task.id, action: "done", result: "built" })
      const out = yield* flock.call("task_reopen", { taskId: task.id, note: "  the test is missing  " })
      expect(out.output).toContain("@bob")
      expect((yield* flock.tasks())[0]).toMatchObject({ state: "claimed", owner: "bob", note: "the test is missing" })
      // The wake for the owner rides this row - the rules read the task off it.
      expect((yield* flock.log()).at(-1)).toMatchObject({ kind: "task_reopen", taskId: task.id })
      // And the row CARRIES the note, exactly as the human's own reject does
      // through `ACPCollab.applyTaskMove`. Without it bob is woken by
      // "reopened task: bob's job" and learns only that somebody was unhappy,
      // not what has to change - and which of the two paths sent it back is
      // not something the room should be able to tell from the text.
      expect((yield* flock.log()).at(-1)?.text).toBe("reopened task: bob's job — the test is missing")
    }),
  )

  it.live("leaves a move with NO note exactly as it was - no dangling separator", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const opened = yield* flock.call("task_add", { title: "ship it" })
      const taskId = opened.metadata["taskId"] as string
      yield* flock.call("task_claim", { taskId })
      yield* flock.call("task_done", { taskId, result: "built" })
      expect((yield* flock.log()).map((message) => message.text)).toEqual([
        "opened task: ship it",
        "claimed task: ship it",
        "completed task: ship it",
      ])
    }),
  )
})

describe("council_ask - a follow-up is a ROUND, and only the synthesis may open one", () => {
  it.live("refuses in a room that is not a council, and points at the tool that fits", () =>
    Effect.gen(function* () {
      const flock = yield* room()
      const out = yield* flock.call("council_ask", { question: "what now?" })
      expect(out.output).toContain("not deliberating as a council")
      expect(out.output).toContain("`ask`")
      // A refusal is a note to ONE model. The room never sees it.
      expect(yield* flock.log()).toHaveLength(0)
    }),
  )

  it.live("refuses inside a blind OPINION, which is the dangerous case", () =>
    Effect.gen(function* () {
      // A question asked from inside an opinion would open a round nested in
      // the round still being answered - and its asker would be the only
      // member that had seen anything of the round it was interrupting.
      const flock = yield* room({ council: "opinion" })
      const out = yield* flock.call("council_ask", { question: "what now?" })
      expect(out.output).toContain("reconciles a round")
      expect(yield* flock.log()).toHaveLength(0)
    }),
  )

  it.live("puts a typed council_question into the room from a synthesis", () =>
    Effect.gen(function* () {
      const flock = yield* room({ council: "synthesis" })
      const out = yield* flock.call("council_ask", { question: "  is the parser the bottleneck?  " })
      expect(out.output).toContain("Put to the council")
      const log = yield* flock.log()
      expect(log).toHaveLength(1)
      expect(log[0]!.kind).toBe("council_question")
      expect(log[0]!.text).toBe("is the parser the bottleneck?")
      // Addressed to NOBODY: the wake rules send a council_question to every
      // active member, so a list here would be a second roster to keep in step.
      expect(log[0]!.mentions).toEqual([])
    }),
  )

  it.live("refuses an empty question rather than opening a round about nothing", () =>
    Effect.gen(function* () {
      const flock = yield* room({ council: "synthesis" })
      const out = yield* flock.call("council_ask", { question: "   " })
      expect(out.output).toContain("needs a question")
      expect(yield* flock.log()).toHaveLength(0)
    }),
  )

  it.live("refuses when the room's budget is spent, because a round costs one", () =>
    Effect.gen(function* () {
      const flock = yield* room({ council: "synthesis", hops: 0 })
      const out = yield* flock.call("council_ask", { question: "one more thing?" })
      expect(out.output).toContain("budget is spent")
      expect(yield* flock.log()).toHaveLength(0)
    }),
  )
})

describe("outside a collab turn", () => {
  it.live("every flock tool refuses rather than acting on a room it does not have", () =>
    Effect.gen(function* () {
      const defs = yield* FlockTools.defs
      const ctx = {
        sessionID: "ses_chat",
        messageID: "msg_1",
        agent: "build",
        abort: new AbortController().signal,
        callID: "call_1",
        extra: {},
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } as unknown as Tool.Context
      const args: Record<string, Record<string, unknown>> = {
        ask: { to: "bob", task: "x" },
        handoff: { to: "bob", task: "x" },
        done: {},
        task_add: { title: "x" },
        task_claim: { taskId: "t" },
        task_done: { taskId: "t", result: "x" },
        task_accept: { taskId: "t" },
        task_reopen: { taskId: "t", note: "x" },
        council_ask: { question: "x" },
      }
      expect(defs.map((def) => def.id).toSorted()).toEqual([
        "ask",
        "council_ask",
        "done",
        "handoff",
        "task_accept",
        "task_add",
        "task_claim",
        "task_done",
        "task_reopen",
      ])
      for (const def of defs) {
        const out = yield* def.execute(args[def.id]!, ctx)
        expect(out.output).toContain("only work inside a collab turn")
      }
    }),
  )
})
