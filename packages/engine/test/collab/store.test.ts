import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CollabStore } from "@/collab/store"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([CollabStore.node])))

const open = (title: string, agentSlugs: readonly string[] = ["alice", "bob"]) =>
  Effect.gen(function* () {
    const store = yield* CollabStore.Service
    return { store, collab: yield* store.create({ title, agentSlugs }) }
  })

const human = (collabId: string, text: string) => ({ collabId, authorId: "user", authorKind: "human", text }) as const

describe("collab store", () => {
  it.live("opens a collab on the engine default cap rather than a copy of it", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Ship it")
      expect(collab.title).toBe("Ship it")
      // null, NOT 6: "never configured" has to stay distinguishable from
      // "configured to today's default", or moving the default would silently
      // skip every collab already opened.
      expect(collab.loopBreakerCap).toBeNull()
      expect(collab.archivedAt).toBeUndefined()
      expect(yield* store.get(collab.id)).toMatchObject({ id: collab.id, title: "Ship it" })
    }),
  )

  it.live("puts every named agent on the roster, once each", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Roster", ["alice", "bob", "alice"])
      const roster = yield* store.participants(collab.id)
      expect(roster.map((entry) => entry.agentSlug).toSorted()).toEqual(["alice", "bob"])
      expect(roster.every((entry) => entry.sessionId === null && entry.lastSeenSeq === 0)).toBe(true)
    }),
  )

  it.live("numbers messages from 1, in order of arrival", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Sequence")
      const first = yield* store.appendMessage(human(collab.id, "one"))
      const second = yield* store.appendMessage(human(collab.id, "two"))
      const third = yield* store.appendMessage({
        collabId: collab.id,
        authorId: "alice",
        authorKind: "agent",
        text: "three",
      })
      expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3])
      expect((yield* store.listMessages(collab.id)).map((message) => message.text)).toEqual(["one", "two", "three"])
    }),
  )

  it.live("numbers each collab's log independently", () =>
    Effect.gen(function* () {
      const left = yield* open("Left")
      const right = yield* open("Right")
      yield* left.store.appendMessage(human(left.collab.id, "a"))
      const other = yield* left.store.appendMessage(human(right.collab.id, "b"))
      expect(other.seq).toBe(1)
    }),
  )

  it.live("assigns a gapless run of sequence numbers when appends are issued together", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Burst")
      const written = yield* Effect.all(
        Array.from({ length: 12 }, (_, index) => store.appendMessage(human(collab.id, `m${index}`))),
        { concurrency: "unbounded" },
      )
      // Exactly 1..12 once each: a duplicate would mean two writers read the
      // same max, a gap would mean a lost append.
      expect(written.map((message) => message.seq).toSorted((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ])
      expect(yield* store.listMessages(collab.id)).toHaveLength(12)
    }),
  )

  it.live("keeps one gapless sequence when two independent writers append at once", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Contention")
      // Two writers, not one burst: an `ask` runs a nested turn INSIDE another
      // agent's drain slot, so the answer and a queued reply reach the same log
      // from two places at once. The unique (collab_id, seq) index plus the
      // append retry are the only things keeping that from duplicating a seq.
      const writer = (name: string) =>
        Effect.all(
          Array.from({ length: 15 }, (_, index) =>
            store.appendMessage({
              collabId: collab.id,
              authorId: name,
              authorKind: "agent",
              text: `${name}-${index}`,
            }),
          ),
          { concurrency: "unbounded" },
        )
      const [left, right] = yield* Effect.all([writer("alice"), writer("bob")], { concurrency: "unbounded" })

      const seqs = [...left, ...right].map((message) => message.seq).toSorted((a, b) => a - b)
      expect(seqs).toEqual(Array.from({ length: 30 }, (_, index) => index + 1))
      expect(new Set(seqs).size).toBe(30)
      // Every append landed, and every author is still attached to its own text.
      const stored = yield* store.listMessages(collab.id)
      expect(stored).toHaveLength(30)
      expect(stored.every((message) => message.text.startsWith(message.authorId))).toBe(true)
    }),
  )

  it.live("lists only what is above sinceSeq, ascending", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Since")
      for (const text of ["a", "b", "c"]) yield* store.appendMessage(human(collab.id, text))
      expect((yield* store.listMessages(collab.id, 1)).map((message) => message.text)).toEqual(["b", "c"])
      expect(yield* store.listMessages(collab.id, 3)).toEqual([])
      // Absent means the whole log, which is not the same as sinceSeq 0 by
      // accident - both must answer with everything.
      expect(yield* store.listMessages(collab.id, 0)).toHaveLength(3)
      expect(yield* store.listMessages(collab.id)).toHaveLength(3)
    }),
  )

  it.live("round-trips all three cap meanings", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Cap")
      yield* store.setCap(collab.id, 0)
      expect((yield* store.get(collab.id))?.loopBreakerCap).toBe(0)
      yield* store.setCap(collab.id, 3)
      expect((yield* store.get(collab.id))?.loopBreakerCap).toBe(3)
      // null is a real value here (restore the default), not "leave it alone".
      yield* store.setCap(collab.id, null)
      expect((yield* store.get(collab.id))?.loopBreakerCap).toBeNull()
    }),
  )

  it.live("keeps the first session an agent was given", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Session")
      yield* store.setParticipantSession(collab.id, "alice", "ses_first")
      yield* store.setParticipantSession(collab.id, "alice", "ses_second")
      const alice = (yield* store.participants(collab.id)).find((entry) => entry.agentSlug === "alice")
      // A second write would strand the first session's history: the agent
      // would answer the next batch with no memory of the last one.
      expect(alice?.sessionId).toBe("ses_first")
    }),
  )

  it.live("moves the last-seen marker forward only", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Marker")
      yield* store.setLastSeen(collab.id, "alice", 5)
      yield* store.setLastSeen(collab.id, "alice", 2)
      const alice = (yield* store.participants(collab.id)).find((entry) => entry.agentSlug === "alice")
      expect(alice?.lastSeenSeq).toBe(5)
    }),
  )

  it.live("marks a collab archived without touching its log", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Archive")
      yield* store.appendMessage(human(collab.id, "a"))
      yield* store.archive(collab.id, 1234)
      expect((yield* store.get(collab.id))?.archivedAt).toBe(1234)
      expect(yield* store.listMessages(collab.id)).toHaveLength(1)
      expect((yield* store.list()).some((entry) => entry.id === collab.id)).toBe(true)
    }),
  )

  it.live("takes a collab back out of the archive without rewinding it", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Reopen")
      yield* store.appendMessage(human(collab.id, "a"))
      yield* store.archive(collab.id, 1234)
      yield* store.unarchive(collab.id)
      // The room is live again...
      expect((yield* store.get(collab.id))?.archivedAt).toBeUndefined()
      // ...and nothing else moved: the log is the reason it was kept, and each
      // member's marker is what stops the reopened room replaying everything.
      expect(yield* store.listMessages(collab.id)).toHaveLength(1)
      expect((yield* store.participants(collab.id)).map((entry) => entry.agentSlug).toSorted()).toEqual([
        "alice",
        "bob",
      ])
    }),
  )

  it.live("retitles a collab without touching anything else", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Old name")
      yield* store.appendMessage(human(collab.id, "a"))
      yield* store.rename(collab.id, "New name")
      const renamed = yield* store.get(collab.id)
      expect(renamed?.title).toBe("New name")
      expect(renamed?.createdAt).toBe(collab.createdAt)
      expect(yield* store.listMessages(collab.id)).toHaveLength(1)
      expect((yield* store.participants(collab.id)).map((entry) => entry.agentSlug).toSorted()).toEqual([
        "alice",
        "bob",
      ])
    }),
  )

  it.live("answers with undefined for a collab that does not exist", () =>
    Effect.gen(function* () {
      expect(yield* (yield* CollabStore.Service).get("clb_missing")).toBeUndefined()
    }),
  )
})

