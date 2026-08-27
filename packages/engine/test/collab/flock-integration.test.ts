// One REAL nested ask, end to end.
//
// Every unit test above stubs one side of the seam. This one stubs nothing
// except the model itself: a real collab runner drives a real
// `SessionPrompt.prompt`, which injects the real flock tools through the real
// `SessionTools.resolve` wrapper, and the `ask` tool runs a real nested prompt
// on the target's own session against a recorded HTTP provider. The plumbing
// this proves - tool injection gated on the turn context, argument decoding,
// the nested prompt, the room appends and the ledger - is exactly what no
// amount of unit coverage can.
//
// The provider is the in-process fake HTTP server. No paid model is contacted.

import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { ACPCollab } from "@/collab/acp"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { FSUtil } from "@origami/core/fs-util"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { def, it, providerConfig, wroteFor } from "./harness"

const writeDefs = (directory: string) =>
  Effect.promise(async () => {
    const dir = path.join(directory, ".origami", "agent")
    await Bun.write(path.join(dir, "collab-lead.md"), def("Lead", "You are the lead."))
    await Bun.write(path.join(dir, "collab-worker.md"), def("Worker", "You are the worker."))
  })

const writeSightedDefs = (directory: string) =>
  Effect.promise(async () => {
    const dir = path.join(directory, ".origami", "agent")
    await Bun.write(path.join(dir, "collab-lead.md"), def("Lead", "You are the lead.", ["vision: true"]))
    await Bun.write(path.join(dir, "collab-worker.md"), def("Worker", "You are the worker."))
  })


