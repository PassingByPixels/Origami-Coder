import { describe, expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionV1 } from "@origami/core/v1/session"
import { CollabActivity } from "@/collab/activity"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([CollabStore.node])))

type Reply = (input: CollabRunner.TurnInput) => Effect.Effect<CollabRunner.TurnOutcome, unknown>

/**
 * A runner on the REAL store with a stubbed turn: no model, no session, but
 * every sequence number, roster read, wake rule, hop charge and last-seen write
 * is the shipping one. The stub receives the real turn context, so it can drive
 * `ops.ask` and `ops.handoff` exactly as the flock tools do.
 */
const harness = (options: {
  title: string
  agentSlugs?: readonly string[]
  displayNames?: Record<string, string>
  reply: Reply
  /** Stubs the runner's read of an agent's latest session message, for liveActivity. */
  latestMessage?: (sessionId: string) => Effect.Effect<SessionV1.WithParts | undefined, unknown>
  /** The slugs whose definition declared `vision: true`. Everyone else is blind. */
  sighted?: readonly string[]
  /** Records the child sessions a per-agent stop asked the engine to cancel. */
  aborted?: string[]
}) =>
  Effect.gen(function* () {
    const store = yield* CollabStore.Service
    const collab = yield* store.create({
      title: options.title,
      agentSlugs: options.agentSlugs ?? ["alice", "bob"],
    })
    const turns: CollabRunner.TurnInput[] = []
    const sessions: string[] = []
    const runner = yield* CollabRunner.make({
      store,
      displayName: (agentSlug) => Effect.succeed(options.displayNames?.[agentSlug] ?? agentSlug),
      createSession: ({ agentSlug }) =>
        Effect.sync(() => {
          sessions.push(agentSlug)
          return `ses_${agentSlug}`
        }),
      turn: (input) =>
        Effect.suspend(() => {
          turns.push(input)
          return options.reply(input)
        }),
      ...(options.latestMessage ? { latestMessage: options.latestMessage } : {}),
      ...(options.sighted
        ? { vision: (agentSlug: string) => Effect.succeed(options.sighted!.includes(agentSlug)) }
        : {}),
      ...(options.aborted
        ? { abort: (sessionId: string) => Effect.sync(() => void options.aborted!.push(sessionId)) }
        : {}),
    })

    const post = (text: string, mentions?: readonly string[], images?: readonly string[]) =>
      Effect.gen(function* () {
        const message = yield* runner.post({
          collabId: collab.id,
          text,
          ...(mentions ? { mentions } : {}),
          ...(images ? { images } : {}),
        })
        yield* awaitWithTimeout(runner.settle, `collab "${options.title}" did not settle`, "10 seconds")
        return message
      })

    const log = () => store.listMessages(collab.id)
    return { store, collab, runner, turns, sessions, post, log }
  })

const speak =
  (text: string): Reply =>
  () =>
    Effect.succeed({ text })
const silent: Reply = () => Effect.succeed({ text: "" })
const agentTexts = (messages: readonly CollabStore.Message[]) =>
  messages.filter((message) => message.authorKind === "agent")
const slugs = (turns: readonly CollabRunner.TurnInput[]) => turns.map((turn) => turn.agentSlug)

const waitUntil = (check: () => boolean, message: string) =>
  awaitWithTimeout(
    Effect.gen(function* () {
      while (!check()) yield* Effect.sleep("5 millis")
    }),
    message,
    "10 seconds",
  )

/** A stub that plays the `handoff` tool: gate, pass the baton, end the turn. */
const handsTo = (next: (slug: string) => string): Reply =>
  Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
    if (CollabRunner.spent(input.turn.hops)) return { text: "" }
    const target = next(input.agentSlug)
    yield* input.turn.ops.append({
      collabId: input.collabId,
      authorId: input.agentSlug,
      authorKind: "agent",
      kind: "handoff",
      text: `take it from here`,
      mentions: [target],
    })
    yield* input.turn.ops.handoff(target)
    input.turn.stop.requested = true
    input.turn.stop.kind = "handoff"
    return { text: "" }
  })

describe("collab hop budget", () => {
  it.live("reads a null cap as the engine default, and 0 as off", () => {
    expect(CollabRunner.effectiveCap(null)).toBe(CollabRunner.LOOP_BREAKER_DEFAULT)
    expect(CollabRunner.startingHops(null)).toBe(CollabRunner.LOOP_BREAKER_DEFAULT)
    expect(CollabRunner.startingHops(0)).toBeNull()
    expect(CollabRunner.startingHops(-3)).toBeNull()
    expect(CollabRunner.startingHops(2)).toBe(2)
    return Effect.void
  })

  it.live("never counts against an OFF budget", () => {
    const off = { remaining: null }
    CollabRunner.charge(off)
    expect(off.remaining).toBeNull()
    expect(CollabRunner.spent(off)).toBe(false)
    const live = { remaining: 1 }
    CollabRunner.charge(live)
    expect(live).toEqual({ remaining: 0 })
    expect(CollabRunner.spent(live)).toBe(true)
    return Effect.void
  })

  it.live("gives one human message exactly `cap` agent turns", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Budget", reply: handsTo((slug) => (slug === "alice" ? "bob" : "alice")) })
      yield* collab.store.setCap(collab.collab.id, 2)
      yield* collab.post("kick it off")

      // Two turns, then the chain has nothing left to spend and stops itself.
      expect(slugs(collab.turns)).toEqual(["alice", "bob"])
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({ remaining: 0, cap: 2 })
    }),
  )

  it.live("a human post buys a fresh budget and the chain runs again", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Reset", reply: handsTo((slug) => (slug === "alice" ? "bob" : "alice")) })
      yield* collab.store.setCap(collab.collab.id, 2)
      yield* collab.post("first")
      expect(collab.turns).toHaveLength(2)

      yield* collab.post("carry on")
      expect(collab.turns).toHaveLength(4)
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({ remaining: 0, cap: 2 })
    }),
  )

  it.live("with the budget OFF, only the agents' own silence ends the chain", () =>
    Effect.gen(function* () {
      // One MORE hand-off than the default budget would ever pay for, so
      // "nothing counts" is proved against the live default rather than against
      // a number that happened to sit under it.
      let remaining = CollabRunner.LOOP_BREAKER_DEFAULT + 1
      const collab = yield* harness({
        title: "Overnight",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (remaining <= 0) return { text: "" }
          remaining--
          const target = input.agentSlug === "alice" ? "bob" : "alice"
          yield* input.turn.ops.append({
            collabId: input.collabId,
            authorId: input.agentSlug,
            authorKind: "agent",
            kind: "handoff",
            text: "your turn",
            mentions: [target],
          })
          yield* input.turn.ops.handoff(target)
          input.turn.stop.requested = true
          input.turn.stop.kind = "handoff"
          return { text: "" }
        }),
      })
      yield* collab.store.setCap(collab.collab.id, 0)
      yield* collab.post("run overnight")

      // Every hand-off plus the one further turn that finds the stub out of
      // replies and chooses silence.
      expect(collab.turns).toHaveLength(CollabRunner.LOOP_BREAKER_DEFAULT + 2)
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({ remaining: null, cap: null })
    }),
  )

  it.live("holds a turn at the DRAIN gate too, and keeps its backlog intact", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "TwoGates", reply: speak("on it") })
      yield* collab.store.setCap(collab.collab.id, 1)
      // Both are addressed, so both join the queue on one budget of 1.
      yield* collab.post("@alice @bob look at this", ["alice", "bob"])

      // alice spends the only hop. bob was already queued, and the drain gate
      // is what stops it running on credit the room no longer has.
      expect(slugs(collab.turns)).toEqual(["alice"])
      const participants = yield* collab.store.participants(collab.collab.id)
      // bob's marker did NOT move: the whole backlog is still there as context
      // for the turn the next human post releases.
      expect(participants.find((entry) => entry.agentSlug === "bob")?.lastSeenSeq).toBe(0)

      yield* collab.post("carry on", ["bob"])
      expect(slugs(collab.turns)).toEqual(["alice", "bob"])
      expect(collab.turns[1]!.text).toContain("user: @alice @bob look at this")
    }),
  )

  it.live("re-issues the budget when a human moves the cap", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Recap", agentSlugs: ["alice"], reply: speak("on it") })
      yield* collab.post("go")
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({
        remaining: CollabRunner.LOOP_BREAKER_DEFAULT - 1,
        cap: CollabRunner.LOOP_BREAKER_DEFAULT,
      })

      // A budget left over against a cap the human just moved to 2 is not a
      // number a shell can show, and a stream still counting down after the cap
      // was turned OFF is worse.
      yield* collab.store.setCap(collab.collab.id, 2)
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({ remaining: 2, cap: 2 })
      yield* collab.store.setCap(collab.collab.id, 0)
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({ remaining: null, cap: null })
    }),
  )

  it.live("keeps a STOP in force when the cap has not moved", () =>
    Effect.gen(function* () {
      // A stop spends the budget without touching the cap, so re-issuing on a
      // cap change must not quietly undo it.
      const collab = yield* harness({ title: "StopHolds", agentSlugs: ["alice"], reply: speak("on it") })
      yield* collab.runner.stop(collab.collab.id)
      const held = { remaining: 0, cap: CollabRunner.LOOP_BREAKER_DEFAULT }
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual(held)
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual(held)
    }),
  )
})