describe("collab roster changes", () => {
  const find = (roster: readonly CollabStore.Participant[], agentSlug: string) =>
    roster.find((entry) => entry.agentSlug === agentSlug)

  it.live("adds one agent to a live roster", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Add")
      yield* store.addParticipant(collab.id, "carol")
      const carol = find(yield* store.participants(collab.id), "carol")
      expect(carol?.removedAt).toBeUndefined()
      expect(carol?.sessionId).toBeNull()
      expect(carol?.lastSeenSeq).toBe(0)
    }),
  )

  it.live("removes an agent WITHOUT deleting its session or its messages", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Remove")
      yield* store.setParticipantSession(collab.id, "bob", "ses_bob")
      yield* store.appendMessage({ collabId: collab.id, authorId: "bob", authorKind: "agent", text: "mine" })
      yield* store.removeParticipant(collab.id, "bob", 4321)

      const bob = find(yield* store.participants(collab.id), "bob")
      // A soft delete: the log is the record of what was said, and taking a
      // member off the roster cannot rewrite it.
      expect(bob?.removedAt).toBe(4321)
      expect(bob?.sessionId).toBe("ses_bob")
      expect((yield* store.listMessages(collab.id)).map((message) => message.authorId)).toEqual(["bob"])
    }),
  )

  it.live("brings a removed agent back with its session and marker intact", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Readd")
      yield* store.setParticipantSession(collab.id, "bob", "ses_bob")
      yield* store.setLastSeen(collab.id, "bob", 7)
      yield* store.removeParticipant(collab.id, "bob")
      yield* store.addParticipant(collab.id, "bob")

      const bob = find(yield* store.participants(collab.id), "bob")
      expect(bob?.removedAt).toBeUndefined()
      // Same member, not a fresh one: it comes back with the memory it left
      // with, and is not handed the backlog it was absent for as one turn.
      expect(bob?.sessionId).toBe("ses_bob")
      expect(bob?.lastSeenSeq).toBe(7)
      expect(yield* store.participants(collab.id)).toHaveLength(2)
    }),
  )

  it.live("keeps an add idempotent for an agent already on the roster", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Twice")
      yield* store.setParticipantSession(collab.id, "alice", "ses_alice")
      yield* store.addParticipant(collab.id, "alice")
      const roster = yield* store.participants(collab.id)
      expect(roster).toHaveLength(2)
      expect(find(roster, "alice")?.sessionId).toBe("ses_alice")
    }),
  )
})