describe("a real nested ask", () => {
  it.instance(
    "runs the target's turn inside the caller's, and records the whole exchange",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fsys = yield* FSUtil.Service
        yield* fsys.writeWithDirs(
          path.join(directory, "origami.json"),
          JSON.stringify({ ...providerConfig(llm.url) }),
        )

        // The lead asks the worker, then answers the room with what it heard.
        // The worker answers once. Everything else the server answers "ok".
        yield* llm.pushMatch(
          wroteFor("collab-lead"),
          reply()
            .tool("ask", {
              to: "collab-worker",
              task: "where is the migration written?",
              context: "the table is collab_task",
              expect: "the file path",
            })
            .item(),
        )
        yield* llm.pushMatch(
          wroteFor("collab-worker"),
          reply().text("it is in packages/core/src/collab/sql.ts").usage({ input: 120, output: 12 }).stop().item(),
        )
        yield* llm.pushMatch(
          wroteFor("collab-lead"),
          reply()
            .text("the worker says it is in packages/core/src/collab/sql.ts")
            .usage({ input: 200, output: 20 })
            .stop()
            .item(),
        )

        const store = yield* CollabStore.Service
        const runner = yield* CollabRunner.Service
        const collab = yield* store.create({
          title: "Ship it",
          agentSlugs: ["collab-lead", "collab-worker"],
        })
        // Through the ACP method, so the instance binding the detached turns
        // need is done exactly the way the extension does it.
        yield* ACPCollab.post(directory, { collabId: collab.id, text: "where is the migration?" })
        yield* awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")

        const log = yield* store.listMessages(collab.id)
        expect(log.map((message) => ({ kind: message.kind, authorId: message.authorId }))).toEqual([
          { kind: "say", authorId: "user" },
          { kind: "ask", authorId: "collab-lead" },
          { kind: "answer", authorId: "collab-worker" },
          { kind: "say", authorId: "collab-lead" },
        ])
        // The ask names its target structurally, and the answer is tied back to
        // the question it answers.
        expect(log[1]).toMatchObject({ mentions: ["collab-worker"] })
        expect(log[1]!.text).toContain("where is the migration written?")
        expect(log[2]).toMatchObject({ replyToSeq: log[1]!.seq, taskId: log[1]!.taskId, mentions: [] })
        expect(log[2]!.text).toContain("packages/core/src/collab/sql.ts")
        // The lead's own final message carries what it heard, which is the
        // whole point of `ask` being blocking.
        expect(log[3]!.text).toContain("packages/core/src/collab/sql.ts")

        // The auto-task the ask opened was closed by the answer.
        const tasks = yield* store.listTasks(collab.id)
        expect(tasks).toHaveLength(1)
        expect(tasks[0]).toMatchObject({
          title: "where is the migration written?",
          owner: "collab-worker",
          createdBy: "collab-lead",
          state: "done",
          originSeq: log[1]!.seq,
        })

        // Both turns are billed, and the nested one names who asked for it.
        const rows = yield* store.listCosts(collab.id)
        expect(
          rows
            .map((row) => ({ agentSlug: row.agentSlug, askedBy: row.askedBy }))
            .toSorted((a, b) => a.agentSlug.localeCompare(b.agentSlug)),
        ).toEqual([
          { agentSlug: "collab-lead", askedBy: null },
          { agentSlug: "collab-worker", askedBy: "collab-lead" },
        ])
        expect(rows.every((row) => row.model === "test/test-model")).toBe(true)
        // A turn spans several assistant messages, and the lead's covers both
        // of its steps rather than only the last one.
        const lead = rows.find((row) => row.agentSlug === "collab-lead")
        expect(lead?.tokensInput).toBe(200)

        // The worker really was given the brief, not a batch of room messages.
        const briefed = (yield* llm.hits).filter((hit) => wroteFor("collab-worker")(hit))
        const body = JSON.stringify(briefed[0]?.body ?? {})
        expect(body).toContain("FROM: @collab-lead")
        expect(body).toContain("TASK: where is the migration written?")
        expect(body).toContain("CONTEXT: the table is collab_task")
        expect(body).toContain("EXPECTED BACK: the file path")

        // Two hops spent: the lead's turn and the nested one it asked for.
        expect(yield* runner.hopState(collab.id)).toEqual({
          remaining: CollabRunner.LOOP_BREAKER_DEFAULT - 2,
          cap: CollabRunner.LOOP_BREAKER_DEFAULT,
        })
      }),
    { init: writeDefs },
    60_000,
  )

  it.instance(
    "lets `done` end the turn from inside it, and posts the summary as the turn's message",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fsys = yield* FSUtil.Service
        yield* fsys.writeWithDirs(
          path.join(directory, "origami.json"),
          JSON.stringify({ ...providerConfig(llm.url) }),
        )
        // ONE scripted reply. A `done` finishes on "tool-calls", so a loop that
        // ignored the termination signal would run another step and take the
        // server's fallback "ok" - which is exactly what would then be posted.
        yield* llm.pushMatch(
          wroteFor("collab-lead"),
          reply().tool("done", { summary: "nothing to add - the worker has it" }).item(),
        )

        const store = yield* CollabStore.Service
        const runner = yield* CollabRunner.Service
        const collab = yield* store.create({ title: "Ending", agentSlugs: ["collab-lead", "collab-worker"] })
        yield* ACPCollab.post(directory, { collabId: collab.id, text: "status?" })
        yield* awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")

        const log = yield* store.listMessages(collab.id)
        expect(log.map((message) => [message.authorId, message.text])).toEqual([
          ["user", "status?"],
          ["collab-lead", "nothing to add - the worker has it"],
        ])
        // One request, so the loop really stopped rather than being talked out
        // of another step. Title generation is answered by the server itself.
        expect((yield* llm.hits).filter((hit) => wroteFor("collab-lead")(hit))).toHaveLength(1)
        // The trace shows the room what the turn actually did.
        expect(log[1]!.trace).toEqual([{ tool: "done", summary: "nothing to add - the worker has it", status: "ok" }])
      }),
    { init: writeDefs },
    60_000,
  )

  it.instance(
    "sends a posted image to the PROVIDER when the def declared vision, as a real image part",
    () =>
      // The whole seam, end to end: `collab_post` -> the images column -> the
      // envelope sweep -> `SessionPrompt.prompt` parts -> the model message ->
      // the wire. A harness assertion proves only that the runner filled a
      // field; this proves the provider is actually shown the picture.
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fsys = yield* FSUtil.Service
        yield* fsys.writeWithDirs(
          path.join(directory, "origami.json"),
          JSON.stringify({ ...providerConfig(llm.url, true) }),
        )
        yield* llm.pushMatch(wroteFor("collab-lead"), reply().text("a red square").stop().item())

        const store = yield* CollabStore.Service
        const runner = yield* CollabRunner.Service
        const collab = yield* store.create({ title: "Look", agentSlugs: ["collab-lead"] })
        const png =
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        yield* ACPCollab.post(directory, { collabId: collab.id, text: "what is this?", images: [png] })
        yield* awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")

        const body = JSON.stringify((yield* llm.hits).filter((hit) => wroteFor("collab-lead")(hit))[0]?.body ?? {})
        // The base64 payload itself, so this cannot pass on a mime type alone.
        expect(body).toContain("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ")
        expect(body).toContain("image/png")
        // The envelope text still went with it, and the blind note did NOT.
        expect(body).toContain("what is this?")
        expect(body).not.toContain("that you cannot see")
      }),
    { init: writeSightedDefs },
    60_000,
  )

  it.instance(
    "tells a BLIND agent about the image instead of sending it",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fsys = yield* FSUtil.Service
        yield* fsys.writeWithDirs(
          path.join(directory, "origami.json"),
          JSON.stringify({ ...providerConfig(llm.url) }),
        )
        yield* llm.pushMatch(wroteFor("collab-lead"), reply().text("I cannot see it").stop().item())

        const store = yield* CollabStore.Service
        const runner = yield* CollabRunner.Service
        const collab = yield* store.create({ title: "Blind", agentSlugs: ["collab-lead"] })
        yield* ACPCollab.post(directory, {
          collabId: collab.id,
          text: "what is this?",
          images: [
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          ],
        })
        yield* awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")

        const body = JSON.stringify((yield* llm.hits).filter((hit) => wroteFor("collab-lead")(hit))[0]?.body ?? {})
        expect(body).toContain("that you cannot see")
        // Never sent: a model with no vision either errors on the attachment or
        // silently ignores it, and both read to the room as the agent lying.
        expect(body).not.toContain("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ")
      }),
    { init: writeDefs },
    60_000,
  )

  it.instance(
    "gives an ORDINARY chat none of the flock tools",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fsys = yield* FSUtil.Service
        yield* fsys.writeWithDirs(
          path.join(directory, "origami.json"),
          JSON.stringify({ ...providerConfig(llm.url) }),
        )
        yield* llm.text("nothing to see here")

        const sessions = yield* Session.Service
        const prompts = yield* SessionPrompt.Service
        const chat = yield* sessions.create({ title: "Just a chat" })
        yield* prompts.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "hello" }] })

        // The gate is the turn context, and an ordinary chat has none. If this
        // ever fails, every chat in the product just grew an `ask` tool that
        // can only fail.
        const offered = (yield* llm.hits).flatMap((hit) => {
          const tools = (hit.body as { tools?: { function?: { name?: string } }[] }).tools ?? []
          return tools.map((tool) => tool.function?.name)
        })
        expect(offered.length).toBeGreaterThan(0)
        for (const name of ["ask", "handoff", "done", "task_add", "task_claim"]) {
          expect(offered).not.toContain(name)
        }
      }),
    60_000,
  )
})