describe("collab envelope", () => {
  const message = (authorId: string, text: string): CollabStore.Message => ({
    id: authorId,
    collabId: "c",
    seq: 1,
    authorId,
    authorKind: authorId === "user" ? "human" : "agent",
    kind: "say",
    text,
    mentions: [],
    taskId: null,
    trace: null,
    createdAt: 0,
  })
  const built = () =>
    CollabRunner.envelope({
      title: "Ship it",
      agentSlug: "alice",
      messages: [message("user", "what next?"), message("alice", "I said this"), message("bob", "the migration")],
    })

  it.live("shows the agent what it missed, without echoing its own messages back at it", () => {
    const text = built()
    expect(text).toContain("[Collab: Ship it] New messages:")
    expect(text).toContain("user: what next?")
    expect(text).toContain("bob: the migration")
    expect(text).not.toContain("I said this")
    return Effect.void
  })

  it.live("carries MESSAGES only - the room's rules are not something a participant said", () => {
    const text = built()
    expect(text.startsWith("[Collab: Ship it] New messages:")).toBe(true)
    expect(text).not.toContain("shared room inside a coding harness")
    expect(text).not.toContain("You are @alice")
    return Effect.void
  })
})

describe("collab brief envelope", () => {
  // Two of the fourteen are carol's own, so a brief built FOR carol has twelve
  // to choose from and must still ship only ten.
  const mine = (index: number) => index === 3 || index === 9
  const history = Array.from({ length: 14 }, (_, index) => ({
    id: `m${index}`,
    collabId: "c",
    seq: index + 1,
    authorId: mine(index) ? "carol" : "user",
    authorKind: (mine(index) ? "agent" : "human") as "human" | "agent",
    kind: "say" as const,
    text: `line ${index}`,
    mentions: [],
    taskId: null,
    trace: null,
    createdAt: 0,
  }))

  it.live("pins who is asking, for what, and what they want back ABOVE the room history", () => {
    const text = CollabRunner.brief({
      title: "Ship it",
      agentSlug: "bob",
      from: "alice",
      task: "write the migration",
      context: "the table is collab_task",
      expect: "the file path and the test you ran",
      messages: history,
    })
    const lines = text.split("\n")
    expect(lines[0]).toBe("[Collab: Ship it]")
    expect(lines[1]).toBe("FROM: @alice")
    expect(lines[2]).toBe("TASK: write the migration")
    expect(lines[3]).toBe("CONTEXT: the table is collab_task")
    expect(lines[4]).toBe("EXPECTED BACK: the file path and the test you ran")
    expect(lines[5]).toBe("")
    expect(lines[6]).toBe("Recent room messages:")
    // The brief must reach the model BEFORE the history, or the ask arrives as
    // one line in ten and gets answered to the room instead of to the asker.
    expect(text.indexOf("TASK:")).toBeLessThan(text.indexOf("Recent room messages:"))
    return Effect.void
  })

  it.live("names the board task the ask or hand-off opened, so the target need not hunt for it", () => {
    const text = CollabRunner.brief({
      title: "Ship it",
      agentSlug: "bob",
      from: "alice",
      task: "write the migration",
      taskId: "clbt_0001",
      messages: [],
    })
    // Above the history with the rest of the brief: a target that guesses the
    // id off the board completes somebody else's task.
    expect(text).toContain("Board task: clbt_0001")
    expect(text.indexOf("Board task: clbt_0001")).toBeLessThan(text.indexOf("Recent room messages:"))
    return Effect.void
  })

  it.live("drops the optional lines rather than printing empty headings", () => {
    const text = CollabRunner.brief({
      title: "Ship it",
      agentSlug: "bob",
      from: "alice",
      task: "take a look",
      context: "   ",
      messages: [],
    })
    expect(text).not.toContain("CONTEXT:")
    expect(text).not.toContain("EXPECTED BACK:")
    return Effect.void
  })

  it.live("carries at most the last ten room messages, and none of the reader's own", () => {
    const text = CollabRunner.brief({
      title: "Ship it",
      agentSlug: "carol",
      from: "alice",
      task: "take a look",
      messages: history,
    })
    const rows = text.split("Recent room messages:")[1]!.trim().split("\n")
    expect(rows).toHaveLength(CollabRunner.BRIEF_HISTORY)
    expect(rows.every((row) => row.startsWith("user: "))).toBe(true)
    return Effect.void
  })
})

// --- Images the human posted. A sighted agent is SHOWN them; a blind one is
// TOLD about them; a room with none is byte-for-byte what it always was.

describe("collab images", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo="
  const JPEG = "data:image/jpeg;base64,/9j/4AAQ"

  it.live("turns one data: URL into the SAME part shape a chat attachment uses", () => {
    expect(CollabRunner.imagePart(PNG)).toEqual({ type: "file", url: PNG, filename: "image", mime: "image/png" })
    return Effect.void
  })

  it.live("reads the mime up to the first `;` OR `,`, and falls back when none is declared", () => {
    expect(CollabRunner.mimeOf("data:image/png;base64,AAAA")).toBe("image/png")
    // No parameters at all: the payload follows the type directly, and reading
    // to the `;` alone would swallow it into the mime.
    expect(CollabRunner.mimeOf("data:image/svg+xml,<svg/>")).toBe("image/svg+xml")
    // A URL that declares nothing gets a generic mime rather than an empty or
    // invented one - some providers reject an empty mediaType outright.
    expect(CollabRunner.mimeOf("data:,plain")).toBe("application/octet-stream")
    expect(CollabRunner.mimeOf("data:base64,AAAA")).toBe("application/octet-stream")
    return Effect.void
  })

  it.live("sweeps images off exactly the window the text renders", () => {
    const message = (authorId: string, images?: readonly string[]): CollabStore.Message => ({
      id: authorId,
      collabId: "c",
      seq: 1,
      authorId,
      authorKind: authorId === "user" ? "human" : "agent",
      kind: "say",
      text: "hi",
      mentions: [],
      taskId: null,
      trace: null,
      ...(images ? { images } : {}),
      createdAt: 0,
    })
    const messages = [message("user", [PNG]), message("alice", [JPEG]), message("bob")]
    // alice's own message is not in alice's envelope, so its image is not in
    // alice's sweep either - an image with no line beside it has no context.
    expect(CollabRunner.imagesOf(CollabRunner.envelopeWindow("alice", messages))).toEqual([PNG])
    expect(CollabRunner.imagesOf(CollabRunner.envelopeWindow("bob", messages))).toEqual([PNG, JPEG])
    return Effect.void
  })

  it.live("leaves an image-free turn byte-identical - text unchanged, no parts at all", () => {
    const text = "[Collab: Ship it] New messages:\nuser: what next?"
    for (const vision of [true, false]) {
      expect(CollabRunner.withImages({ text, images: [], vision })).toEqual({ text })
    }
    return Effect.void
  })

  it.live("SHOWS a sighted agent the images and leaves its text alone", () => {
    const carried = CollabRunner.withImages({ text: "envelope", images: [PNG, JPEG], vision: true })
    expect(carried.text).toBe("envelope")
    expect(carried.images).toEqual([CollabRunner.imagePart(PNG), CollabRunner.imagePart(JPEG)])
    return Effect.void
  })

  it.live("TELLS a blind agent what it cannot see, and sends it no parts", () => {
    const carried = CollabRunner.withImages({ text: "envelope", images: [PNG, JPEG], vision: false })
    expect(carried.images).toBeUndefined()
    expect(carried.text).toBe(
      "envelope\n[The human posted 2 image(s) here that you cannot see. A participant whose model has vision can look and describe them.]",
    )
    // The way OUT is in the note: without it the agent knows only that it is
    // blind, not that another participant can look for it.
    expect(carried.text).toContain("A participant whose model has vision can look")
    return Effect.void
  })

  it.live("reads `vision: true` off the definition's options, and nothing else", () => {
    expect(CollabRunner.visionCapable({ options: { vision: true } })).toBe(true)
    expect(CollabRunner.visionCapable({ options: { collab: true } })).toBe(false)
    expect(CollabRunner.visionCapable({ options: {} })).toBe(false)
    expect(CollabRunner.visionCapable(undefined)).toBe(false)
    return Effect.void
  })

  it.live("gives a vision agent's TURN the images as parts, beside the envelope", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Seen",
        agentSlugs: ["alice"],
        sighted: ["alice"],
        reply: silent,
      })
      yield* collab.post("what is wrong with this?", undefined, [PNG])

      const turn = collab.turns[0]!
      expect(turn.images).toEqual([{ type: "file", url: PNG, filename: "image", mime: "image/png" }])
      // The envelope text is untouched: the picture is an attachment on the
      // message, not a sentence inside it.
      expect(turn.text).toBe("[Collab: Seen] New messages:\nuser: what is wrong with this?")
    }),
  )

  it.live("gives a blind agent the note instead, and no parts", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Unseen", agentSlugs: ["alice"], reply: silent })
      yield* collab.post("what is wrong with this?", undefined, [PNG, JPEG])

      const turn = collab.turns[0]!
      expect(turn.images).toBeUndefined()
      expect(turn.text).toContain("[The human posted 2 image(s) here that you cannot see")
    }),
  )

  it.live("carries images under an ask BRIEF too, not only under an envelope", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Asked",
        agentSlugs: ["alice", "bob"],
        sighted: ["bob"],
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug !== "alice") return { text: "I see a red square" }
          const answer = yield* input.turn.ops.ask({
            target: "bob",
            sessionId: "ses_bob",
            from: "alice",
            task: "what is in the picture?",
            askChain: [],
            hops: input.turn.hops,
          })
          return { text: answer.text }
        }),
      })
      yield* collab.post("take a look", undefined, [PNG])

      const asked = collab.turns.find((turn) => turn.agentSlug === "bob")
      expect(asked?.images).toEqual([CollabRunner.imagePart(PNG)])
      expect(asked?.text).toContain("Recent room messages:")
    }),
  )

  it.live("changes NOTHING for a room that posted no images", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Plain", agentSlugs: ["alice"], sighted: ["alice"], reply: silent })
      yield* collab.post("what next?")

      const turn = collab.turns[0]!
      expect("images" in turn).toBe(false)
      expect(turn.text).toBe("[Collab: Plain] New messages:\nuser: what next?")
    }),
  )
})

