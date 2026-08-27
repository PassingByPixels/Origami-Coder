import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { ACPCollab } from "@/collab/acp"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * The Collab ext METHODS, against the real store and runner rather than the
 * projection helpers. No agent definitions back the roster slugs, so a turn
 * that starts will fail and be recorded on the agent's status - which is what
 * the runner does with any broken agent, and is not what these tests assert.
 */
const it = testEffect(
  LayerNode.compile(LayerNode.group([CollabStore.node, CollabRunner.node, Agent.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({})],
  ]),
)

const room = (agentSlugs: readonly string[] = ["alice", "bob"]) =>
  Effect.gen(function* () {
    const directory = (yield* TestInstance).directory
    const store = yield* CollabStore.Service
    const collab = yield* store.create({ title: "Ship it", agentSlugs })
    return { directory, store, collab }
  })

/** The safe message a refused ext method carries, or undefined when it succeeded. */
const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.map(() => undefined as string | undefined),
    Effect.catch((error: E) => Effect.succeed((error as { safeMessage?: string }).safeMessage ?? String(error))),
  )

const settle = Effect.gen(function* () {
  yield* (yield* CollabRunner.Service).settle
})

describe("collab_post addressing", () => {
  it.instance("refuses a slug that is not in the room, and names the ones that are", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const refusal = yield* failure(
        ACPCollab.post(directory, { collabId: collab.id, text: "hi", mentions: ["alice", "carol"] }),
      )
      expect(refusal).toContain("carol")
      // The valid set has to be IN the error: a shell cannot fix an address it
      // is not told the alternatives to.
      expect(refusal).toContain("alice")
      expect(refusal).toContain("bob")
      // Nothing is appended: a recorded post that reaches nobody reads as the
      // whole room ignoring it.
      expect(yield* store.listMessages(collab.id)).toEqual([])
    }),
  )

  it.instance("round-trips the images the human attached, on the row and on the wire", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const png = "data:image/png;base64,iVBORw0KGgo="
      const jpeg = "data:image/jpeg;base64,/9j/4AAQ"
      const result = yield* ACPCollab.post(directory, {
        collabId: collab.id,
        text: "look at this",
        images: [png, jpeg],
      })
      expect(result.seq).toBe(1)

      const stored = yield* store.listMessages(collab.id)
      expect(stored[0]?.images).toEqual([png, jpeg])

      const state = yield* ACPCollab.state(directory, { collabId: collab.id })
      expect(state.messages[0]?.images).toEqual([png, jpeg])
      yield* settle
    }),
  )

  it.instance("leaves the key OFF an ordinary post, so a shell can test presence", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      yield* ACPCollab.post(directory, { collabId: collab.id, text: "no pictures here" })
      expect("images" in (yield* store.listMessages(collab.id))[0]!).toBe(false)
      const state = yield* ACPCollab.state(directory, { collabId: collab.id })
      expect("images" in state.messages[0]!).toBe(false)
      yield* settle
    }),
  )

  it.instance("refuses more images than one message may carry, and appends nothing", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const one = "data:image/png;base64,iVBORw0KGgo="
      const refusal = yield* failure(
        ACPCollab.post(directory, {
          collabId: collab.id,
          text: "a gallery",
          images: Array.from({ length: CollabStore.IMAGE_LIMIT + 1 }, () => one),
        }),
      )
      // The LIMIT is in the message: a human told only "refused" is left
      // guessing which of three rules they broke.
      expect(refusal).toContain(`${CollabStore.IMAGE_LIMIT}`)
      expect(yield* store.listMessages(collab.id)).toEqual([])
    }),
  )

  it.instance("refuses an image that is not inlined as a data: URL", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const refusal = yield* failure(
        ACPCollab.post(directory, { collabId: collab.id, text: "see", images: ["https://example.com/cat.png"] }),
      )
      expect(refusal).toContain("data: URL")
      expect(yield* store.listMessages(collab.id)).toEqual([])
    }),
  )

  it.instance("refuses an image over the per-image size limit, and appends nothing", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      // Just over the bound once decoded - the payload is base64, so four
      // characters buy three bytes.
      const oversize = `data:image/png;base64,${"A".repeat(Math.ceil((CollabStore.IMAGE_BYTES_MAX + 1024) / 3) * 4)}`
      const refusal = yield* failure(
        ACPCollab.post(directory, { collabId: collab.id, text: "a big one", images: [oversize] }),
      )
      expect(refusal).toContain("2MB")
      expect(yield* store.listMessages(collab.id)).toEqual([])
    }),
  )

  it.instance("treats a participant that has left as unaddressable", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      yield* store.removeParticipant(collab.id, "bob")
      const refusal = yield* failure(ACPCollab.post(directory, { collabId: collab.id, text: "hi", mentions: ["bob"] }))
      expect(refusal).toContain("bob")
      expect(yield* store.listMessages(collab.id)).toEqual([])
    }),
  )

  it.instance("takes a post addressed to agents that are all in the room", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const result = yield* ACPCollab.post(directory, { collabId: collab.id, text: "hi", mentions: ["alice", "bob"] })
      expect(result.seq).toBe(1)
      expect("notice" in result).toBe(false)
      expect(yield* store.listMessages(collab.id)).toHaveLength(1)
      yield* settle
    }),
  )

  it.instance("says so when an unaddressed post has no lead to reach", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room([])
      const result = yield* ACPCollab.post(directory, { collabId: collab.id, text: "anyone?" })
      // The post still stands - it is the record of what was asked - but the
      // shell is told, rather than left watching a room that never answers.
      expect(result).toEqual({ seq: 1, notice: "no-lead" })
      expect(yield* store.listMessages(collab.id)).toHaveLength(1)
      yield* settle
    }),
  )

  it.instance("sends no notice when a lead is there to take the post", () =>
    Effect.gen(function* () {
      const { directory, collab } = yield* room()
      const result = yield* ACPCollab.post(directory, { collabId: collab.id, text: "anyone?" })
      expect(result).toEqual({ seq: 1 })
      yield* settle
    }),
  )

  it.instance("sends the no-lead notice again once the seat is cleared", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      yield* store.setLead(collab.id, null)
      expect(yield* ACPCollab.post(directory, { collabId: collab.id, text: "anyone?" })).toEqual({
        seq: 1,
        notice: "no-lead",
      })
      yield* settle
    }),
  )

  it.instance("still refuses to post into an archived room", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      yield* store.archive(collab.id)
      expect(yield* failure(ACPCollab.post(directory, { collabId: collab.id, text: "hi" }))).toContain("archived")
    }),
  )
})