describe("collab lead", () => {
  const leadOf = (store: CollabStore.Interface, collabId: string) =>
    store.get(collabId).pipe(Effect.map((collab) => collab?.lead))

  it.live("hands the seat to the first agent when a collab opens", () =>
    Effect.gen(function* () {
      const { collab } = yield* open("Lead")
      expect(collab.lead).toBe("alice")
    }),
  )

  // The live acceptance run caught this: a bulk invite lands inside one
  // millisecond, and equal join times tiebreak alphabetically — so the lead
  // seat fell on the alphabetically-first slug, not the first INVITED.
  it.live("first INVITED leads, even against alphabetical order in a same-instant bulk add", () =>
    Effect.gen(function* () {
      const store = yield* CollabStore.Service
      const collab = yield* store.create({ title: "Order", agentSlugs: ["zed-lead", "abel-second"] })
      expect(collab.lead).toBe("zed-lead")
      const roster = yield* store.participants(collab.id)
      expect(roster.map((p) => p.agentSlug)).toEqual(["zed-lead", "abel-second"])
    }),
  )

  it.live("opens with no lead when nobody is on the roster", () =>
    Effect.gen(function* () {
      const { collab } = yield* open("Empty", [])
      // Nobody to route to, so an unaddressed post reaches no one and the shell
      // has to be told - the alternative is a room that silently never answers.
      expect(collab.lead).toBeNull()
    }),
  )

  it.live("fills an empty seat when the first agent is invited later", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Invite", [])
      yield* store.addParticipant(collab.id, "carol")
      expect(yield* leadOf(store, collab.id)).toBe("carol")
    }),
  )

  it.live("promotes the next active participant when the lead leaves", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Promote")
      yield* store.removeParticipant(collab.id, "alice")
      expect(yield* leadOf(store, collab.id)).toBe("bob")
    }),
  )

  it.live("skips participants that already left when it promotes", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Skip", ["alice", "bob", "carol"])
      yield* store.removeParticipant(collab.id, "bob")
      yield* store.removeParticipant(collab.id, "alice")
      expect(yield* leadOf(store, collab.id)).toBe("carol")
    }),
  )

  it.live("clears the seat when the last participant leaves", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Last", ["alice"])
      yield* store.removeParticipant(collab.id, "alice")
      expect(yield* leadOf(store, collab.id)).toBeNull()
    }),
  )

  it.live("leaves a chosen lead alone while it is still in the room", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Chosen")
      yield* store.setLead(collab.id, "bob")
      yield* store.addParticipant(collab.id, "carol")
      yield* store.removeParticipant(collab.id, "alice")
      // A roster change is not a re-election: the human named bob.
      expect(yield* leadOf(store, collab.id)).toBe("bob")
    }),
  )

  it.live("keeps a deliberately cleared seat empty until the roster changes", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Cleared")
      yield* store.setLead(collab.id, null)
      expect(yield* leadOf(store, collab.id)).toBeNull()
      // Only a roster change may fill an empty seat, and then it takes the
      // first active agent, exactly as opening the collab did.
      yield* store.addParticipant(collab.id, "carol")
      expect(yield* leadOf(store, collab.id)).toBe("alice")
    }),
  )

  it.live("stores the objective a collab opened with, and any later one", () =>
    Effect.gen(function* () {
      const store = yield* CollabStore.Service
      const collab = yield* store.create({ title: "Goal", agentSlugs: ["alice"], objective: "cut the release" })
      expect(collab.objective).toBe("cut the release")
      yield* store.setObjective(collab.id, "hold the release")
      expect((yield* store.get(collab.id))?.objective).toBe("hold the release")
    }),
  )

  it.live("opens with no objective when none was given", () =>
    Effect.gen(function* () {
      expect((yield* open("No goal")).collab.objective).toBeNull()
    }),
  )
})