describe("collab wake routing", () => {
  it.live("sends an unaddressed human post to the LEAD alone", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Lead", agentSlugs: ["alice", "bob", "carol"], reply: speak("on it") })
      yield* collab.post("what is left to do?")

      // Not "everyone answers, most of them briefly": bob and carol are never
      // woken at all, so they cost nothing.
      expect(slugs(collab.turns)).toEqual(["alice"])
      expect(agentTexts(yield* collab.log()).map((message) => message.authorId)).toEqual(["alice"])
    }),
  )

  it.live("sends an addressed human post to exactly those agents, in roster order", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Addressed", agentSlugs: ["alice", "bob", "carol"], reply: speak("ack") })
      yield* collab.post("you two sync up", ["carol", "bob"])
      expect(slugs(collab.turns)).toEqual(["bob", "carol"])
    }),
  )

  it.live("wakes NOBODY when an unaddressed post has no lead", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Headless", reply: speak("on it") })
      yield* collab.store.setLead(collab.collab.id, null)
      yield* collab.post("anyone there?")
      expect(collab.turns).toHaveLength(0)
    }),
  )

  it.live("gives nobody a turn for an agent's ordinary message, whoever it names in prose", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Prose", reply: speak("over to @bob, and @carol should look too") })
      yield* collab.post("start")

      // v1 read the prose and woke bob. Two agents discussing a third could
      // keep a room awake with nobody having asked for anything.
      expect(slugs(collab.turns)).toEqual(["alice"])
      expect(agentTexts(yield* collab.log())).toHaveLength(1)
    }),
  )

  it.live("never lets an agent answer its own message", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Self",
        agentSlugs: ["alice"],
        reply: speak("reminder to @alice: keep going"),
      })
      yield* collab.post("start")
      expect(collab.turns).toHaveLength(1)
    }),
  )

  it.live("schedules nothing for an archived collab", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Archived", reply: speak("hello") })
      yield* collab.store.archive(collab.collab.id)
      yield* collab.post("anyone there?")
      expect(collab.turns).toHaveLength(0)
      expect(agentTexts(yield* collab.log())).toHaveLength(0)
    }),
  )

  it.live("takes turns again once an archived collab is reopened", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Reopened", reply: speak("hello") })
      yield* collab.store.archive(collab.collab.id)
      yield* collab.post("anyone there?")
      expect(collab.turns).toHaveLength(0)

      yield* collab.store.unarchive(collab.collab.id)
      yield* collab.post("still there?")
      // The runner reads `time_archived` live on both the fan-out and the turn,
      // so nothing else has to be told the room came back.
      expect(collab.turns.length).toBeGreaterThan(0)
      expect(agentTexts(yield* collab.log()).length).toBeGreaterThan(0)
    }),
  )

  it.live("wakes the agent that opened a task when its owner completes it", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Board",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug !== "bob") return { text: "" }
          const task = yield* input.turn.ops.store.addTask({
            collabId: input.collabId,
            title: "write it",
            createdBy: "alice",
            owner: "bob",
            state: "claimed",
          })
          yield* input.turn.ops.store.updateTask({
            collabId: input.collabId,
            taskId: task.id,
            action: "done",
            result: "written",
          })
          yield* input.turn.ops.append({
            collabId: input.collabId,
            authorId: "bob",
            authorKind: "agent",
            kind: "task_done",
            text: "completed task: write it",
            taskId: task.id,
          })
          return { text: "" }
        }),
      })
      yield* collab.post("@bob please", ["bob"])

      // alice opened it, so alice is the one woken to check the work - and the
      // rule read that off the task, not off any prose.
      expect(slugs(collab.turns)).toEqual(["bob", "alice"])
    }),
  )
})

describe("collab turn order", () => {
  it.live("runs ONE turn at a time and shows a later agent the earlier agent's fresh reply", () =>
    Effect.gen(function* () {
      const order: string[] = []
      const state = { overlapped: false, inFlight: 0 }
      const collab = yield* harness({
        title: "Serialized",
        agentSlugs: ["alice", "bob"],
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          state.inFlight++
          if (state.inFlight > 1) state.overlapped = true
          order.push(input.agentSlug)
          yield* Effect.sleep("10 millis")
          state.inFlight--
          return { text: input.agentSlug === "alice" ? "the migration is mine" : "" }
        }),
      })
      yield* collab.post("who takes the migration?", ["alice", "bob"])

      expect(state.overlapped).toBe(false)
      expect(order).toEqual(["alice", "bob"])
      const bobTurn = collab.turns.find((turn) => turn.agentSlug === "bob")
      expect(bobTurn?.text).toContain("alice: the migration is mine")
    }),
  )

  it.live("serializes WITHIN a collab, not across them", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const left = yield* harness({
        title: "Left",
        agentSlugs: ["alice"],
        reply: () => Deferred.await(gate).pipe(Effect.as({ text: "" })),
      })
      const right = yield* harness({ title: "Right", agentSlugs: ["bob"], reply: silent })

      yield* left.runner.post({ collabId: left.collab.id, text: "blocked" })
      yield* waitUntil(() => left.turns.length === 1, "the blocking turn never started")
      yield* right.post("carry on")
      expect(right.turns).toHaveLength(1)

      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(left.runner.settle, "the left collab did not settle", "10 seconds")
    }),
  )

  it.live("gives the next agent its turn even when the one before it failed", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Isolation",
        reply: (input) =>
          input.agentSlug === "alice"
            ? Effect.fail(new Error("provider is down"))
            : Effect.succeed({ text: "I have it" }),
      })
      yield* collab.post("who takes it?", ["alice", "bob"])

      expect(slugs(collab.turns)).toEqual(["alice", "bob"])
      expect(agentTexts(yield* collab.log()).map((message) => message.authorId)).toEqual(["bob"])
      const statuses = yield* collab.runner.statuses(collab.collab.id)
      expect(statuses.get("alice")?.lastError).toContain("provider is down")
      expect(statuses.get("alice")?.state).toBe("idle")
      expect(statuses.get("bob")?.state).toBe("idle")
    }),
  )

  it.live("delivers messages that arrive during a turn as ONE follow-up", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      let first = true
      const collab = yield* harness({
        title: "Batch",
        agentSlugs: ["alice"],
        reply: () => {
          if (!first) return Effect.succeed({ text: "" })
          first = false
          return Deferred.await(gate).pipe(Effect.as({ text: "" }))
        },
      })

      yield* collab.runner.post({ collabId: collab.collab.id, text: "one" })
      yield* waitUntil(() => collab.turns.length === 1, "first turn never started")
      yield* collab.runner.post({ collabId: collab.collab.id, text: "two" })
      yield* collab.runner.post({ collabId: collab.collab.id, text: "three" })
      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(collab.runner.settle, "collab did not settle", "10 seconds")

      expect(collab.turns).toHaveLength(2)
      expect(collab.turns[0]!.text).toContain("user: one")
      expect(collab.turns[1]!.text).toContain("user: two")
      expect(collab.turns[1]!.text).toContain("user: three")
      expect(collab.turns[1]!.text).not.toContain("user: one")
    }),
  )

  it.live("keeps every sequence number unique when two writers append at once", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Race", agentSlugs: [], reply: silent })
      yield* Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          collab.runner.post({ collabId: collab.collab.id, text: `post ${index}` }),
        ),
        { concurrency: "unbounded" },
      )
      const seqs = (yield* collab.log()).map((message) => message.seq)
      expect(seqs).toHaveLength(12)
      expect(new Set(seqs).size).toBe(12)
    }),
  )
})

describe("collab hand-off", () => {
  it.live("passes the baton: the target runs AFTER the caller's turn, not beside it", () =>
    Effect.gen(function* () {
      const order: string[] = []
      const collab = yield* harness({
        title: "Baton",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          order.push(`start ${input.agentSlug}`)
          if (input.agentSlug === "alice") {
            yield* input.turn.ops.append({
              collabId: input.collabId,
              authorId: "alice",
              authorKind: "agent",
              kind: "handoff",
              text: "build the migration",
              mentions: ["bob"],
            })
            yield* input.turn.ops.handoff("bob")
            input.turn.stop.requested = true
            input.turn.stop.kind = "handoff"
          }
          order.push(`end ${input.agentSlug}`)
          return { text: "should never be posted" }
        }),
      })
      yield* collab.post("start")

      expect(order).toEqual(["start alice", "end alice", "start bob", "end bob"])
      // A hand-off already said its piece in the room, so the caller's own
      // assistant text is NOT appended on top of it.
      const log = yield* collab.log()
      expect(log.map((message) => message.kind)).toEqual(["say", "handoff", "say"])
      expect(log.at(-1)).toMatchObject({ authorId: "bob", text: "should never be posted" })
    }),
  )

  it.live("gives the target the hand-off as a BRIEF, not as a batch of missed messages", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Brief",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug !== "alice") return { text: "" }
          yield* input.turn.ops.append({
            collabId: input.collabId,
            authorId: "alice",
            authorKind: "agent",
            kind: "handoff",
            text: "build the migration\nContext: the table is collab_task",
            mentions: ["bob"],
          })
          yield* input.turn.ops.handoff("bob")
          input.turn.stop.requested = true
          input.turn.stop.kind = "handoff"
          return { text: "" }
        }),
      })
      yield* collab.post("who builds it?")

      const bobTurn = collab.turns.find((turn) => turn.agentSlug === "bob")
      expect(bobTurn?.text.startsWith("[Collab: Brief]\nFROM: @alice\nTASK: build the migration")).toBe(true)
      expect(bobTurn?.text).toContain("Recent room messages:")
      expect(bobTurn?.text).toContain("user: who builds it?")
      // The hand-off is the brief, so it must not ALSO appear under it.
      expect(bobTurn?.text.split("Recent room messages:")[1]).not.toContain("build the migration")
    }),
  )
})

// --- The hand-off AUTO-RETURN. `ask` returns its answer to the asker by
// construction; a hand-off does not, so a target that simply talks and stops
// leaves its task CLAIMED forever and the issuer is never woken. In the UAT
// rooms that killed the loop dead until a human intervened.