describe("collab_set_lead", () => {
  it.instance("takes only an agent that is actually in the room", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      expect(yield* failure(ACPCollab.setLead(directory, { collabId: collab.id, agentSlug: "carol" }))).toContain(
        "carol",
      )
      yield* store.removeParticipant(collab.id, "bob")
      // A lead nobody can wake is the same as no lead, but reads as a room
      // that is simply ignoring you.
      expect(yield* failure(ACPCollab.setLead(directory, { collabId: collab.id, agentSlug: "bob" }))).toContain("bob")
      expect((yield* store.get(collab.id))?.lead).toBe("alice")
    }),
  )

  it.instance("moves the seat, and clears it on an explicit null", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      expect(yield* ACPCollab.setLead(directory, { collabId: collab.id, agentSlug: "bob" })).toEqual({ ok: true })
      expect((yield* store.get(collab.id))?.lead).toBe("bob")
      yield* ACPCollab.setLead(directory, { collabId: collab.id, agentSlug: null })
      expect((yield* store.get(collab.id))?.lead).toBeNull()
    }),
  )

  it.instance("stores a trimmed objective", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      yield* ACPCollab.setObjective(directory, { collabId: collab.id, objective: "  cut the release  " })
      expect((yield* store.get(collab.id))?.objective).toBe("cut the release")
    }),
  )
})