describe("collab message kinds", () => {
  it.live("records an ordinary post as a say addressed to nobody", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Plain")
      const message = yield* store.appendMessage(human(collab.id, "what next?"))
      expect(message).toMatchObject({ kind: "say", mentions: [], taskId: null, trace: null })
      expect((yield* store.listMessages(collab.id))[0]).toMatchObject({ kind: "say", mentions: [] })
    }),
  )

  it.live("round-trips the kind, the address list, the task and the trace", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Typed")
      const trace = [
        { tool: "read", summary: "src/index.ts", status: "ok" as const },
        { tool: "bash", summary: "bun test", status: "error" as const },
      ]
      yield* store.appendMessage({
        collabId: collab.id,
        authorId: "alice",
        authorKind: "agent",
        kind: "ask",
        text: "can you run the migration?",
        mentions: ["bob"],
        taskId: "clbt_1",
        trace,
        replyToSeq: 1,
      })
      // Read back through a SECOND query, not the insert's own return: the JSON
      // columns have to survive the round trip, not just the write path.
      const stored = (yield* store.listMessages(collab.id))[0]!
      expect(stored).toMatchObject({
        kind: "ask",
        mentions: ["bob"],
        taskId: "clbt_1",
        replyToSeq: 1,
      })
      expect(stored.trace).toEqual(trace)
      // Epoch-ms in the store. The ISO string is the wire's job alone.
      expect(typeof stored.createdAt).toBe("number")
    }),
  )

  it.live("stores an empty address list as addressed to nobody", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Nobody")
      yield* store.appendMessage({ ...human(collab.id, "anyone?"), mentions: [] })
      expect((yield* store.listMessages(collab.id))[0]!.mentions).toEqual([])
    }),
  )

  it.live("keeps an empty trace distinct from no trace at all", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Toolless")
      yield* store.appendMessage({ collabId: collab.id, authorId: "alice", authorKind: "agent", text: "a", trace: [] })
      yield* store.appendMessage({ collabId: collab.id, authorId: "alice", authorKind: "agent", text: "b" })
      const stored = yield* store.listMessages(collab.id)
      // "Ran no tools" and "nobody recorded" are different claims, and a UI that
      // shows a trace row has to be able to tell them apart.
      expect(stored[0]!.trace).toEqual([])
      expect(stored[1]!.trace).toBeNull()
    }),
  )

  it.live("bounds a trace, and says how many tools it left out", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Chatty")
      yield* store.appendMessage({
        collabId: collab.id,
        authorId: "alice",
        authorKind: "agent",
        text: "done",
        trace: Array.from({ length: 26 }, (_, index) => ({
          tool: `tool-${index}`,
          summary: "x".repeat(200),
          status: "ok" as const,
        })),
      })
      const stored = (yield* store.listMessages(collab.id))[0]!.trace!
      expect(stored).toHaveLength(CollabStore.TRACE_LIMIT + 1)
      // The count is the point: a trace that silently stopped at 20 would tell
      // the room the agent ran 20 tools when it ran 26.
      expect(stored.at(-1)).toEqual({ tool: "…", summary: "+6 more", status: "ok" })
      expect(stored[0]!.summary).toHaveLength(CollabStore.TRACE_SUMMARY_LIMIT)
    }),
  )

  it.live("leaves a trace inside the bounds exactly as it was given", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Short")
      const trace = Array.from({ length: CollabStore.TRACE_LIMIT }, (_, index) => ({
        tool: `tool-${index}`,
        summary: "fine",
        status: "ok" as const,
      }))
      yield* store.appendMessage({ collabId: collab.id, authorId: "alice", authorKind: "agent", text: "d", trace })
      expect((yield* store.listMessages(collab.id))[0]!.trace).toEqual(trace)
    }),
  )
})