/**
 * Plays the `handoff` tool exactly as `flock-tools.ts` does: open a task
 * already CLAIMED by the target, append the hand-off row carrying its id, pass
 * the baton, end the turn.
 */
const handOver = Effect.fnUntraced(function* (
  input: CollabRunner.TurnInput,
  to: string,
  title = "build the migration",
) {
  const task = yield* input.turn.ops.store.addTask({
    collabId: input.collabId,
    title,
    createdBy: input.agentSlug,
    owner: to,
    state: "claimed",
  })
  const handed = yield* input.turn.ops.append({
    collabId: input.collabId,
    authorId: input.agentSlug,
    authorKind: "agent",
    kind: "handoff",
    text: title,
    mentions: [to],
    taskId: task.id,
  })
  yield* input.turn.ops.store.setTaskOrigin(input.collabId, task.id, handed.seq)
  yield* input.turn.ops.handoff(to)
  input.turn.stop.requested = true
  input.turn.stop.kind = "handoff"
  return task
})

describe("collab hand-off auto-return", () => {
  it.live("gives the target the board id of the task the hand-off opened", () =>
    Effect.gen(function* () {
      let handedOnce = false
      const collab = yield* harness({
        title: "BriefId",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug === "alice" && !handedOnce) {
            handedOnce = true
            yield* handOver(input, "bob")
          }
          return { text: "" }
        }),
      })
      yield* collab.post("who builds it?")

      const task = (yield* collab.store.listTasks(collab.collab.id))[0]!
      const bobTurn = collab.turns.find((turn) => turn.agentSlug === "bob")
      expect(bobTurn?.text).toContain(`Board task: ${task.id}`)
    }),
  )

  it.live("closes the task and wakes the ISSUER when the target ends its turn in silence", () =>
    Effect.gen(function* () {
      let handedOnce = false
      const collab = yield* harness({
        title: "Silent",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug === "alice" && !handedOnce) {
            handedOnce = true
            yield* handOver(input, "bob")
          }
          return { text: "" }
        }),
      })
      yield* collab.post("start")

      const tasks = yield* collab.store.listTasks(collab.collab.id)
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({ state: "done", owner: "bob" })
      // Marked, because the RUNNER wrote it. Unmarked it would read as bob's
      // own report of work bob never described.
      expect(tasks[0]!.result).toBe(`${CollabRunner.AUTO_RESULT_PREFIX} ${CollabRunner.AUTO_SILENT_RESULT}`)
      // alice opened the task, so alice is woken to accept or reopen it. That
      // third turn is the loop that used to die here.
      expect(slugs(collab.turns)).toEqual(["alice", "bob", "alice"])
      const done = (yield* collab.log()).filter((message) => message.kind === "task_done")
      expect(done).toHaveLength(1)
      expect(done[0]).toMatchObject({ authorId: "bob", taskId: tasks[0]!.id })
    }),
  )

  it.live("carries the target's own words into the result, and lets the issuer reopen on them", () =>
    Effect.gen(function* () {
      let handedOnce = false
      const collab = yield* harness({
        title: "Blocked",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug === "bob") return { text: "blocked: the spec you referenced was never posted" }
          if (!handedOnce) {
            handedOnce = true
            yield* handOver(input, "bob")
            return { text: "" }
          }
          // alice, woken by the auto-close, sends it back.
          const open = (yield* input.turn.ops.store.listTasks(input.collabId))[0]!
          yield* input.turn.ops.store.updateTask({
            collabId: input.collabId,
            taskId: open.id,
            action: "reopen",
            note: "here is the spec: docs/migration.md",
          })
          return { text: "" }
        }),
      })
      yield* collab.post("start")

      const tasks = yield* collab.store.listTasks(collab.collab.id)
      expect(tasks[0]!.result).toBe(
        `${CollabRunner.AUTO_RESULT_PREFIX} blocked: the spec you referenced was never posted`,
      )
      // Reopened, not stuck: the issuer got a real decision to make.
      expect(tasks[0]).toMatchObject({ state: "claimed", owner: "bob", note: "here is the spec: docs/migration.md" })
    }),
  )

  it.live("does NOT fire a second time when the target completed the task itself", () =>
    Effect.gen(function* () {
      let handedOnce = false
      const collab = yield* harness({
        title: "NoDoubleFire",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug === "alice") {
            if (handedOnce) return { text: "" }
            handedOnce = true
            yield* handOver(input, "bob")
            return { text: "" }
          }
          const task = (yield* input.turn.ops.store.listTasks(input.collabId))[0]!
          yield* input.turn.ops.store.updateTask({
            collabId: input.collabId,
            taskId: task.id,
            action: "done",
            result: "written, bun test green",
          })
          yield* input.turn.ops.append({
            collabId: input.collabId,
            authorId: "bob",
            authorKind: "agent",
            kind: "task_done",
            text: `completed task: ${task.title}`,
            taskId: task.id,
          })
          return { text: "", trace: [{ tool: "task_done", summary: task.id, status: "ok" as const }] }
        }),
      })
      yield* collab.post("start")

      const tasks = yield* collab.store.listTasks(collab.collab.id)
      // bob's evidence survives; the runner does not overwrite it with "[auto]".
      expect(tasks[0]!.result).toBe("written, bun test green")
      // And exactly ONE task_done row, so alice is woken once rather than twice.
      expect((yield* collab.log()).filter((message) => message.kind === "task_done")).toHaveLength(1)
    }),
  )

  it.live("still auto-closes when the target ends with done() - done is not routing", () =>
    Effect.gen(function* () {
      // The Test 4 stall wearing its most likely disguise: the target finishes
      // the work and ends with done("finished it") instead of task_done. done
      // says "my turn is over", not "the work left my hands" - the task must
      // still close and the issuer must still wake.
      let handedOnce = false
      const collab = yield* harness({
        title: "DoneStall",
        agentSlugs: ["alice", "bob"],
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug === "alice" && !handedOnce) {
            handedOnce = true
            yield* handOver(input, "bob")
            return { text: "" }
          }
          if (input.agentSlug === "bob") {
            input.turn.stop.requested = true
            input.turn.stop.kind = "done"
            input.turn.stop.summary = "finished it"
            return { text: "" }
          }
          return { text: "" }
        }),
      })
      yield* collab.post("start")

      const task = (yield* collab.store.listTasks(collab.collab.id))[0]!
      expect(task).toMatchObject({ state: "done", owner: "bob" })
      expect(task.result).toBe(`${CollabRunner.AUTO_RESULT_PREFIX} finished it`)
      expect((yield* collab.log()).filter((message) => message.kind === "task_done")).toHaveLength(1)
      // alice, the issuer, was woken by the auto-close for acceptance.
      expect(collab.turns.map((turn) => turn.agentSlug)).toEqual(["alice", "bob", "alice"])
    }),
  )

  it.live("leaves the task alone when the target routed the work itself", () =>
    Effect.gen(function* () {
      let handedOnce = false
      const collab = yield* harness({
        title: "Routed",
        agentSlugs: ["alice", "bob", "carol"],
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug === "alice" && !handedOnce) {
            handedOnce = true
            yield* handOver(input, "bob")
            return { text: "" }
          }
          if (input.agentSlug !== "bob") return { text: "" }
          // bob asked carol and is still holding the work: the board move is
          // bob's to make once the answer lands, not the runner's to make now.
          yield* input.turn.ops.ask({
            target: "carol",
            sessionId: yield* input.turn.ops.session("carol").pipe(Effect.orDie),
            from: "bob",
            task: "where is the table defined?",
            askChain: [...input.turn.askChain, input.turn.sessionId],
            hops: input.turn.hops,
          })
          return { text: "still working on it", trace: [{ tool: "ask", summary: "carol", status: "ok" as const }] }
        }),
      })
      yield* collab.post("start")

      const tasks = yield* collab.store.listTasks(collab.collab.id)
      expect(tasks[0]).toMatchObject({ state: "claimed", owner: "bob", result: null })
      expect((yield* collab.log()).filter((message) => message.kind === "task_done")).toHaveLength(0)
    }),
  )

  it.live("leaves the task alone when the target passed the baton on", () =>
    Effect.gen(function* () {
      let hops = 3
      const collab = yield* harness({
        title: "Chained",
        agentSlugs: ["alice", "bob", "carol"],
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (hops-- <= 0) return { text: "" }
          if (input.agentSlug === "alice") yield* handOver(input, "bob", "build it")
          if (input.agentSlug === "bob") yield* handOver(input, "carol", "review it")
          return { text: "" }
        }),
      })
      yield* collab.post("start")

      const tasks = yield* collab.store.listTasks(collab.collab.id)
      // bob's own task stays claimed - the chain is alive and bob is still on
      // the hook. Only carol's turn, which ended without routing, auto-closes.
      expect(tasks.find((task) => task.title === "build it")).toMatchObject({ state: "claimed", owner: "bob" })
      expect(tasks.find((task) => task.title === "review it")).toMatchObject({ state: "done", owner: "carol" })
    }),
  )

  it.live("closes the task but wakes NOBODY once the hop budget is spent", () =>
    Effect.gen(function* () {
      let handedOnce = false
      const collab = yield* harness({
        title: "Exhausted",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug === "alice" && !handedOnce) {
            handedOnce = true
            yield* handOver(input, "bob")
          }
          return { text: "" }
        }),
      })
      yield* collab.store.setCap(collab.collab.id, 2)
      yield* collab.post("start")

      // alice spent one, bob spent the second. The auto-close still records
      // the work, but the wake it would carry is gated like every other wake.
      expect(slugs(collab.turns)).toEqual(["alice", "bob"])
      expect((yield* collab.store.listTasks(collab.collab.id))[0]).toMatchObject({ state: "done" })
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({ remaining: 0, cap: 2 })
    }),
  )
})