describe("collab task methods", () => {
  it.instance("puts a task on the board and leaves a typed row in the log", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const { task } = yield* ACPCollab.taskAdd(directory, { collabId: collab.id, title: "  write the migration  " })
      expect(task).toMatchObject({ title: "write the migration", state: "open", owner: null, createdBy: "user" })

      const log = yield* store.listMessages(collab.id)
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ kind: "task_open", taskId: task.id, authorKind: "human" })
      // Appended through the STORE, so no agent was queued: board bookkeeping
      // must not spend a turn from everyone in the room.
      expect((yield* (yield* CollabRunner.Service).statuses(collab.id)).size).toBe(0)
    }),
  )

  it.instance("refuses an empty task title", () =>
    Effect.gen(function* () {
      const { directory, collab } = yield* room()
      expect(yield* failure(ACPCollab.taskAdd(directory, { collabId: collab.id, title: "   " }))).toContain("empty")
    }),
  )

  it.instance("walks a task through its moves, one typed log row each", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const { task } = yield* ACPCollab.taskAdd(directory, { collabId: collab.id, title: "ship it" })
      yield* ACPCollab.taskUpdate(directory, {
        collabId: collab.id,
        taskId: task.id,
        action: "claim",
        owner: "alice",
      })
      yield* ACPCollab.taskUpdate(directory, { collabId: collab.id, taskId: task.id, action: "done", result: "built" })
      const accepted = yield* ACPCollab.taskUpdate(directory, {
        collabId: collab.id,
        taskId: task.id,
        action: "accept",
      })
      expect(accepted.task).toMatchObject({ state: "accepted", owner: "alice", result: "built" })
      expect((yield* store.listMessages(collab.id)).map((entry) => entry.kind)).toEqual([
        "task_open",
        "task_claim",
        "task_done",
        "task_accept",
      ])
    }),
  )

  it.instance("refuses an illegal move with the reason, and changes nothing", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const { task } = yield* ACPCollab.taskAdd(directory, { collabId: collab.id, title: "ship it" })
      const refusal = yield* failure(
        ACPCollab.taskUpdate(directory, { collabId: collab.id, taskId: task.id, action: "done", result: "built" }),
      )
      expect(refusal).toContain("open")
      expect((yield* store.getTask(collab.id, task.id))?.state).toBe("open")
      // No log row either: a refused move did not happen.
      expect((yield* store.listMessages(collab.id)).map((entry) => entry.kind)).toEqual(["task_open"])
    }),
  )

  it.instance("refuses a claim with no owner, and a reopen with no note", () =>
    Effect.gen(function* () {
      const { directory, collab } = yield* room()
      const { task } = yield* ACPCollab.taskAdd(directory, { collabId: collab.id, title: "ship it" })
      expect(
        yield* failure(ACPCollab.taskUpdate(directory, { collabId: collab.id, taskId: task.id, action: "claim" })),
      ).toContain("owner")
      yield* ACPCollab.taskUpdate(directory, { collabId: collab.id, taskId: task.id, action: "claim", owner: "alice" })
      yield* ACPCollab.taskUpdate(directory, { collabId: collab.id, taskId: task.id, action: "done", result: "built" })
      expect(
        yield* failure(ACPCollab.taskUpdate(directory, { collabId: collab.id, taskId: task.id, action: "reopen" })),
      ).toContain("note")
    }),
  )

  it.instance("refuses a task id the room does not have", () =>
    Effect.gen(function* () {
      const { directory, collab } = yield* room()
      expect(
        yield* failure(ACPCollab.taskUpdate(directory, { collabId: collab.id, taskId: "clbt_nope", action: "accept" })),
      ).toContain("clbt_nope")
    }),
  )
})

describe("collab_ledger", () => {
  it.instance("answers with the page newest-first and the totals over everything", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const spend = (agentSlug: string, cost: number) =>
        store.appendCost({
          collabId: collab.id,
          agentSlug,
          model: "lmstudio/qwen3-coder",
          tokensInput: 10,
          tokensOutput: 2,
          cost,
        })
      yield* spend("alice", 1)
      yield* spend("alice", 2)
      yield* spend("bob", 4)

      const paged = yield* ACPCollab.ledger(directory, { collabId: collab.id, limit: 2 })
      expect(paged.entries.map((entry) => entry.cost)).toEqual([4, 2])
      expect(typeof paged.entries[0]!.createdAt).toBe("string")
      // Totals cover the WHOLE ledger, never just the page above.
      expect(paged.totals).toEqual([
        { agentSlug: "alice", cost: 3, tokensInput: 20, tokensOutput: 4 },
        { agentSlug: "bob", cost: 4, tokensInput: 10, tokensOutput: 2 },
      ])
    }),
  )
})