// -- W8: A HUMAN'S UNASSIGNED TASK, END TO END -------------------------------
//
// THE OWNER'S UAT, verbatim. A room with one bot. The owner puts an UNASSIGNED
// task on the board ("Explain who you are"). The bot's tool trace then read
// `task_claim ok -> bash ok -> done ok`, its prose said the task "appears to
// have been consumed already", and the Tasks drawer still showed the chip OPEN
// and unassigned.
//
// Nothing about that was a drawer fault. The drawer was the only honest reader
// in the room:
//
//   1. The room-state block printed the task's title, state and owner and NOT
//      its id - and `taskId` is the only argument every board tool takes. A
//      task the agent did not open itself, and was not handed through `ask` or
//      `handoff`, could not be named at all. The model guessed.
//   2. `task_claim` refused the guess ("there is no task X on this board").
//      A flock refusal is a plain-text RESULT, never an error, so the part
//      completed and the trace called it "ok" - the screenshot's first lie.
//   3. The model read the refusal as the task having been taken by someone
//      else, said so, and ended its turn. The board never moved, which is
//      exactly what the drawer kept showing.
describe("a human's unassigned task", () => {
  const setup = Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const llm = yield* TestLLMServer
    const fsys = yield* FSUtil.Service
    yield* fsys.writeWithDirs(path.join(directory, "origami.json"), JSON.stringify({ ...providerConfig(llm.url) }))
    yield* Effect.promise(async () => {
      await Bun.write(path.join(directory, ".origami", "agent", "collab-lead.md"), def("Lead", "You are the lead."))
    })
    const store = yield* CollabStore.Service
    const collab = yield* store.create({ title: "Board", agentSlugs: ["collab-lead"] })
    const { task } = yield* ACPCollab.taskAdd(directory, { collabId: collab.id, title: "Explain who you are" })
    return { directory, llm, store, collab, task }
  })

  it.instance(
    "puts the task's ID in front of the agent, so it can name the one thing its board tools take",
    () =>
      Effect.gen(function* () {
        const { directory, llm, collab, task } = yield* setup
        const runner = yield* CollabRunner.Service
        yield* llm.pushMatch(wroteFor("collab-lead"), reply().text("on it").stop().item())

        yield* ACPCollab.post(directory, { collabId: collab.id, text: "get on with it" })
        yield* awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")

        // THE ROOT CAUSE, at the seam it actually breaks: what the model was
        // sent. Without the id in here there is no move the agent can make on
        // this task that is not a guess.
        const sent = (yield* llm.hits).map((hit) => JSON.stringify(hit.body)).join("\n")
        expect(sent).toContain(task.id)
      }),
    60_000,
  )

  it.instance(
    "records a refused claim as a FAILED tool, so the trace and the board cannot disagree",
    () =>
      Effect.gen(function* () {
        const { directory, llm, store, collab, task } = yield* setup
        const runner = yield* CollabRunner.Service
        // The guess the owner's bot made, and the turn it ended in.
        yield* llm.pushMatch(
          wroteFor("collab-lead"),
          reply().tool("task_claim", { taskId: "clbt_notarealid" }).item(),
          reply().text("that task appears to have been consumed already").stop().item(),
        )

        yield* ACPCollab.post(directory, { collabId: collab.id, text: "get on with it" })
        yield* awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")

        // The trace the owner read as "task_claim ok".
        const said = (yield* store.listMessages(collab.id)).findLast((message) => message.authorId === "collab-lead")
        expect(said?.trace).toEqual([{ tool: "task_claim", summary: "clbt_notarealid", status: "error" }])
        // ...and the board, which was right all along.
        expect(yield* store.getTask(collab.id, task.id)).toMatchObject({ state: "open", owner: null })
      }),
    60_000,
  )

  it.instance(
    "lands claimant and result on the STORED task once the agent can name it",
    () =>
      Effect.gen(function* () {
        const { directory, llm, store, collab, task } = yield* setup
        const runner = yield* CollabRunner.Service
        yield* llm.pushMatch(
          wroteFor("collab-lead"),
          reply().tool("task_claim", { taskId: task.id }).item(),
          reply().tool("task_done", { taskId: task.id, result: "I am the lead of this room." }).item(),
          reply().text("done - I have said who I am").stop().item(),
        )

        yield* ACPCollab.post(directory, { collabId: collab.id, text: "get on with it" })
        yield* awaitWithTimeout(runner.settle, "the collab never settled", "60 seconds")

        // `done` is NOT closed: it is the task parked on whoever raised it, and
        // the owner survives the move - "who did this" is the question the
        // drawer could never answer.
        expect(yield* store.getTask(collab.id, task.id)).toMatchObject({
          state: "done",
          owner: "collab-lead",
          createdBy: "user",
          result: "I am the lead of this room.",
        })
        // The room carries both moves, so the stream reads the same as the board.
        const kinds = (yield* store.listMessages(collab.id)).map((message) => message.kind)
        expect(kinds).toContain("task_claim")
        expect(kinds).toContain("task_done")
      }),
    60_000,
  )
})