describe("collab turn ending", () => {
  it.live("posts a `done` summary as the turn's final message, in place of the text", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Done",
        agentSlugs: ["alice"],
        reply: (input) =>
          Effect.sync(() => {
            input.turn.stop.requested = true
            input.turn.stop.kind = "done"
            input.turn.stop.summary = "migration written, tests green"
            return { text: "some half-finished thinking" }
          }),
      })
      yield* collab.post("status?")
      expect(agentTexts(yield* collab.log()).map((message) => message.text)).toEqual(["migration written, tests green"])
    }),
  )

  it.live("appends nothing at all when `done` carries no summary", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Silence",
        agentSlugs: ["alice"],
        reply: (input) =>
          Effect.sync(() => {
            input.turn.stop.requested = true
            input.turn.stop.kind = "done"
            return { text: "this was not meant for the room" }
          }),
      })
      yield* collab.post("anything to add?")
      expect(agentTexts(yield* collab.log())).toHaveLength(0)
    }),
  )

  it.live("treats an empty reply as silence and appends nothing", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Empty", reply: speak("   \n  ") })
      yield* collab.post("anything to add?")
      expect(agentTexts(yield* collab.log())).toHaveLength(0)
    }),
  )

  it.live("refuses to post a turn that stopped on its STEP CAP", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Capped",
        agentSlugs: ["alice"],
        reply: () => Effect.succeed({ text: "half an answer, cut off mid-", stepCapped: true }),
      })
      yield* collab.post("go")

      // Posting it would put half an answer in the room, and every other agent
      // would read it as a whole one.
      expect(agentTexts(yield* collab.log())).toHaveLength(0)
      expect((yield* collab.runner.statuses(collab.collab.id)).get("alice")?.lastError).toContain("ran out of steps")
    }),
  )
})

describe("collab nested ask", () => {
  const asking = (task: string): Reply =>
    Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
      if (input.agentSlug !== "alice") return { text: "bob says: it is on line 40" }
      const outcome = yield* input.turn.ops.ask({
        target: "bob",
        sessionId: yield* input.turn.ops.session("bob").pipe(Effect.orDie),
        from: "alice",
        task,
        context: "the table is collab_task",
        expect: "the line number",
        askChain: [...input.turn.askChain, input.turn.sessionId],
        hops: input.turn.hops,
      })
      return { text: `alice heard: ${outcome.text}` }
    })

  it.live("runs the target INSIDE the caller's turn and hands its answer back", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Ask", reply: asking("where is the migration?") })
      yield* collab.post("where is it?")

      expect(slugs(collab.turns)).toEqual(["alice", "bob"])
      expect(agentTexts(yield* collab.log()).map((message) => message.text)).toEqual([
        "alice heard: bob says: it is on line 40",
      ])
      // The nested turn got the brief, not a batch of missed room messages.
      const bobTurn = collab.turns[1]!
      expect(bobTurn.text).toContain("FROM: @alice")
      expect(bobTurn.text).toContain("TASK: where is the migration?")
      expect(bobTurn.text).toContain("CONTEXT: the table is collab_task")
      expect(bobTurn.text).toContain("EXPECTED BACK: the line number")
    }),
  )

  it.live("carries the ask chain and the SAME budget into the nested turn", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Chain", reply: asking("look it up") })
      yield* collab.store.setCap(collab.collab.id, 4)
      yield* collab.post("where is it?")

      const bobTurn = collab.turns[1]!
      expect(bobTurn.turn.askChain).toEqual(["ses_alice"])
      // One budget for the whole chain: the nested turn must not be able to
      // buy itself more room by going a level deeper.
      expect(bobTurn.turn.hops).toBe(collab.turns[0]!.turn.hops)
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({ remaining: 2, cap: 4 })
    }),
  )

  it.live("reports a target that is no longer in the room instead of running nothing", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const collab = yield* harness({
        title: "Gone",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug !== "alice") return { text: "" }
          yield* input.turn.ops.store.removeParticipant(input.collabId, "bob")
          const outcome = yield* input.turn.ops.ask({
            target: "bob",
            sessionId: "ses_bob",
            from: "alice",
            task: "anything",
            askChain: [],
            hops: input.turn.hops,
          })
          seen.push(outcome.error ?? "")
          return { text: "" }
        }),
      })
      yield* collab.post("go")
      expect(seen[0]).toContain("no longer in this collab")
    }),
  )

  it.live("hands a failed nested turn back as an error rather than as silence", () =>
    Effect.gen(function* () {
      const seen: CollabSystemOutcome[] = []
      const collab = yield* harness({
        title: "NestedFail",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug === "bob") return yield* Effect.fail(new Error("provider is down"))
          const outcome = yield* input.turn.ops.ask({
            target: "bob",
            sessionId: yield* input.turn.ops.session("bob").pipe(Effect.orDie),
            from: "alice",
            task: "anything",
            askChain: [],
            hops: input.turn.hops,
          })
          seen.push(outcome)
          return { text: "" }
        }),
      })
      yield* collab.post("go")

      expect(seen[0]?.error).toContain("provider is down")
      expect(seen[0]?.text).toBe("")
      // Nothing is appended on a failed turn, nested or not.
      expect(agentTexts(yield* collab.log())).toHaveLength(0)
      expect((yield* collab.runner.statuses(collab.collab.id)).get("bob")?.lastError).toContain("provider is down")
    }),
  )

  it.live("flags a nested turn that stopped on its step cap instead of returning the stump", () =>
    Effect.gen(function* () {
      const seen: CollabSystemOutcome[] = []
      const collab = yield* harness({
        title: "NestedCapped",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug === "bob") return { text: "half an answ", stepCapped: true }
          seen.push(
            yield* input.turn.ops.ask({
              target: "bob",
              sessionId: yield* input.turn.ops.session("bob").pipe(Effect.orDie),
              from: "alice",
              task: "anything",
              askChain: [],
              hops: input.turn.hops,
            }),
          )
          return { text: "" }
        }),
      })
      yield* collab.post("go")

      expect(seen[0]?.stepCapped).toBe(true)
      expect(seen[0]?.text).toBe("")
    }),
  )
})

type CollabSystemOutcome = { text: string; error?: string; stepCapped?: boolean }

describe("collab trace and ledger", () => {
  it.live("puts the turn's tool trace on the message it appended", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Trace",
        agentSlugs: ["alice"],
        reply: () =>
          Effect.succeed({
            text: "read it",
            trace: [
              { tool: "read", summary: "src/collab/sql.ts", status: "ok" as const },
              { tool: "bash", summary: "bun test", status: "error" as const },
            ],
          }),
      })
      yield* collab.post("go")
      expect(agentTexts(yield* collab.log())[0]!.trace).toEqual([
        { tool: "read", summary: "src/collab/sql.ts", status: "ok" },
        { tool: "bash", summary: "bun test", status: "error" },
      ])
    }),
  )

  it.live("writes ONE ledger row per turn, silent turns included", () =>
    Effect.gen(function* () {
      const cost = { model: "lmstudio/qwen3-coder", tokensInput: 100, tokensOutput: 20, cost: 0.5 }
      const collab = yield* harness({
        title: "Ledger",
        agentSlugs: ["alice"],
        reply: () => Effect.succeed({ text: "", cost }),
      })
      yield* collab.post("go")

      // Silence costs tokens: a ledger that only billed for messages would
      // under-report every turn where an agent correctly said nothing.
      const rows = yield* collab.store.listCosts(collab.collab.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ agentSlug: "alice", model: "lmstudio/qwen3-coder", cost: 0.5, askedBy: null })
    }),
  )

  it.live("attributes a nested turn to the agent that asked for it", () =>
    Effect.gen(function* () {
      const cost = { model: "lmstudio/qwen3-coder", tokensInput: 10, tokensOutput: 2, cost: 0.25 }
      const collab = yield* harness({
        title: "AskedBy",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug === "bob") return { text: "line 40", cost }
          yield* input.turn.ops.ask({
            target: "bob",
            sessionId: yield* input.turn.ops.session("bob").pipe(Effect.orDie),
            from: "alice",
            task: "where?",
            askChain: [],
            hops: input.turn.hops,
          })
          return { text: "", cost }
        }),
      })
      yield* collab.post("go")

      const rows = yield* collab.store.listCosts(collab.collab.id)
      expect(rows.map((row) => ({ agentSlug: row.agentSlug, askedBy: row.askedBy }))).toEqual([
        { agentSlug: "alice", askedBy: null },
        { agentSlug: "bob", askedBy: "alice" },
      ])
      expect(yield* collab.store.costTotals(collab.collab.id)).toEqual([
        { agentSlug: "alice", cost: 0.25, tokensInput: 10, tokensOutput: 2 },
        { agentSlug: "bob", cost: 0.25, tokensInput: 10, tokensOutput: 2 },
      ])
    }),
  )
})

describe("collab stop", () => {
  it.live("interrupts the turn in flight, drops the queue and spends the budget", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const collab = yield* harness({
        title: "Stop",
        agentSlugs: ["alice", "bob", "carol"],
        reply: () => Deferred.await(gate).pipe(Effect.as({ text: "too late" })),
      })
      yield* collab.runner.post({ collabId: collab.collab.id, text: "go", mentions: ["alice", "bob", "carol"] })
      yield* waitUntil(() => collab.turns.length === 1, "the first turn never started")

      yield* collab.runner.stop(collab.collab.id)
      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(collab.runner.settle, "the collab did not settle after stop", "10 seconds")

      // Only the interrupted turn ever started, and nothing it produced landed.
      expect(collab.turns).toHaveLength(1)
      expect(agentTexts(yield* collab.log())).toHaveLength(0)
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({
        remaining: 0,
        cap: CollabRunner.LOOP_BREAKER_DEFAULT,
      })
      // The two agents still sitting in the queue are put back to idle too: a
      // roster stuck on "queued" after a stop reads as work still coming.
      expect([...(yield* collab.runner.statuses(collab.collab.id)).values()].map((entry) => entry.state)).toEqual([
        "idle",
        "idle",
        "idle",
      ])
    }),
  )

  it.live("holds the room until a human posts again, then releases it", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Resume", agentSlugs: ["alice"], reply: speak("on it") })
      yield* collab.runner.stop(collab.collab.id)
      yield* collab.post("are you there?")
      // The post reset the budget before the fan-out read it, so the held room
      // answers the very message that released it.
      expect(collab.turns).toHaveLength(1)
    }),
  )

  it.live("spends the budget of a collab whose cap is OFF as well", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "StopOvernight", agentSlugs: ["alice"], reply: speak("on it") })
      yield* collab.store.setCap(collab.collab.id, 0)
      yield* collab.runner.stop(collab.collab.id)
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({ remaining: 0, cap: null })
      yield* collab.post("carry on")
      expect(collab.turns).toHaveLength(1)
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({ remaining: null, cap: null })
    }),
  )
})

