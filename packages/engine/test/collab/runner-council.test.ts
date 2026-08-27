import { describe, expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { awaitWithTimeout, testEffect } from "../lib/effect"

/**
 * COUNCIL MODE — the room as a DELIBERATION, end to end.
 *
 * Its own file for the reason runner-parallel.test.ts is: the first success
 * criterion of this wave is that a DISCUSS room is bit-identical, and the way
 * that is proven is runner.test.ts passing verbatim. Everything the flavor
 * changes is proven here.
 *
 * The assertions are on the ENVELOPES the turns were actually given, not on the
 * transcript afterwards. A test that only read the log could not tell an
 * independent opinion from one that copied its neighbour's - which is the whole
 * quality claim the mode makes.
 */

const it = testEffect(LayerNode.compile(LayerNode.group([CollabStore.node])))

type Reply = (input: CollabRunner.TurnInput) => Effect.Effect<CollabRunner.TurnOutcome, unknown>

const harness = (options: {
  title: string
  agentSlugs: readonly string[]
  reply: Reply
  /** null (the default) leaves the room a DISCUSS room, exactly as it ships. */
  flavor?: string | null
  lead?: string | null
  cap?: number | null
  aborted?: string[]
}) =>
  Effect.gen(function* () {
    const store = yield* CollabStore.Service
    const collab = yield* store.create({ title: options.title, agentSlugs: options.agentSlugs })
    if (options.flavor !== undefined) yield* store.setFlavor(collab.id, options.flavor)
    if (options.lead !== undefined) yield* store.setLead(collab.id, options.lead)
    if (options.cap !== undefined) yield* store.setCap(collab.id, options.cap)
    const turns: CollabRunner.TurnInput[] = []
    const runner = yield* CollabRunner.make({
      store,
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

const settle = (runner: CollabRunner.Interface) =>
  awaitWithTimeout(runner.settle, "the collab did not settle", "10 seconds")

const turnsOf = (turns: readonly CollabRunner.TurnInput[], slug: string) =>
  turns.filter((turn) => turn.agentSlug === slug)

const kinds = (messages: readonly CollabStore.Message[], kind: CollabStore.MessageKind) =>
  messages.filter((message) => message.kind === kind)

/** Three members, each answering with something the others could recognise. */
const OPINION: Record<string, string> = {
  crane: "crane says rewrite it",
  heron: "heron says keep it",
  ibis: "ibis says measure first",
}

/** What a synthesis says, so it is unmistakable in the log. */
const DECISION = "the decision"

/**
 * A council member's reply: its OPINION on its first turn of the room, and the
 * reconciliation on any turn after that.
 *
 * Counted here rather than read back off the room being built, because a reply
 * that reached into that room is a cycle TypeScript cannot infer a type
 * through - and `bun test` transpiles without typechecking, so such a test
 * passes green and fails the build.
 */
const council = (opinion: (agentSlug: string) => Effect.Effect<CollabRunner.TurnOutcome, unknown>): Reply => {
  const taken = new Map<string, number>()
  return (input) => {
    const nth = (taken.get(input.agentSlug) ?? 0) + 1
    taken.set(input.agentSlug, nth)
    return nth === 1 ? opinion(input.agentSlug) : Effect.succeed({ text: DECISION })
  }
}

/** The plain case: every member speaks its own line, then reconciles. */
const speaks = (line: (agentSlug: string) => string): Reply =>
  council((agentSlug) => Effect.succeed({ text: line(agentSlug) }))

describe("council rounds", () => {
  it.live("dispatches ONE question to every member, and none of them reads a sibling", () =>
    Effect.gen(function* () {
      // THE POINT OF THE MODE. Three opinions are taken from the same cut of the
      // room, so no envelope can contain another member's answer. A chain room
      // fails this on the second turn.
      const room = yield* harness({
        title: "Council",
        agentSlugs: ["crane", "heron", "ibis"],
        flavor: "council",
        lead: "crane",
        reply: (input) => Effect.succeed({ text: OPINION[input.agentSlug] ?? "" }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "should we rewrite the parser?" })
      yield* settle(room.runner)

      for (const slug of ["crane", "heron", "ibis"]) {
        const opinion = turnsOf(room.turns, slug)[0]
        expect(opinion, `${slug} was never asked`).toBeDefined()
        expect(opinion!.text).toContain("should we rewrite the parser?")
        for (const other of ["crane", "heron", "ibis"]) {
          if (other === slug) continue
          expect(opinion!.text, `${slug} read ${other}'s opinion`).not.toContain(OPINION[other]!)
        }
      }
    }),
  )

  it.live("keeps the LAST member blind even when the council is wider than the scheduler", () =>
    Effect.gen(function* () {
      // THE TEST THE ROUND CEILING EXISTS FOR, and the one a per-dispatch mark
      // cannot pass.
      //
      // Five members against a scheduler four wide: the fifth is not claimed
      // until one of the first four has finished, so the room's newest seq at
      // ITS dispatch already carries an answer. A mark taken when a turn is
      // claimed - which is exactly what an ordinary wide room uses - would hand
      // that answer to the fifth member and anchor it. The round's ceiling is
      // the question's seq for every member however late it is claimed, which
      // is the whole quality claim of the mode.
      const started = yield* Deferred.make<void>()
      const held = yield* Deferred.make<void>()
      const slugs = ["crane", "heron", "ibis", "jay", "kite"]
      let answered = 0
      const room = yield* harness({
        title: "WiderThanTheScheduler",
        agentSlugs: slugs,
        flavor: "council",
        lead: "crane",
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          // The first four hold until one is released, so the fifth can only be
          // claimed after an opinion is already in the log.
          if (answered === 0 && input.agentSlug === "crane") {
            yield* Deferred.succeed(started, undefined)
            answered += 1
            return { text: "crane says rewrite it" }
          }
          yield* Deferred.await(held)
          return { text: `${input.agentSlug} spoke` }
        }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "should we rewrite the parser?" })
      yield* awaitWithTimeout(Deferred.await(started), "the council never started", "10 seconds")
      yield* waitUntil(() => room.turns.length === 5, "the fifth member was never dispatched")

      const last = turnsOf(room.turns, "kite")[0]!
      expect(last.text).toContain("should we rewrite the parser?")
      expect(last.text, "the fifth member read an opinion from its own round").not.toContain("crane says rewrite it")

      yield* Deferred.succeed(held, undefined)
      yield* settle(room.runner)
      expect(kinds(yield* room.log(), "round")[0]!.text).toContain("5 of 5 answered")
    }),
  )

  it.live("an unaddressed question reaches the whole council, not the lead alone", () =>
    Effect.gen(function* () {
      const room = yield* harness({
        title: "Everyone",
        agentSlugs: ["crane", "heron", "ibis"],
        flavor: "council",
        lead: "crane",
        reply: (input) => Effect.succeed({ text: `${input.agentSlug} spoke` }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "go" })
      yield* settle(room.runner)
      expect(
        kinds(yield* room.log(), "opinion")
          .map((message) => message.authorId)
          .sort(),
      ).toEqual(["crane", "heron", "ibis"])
    }),
  )

  it.live("an ADDRESSED question still narrows the council to the members named", () =>
    Effect.gen(function* () {
      // The escape hatch: naming members is how a human asks two of five.
      const room = yield* harness({
        title: "Narrowed",
        agentSlugs: ["crane", "heron", "ibis"],
        flavor: "council",
        lead: "crane",
        reply: (input) => Effect.succeed({ text: `${input.agentSlug} spoke` }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "you two", mentions: ["heron", "ibis"] })
      yield* settle(room.runner)
      const log = yield* room.log()
      expect(
        kinds(log, "opinion")
          .map((message) => message.authorId)
          .sort(),
      ).toEqual(["heron", "ibis"])
      // ...and the synthesizer is one of the two asked, not the absent lead.
      expect(kinds(log, "synthesis").map((message) => message.authorId)).toEqual(["heron"])
    }),
  )

  it.live("the round closes ONLY when every opinion has settled", () =>
    Effect.gen(function* () {
      // The synthesis must not run over a partial council. ibis is held; the
      // round is not allowed to close, and no synthesis may be dispatched,
      // until it lets go.
      const held = yield* Deferred.make<void>()
      const room = yield* harness({
        title: "WaitForAll",
        agentSlugs: ["crane", "heron", "ibis"],
        flavor: "council",
        lead: "crane",
        reply: (input) =>
          input.agentSlug === "ibis"
            ? Deferred.await(held).pipe(Effect.as({ text: OPINION["ibis"]! }))
            : Effect.succeed({ text: OPINION[input.agentSlug] ?? "" }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "question" })
      yield* waitUntil(() => turnsOf(room.turns, "ibis").length === 1, "ibis never took its turn")
      yield* waitUntil(
        () => turnsOf(room.turns, "crane").length === 1 && turnsOf(room.turns, "heron").length === 1,
        "the other two never answered",
      )

      // Long enough for a close to have happened if the round were going to
      // close on the members that HAVE answered.
      yield* Effect.sleep("120 millis")
      expect(kinds(yield* room.log(), "round")).toHaveLength(0)
      expect(turnsOf(room.turns, "crane")).toHaveLength(1)

      yield* Deferred.succeed(held, undefined)
      yield* settle(room.runner)
      expect(kinds(yield* room.log(), "round")).toHaveLength(1)
    }),
  )

  it.live("the SYNTHESIS reads every opinion of the round", () =>
    Effect.gen(function* () {
      const room = yield* harness({
        title: "Synthesis",
        agentSlugs: ["crane", "heron", "ibis"],
        flavor: "council",
        lead: "crane",
        reply: speaks((agentSlug) => OPINION[agentSlug]!),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "question" })
      yield* settle(room.runner)

      // The lead takes two turns: its own opinion, then the reconciliation.
      const taken = turnsOf(room.turns, "crane")
      expect(taken).toHaveLength(2)
      const synthesis = taken[1]!
      for (const slug of ["crane", "heron", "ibis"]) {
        expect(synthesis.text, `the synthesis never saw ${slug}`).toContain(OPINION[slug]!)
      }
      expect(kinds(yield* room.log(), "synthesis").map((message) => message.text)).toEqual([DECISION])
    }),
  )

  it.live("a leadless council still synthesises, deterministically", () =>
    Effect.gen(function* () {
      const room = yield* harness({
        title: "Leadless",
        agentSlugs: ["crane", "heron"],
        flavor: "council",
        lead: null,
        reply: speaks((agentSlug) => `${agentSlug} spoke`),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "question" })
      yield* settle(room.runner)
      expect(kinds(yield* room.log(), "synthesis").map((message) => message.authorId)).toEqual(["crane"])
    }),
  )
})

describe("council failure honesty", () => {
  it.live("a STOPPED member is reported in the round, never silently absent", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const aborted: string[] = []
      const room = yield* harness({
        title: "StoppedMember",
        agentSlugs: ["crane", "heron", "ibis"],
        flavor: "council",
        lead: "crane",
        aborted,
        reply: council((agentSlug) => Deferred.await(gate).pipe(Effect.as({ text: OPINION[agentSlug] ?? "" }))),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "question" })
      yield* waitUntil(() => room.turns.length === 3, "the council never dispatched three opinions at once")

      expect(yield* room.runner.stopAgent(room.collab.id, "heron")).toEqual({ interrupted: true, dequeued: false })
      yield* Deferred.succeed(gate, undefined)
      yield* settle(room.runner)

      const summary = kinds(yield* room.log(), "round")
      expect(summary).toHaveLength(1)
      expect(summary[0]!.text).toContain("2 of 3 answered")
      expect(summary[0]!.text).toContain("heron was stopped")
      // ...and the council still reached a decision rather than hanging on it.
      expect(kinds(yield* room.log(), "synthesis")).toHaveLength(1)
    }),
  )

  it.live("a FAILED member is named, and does not take the round down with it", () =>
    Effect.gen(function* () {
      const room = yield* harness({
        title: "FailedMember",
        agentSlugs: ["crane", "heron", "ibis"],
        flavor: "council",
        lead: "crane",
        reply: council((agentSlug) =>
          agentSlug === "ibis"
            ? Effect.fail(new Error("provider exploded"))
            : Effect.succeed({ text: OPINION[agentSlug]! }),
        ),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "question" })
      yield* settle(room.runner)

      const summary = kinds(yield* room.log(), "round")[0]
      expect(summary?.text).toContain("2 of 3 answered")
      expect(summary?.text).toContain("ibis failed")
      expect(kinds(yield* room.log(), "synthesis")).toHaveLength(1)
    }),
  )

  it.live("a member that chose SILENCE reads as silence, not as a failure", () =>
    Effect.gen(function* () {
      const room = yield* harness({
        title: "SilentMember",
        agentSlugs: ["crane", "heron", "ibis"],
        flavor: "council",
        lead: "crane",
        reply: speaks((agentSlug) => (agentSlug === "ibis" ? "" : OPINION[agentSlug]!)),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "question" })
      yield* settle(room.runner)
      const summary = kinds(yield* room.log(), "round")[0]
      expect(summary?.text).toContain("2 of 3 answered")
      expect(summary?.text).toContain("ibis had nothing to add")
      expect(summary?.text).not.toContain("ibis failed")
    }),
  )

  it.live("stopping the ROOM records how far the round got and dispatches no synthesis", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const room = yield* harness({
        title: "StoppedRoom",
        agentSlugs: ["crane", "heron", "ibis"],
        flavor: "council",
        lead: "crane",
        aborted: [],
        reply: () => Deferred.await(gate).pipe(Effect.as({ text: "spoke" })),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "question" })
      yield* waitUntil(() => room.turns.length === 3, "the council never dispatched three opinions at once")

      yield* room.runner.stop(room.collab.id)
      yield* Deferred.succeed(gate, undefined)
      yield* settle(room.runner)

      const log = yield* room.log()
      const summary = kinds(log, "round")
      expect(summary).toHaveLength(1)
      expect(summary[0]!.text).toContain("0 of 3 answered")
      // A stopped room is quiet. The record says where it got to; nobody speaks.
      expect(kinds(log, "synthesis")).toHaveLength(0)
    }),
  )
})

describe("council budget", () => {
  it.live("one ROUND costs one hop, however many members answer", () =>
    Effect.gen(function* () {
      // The unit of autonomy in a council is the round. Charging per turn would
      // let a budget of 2 fund two opinions of a three-member council and then
      // synthesise over a truncated room.
      const room = yield* harness({
        title: "RoundBudget",
        agentSlugs: ["crane", "heron", "ibis"],
        flavor: "council",
        lead: "crane",
        cap: 3,
        reply: speaks((agentSlug) => OPINION[agentSlug]!),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "question" })
      yield* settle(room.runner)

      // Three opinions plus a synthesis ran; the budget moved by ONE.
      expect(room.turns).toHaveLength(4)
      expect(yield* room.runner.hopState(room.collab.id)).toEqual({ remaining: 2, cap: 3 })
      expect(kinds(yield* room.log(), "opinion")).toHaveLength(3)
    }),
  )

  it.live("a spent budget opens no round at all", () =>
    Effect.gen(function* () {
      const room = yield* harness({
        title: "NoBudget",
        agentSlugs: ["crane", "heron"],
        flavor: "council",
        lead: "crane",
        cap: 1,
        reply: speaks((agentSlug) => `${agentSlug} spoke`),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "first" })
      yield* settle(room.runner)
      const after = room.turns.length
      expect(yield* room.runner.hopState(room.collab.id)).toEqual({ remaining: 0, cap: 1 })

      // A follow-up from an AGENT would find nothing to spend. A human post
      // buys a fresh budget, which is the rule every room already follows.
      yield* room.runner.post({ collabId: room.collab.id, text: "second" })
      yield* settle(room.runner)
      expect(room.turns.length).toBeGreaterThan(after)
    }),
  )
})

describe("council follow-up rounds", () => {
  it.live("a synthesis that puts a question back to the council opens a SECOND blind round", () =>
    Effect.gen(function* () {
      // The `council_ask` tool's own gates are proven in flock-tools.test.ts.
      // What is proven here is the half that tool cannot reach: a
      // `council_question` in the log is a NEW round - dispatched to everyone,
      // blind again, and charged one more hop.
      const asked = new Map<string, number>()
      const room = yield* harness({
        title: "SecondRound",
        agentSlugs: ["crane", "heron", "ibis"],
        flavor: "council",
        lead: "crane",
        cap: 4,
        reply: Effect.fnUntraced(function* (input: CollabRunner.TurnInput) {
          const nth = (asked.get(input.agentSlug) ?? 0) + 1
          asked.set(input.agentSlug, nth)
          // crane's second turn is the synthesis of round one. It asks again,
          // exactly as the tool does.
          if (input.agentSlug === "crane" && nth === 2) {
            yield* input.turn.ops.append({
              collabId: input.collabId,
              authorId: "crane",
              authorKind: "agent",
              kind: "council_question",
              text: "and what would it cost?",
            })
            return { text: "undecided - asking again" }
          }
          return { text: `${input.agentSlug} turn ${nth}` }
        }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "should we rewrite the parser?" })
      yield* settle(room.runner)

      const log = yield* room.log()
      // Two rounds ran, each with its own record.
      expect(kinds(log, "round")).toHaveLength(2)
      const followUp = kinds(log, "council_question")
      expect(followUp).toHaveLength(1)

      // ROUND TWO IS BLIND TOO: heron answers the follow-up without reading
      // ibis's answer to it, because the round's ceiling is the question rather
      // than each turn's own dispatch...
      const second = turnsOf(room.turns, "heron").find((turn) => turn.text.includes("and what would it cost?"))
      expect(second, "heron never got the follow-up").toBeDefined()
      expect(second!.text, "heron read a sibling's answer to the SAME question").not.toContain("ibis turn 2")
      // ...and the round it can see is the one that CLOSED. Blind means blind
      // to the round in flight, not to the record: a council that could not
      // read its own last round would restate it every time.
      expect(second!.text).toContain("ibis turn 1")
      expect(second!.text).toContain("Council round: 3 of 3 answered")

      // ...and the asker is NOT woken by its own question: SELF takes it out,
      // so crane's next turn is the second synthesis, not a second opinion.
      const craneOpinions = kinds(log, "opinion").filter((message) => message.authorId === "crane")
      expect(craneOpinions).toHaveLength(1)

      // TWO ROUNDS, TWO HOPS. The budget bounds a council in rounds, so a room
      // that asked itself questions forever would still come back to a human.
      expect(yield* room.runner.hopState(room.collab.id)).toEqual({ remaining: 2, cap: 4 })
    }),
  )
})

describe("the round seal", () => {
  it.live("marks every OPINION and the SYNTHESIS as a turn to run read-only", () =>
    Effect.gen(function* () {
      // The flag the layer acts on: it is what makes a WORKER's child session
      // lose `edit` and `bash` for the length of a round turn, and it is the
      // reason `collab_set_flavor` no longer has to refuse a room of workers.
      const room = yield* harness({
        title: "Sealed",
        agentSlugs: ["crane", "heron"],
        flavor: "council",
        lead: "crane",
        reply: speaks((agentSlug) => `${agentSlug} spoke`),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "what do you think?" })
      yield* settle(room.runner)

      expect(room.turns.length).toBeGreaterThanOrEqual(3)
      for (const turn of room.turns) expect(turn.sealed, `${turn.agentSlug} ran unsealed`).toBe(true)
    }),
  )

  it.live("leaves a DISCUSS turn of the same room unsealed", () =>
    Effect.gen(function* () {
      // The other half of the ruling: a member with `edit` keeps it in the
      // room's ordinary conversation. A seal that outlived the round would take
      // a bot's tools away for good the first time anyone tried council mode.
      const room = yield* harness({
        title: "BackToDiscuss",
        agentSlugs: ["crane", "heron"],
        flavor: "council",
        lead: "crane",
        reply: speaks((agentSlug) => `${agentSlug} spoke`),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "what do you think?" })
      yield* settle(room.runner)
      const round = room.turns.length

      yield* room.store.setFlavor(room.collab.id, "discuss")
      yield* room.runner.post({ collabId: room.collab.id, text: "@crane now go and do it" })
      yield* settle(room.runner)

      const after = room.turns.slice(round)
      expect(after.length).toBeGreaterThan(0)
      for (const turn of after) expect(turn.sealed, `${turn.agentSlug} was sealed outside a round`).toBeUndefined()
    }),
  )

  it.live("carries the seal into an ASK made from inside a round turn", () =>
    Effect.gen(function* () {
      // The way around it, closed. An opinion turn holds the `ask` tool, so a
      // sealed member that could hand the work to an unsealed peer would have
      // put a writer back into a parallel round through one tool call.
      const asked: string[] = []
      const room = yield* harness({
        title: "AskFromRound",
        agentSlugs: ["crane", "heron"],
        flavor: "council",
        lead: "crane",
        reply: (input) =>
          Effect.gen(function* () {
            if (input.agentSlug !== "crane" || asked.length > 0) return { text: `${input.agentSlug} spoke` }
            asked.push(input.agentSlug)
            yield* input.turn.ops.ask({
              target: "heron",
              sessionId: yield* input.turn.ops.session("heron"),
              from: "crane",
              task: "check the parser",
              askChain: [],
              hops: input.turn.hops,
            })
            return { text: "crane spoke" }
          }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "what do you think?" })
      yield* settle(room.runner)

      expect(asked).toHaveLength(1)
      for (const turn of room.turns) expect(turn.sealed, `${turn.agentSlug} ran unsealed`).toBe(true)
    }),
  )
})

describe("discuss rooms are untouched", () => {
  it.live("a room with no flavor still routes an unaddressed message to the lead alone", () =>
    Effect.gen(function* () {
      const room = yield* harness({
        title: "Discuss",
        agentSlugs: ["crane", "heron", "ibis"],
        lead: "crane",
        reply: (input) => Effect.succeed({ text: `${input.agentSlug} spoke` }),
      })
      yield* room.runner.post({ collabId: room.collab.id, text: "go" })
      yield* settle(room.runner)
      const log = yield* room.log()
      expect(log.filter((message) => message.authorKind === "agent").map((message) => message.authorId)).toEqual([
        "crane",
      ])
      // No round machinery ran: no opinions, no summary, no synthesis.
      expect(kinds(log, "opinion")).toHaveLength(0)
      expect(kinds(log, "round")).toHaveLength(0)
      expect(kinds(log, "synthesis")).toHaveLength(0)
      expect(log.filter((message) => message.kind === "say" && message.authorKind === "agent")).toHaveLength(1)
    }),
  )
})