describe("collab task transitions", () => {
  const task = (state: CollabStore.TaskState): CollabStore.Task => ({
    id: "clbt_1",
    collabId: "clb_1",
    title: "ship it",
    owner: state === "open" ? null : "alice",
    state,
    createdBy: "user",
    result: null,
    note: null,
    originSeq: null,
    createdAt: 1,
    updatedAt: 1,
  })

  const STATES: CollabStore.TaskState[] = ["open", "claimed", "done", "accepted"]
  const ACTIONS: CollabStore.TaskAction[] = ["claim", "done", "accept", "reopen"]
  /** The only four moves the board has. Everything else is refused. */
  const LEGAL = new Set(["open:claim", "claimed:done", "done:accept", "done:reopen"])
  const ARGUMENTS = { owner: "alice", result: "shipped", note: "not quite" }

  it.live("accepts exactly the four contracted moves and refuses every other pair", () => {
    for (const state of STATES) {
      for (const action of ACTIONS) {
        // Every move is offered every argument, so this pair is about the STATE
        // alone and never about a missing owner, result or note.
        const verdict = CollabStore.taskRefusal(task(state), { action, ...ARGUMENTS }) ? "refused" : "allowed"
        const expected = LEGAL.has(`${state}:${action}`) ? "allowed" : "refused"
        expect(`${state}:${action} ${verdict}`).toBe(`${state}:${action} ${expected}`)
      }
    }
    return Effect.void
  })

  it.live("names the state that blocked an illegal move", () => {
    // The refusal is what a human reads in the shell, so it has to say WHY,
    // not just that the button did nothing.
    expect(CollabStore.taskRefusal(task("accepted"), { action: "reopen", note: "again" })).toContain("accepted")
    expect(CollabStore.taskRefusal(task("open"), { action: "done", result: "r" })).toContain("open")
    return Effect.void
  })

  it.live("refuses a legal move that is missing what it has to record", () => {
    expect(CollabStore.taskRefusal(task("open"), { action: "claim" })).toContain("owner")
    expect(CollabStore.taskRefusal(task("open"), { action: "claim", owner: "" })).toContain("owner")
    expect(CollabStore.taskRefusal(task("claimed"), { action: "done" })).toContain("result")
    expect(CollabStore.taskRefusal(task("done"), { action: "reopen" })).toContain("note")
    // Accept records nothing, so it needs nothing.
    expect(CollabStore.taskRefusal(task("done"), { action: "accept" })).toBeUndefined()
    return Effect.void
  })
})