describe("collab system layers", () => {
  it.live("puts the base prompt, the roster and the reader's own handle in every turn", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Manual",
        displayNames: { alice: "Alice Reviewer", bob: "Bob Builder" },
        reply: silent,
      })
      yield* collab.post("what next?")

      const turn = collab.turns.find((entry) => entry.agentSlug === "alice")
      expect(turn?.turn.base).toContain("shared room inside a coding harness")
      // The layer below the persona is STATE. The prose that used to lead it
      // is gone: one base prompt states the room's rules, once.
      expect(turn?.turn.state).not.toContain("How this collab works")
      expect(turn?.turn.state.startsWith('You are @alice ("Alice Reviewer"). Collab: "Manual". Roster:')).toBe(true)
      expect(turn?.turn.state).toContain("- @alice: Alice Reviewer (you)")
      expect(turn?.turn.state).toContain("- @bob: Bob Builder")
      expect(turn?.text.startsWith("[Collab: Manual] New messages:")).toBe(true)
    }),
  )

  it.live("carries the room's facts on the turn context the tools read", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Facts", reply: silent })
      yield* collab.store.setObjective(collab.collab.id, "cut the release")
      yield* collab.post("what next?")

      const turn = collab.turns[0]!
      expect(turn.turn).toMatchObject({
        collabId: collab.collab.id,
        title: "Facts",
        agentSlug: "alice",
        sessionId: "ses_alice",
        lead: "alice",
        objective: "cut the release",
        askChain: [],
      })
      expect(turn.turn.roster).toEqual([
        { agentSlug: "alice", displayName: "alice", sessionId: null },
        { agentSlug: "bob", displayName: "bob", sessionId: null },
      ])
      expect(turn.turn.stop).toEqual({ requested: false, summary: "" })
    }),
  )

  it.live("rebuilds the roster from the store, so an add or a remove lands on the next turn", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "Roster", reply: silent })
      yield* collab.post("first")
      yield* collab.store.removeParticipant(collab.collab.id, "bob")
      yield* collab.store.addParticipant(collab.collab.id, "carol")
      yield* collab.post("second")

      const last = collab.turns.at(-1)
      expect(last?.agentSlug).toBe("alice")
      expect(last?.turn.state).toContain("- @carol: carol")
      expect(last?.turn.state).not.toContain("@bob")
    }),
  )
})