describe("collab_stop", () => {
  it.instance("spends the budget so the room holds, and a human post releases it", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      expect(yield* ACPCollab.stop(directory, { collabId: collab.id })).toEqual({ ok: true })

      const held = yield* ACPCollab.state(directory, { collabId: collab.id })
      expect(held.hopState).toEqual({ remaining: 0, cap: CollabRunner.LOOP_BREAKER_DEFAULT })
      expect(held.suspended).toBe(true)

      yield* ACPCollab.post(directory, { collabId: collab.id, text: "carry on" })
      yield* settle
      const released = yield* ACPCollab.state(directory, { collabId: collab.id })
      expect(released.suspended).toBe(false)
      expect(yield* store.listMessages(collab.id)).toHaveLength(1)
    }),
  )

  it.instance("refuses a collab that does not exist", () =>
    Effect.gen(function* () {
      const { directory } = yield* room()
      expect(yield* failure(ACPCollab.stop(directory, { collabId: "clb_nope" }))).toContain("clb_nope")
    }),
  )
})

describe("collab_unarchive", () => {
  // The inverse of the archived refusal above: archiving is "read-only from
  // here", and until this verb existed it was also "for ever", because
  // `time_archived` had nothing to set it back.
  it.instance("puts an archived room back on the record and lets posts land again", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      yield* ACPCollab.archive(directory, { collabId: collab.id })
      expect(yield* failure(ACPCollab.post(directory, { collabId: collab.id, text: "hi" }))).toContain("archived")

      expect(yield* ACPCollab.unarchive(directory, { collabId: collab.id })).toEqual({ ok: true })
      expect((yield* store.get(collab.id))?.archivedAt).toBeUndefined()

      expect(yield* ACPCollab.post(directory, { collabId: collab.id, text: "we are back" })).toEqual({ seq: 1 })
      yield* settle
      expect(yield* store.listMessages(collab.id)).toHaveLength(1)
    }),
  )

  it.instance("refuses a collab that does not exist", () =>
    Effect.gen(function* () {
      const { directory } = yield* room()
      expect(yield* failure(ACPCollab.unarchive(directory, { collabId: "clb_nope" }))).toContain("clb_nope")
    }),
  )

  it.instance("is a no-op on a room that was never archived", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      expect(yield* ACPCollab.unarchive(directory, { collabId: collab.id })).toEqual({ ok: true })
      expect((yield* store.get(collab.id))?.archivedAt).toBeUndefined()
    }),
  )
})

describe("collab_state", () => {
  it.instance("carries the lead, the objective, the board, the totals and the hop budget", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      yield* store.setObjective(collab.id, "cut the release")
      yield* store.appendCost({
        collabId: collab.id,
        agentSlug: "alice",
        model: "lmstudio/qwen3-coder",
        tokensInput: 7,
        tokensOutput: 3,
        cost: 0.5,
      })
      const open = yield* store.addTask({ collabId: collab.id, title: "live", createdBy: "user" })
      const closed = yield* store.addTask({ collabId: collab.id, title: "old", createdBy: "user", state: "accepted" })

      const state = yield* ACPCollab.state(directory, { collabId: collab.id })
      expect(state.lead).toBe("alice")
      expect(state.objective).toBe("cut the release")
      expect(state.collab.lead).toBe("alice")
      expect(state.tasks.map((task) => task.id)).toEqual([open.id, closed.id])
      expect(state.costTotals).toEqual([{ agentSlug: "alice", cost: 0.5, tokensInput: 7, tokensOutput: 3 }])
      expect(state.hopState).toEqual({
        remaining: CollabRunner.LOOP_BREAKER_DEFAULT,
        cap: CollabRunner.LOOP_BREAKER_DEFAULT,
      })
      expect(state.suspended).toBe(false)
    }),
  )

  it.instance("reports no budget at all once the cap is turned off", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      yield* store.setCap(collab.id, 0)
      const state = yield* ACPCollab.state(directory, { collabId: collab.id })
      expect(state.hopState).toEqual({ remaining: null, cap: null })
      expect(state.suspended).toBe(false)
    }),
  )

  it.instance("omits liveActivity AND liveThought from every agent entry while the room is idle", () =>
    Effect.gen(function* () {
      // No agent definitions back these slugs, so nothing here ever reaches
      // "running" - the wire shape this exercises is the absence itself.
      const { directory, collab } = yield* room()
      const state = yield* ACPCollab.state(directory, { collabId: collab.id })
      expect(state.agents.length).toBeGreaterThan(0)
      for (const entry of state.agents) {
        expect("liveActivity" in entry).toBe(false)
        expect("liveThought" in entry).toBe(false)
      }
    }),
  )

  it.instance("omits the retained activity from an agent that has nothing kept", () =>
    Effect.gen(function* () {
      const { directory, collab } = yield* room()
      const state = yield* ACPCollab.state(directory, { collabId: collab.id })
      for (const entry of state.agents) expect("activity" in entry).toBe(false)
    }),
  )
})