describe("collab task board", () => {
  it.live("opens a task unowned, in the open state, credited to its author", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Board")
      const task = yield* store.addTask({ collabId: collab.id, title: "write the migration", createdBy: "user" })
      expect(task).toMatchObject({
        title: "write the migration",
        state: "open",
        owner: null,
        createdBy: "user",
        result: null,
        note: null,
        originSeq: null,
      })
      expect(yield* store.getTask(collab.id, task.id)).toEqual(task)
    }),
  )

  it.live("opens a task already claimed when an ask created it", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Asked")
      const task = yield* store.addTask({
        collabId: collab.id,
        title: "run the migration",
        createdBy: "alice",
        owner: "bob",
        state: "claimed",
        originSeq: 4,
      })
      expect(task).toMatchObject({ state: "claimed", owner: "bob", createdBy: "alice", originSeq: 4 })
    }),
  )

  it.live("walks a task from open to accepted, recording what each move said", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Walk")
      const opened = yield* store.addTask({ collabId: collab.id, title: "ship it", createdBy: "user" })
      const claimed = yield* store.updateTask({
        collabId: collab.id,
        taskId: opened.id,
        action: "claim",
        owner: "alice",
      })
      expect(claimed).toMatchObject({ state: "claimed", owner: "alice" })
      const done = yield* store.updateTask({
        collabId: collab.id,
        taskId: opened.id,
        action: "done",
        result: "migration written",
      })
      expect(done).toMatchObject({ state: "done", owner: "alice", result: "migration written" })
      const accepted = yield* store.updateTask({ collabId: collab.id, taskId: opened.id, action: "accept" })
      expect(accepted).toMatchObject({ state: "accepted", result: "migration written" })
      expect((yield* store.getTask(collab.id, opened.id))?.state).toBe("accepted")
    }),
  )

  it.live("sends a completed task back to the SAME owner, with the reason on it", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Reopen")
      const opened = yield* store.addTask({ collabId: collab.id, title: "ship it", createdBy: "user" })
      yield* store.updateTask({ collabId: collab.id, taskId: opened.id, action: "claim", owner: "alice" })
      yield* store.updateTask({ collabId: collab.id, taskId: opened.id, action: "done", result: "first try" })
      const reopened = yield* store.updateTask({
        collabId: collab.id,
        taskId: opened.id,
        action: "reopen",
        note: "tests are red",
      })
      // Same owner: reopening is "you are not finished", not "someone else do it".
      expect(reopened).toMatchObject({ state: "claimed", owner: "alice", note: "tests are red" })
      expect(reopened.result).toBe("first try")
    }),
  )

  it.live("refuses to apply an illegal move, and leaves the board where it was", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Illegal")
      const opened = yield* store.addTask({ collabId: collab.id, title: "ship it", createdBy: "user" })
      const exit = yield* store
        .updateTask({ collabId: collab.id, taskId: opened.id, action: "accept" })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* store.getTask(collab.id, opened.id))?.state).toBe("open")
    }),
  )

  it.live("lists a collab's own tasks, oldest first", () =>
    Effect.gen(function* () {
      const left = yield* open("Mine")
      const right = yield* open("Theirs")
      yield* left.store.addTask({ collabId: left.collab.id, title: "first", createdBy: "user" })
      yield* left.store.addTask({ collabId: left.collab.id, title: "second", createdBy: "user" })
      yield* left.store.addTask({ collabId: right.collab.id, title: "other room", createdBy: "user" })
      expect((yield* left.store.listTasks(left.collab.id)).map((task) => task.title)).toEqual(["first", "second"])
      expect(yield* left.store.listTasks(right.collab.id)).toHaveLength(1)
    }),
  )

  it.live("answers with undefined for a task that does not exist", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Missing")
      expect(yield* store.getTask(collab.id, "clbt_nope")).toBeUndefined()
    }),
  )
})