describe("collab turn measurements", () => {
  const message = (parts: unknown[]): never => ({ info: { role: "assistant" }, parts }) as never

  it.live("summarises each tool call by its primary argument, falling back to the title", () => {
    const trace = CollabRunner.traceOf([
      message([
        { type: "tool", tool: "read", state: { status: "completed", title: "read", input: { path: "src/app.ts" } } },
        { type: "tool", tool: "bash", state: { status: "error", input: { command: "bun test" } } },
        { type: "tool", tool: "glob", state: { status: "completed", title: "3 matches", input: {} } },
        { type: "text", text: "not a tool" },
      ]),
    ])
    // A title is often the tool's own name again, which tells a reader nothing
    // the `tool` field did not already say.
    expect(trace).toEqual([
      { tool: "read", summary: "src/app.ts", status: "ok" },
      { tool: "bash", summary: "bun test", status: "error" },
      { tool: "glob", summary: "3 matches", status: "ok" },
    ])
    return Effect.void
  })

  // THE W8 UAT BUG, second half. A flock tool REFUSES with a plain-text result
  // (`refuse()` in flock-tools.ts) rather than an error, so the part completes
  // and the trace called it "ok". The owner's screenshot therefore read
  // "task_claim ok" for a claim that never happened, and the board disagreeing
  // with the trace looked like a UI fault instead of a refused move.
  it.live("reads a REFUSED flock tool as a failure, not as a tool that worked", () => {
    const trace = CollabRunner.traceOf([
      message([
        {
          type: "tool",
          tool: "task_claim",
          state: {
            status: "completed",
            title: "task_claim",
            input: { taskId: "clbt_guessed" },
            metadata: { refused: true },
          },
        },
        {
          type: "tool",
          tool: "task_claim",
          state: { status: "completed", title: "task_claim", input: { taskId: "clbt_real" }, metadata: {} },
        },
      ]),
    ])
    expect(trace).toEqual([
      { tool: "task_claim", summary: "clbt_guessed", status: "error" },
      { tool: "task_claim", summary: "clbt_real", status: "ok" },
    ])
    return Effect.void
  })

  // `routed` decides whether the runner auto-closes the task a turn was handed.
  // It read the tool NAME only, so a task_done the board REFUSED ("that task
  // belongs to X, not you") counted as work routed onward and suppressed the
  // auto-close - the issuer was never woken and the task sat claimed forever.
  it.live("does not count a refused task_done as work the board can see", () => {
    const stop = { requested: true, kind: "done", summary: "" } as never
    expect(CollabRunner.routed({ stop, trace: [{ tool: "task_done", summary: "clbt_x", status: "ok" }] })).toBe(true)
    expect(CollabRunner.routed({ stop, trace: [{ tool: "task_done", summary: "clbt_x", status: "error" }] })).toBe(
      false,
    )
    return Effect.void
  })

  it.live("sums the STEP-FINISH parts across every message of the turn", () => {
    // Not the last assistant message's `tokens`, which is last-write-wins: a
    // ten-step turn billed off its final step reports a tenth of what it cost.
    const step = (cost: number, input: number, output: number) => ({
      type: "step-finish",
      cost,
      tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect(
      CollabRunner.spendOf([message([step(0.5, 100, 10), step(0.25, 40, 5)]), message([step(0.25, 10, 1)])]),
    ).toEqual({ cost: 1, tokensInput: 150, tokensOutput: 16 })
    return Effect.void
  })
})

describe("collab live activity signal", () => {
  const running = (parts: unknown[]): never => ({ info: { role: "assistant", time: { created: 0 } }, parts }) as never
  const finished = (parts: unknown[]): never =>
    ({ info: { role: "assistant", time: { created: 0, completed: 1 } }, parts }) as never

  it.live("shows the newest tool call as its tool name plus its primary argument", () => {
    const activity = CollabRunner.liveActivityOf(
      running([
        { type: "reasoning", text: "let me check the file" },
        { type: "tool", tool: "read", state: { status: "running", input: { path: "src/app.ts" } } },
      ]),
    )
    expect(activity).toEqual({ kind: "tool", text: "read: src/app.ts" })
    return Effect.void
  })

  it.live("falls back to the tool name alone when there is no string argument to show", () => {
    const activity = CollabRunner.liveActivityOf(
      running([{ type: "tool", tool: "bash", state: { status: "pending", input: {} } }]),
    )
    expect(activity).toEqual({ kind: "tool", text: "bash" })
    return Effect.void
  })

  it.live("reports a thought when nothing has called a tool yet this step", () => {
    const activity = CollabRunner.liveActivityOf(running([{ type: "reasoning", text: "thinking it through" }]))
    expect(activity).toEqual({ kind: "thought", text: "thinking it through" })
    return Effect.void
  })

  it.live("prefers a tool call over an OLDER reasoning part, but not over a NEWER one", () => {
    // Reasoning almost always leads straight into the tool call it explains,
    // so walking from the end naturally lands on the tool once one exists -
    // but a fresh step that is still only reasoning must not keep showing the
    // previous step's tool call.
    const afterTool = CollabRunner.liveActivityOf(
      running([
        { type: "reasoning", text: "old thought" },
        { type: "tool", tool: "read", state: { status: "completed", input: { path: "a.ts" } } },
      ]),
    )
    expect(afterTool).toEqual({ kind: "tool", text: "read: a.ts" })

    const newStepReasoning = CollabRunner.liveActivityOf(
      running([
        { type: "tool", tool: "read", state: { status: "completed", input: { path: "a.ts" } } },
        { type: "reasoning", text: "now let me check the tests" },
      ]),
    )
    expect(newStepReasoning).toEqual({ kind: "thought", text: "now let me check the tests" })
    return Effect.void
  })

  it.live("clamps a tool's text at the wire's 200-character bound", () => {
    const activity = CollabRunner.liveActivityOf(
      running([{ type: "tool", tool: "bash", state: { status: "running", input: { command: "x".repeat(250) } } }]),
    )
    expect(activity?.text.length).toBe(CollabActivity.LIVE_ACTIVITY_MAX_CHARS)
    expect(activity?.text.startsWith("bash: ")).toBe(true)
    return Effect.void
  })

  it.live("clamps a thought to its last 200 characters - the freshest words, not the first", () => {
    const long = Array.from({ length: 40 }, (_, index) => `sentence number ${index}`).join(". ")
    const activity = CollabRunner.liveActivityOf(running([{ type: "reasoning", text: long }]))
    expect(activity).toEqual({ kind: "thought", text: long.slice(-CollabActivity.LIVE_ACTIVITY_MAX_CHARS) })
    return Effect.void
  })

  it.live("is absent while a reasoning part has not streamed any text yet", () => {
    expect(CollabRunner.liveActivityOf(running([{ type: "reasoning", text: "   " }]))).toBeUndefined()
    return Effect.void
  })

  it.live("is absent once the turn's own message is complete - a finished turn leaves nothing behind", () => {
    const activity = CollabRunner.liveActivityOf(
      finished([{ type: "tool", tool: "read", state: { status: "completed", input: {} } }]),
    )
    expect(activity).toBeUndefined()
    return Effect.void
  })

  it.live("is absent when there is no message at all, and for a user message", () => {
    expect(CollabRunner.liveActivityOf(undefined)).toBeUndefined()
    const userMessage = { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] } as never
    expect(CollabRunner.liveActivityOf(userMessage)).toBeUndefined()
    return Effect.void
  })

  it.live("is absent when a message carries neither a tool nor a reasoning part", () => {
    expect(CollabRunner.liveActivityOf(running([{ type: "text", text: "the final answer" }]))).toBeUndefined()
    return Effect.void
  })
})

// --- The FULL reasoning of the turn in flight. The one-line signal above and
// this one are read off the same message and answer different questions, so
// every case below states what the OTHER signal does with the same input.

describe("collab live thought", () => {
  const running = (parts: unknown[]): never => ({ info: { role: "assistant", time: { created: 0 } }, parts }) as never
  const finished = (parts: unknown[]): never =>
    ({ info: { role: "assistant", time: { created: 0, completed: 1 } }, parts }) as never

  it.live("accumulates every reasoning part of the turn, in order, not just the newest", () => {
    // One reasoning part per step: a thought taken from the last part alone
    // would drop everything the agent worked through to get there.
    const message = running([
      { type: "reasoning", text: "first I read the schema" },
      { type: "tool", tool: "read", state: { status: "completed", input: { path: "sql.ts" } } },
      { type: "reasoning", text: "now the migration" },
    ])
    expect(CollabRunner.liveThoughtOf(message)).toBe("first I read the schema\nnow the migration")
    // The one-line chip is unchanged by any of this: it still shows the newest
    // signal, which here is the reasoning that followed the tool call.
    expect(CollabRunner.liveActivityOf(message)).toEqual({ kind: "thought", text: "now the migration" })
    return Effect.void
  })

  it.live("keeps the TAIL when the reasoning overruns its 4000-character bound", () => {
    const long = Array.from({ length: 400 }, (_, index) => `sentence number ${index}`).join(". ")
    const thought = CollabRunner.liveThoughtOf(running([{ type: "reasoning", text: long }]))
    expect(long.length).toBeGreaterThan(CollabRunner.LIVE_THOUGHT_MAX_CHARS)
    expect(thought?.length).toBe(CollabRunner.LIVE_THOUGHT_MAX_CHARS)
    // The freshest words, not the opening ones.
    expect(thought).toBe(long.slice(-CollabRunner.LIVE_THOUGHT_MAX_CHARS))
    return Effect.void
  })

  it.live("bounds the JOINED text, not each part on its own", () => {
    const half = "x".repeat(CollabRunner.LIVE_THOUGHT_MAX_CHARS)
    const thought = CollabRunner.liveThoughtOf(
      running([
        { type: "reasoning", text: half },
        { type: "reasoning", text: `y${"z".repeat(CollabRunner.LIVE_THOUGHT_MAX_CHARS - 1)}` },
      ]),
    )
    expect(thought?.length).toBe(CollabRunner.LIVE_THOUGHT_MAX_CHARS)
    // Nothing of the first part survives: two parts each at the bound would
    // otherwise ship 8000 characters on a wire that promises 4000.
    expect(thought?.startsWith("y")).toBe(true)
    return Effect.void
  })

  it.live("is absent once the turn's own message is complete - a finished turn leaves nothing behind", () => {
    expect(CollabRunner.liveThoughtOf(finished([{ type: "reasoning", text: "all done now" }]))).toBeUndefined()
    return Effect.void
  })

  it.live("is absent for no message, a user message and a turn that has not reasoned", () => {
    expect(CollabRunner.liveThoughtOf(undefined)).toBeUndefined()
    expect(
      CollabRunner.liveThoughtOf({ info: { role: "user" }, parts: [{ type: "reasoning", text: "hi" }] } as never),
    ).toBeUndefined()
    expect(
      CollabRunner.liveThoughtOf(running([{ type: "tool", tool: "bash", state: { status: "running", input: {} } }])),
    ).toBeUndefined()
    return Effect.void
  })

  it.live("is absent while the reasoning parts are still blank", () => {
    expect(
      CollabRunner.liveThoughtOf(
        running([
          { type: "reasoning", text: "   " },
          { type: "reasoning", text: "\n\t" },
        ]),
      ),
    ).toBeUndefined()
    return Effect.void
  })
})

describe("collab liveActivity wiring", () => {
  const toolPart = (tool: string, path: string): never =>
    ({
      info: { role: "assistant", time: { created: 0 } },
      parts: [{ type: "tool", tool, state: { status: "running", input: { path } } }],
    }) as never

  it.live("is present with the newest tool while the turn runs, and gone once it settles", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const collab = yield* harness({
        title: "Live",
        agentSlugs: ["alice"],
        latestMessage: (sessionId) =>
          Effect.succeed(sessionId === "ses_alice" ? toolPart("read", "src/app.ts") : undefined),
        reply: () => Deferred.await(gate).pipe(Effect.as({ text: "on it" })),
      })

      yield* collab.runner.post({ collabId: collab.collab.id, text: "go" })
      yield* waitUntil(() => collab.turns.length === 1, "the turn never started")

      const whileRunning = yield* collab.runner.liveActivity(collab.collab.id)
      expect(whileRunning.get("alice")).toEqual({ activity: { kind: "tool", text: "read: src/app.ts" } })

      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(collab.runner.settle, "collab did not settle", "10 seconds")

      const afterSettle = yield* collab.runner.liveActivity(collab.collab.id)
      expect(afterSettle.has("alice")).toBe(false)
    }),
  )

  it.live("carries the turn's whole reasoning beside the one-line signal, off the SAME read", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      let reads = 0
      const collab = yield* harness({
        title: "Thinking",
        agentSlugs: ["alice"],
        latestMessage: () =>
          Effect.sync(() => {
            reads++
            return {
              info: { role: "assistant", time: { created: 0 } },
              parts: [
                { type: "reasoning", text: "the schema first" },
                { type: "tool", tool: "read", state: { status: "running", input: { path: "sql.ts" } } },
              ],
            } as never
          }),
        reply: () => Deferred.await(gate).pipe(Effect.as({ text: "on it" })),
      })

      yield* collab.runner.post({ collabId: collab.collab.id, text: "go" })
      yield* waitUntil(() => collab.turns.length === 1, "the turn never started")

      const whileRunning = yield* collab.runner.liveActivity(collab.collab.id)
      expect(whileRunning.get("alice")).toEqual({
        activity: { kind: "tool", text: "read: sql.ts" },
        thought: "the schema first",
      })
      // ONE read per agent per poll: a chip and a thought taken from two
      // different reads would show two different instants of the same turn.
      expect(reads).toBe(1)

      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(collab.runner.settle, "collab did not settle", "10 seconds")

      // A finished turn leaves NEITHER signal behind.
      expect((yield* collab.runner.liveActivity(collab.collab.id)).has("alice")).toBe(false)
    }),
  )

  it.live("is absent before any turn has ever run, even with a session read wired up", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "Fresh",
        agentSlugs: ["alice"],
        latestMessage: () => Effect.succeed(toolPart("read", "irrelevant.ts")),
        reply: speak("hi"),
      })
      const activity = yield* collab.runner.liveActivity(collab.collab.id)
      expect(activity.size).toBe(0)
    }),
  )

  it.live("never fails the state poll when the session read itself fails", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const collab = yield* harness({
        title: "Broken",
        agentSlugs: ["alice"],
        latestMessage: () => Effect.fail(new Error("session store is down")),
        reply: () => Deferred.await(gate).pipe(Effect.as({ text: "on it" })),
      })

      yield* collab.runner.post({ collabId: collab.collab.id, text: "go" })
      yield* waitUntil(() => collab.turns.length === 1, "the turn never started")

      // The read fails every time it is tried; the poll still answers, just
      // with alice missing from the map rather than throwing.
      const activity = yield* collab.runner.liveActivity(collab.collab.id)
      expect(activity.size).toBe(0)

      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(collab.runner.settle, "collab did not settle", "10 seconds")
    }),
  )
})