describe("collab_preview", () => {
  it.instance("names exactly the agents an addressed draft would wake", () =>
    Effect.gen(function* () {
      const { directory, collab } = yield* room(["alice", "bob", "carol"])
      expect(yield* ACPCollab.preview(directory, { collabId: collab.id, mentions: ["bob", "carol"] })).toEqual({
        wake: ["bob", "carol"],
      })
    }),
  )

  it.instance("names the lead alone for an unaddressed draft, and says so when the seat is empty", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      expect(yield* ACPCollab.preview(directory, { collabId: collab.id })).toEqual({ wake: ["alice"] })

      yield* store.setLead(collab.id, null)
      // The SAME notice `collab_post` answers with, so the composer can warn
      // before the message is sent rather than after it lands on nobody.
      expect(yield* ACPCollab.preview(directory, { collabId: collab.id })).toEqual({ wake: [], notice: "no-lead" })
    }),
  )

  it.instance("names an address the room does not have instead of previewing silence", () =>
    Effect.gen(function* () {
      const { directory, collab } = yield* room()
      // `collab_post` would REFUSE this outright, so a preview that answered a
      // bare "nobody" would be describing a message that is never sent.
      expect(yield* ACPCollab.preview(directory, { collabId: collab.id, mentions: ["carol"] })).toEqual({
        wake: [],
        unknown: ["carol"],
      })
    }),
  )

  it.instance("leaves a removed member out of the wake set", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      yield* store.removeParticipant(collab.id, "bob")
      expect(yield* ACPCollab.preview(directory, { collabId: collab.id, mentions: ["bob"] })).toEqual({
        wake: [],
        unknown: ["bob"],
      })
    }),
  )

  it.instance("starts NOTHING - no message, no turn, no session, no spend", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      yield* ACPCollab.preview(directory, { collabId: collab.id })
      yield* ACPCollab.preview(directory, { collabId: collab.id, mentions: ["alice", "bob"] })
      yield* settle

      expect(yield* store.listMessages(collab.id)).toEqual([])
      expect((yield* (yield* CollabRunner.Service).statuses(collab.id)).size).toBe(0)
      expect((yield* store.participants(collab.id)).map((entry) => entry.sessionId)).toEqual([null, null])
      expect(yield* store.listCosts(collab.id)).toEqual([])
      // And it does not touch the budget either: a preview that spent a hop
      // would make looking at a draft cost the same as sending it.
      expect((yield* ACPCollab.state(directory, { collabId: collab.id })).hopState.remaining).toBe(
        CollabRunner.LOOP_BREAKER_DEFAULT,
      )
    }),
  )

  it.instance("refuses a collab that does not exist", () =>
    Effect.gen(function* () {
      const { directory } = yield* room()
      expect(yield* failure(ACPCollab.preview(directory, { collabId: "clb_nope" }))).toContain("clb_nope")
    }),
  )
})