describe("collab turn cost ledger", () => {
  const spend = (collabId: string, agentSlug: string, over: Partial<CollabStore.LedgerInput> = {}) => ({
    collabId,
    agentSlug,
    model: "lmstudio/qwen3-coder",
    tokensInput: 100,
    tokensOutput: 20,
    cost: 0.5,
    ...over,
  })

  it.live("records a turn, including the agent that asked for a nested one", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Ledger")
      const top = yield* store.appendCost(spend(collab.id, "alice"))
      const nested = yield* store.appendCost(spend(collab.id, "bob", { askedBy: "alice" }))
      expect(top.askedBy).toBeNull()
      expect(nested.askedBy).toBe("alice")
      expect(nested.model).toBe("lmstudio/qwen3-coder")
    }),
  )

  it.live("lists the ledger newest first, and honours the page size", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Page")
      for (const cost of [1, 2, 3, 4]) yield* store.appendCost(spend(collab.id, "alice", { cost }))
      expect((yield* store.listCosts(collab.id)).map((entry) => entry.cost)).toEqual([4, 3, 2, 1])
      expect((yield* store.listCosts(collab.id, 2)).map((entry) => entry.cost)).toEqual([4, 3])
    }),
  )

  it.live("totals the WHOLE ledger per agent, not the page a shell asked for", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Totals")
      yield* store.appendCost(spend(collab.id, "alice", { cost: 0.25, tokensInput: 10, tokensOutput: 1 }))
      yield* store.appendCost(spend(collab.id, "alice", { cost: 0.75, tokensInput: 30, tokensOutput: 3 }))
      yield* store.appendCost(spend(collab.id, "bob", { cost: 2, tokensInput: 5, tokensOutput: 50 }))
      expect(yield* store.costTotals(collab.id)).toEqual([
        { agentSlug: "alice", cost: 1, tokensInput: 40, tokensOutput: 4 },
        { agentSlug: "bob", cost: 2, tokensInput: 5, tokensOutput: 50 },
      ])
    }),
  )

  it.live("keeps each room's spend to itself", () =>
    Effect.gen(function* () {
      const left = yield* open("Room A")
      const right = yield* open("Room B")
      yield* left.store.appendCost(spend(left.collab.id, "alice", { cost: 1 }))
      yield* left.store.appendCost(spend(right.collab.id, "alice", { cost: 9 }))
      expect(yield* left.store.costTotals(left.collab.id)).toEqual([
        { agentSlug: "alice", cost: 1, tokensInput: 100, tokensOutput: 20 },
      ])
    }),
  )

  it.live("answers with an empty ledger and no totals for a room that has spent nothing", () =>
    Effect.gen(function* () {
      const { store, collab } = yield* open("Quiet")
      expect(yield* store.listCosts(collab.id)).toEqual([])
      expect(yield* store.costTotals(collab.id)).toEqual([])
    }),
  )
})