// Per-agent supervision (report F7): today's only interrupt kills the whole
// room's chain and spends its budget, so a human who wants ONE agent to stop
// has to stop everything. These are the primitives that do not.
describe("collab per-agent stop", () => {
  it.live("drops ONE queued agent and leaves the rest of the room running", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const collab = yield* harness({
        title: "StopQueued",
        agentSlugs: ["alice", "bob", "carol"],
        reply: (input) =>
          input.agentSlug === "alice"
            ? Deferred.await(gate).pipe(Effect.as({ text: "alice done" }))
            : Effect.succeed({ text: `${input.agentSlug} done` }),
      })
      yield* collab.runner.post({ collabId: collab.collab.id, text: "go", mentions: ["alice", "bob", "carol"] })
      yield* waitUntil(() => collab.turns.length === 1, "the first turn never started")

      expect(yield* collab.runner.stopAgent(collab.collab.id, "bob")).toEqual({ interrupted: false, dequeued: true })
      // Queued, so there was nothing in flight to cancel - but the chip must
      // still come back to idle, because no drain will ever reach it to do that.
      expect((yield* collab.runner.statuses(collab.collab.id)).get("bob")).toEqual({ state: "idle" })

      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(collab.runner.settle, "the collab did not settle", "10 seconds")

      // carol still gets her turn: only bob's slug left the queue.
      expect(slugs(collab.turns)).toEqual(["alice", "carol"])
      expect(agentTexts(yield* collab.log()).map((entry) => entry.text)).toEqual(["alice done", "carol done"])
    }),
  )

  it.live("leaves the ROOM's hop budget alone - this is not a room stop", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "StopBudget", agentSlugs: ["alice", "bob"], reply: speak("on it") })
      yield* collab.post("go", ["alice", "bob"])
      // Both turns ran and spent one hop each; stopping an agent afterwards must
      // not zero what is left, the way the room-wide `stop` deliberately does.
      yield* collab.runner.stopAgent(collab.collab.id, "bob")
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({
        remaining: CollabRunner.LOOP_BREAKER_DEFAULT - 2,
        cap: CollabRunner.LOOP_BREAKER_DEFAULT,
      })
      // And the room still answers the next post rather than being held.
      yield* collab.post("carry on", ["alice"])
      expect(slugs(collab.turns)).toEqual(["alice", "bob", "alice"])
    }),
  )

  it.live("interrupts the turn in flight and gives the NEXT agent its turn", () =>
    Effect.gen(function* () {
      // alice's gate is never opened: the only thing that can end her turn is
      // the interrupt under test.
      const gate = yield* Deferred.make<void>()
      const collab = yield* harness({
        title: "StopRunning",
        agentSlugs: ["alice", "bob"],
        reply: (input) =>
          input.agentSlug === "alice"
            ? Deferred.await(gate).pipe(Effect.as({ text: "alice was not stopped" }))
            : Effect.succeed({ text: "bob done" }),
      })
      yield* collab.runner.post({ collabId: collab.collab.id, text: "go", mentions: ["alice", "bob"] })
      yield* waitUntil(() => collab.turns.length === 1, "the first turn never started")

      expect(yield* collab.runner.stopAgent(collab.collab.id, "alice")).toEqual({
        interrupted: true,
        dequeued: false,
      })
      yield* awaitWithTimeout(collab.runner.settle, "the collab did not settle", "10 seconds")

      expect(slugs(collab.turns)).toEqual(["alice", "bob"])
      // Nothing the interrupted turn was about to say reached the room, and the
      // room did not go down with it.
      expect(agentTexts(yield* collab.log()).map((entry) => entry.text)).toEqual(["bob done"])
      expect((yield* collab.runner.statuses(collab.collab.id)).get("alice")).toEqual({ state: "idle" })
    }),
  )

  it.live("cancels the stopped agent's own child session, and nobody else's", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const aborted: string[] = []
      const collab = yield* harness({
        title: "StopSession",
        agentSlugs: ["alice", "bob"],
        aborted,
        reply: (input) =>
          input.agentSlug === "alice"
            ? Deferred.await(gate).pipe(Effect.as({ text: "never" }))
            : Effect.succeed({ text: "bob done" }),
      })
      yield* collab.runner.post({ collabId: collab.collab.id, text: "go", mentions: ["alice", "bob"] })
      yield* waitUntil(() => collab.turns.length === 1, "the first turn never started")

      yield* collab.runner.stopAgent(collab.collab.id, "alice")
      // Interrupting the runner's own fiber stops the ROOM waiting on the turn;
      // the child session has to be told separately or the model call runs on.
      expect(aborted).toEqual(["ses_alice"])
      yield* awaitWithTimeout(collab.runner.settle, "the collab did not settle", "10 seconds")
    }),
  )

  it.live("reports honestly that an idle agent had nothing to stop", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "StopIdle", agentSlugs: ["alice", "bob"], reply: speak("on it") })
      expect(yield* collab.runner.stopAgent(collab.collab.id, "bob")).toEqual({
        interrupted: false,
        dequeued: false,
      })
      // And it is not a way to mute an agent: the next post still reaches it.
      yield* collab.post("go", ["bob"])
      expect(slugs(collab.turns)).toEqual(["bob"])
    }),
  )
})

describe("collab redirect", () => {
  it.live("puts the target at the FRONT of the queue, ahead of who was waiting", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const collab = yield* harness({
        title: "Redirect",
        agentSlugs: ["alice", "bob", "carol"],
        reply: (input) =>
          input.agentSlug === "alice"
            ? Deferred.await(gate).pipe(Effect.as({ text: "alice done" }))
            : Effect.succeed({ text: `${input.agentSlug} done` }),
      })
      yield* collab.runner.post({ collabId: collab.collab.id, text: "go", mentions: ["alice", "bob", "carol"] })
      yield* waitUntil(() => collab.turns.length === 1, "the first turn never started")

      // Roster order would give bob the next turn - see "sends an addressed
      // human post to exactly those agents, in roster order".
      yield* collab.runner.redirect({ collabId: collab.collab.id, agentSlug: "carol", text: "drop that, do X" })
      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(collab.runner.settle, "the collab did not settle", "10 seconds")

      expect(slugs(collab.turns)).toEqual(["alice", "carol", "bob"])
      // bob is pre-empted, not cancelled: it still takes the turn it was queued for.
      expect(collab.turns[2]?.text).toContain("user: go")
    }),
  )

  it.live("reaches the target ALONE, as a human message it can read", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "RedirectOne", agentSlugs: ["alice", "bob"], reply: speak("ok") })
      const posted = yield* collab.runner.redirect({
        collabId: collab.collab.id,
        agentSlug: "bob",
        text: "smaller diff please",
      })
      yield* awaitWithTimeout(collab.runner.settle, "the collab did not settle", "10 seconds")

      // alice is the lead and takes any unaddressed post; a redirect is
      // addressed, so a correction for bob does not become the room's business.
      expect(slugs(collab.turns)).toEqual(["bob"])
      expect(collab.turns[0]?.text).toContain("user: smaller diff please")
      // An ordinary human `say` in the log, not a control row: the correction
      // has to be readable by the agent it is aimed at.
      expect(posted.authorKind).toBe("human")
      expect(posted.kind).toBe("say")
      expect(posted.mentions).toEqual(["bob"])
      expect((yield* collab.log())[0]?.id).toBe(posted.id)
    }),
  )

  it.live("buys a fresh hop budget, so a suspended room can still be corrected", () =>
    Effect.gen(function* () {
      const collab = yield* harness({ title: "RedirectHeld", agentSlugs: ["alice", "bob"], reply: speak("ok") })
      yield* collab.store.setCap(collab.collab.id, 1)
      yield* collab.post("go")
      expect(yield* collab.runner.hopState(collab.collab.id)).toEqual({ remaining: 0, cap: 1 })

      yield* collab.runner.redirect({ collabId: collab.collab.id, agentSlug: "bob", text: "take this instead" })
      yield* awaitWithTimeout(collab.runner.settle, "the collab did not settle", "10 seconds")
      expect(slugs(collab.turns)).toEqual(["alice", "bob"])
    }),
  )
})

describe("collab activity log", () => {
  const written = (id: string, parts: readonly unknown[]) =>
    ({ info: { id, role: "assistant", time: { created: 0 } }, parts }) as never

  it.live("keeps what the agent did, and keeps it once the turn is over", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const collab = yield* harness({
        title: "ActivityLog",
        agentSlugs: ["alice"],
        latestMessage: () =>
          Effect.succeed(
            written("msg_1", [
              { type: "reasoning", text: "the schema first" },
              { type: "tool", tool: "read", state: { status: "running", input: { path: "sql.ts" } } },
            ]),
          ),
        reply: () => Deferred.await(gate).pipe(Effect.as({ text: "on it" })),
      })
      yield* collab.runner.post({ collabId: collab.collab.id, text: "go" })
      yield* waitUntil(() => collab.turns.length === 1, "the turn never started")

      // The log is filled by the SAME poll the live pill already rides on.
      yield* collab.runner.liveActivity(collab.collab.id)
      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(collab.runner.settle, "collab did not settle", "10 seconds")

      // The one-line signal goes with the turn. The history does not: that is
      // the difference between "it is thinking" and "here is what it did".
      expect((yield* collab.runner.liveActivity(collab.collab.id)).has("alice")).toBe(false)
      expect([...(yield* collab.runner.activityLog(collab.collab.id))]).toEqual([
        [
          "alice",
          [
            { kind: "thought", text: "the schema first", messageId: "msg_1" },
            { kind: "tool", text: "read: sql.ts", messageId: "msg_1" },
          ],
        ],
      ])
    }),
  )

  it.live("does not pile up copies when the same turn is polled again", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      let calls = 0
      const collab = yield* harness({
        title: "ActivityPoll",
        agentSlugs: ["alice"],
        latestMessage: () =>
          Effect.sync(() => {
            calls++
            return written("msg_1", [
              { type: "tool", tool: "read", state: { status: "running", input: { path: "sql.ts" } } },
              ...(calls > 1
                ? [{ type: "tool", tool: "edit", state: { status: "running", input: { path: "s.ts" } } }]
                : []),
            ])
          }),
        reply: () => Deferred.await(gate).pipe(Effect.as({ text: "on it" })),
      })
      yield* collab.runner.post({ collabId: collab.collab.id, text: "go" })
      yield* waitUntil(() => collab.turns.length === 1, "the turn never started")

      yield* collab.runner.liveActivity(collab.collab.id)
      yield* collab.runner.liveActivity(collab.collab.id)
      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(collab.runner.settle, "collab did not settle", "10 seconds")

      expect((yield* collab.runner.activityLog(collab.collab.id)).get("alice")).toEqual([
        { kind: "tool", text: "read: sql.ts", messageId: "msg_1" },
        { kind: "tool", text: "edit: s.ts", messageId: "msg_1" },
      ])
    }),
  )

  it.live("is empty for an agent that has never taken a turn", () =>
    Effect.gen(function* () {
      const collab = yield* harness({
        title: "ActivityFresh",
        agentSlugs: ["alice"],
        latestMessage: () => Effect.succeed(written("msg_1", [])),
        reply: speak("hi"),
      })
      expect((yield* collab.runner.activityLog(collab.collab.id)).size).toBe(0)
    }),
  )
})