describe("collab_review", () => {
  /** A task an agent finished, waiting on the human's verdict. */
  const completed = (directory: string, collabId: string) =>
    Effect.gen(function* () {
      const store = yield* CollabStore.Service
      const task = yield* store.addTask({ collabId, title: "write the migration", createdBy: "alice" })
      yield* store.updateTask({ collabId, taskId: task.id, action: "claim", owner: "bob" })
      yield* store.updateTask({ collabId, taskId: task.id, action: "done", result: "built" })
      void directory
      return task
    })

  it.instance("approve accepts the task and leaves the typed row behind", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const task = yield* completed(directory, collab.id)
      const result = yield* ACPCollab.review(directory, { collabId: collab.id, taskId: task.id, verdict: "approve" })
      expect(result.task).toMatchObject({ state: "accepted", owner: "bob" })
      expect((yield* store.listMessages(collab.id)).map((entry) => entry.kind)).toEqual(["task_accept"])
      yield* settle
    }),
  )

  it.instance("reject sends it back to its owner WITH the reason in the room", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const task = yield* completed(directory, collab.id)
      const result = yield* ACPCollab.review(directory, {
        collabId: collab.id,
        taskId: task.id,
        verdict: "reject",
        note: "the index is missing",
      })
      expect(result.task).toMatchObject({ state: "claimed", owner: "bob", note: "the index is missing" })
      // The row the OWNER is woken by has to carry the correction. Without it
      // bob reads "reopened task: write the migration" and knows only that the
      // human was unhappy, not what has to change.
      const row = (yield* store.listMessages(collab.id)).at(-1)
      expect(row?.kind).toBe("task_reopen")
      expect(row?.text).toContain("the index is missing")
      yield* settle
    }),
  )

  it.instance("refuses a reject with no reason, and changes nothing", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const task = yield* completed(directory, collab.id)
      expect(
        yield* failure(ACPCollab.review(directory, { collabId: collab.id, taskId: task.id, verdict: "reject" })),
      ).toContain("note")
      expect((yield* store.getTask(collab.id, task.id))?.state).toBe("done")
      expect(yield* store.listMessages(collab.id)).toEqual([])
    }),
  )

  it.instance("refuses a verdict on a task nobody has completed", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      const task = yield* store.addTask({ collabId: collab.id, title: "not started", createdBy: "alice" })
      expect(
        yield* failure(ACPCollab.review(directory, { collabId: collab.id, taskId: task.id, verdict: "approve" })),
      ).toContain("open")
      expect(yield* store.listMessages(collab.id)).toEqual([])
    }),
  )

  it.instance("refuses a task id the room does not have", () =>
    Effect.gen(function* () {
      const { directory, collab } = yield* room()
      expect(
        yield* failure(ACPCollab.review(directory, { collabId: collab.id, taskId: "clbt_nope", verdict: "approve" })),
      ).toContain("clbt_nope")
    }),
  )
})

describe("collab per-agent supervision methods", () => {
  it.instance("stop_agent answers what it did, and refuses a slug the room does not have", () =>
    Effect.gen(function* () {
      const { directory, collab } = yield* room()
      expect(yield* ACPCollab.stopAgent(directory, { collabId: collab.id, agentSlug: "alice" })).toEqual({
        interrupted: false,
        dequeued: false,
      })
      const refusal = yield* failure(
        ACPCollab.stopAgent(directory, { collabId: collab.id, agentSlug: "carol" }),
      )
      expect(refusal).toContain("carol")
      expect(refusal).toContain("alice")
    }),
  )

  it.instance("redirect posts the correction to that agent alone", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      expect(
        yield* ACPCollab.redirect(directory, { collabId: collab.id, agentSlug: "bob", text: "smaller diff please" }),
      ).toEqual({ seq: 1 })
      yield* settle
      const row = (yield* store.listMessages(collab.id))[0]
      expect(row).toMatchObject({ authorKind: "human", kind: "say", text: "smaller diff please" })
      expect(row?.mentions).toEqual(["bob"])
    }),
  )

  it.instance("redirect refuses a slug that is not in the room, and appends nothing", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      expect(
        yield* failure(ACPCollab.redirect(directory, { collabId: collab.id, agentSlug: "carol", text: "do X" })),
      ).toContain("carol")
      expect(yield* store.listMessages(collab.id)).toEqual([])
    }),
  )

  it.instance("redirect refuses an archived room", () =>
    Effect.gen(function* () {
      const { directory, store, collab } = yield* room()
      yield* store.archive(collab.id)
      expect(
        yield* failure(ACPCollab.redirect(directory, { collabId: collab.id, agentSlug: "bob", text: "do X" })),
      ).toContain("archived")
    }),
  )
})
