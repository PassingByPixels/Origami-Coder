import { describe, expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { awaitWithTimeout, testEffect } from "../lib/effect"

/**
 * PARALLEL PARTICIPANTS — the room as a SCHEDULER.
 *
 * Its own file rather than more blocks in runner.test.ts, for one reason that
 * is also the wave's first success criterion: the serial suite has to stay
 * UNTOUCHED and green. A default room is proven unchanged by that file passing
 * verbatim; everything a raised concurrency changes is proven here.
 */

const it = testEffect(LayerNode.compile(LayerNode.group([CollabStore.node])))

type Reply = (input: CollabRunner.TurnInput) => Effect.Effect<CollabRunner.TurnOutcome, unknown>

/**
 * The same stubbed-turn harness runner.test.ts uses, plus the one thing this
 * file needs that it does not: a room whose dispatch width is set BEFORE the
 * first post, so the very first drain already runs at that width.
 */
const harness = (options: {
  title: string
  agentSlugs: readonly string[]
  reply: Reply
  /** null (the default) leaves the room SERIAL, exactly as it ships. */
  concurrency?: number | null
  cap?: number | null
  aborted?: string[]
  /**
   * Run before every `listMessages`, which a turn does once - AFTER the hop
   * gate and BEFORE the hop charge. Parking here is the only way to hold
   * several turns inside that window on purpose, which is what makes a budget
   * race reproducible instead of a rare interleaving nobody can test.
   */
  onRead?: () => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const store = yield* CollabStore.Service
    const collab = yield* store.create({ title: options.title, agentSlugs: options.agentSlugs })
    if (options.concurrency !== undefined) yield* store.setConcurrency(collab.id, options.concurrency)
    if (options.cap !== undefined) yield* store.setCap(collab.id, options.cap)
    const turns: CollabRunner.TurnInput[] = []
    const read = options.onRead
    const gated: CollabStore.Interface = read
      ? {
          ...store,
          listMessages: (collabId: string, sinceSeq?: number) =>
            read().pipe(Effect.andThen(store.listMessages(collabId, sinceSeq))),
        }
      : store
    const runner = yield* CollabRunner.make({
      store: gated,
      displayName: (agentSlug) => Effect.succeed(agentSlug),
      createSession: ({ agentSlug }) => Effect.succeed(`ses_${agentSlug}`),
      turn: (input) =>
        Effect.suspend(() => {
          turns.push(input)
          return options.reply(input)
        }),
      ...(options.aborted
        ? { abort: (sessionId: string) => Effect.sync(() => void options.aborted!.push(sessionId)) }
        : {}),
    })
    const log = () => store.listMessages(collab.id)
    return { store, collab, runner, turns, log }
  })

const waitUntil = (check: () => boolean, message: string) =>
  awaitWithTimeout(
    Effect.gen(function* () {
      while (!check()) yield* Effect.sleep("5 millis")
    }),
    message,
    "10 seconds",
  )

/** Every turn this agent was given, oldest first. */
const turnsOf = (turns: readonly CollabRunner.TurnInput[], slug: string) =>
  turns.filter((turn) => turn.agentSlug === slug)

const settle = (runner: CollabRunner.Interface) =>
  awaitWithTimeout(runner.settle, "the collab did not settle", "10 seconds")

const agentTexts = (messages: readonly CollabStore.Message[]) =>
  messages.filter((message) => message.authorKind === "agent").map((message) => message.text)

describe("collab dispatch width", () => {
  it.live("a DEFAULT room never runs two turns at once", () =>
    Effect.gen(function* () {
      // The serial guarantee, asserted rather than assumed. Three agents are
      // woken by one post and every one of them blocks forever; a room that
      // dispatched in parallel would have three turns in flight, and this is
      // the test that fails the moment concurrency 1 stops meaning serial.
      const gate = yield* Deferred.make<void>()
      const room = yield* harness({
        title: "SerialDefault",
        agentSlugs: ["alice", "bob", "carol"],
        reply: () => Deferred.await(gate).pipe(Effect.as({ text: "done" })),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "go", mentions: ["alice", "bob", "carol"] })
      yield* waitUntil(() => room.turns.length === 1, "the first turn never started")

      // Long enough for a second and third dispatch to have happened if the
      // room were ever going to make one.
      yield* Effect.sleep("120 millis")
      expect(room.turns.length).toBe(1)

      yield* Deferred.succeed(gate, undefined)
      yield* settle(room.runner)
      expect(room.turns.length).toBe(3)
    }),
  )

  it.live("a room at concurrency 3 dispatches THREE turns at once", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const room = yield* harness({
        title: "Wide",
        agentSlugs: ["alice", "bob", "carol"],
        concurrency: 3,
        reply: (input) => Deferred.await(gate).pipe(Effect.as({ text: `${input.agentSlug} done` })),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "go", mentions: ["alice", "bob", "carol"] })
      // Nothing has completed - the gate is shut - so three turns can only be
      // in flight if the drain dispatched them side by side. A serial room
      // times out here at one.
      yield* waitUntil(() => room.turns.length === 3, "the room never dispatched three turns at once")

      yield* Deferred.succeed(gate, undefined)
      yield* settle(room.runner)
      expect(agentTexts(yield* room.log()).sort()).toEqual(["alice done", "bob done", "carol done"])
    }),
  )

  it.live("clamps a width above the ceiling instead of refusing to run", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const room = yield* harness({
        title: "Clamped",
        agentSlugs: ["alice", "bob", "carol"],
        concurrency: 99,
        reply: () => Deferred.await(gate).pipe(Effect.as({ text: "done" })),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "go", mentions: ["alice", "bob", "carol"] })
      yield* waitUntil(() => room.turns.length === 3, "a clamped room still has to run its roster")
      yield* Deferred.succeed(gate, undefined)
      yield* settle(room.runner)
    }),
  )

  it.live("never gives ONE agent two turns at the same time", () =>
    Effect.gen(function* () {
      // The hazard parallel dispatch invents: an agent that is mid-turn AND
      // back in the queue because a colleague handed it the baton. A second
      // concurrent turn would run two prompts through one child session.
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const room = yield* harness({
        title: "NoDoubleTurn",
        agentSlugs: ["alice", "bob"],
        concurrency: 3,
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          if (input.agentSlug === "alice") {
            // alice holds her slot while bob's hand-off wakes her again.
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(gate)
            return { text: "alice done" }
          }
          yield* input.turn.ops.append({
            collabId: input.collabId,
            authorId: "bob",
            authorKind: "agent",
            kind: "handoff",
            text: "take it from here",
            mentions: ["alice"],
          })
          yield* input.turn.ops.handoff("alice")
          input.turn.stop.requested = true
          input.turn.stop.kind = "handoff"
          return { text: "" }
        }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "go", mentions: ["alice", "bob"] })
      yield* Deferred.await(started)
      yield* waitUntil(() => turnsOf(room.turns, "bob").length === 1, "bob never took its turn")
      yield* Effect.sleep("120 millis")
      expect(turnsOf(room.turns, "alice").length).toBe(1)

      yield* Deferred.succeed(gate, undefined)
      yield* settle(room.runner)
      // She still gets the turn the baton bought her - it was deferred, not
      // dropped - it just never overlapped the one she was already taking.
      expect(turnsOf(room.turns, "alice").length).toBe(2)
    }),
  )
})

describe("collab visibility under concurrency", () => {
  it.live("concurrent turns do not see what lands beside them, and get it on their next one", () =>
    Effect.gen(function* () {
      // THE RULE: a turn reads the room as it stood when it was DISPATCHED.
      //
      // The three turns are held at their READ, not at their reply. That is the
      // whole difference between this test and one that proves nothing: a line
      // written after the envelopes are already built is kept out by ordinary
      // sequencing, so parking at the reply would pass with the dispatch mark
      // deleted. Parking at the read puts the write INSIDE the window the rule
      // governs - claimed, not yet read - where the clamp is the only thing
      // that can keep it out.
      const atRead = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      let parked = 0
      const room = yield* harness({
        title: "Visibility",
        agentSlugs: ["alice", "bob", "carol"],
        concurrency: 3,
        onRead: () =>
          Effect.gen(function* () {
            parked += 1
            // Only the three turns of the first wave; every later read runs
            // free, so the room can still settle.
            if (parked > 3) return
            if (parked === 3) yield* Deferred.succeed(atRead, undefined)
            yield* Deferred.await(released)
          }),
        reply: (input) => Deferred.await(gate).pipe(Effect.as({ text: `${input.agentSlug} done` })),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "go", mentions: ["alice", "bob", "carol"] })
      yield* awaitWithTimeout(Deferred.await(atRead), "the room never dispatched three turns at once", "10 seconds")

      // Lands after all three were dispatched and before ANY of them has read.
      yield* room.runner.post({
        collabId: room.collab.id,
        text: "second post",
        mentions: ["alice", "bob", "carol"],
      })
      yield* Deferred.succeed(released, undefined)
      yield* waitUntil(() => room.turns.length === 3, "the parked turns never reached their reply")

      // Cut at the mark: no envelope carries a line written after its turn was
      // claimed, however late its own read landed.
      for (const slug of ["alice", "bob", "carol"]) {
        expect(turnsOf(room.turns, slug)[0]!.text).not.toContain("second post")
      }

      yield* Deferred.succeed(gate, undefined)
      yield* settle(room.runner)

      // ...and it arrives on their NEXT turn rather than being lost.
      for (const slug of ["alice", "bob", "carol"]) {
        const later = turnsOf(room.turns, slug).slice(1)
        expect(later.some((turn) => turn.text.includes("second post"))).toBe(true)
      }
    }),
  )

  it.live("cuts the envelope at the DISPATCH MARK, not at whenever the read lands", () =>
    Effect.gen(function* () {
      // The window the rule above would otherwise leave open: a turn is claimed
      // and its mark taken, and something is written to the room BEFORE the
      // turn's own read completes. Held open on purpose here; in a live room it
      // is however long the runtime takes to reschedule the fiber, which is
      // exactly the kind of "almost never" that is not a rule.
      const arrived = yield* Deferred.make<void>()
      const parked = yield* Deferred.make<void>()
      let reads = 0
      const room = yield* harness({
        title: "DispatchMark",
        agentSlugs: ["alice"],
        concurrency: 2,
        onRead: () =>
          Effect.gen(function* () {
            reads += 1
            if (reads !== 1) return
            yield* Deferred.succeed(arrived, undefined)
            yield* Deferred.await(parked)
          }),
        reply: (input) => Effect.succeed({ text: `${input.agentSlug} done` }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "go", mentions: ["alice"] })
      yield* awaitWithTimeout(Deferred.await(arrived), "alice's turn never reached its read", "10 seconds")

      // Lands after alice's turn was dispatched and before it read the log.
      yield* room.runner.post({ collabId: room.collab.id, text: "late line", mentions: ["alice"] })
      yield* Deferred.succeed(parked, undefined)
      yield* settle(room.runner)

      const taken = turnsOf(room.turns, "alice")
      expect(taken[0]!.text).not.toContain("late line")
      // Not dropped, just deferred: last-seen stopped at the mark too, so the
      // line is still above it and rides the next batch.
      expect(taken.slice(1).some((turn) => turn.text.includes("late line"))).toBe(true)
    }),
  )
})

describe("collab hop budget under concurrency", () => {
  it.live("spends EXACTLY the budget when more turns are dispatched than it can pay for", () =>
    Effect.gen(function* () {
      // Three agents dispatched side by side against a budget of TWO, and all
      // three parked between the hop gate and the hop charge before any of them
      // pays. Read-then-spend is not a budget in that window: three turns that
      // each read "2 left" and then each subtract one is the overshoot, and the
      // room runs a turn it could not afford.
      const inWindow = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let parked = 0
      const room = yield* harness({
        title: "BudgetRace",
        agentSlugs: ["alice", "bob", "carol"],
        concurrency: 3,
        cap: 2,
        onRead: () =>
          Effect.gen(function* () {
            parked += 1
            if (parked === 3) yield* Deferred.succeed(inWindow, undefined)
            yield* Deferred.await(release)
          }),
        reply: (input) => Effect.succeed({ text: `${input.agentSlug} done` }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "go", mentions: ["alice", "bob", "carol"] })
      yield* awaitWithTimeout(Deferred.await(inWindow), "three turns never reached the hop gate together", "10 seconds")
      yield* Deferred.succeed(release, undefined)
      yield* settle(room.runner)

      expect(room.turns.length).toBe(2)
      expect(yield* room.runner.hopState(room.collab.id)).toEqual({ remaining: 0, cap: 2 })
    }),
  )

  it.live("counts DISPATCHED turns for the room, whatever the width", () =>
    Effect.gen(function* () {
      // The same room, the same cap, run serially: the budget is a property of
      // the ROOM and a wider one must not buy more turns per human message.
      const room = yield* harness({
        title: "BudgetSerial",
        agentSlugs: ["alice", "bob", "carol"],
        cap: 2,
        reply: (input) => Effect.succeed({ text: `${input.agentSlug} done` }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "go", mentions: ["alice", "bob", "carol"] })
      yield* settle(room.runner)
      expect(room.turns.length).toBe(2)
    }),
  )
})

describe("collab per-agent stop under concurrency", () => {
  it.live("interrupts ONE of three running turns and leaves the other two alone", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const aborted: string[] = []
      const room = yield* harness({
        title: "StopOneWide",
        agentSlugs: ["alice", "bob", "carol"],
        concurrency: 3,
        aborted,
        reply: (input) => Deferred.await(gate).pipe(Effect.as({ text: `${input.agentSlug} done` })),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "go", mentions: ["alice", "bob", "carol"] })
      yield* waitUntil(() => room.turns.length === 3, "the room never dispatched three turns at once")

      expect(yield* room.runner.stopAgent(room.collab.id, "bob")).toEqual({ interrupted: true, dequeued: false })
      expect(aborted).toEqual(["ses_bob"])

      yield* Deferred.succeed(gate, undefined)
      yield* settle(room.runner)

      // bob said nothing; the room carried on without it, and the budget is
      // untouched by a per-agent stop exactly as it is when the room is serial.
      const texts = agentTexts(yield* room.log())
      expect(texts).toContain("alice done")
      expect(texts).toContain("carol done")
      expect(texts).not.toContain("bob done")
      expect((yield* room.runner.statuses(room.collab.id)).get("bob")).toEqual({ state: "idle" })
    }),
  )
})
