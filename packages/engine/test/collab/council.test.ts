import { describe, expect, test } from "bun:test"
import { CollabCouncil } from "@/collab/council"

/**
 * THE ROUND, as a pure state machine.
 *
 * Its own file, and its own leaf under test, for the same reason parallel.test.ts
 * exists beside runner-parallel.test.ts: the rules a round obeys - who
 * synthesises, when it may close, what a dead member does to it, and what the
 * record says afterwards - are decidable with no runner, no store and no fibers.
 * What the runner test below it proves is only the WIRING.
 */

describe("council flavor", () => {
  test("absent, null and anything unknown all read as DISCUSS", () => {
    // The safest reading of a value this build does not understand. A room
    // written by a newer shell must not silently start dispatching in parallel
    // on an older engine that cannot enforce the write gate.
    expect(CollabCouncil.flavorOf(undefined)).toBe("discuss")
    expect(CollabCouncil.flavorOf(null)).toBe("discuss")
    expect(CollabCouncil.flavorOf("")).toBe("discuss")
    expect(CollabCouncil.flavorOf("senate")).toBe("discuss")
    expect(CollabCouncil.flavorOf("discuss")).toBe("discuss")
  })

  test("council is the only value that turns it on", () => {
    expect(CollabCouncil.flavorOf("council")).toBe("council")
  })

  test("a council dispatches its opinions side by side, a discuss room does not", () => {
    // The width is not a second setting the human has to find: a council whose
    // members answered one at a time would be the anchored room the whole
    // feature exists to replace.
    expect(CollabCouncil.dispatchWidth("council")).toBeGreaterThan(1)
    expect(CollabCouncil.dispatchWidth("discuss")).toBe(1)
    expect(CollabCouncil.dispatchWidth(null)).toBe(1)
  })
})

describe("council synthesizer", () => {
  test("the LEAD synthesises when it is still in the room", () => {
    expect(CollabCouncil.pickSynthesizer(["crane", "heron", "ibis"], "heron")).toBe("heron")
  })

  test("a leadless room picks the FIRST member, deterministically", () => {
    // Roster order, which is the order the human already sees in the room.
    // Deterministic matters more than which one: two engines reading the same
    // room must name the same synthesizer, or the record disagrees with itself.
    expect(CollabCouncil.pickSynthesizer(["crane", "heron", "ibis"], null)).toBe("crane")
    expect(CollabCouncil.pickSynthesizer(["crane", "heron", "ibis"], null)).toBe("crane")
  })

  test("a lead that has LEFT does not get to synthesise", () => {
    expect(CollabCouncil.pickSynthesizer(["crane", "ibis"], "heron")).toBe("crane")
  })

  test("no members, no synthesizer", () => {
    expect(CollabCouncil.pickSynthesizer([], "heron")).toBeUndefined()
  })
})

describe("council rounds", () => {
  const rounds = () => CollabCouncil.makeRegistry()

  test("an opinion turn is cut at the round's ceiling, whenever it is claimed", () => {
    const registry = rounds()
    registry.open({ collabId: "c1", ceiling: 7, members: ["crane", "heron", "ibis"], synthesizer: "crane" })
    // THE BLIND WINDOW. Every member of the round reads the same cut - not the
    // cut as it stood when each was claimed - so the fourth member of a
    // four-wide council still cannot see the first one's answer.
    for (const slug of ["crane", "heron", "ibis"]) {
      expect(registry.dispatchFor("c1", slug)).toMatchObject({ phase: "opinion", ceiling: 7 })
    }
  })

  test("an agent that is not in the round gets no round dispatch at all", () => {
    const registry = rounds()
    registry.open({ collabId: "c1", ceiling: 7, members: ["crane"], synthesizer: "crane" })
    expect(registry.dispatchFor("c1", "heron")).toBeUndefined()
    expect(registry.dispatchFor("c2", "crane")).toBeUndefined()
  })

  test("the round does NOT close until every member has settled", () => {
    const registry = rounds()
    const round = registry.open({
      collabId: "c1",
      ceiling: 7,
      members: ["crane", "heron", "ibis"],
      synthesizer: "crane",
    })!
    registry.settle("c1", { roundId: round.id, phase: "opinion" }, "crane", "answered")
    expect(registry.takeClosed("c1")).toBeUndefined()
    registry.settle("c1", { roundId: round.id, phase: "opinion" }, "heron", "answered")
    expect(registry.takeClosed("c1")).toBeUndefined()
    registry.settle("c1", { roundId: round.id, phase: "opinion" }, "ibis", "answered")
    expect(registry.takeClosed("c1")).toBeDefined()
  })

  test("a member that FAILED or was STOPPED closes the round rather than hanging it", () => {
    // FAILURE HONESTY, half one: a dead member cannot hold the council open.
    const registry = rounds()
    const round = registry.open({
      collabId: "c1",
      ceiling: 7,
      members: ["crane", "heron", "ibis"],
      synthesizer: "crane",
    })!
    const dispatch = { roundId: round.id, phase: "opinion" as const }
    registry.settle("c1", dispatch, "crane", "answered")
    registry.settle("c1", dispatch, "heron", "failed")
    registry.settle("c1", dispatch, "ibis", "stopped")
    expect(registry.takeClosed("c1")).toBeDefined()
  })

  test("the closed round is taken exactly ONCE", () => {
    // Two workers can settle the last two members at the same instant; the
    // close (a summary row and a synthesis turn) must happen for one of them.
    const registry = rounds()
    const round = registry.open({ collabId: "c1", ceiling: 7, members: ["crane"], synthesizer: "crane" })!
    registry.settle("c1", { roundId: round.id, phase: "opinion" }, "crane", "answered")
    expect(registry.takeClosed("c1")).toBeDefined()
    expect(registry.takeClosed("c1")).toBeUndefined()
  })

  test("after the close the SYNTHESIZER reads the whole room, and nobody else has a turn", () => {
    const registry = rounds()
    const round = registry.open({
      collabId: "c1",
      ceiling: 7,
      members: ["crane", "heron"],
      synthesizer: "heron",
    })!
    const dispatch = { roundId: round.id, phase: "opinion" as const }
    registry.settle("c1", dispatch, "crane", "answered")
    registry.settle("c1", dispatch, "heron", "answered")
    registry.takeClosed("c1")
    // No ceiling: the synthesis is the one turn that is MEANT to read every
    // opinion, and clamping it would defeat the round it is closing.
    expect(registry.dispatchFor("c1", "heron")).toEqual({ roundId: round.id, phase: "synthesis" })
    expect(registry.dispatchFor("c1", "crane")).toBeUndefined()
  })

  test("the round is gone once its synthesis has run", () => {
    const registry = rounds()
    const round = registry.open({ collabId: "c1", ceiling: 7, members: ["crane"], synthesizer: "crane" })!
    registry.settle("c1", { roundId: round.id, phase: "opinion" }, "crane", "answered")
    registry.takeClosed("c1")
    registry.settle("c1", { roundId: round.id, phase: "synthesis" }, "crane", "answered")
    expect(registry.get("c1")).toBeUndefined()
    expect(registry.dispatchFor("c1", "crane")).toBeUndefined()
  })

  test("abandoning answers only a round whose record was never written", () => {
    const registry = rounds()
    const open = registry.open({ collabId: "c1", ceiling: 7, members: ["crane", "heron"], synthesizer: "crane" })!
    // Still mid-round: there is something to report, so the caller gets it.
    registry.settle("c1", { roundId: open.id, phase: "opinion" }, "crane", "answered")
    expect(registry.abandon("c1")).toBeDefined()

    // ...but a round whose summary has already been taken is FINISHED, not
    // abandoned. It is only still here because its synthesis is running, which
    // is exactly the state a follow-up round opens in - and answering here
    // would put a second n-of-m line in the room for one council.
    const done = registry.open({ collabId: "c1", ceiling: 9, members: ["crane"], synthesizer: "crane" })!
    registry.settle("c1", { roundId: done.id, phase: "opinion" }, "crane", "answered")
    expect(registry.takeClosed("c1")).toBeDefined()
    expect(registry.abandon("c1")).toBeUndefined()
    expect(registry.get("c1")).toBeUndefined()
  })

  test("a settle from a SUPERSEDED round never touches the live one", () => {
    // A human who re-asks mid-round abandons the old round. Its turns are still
    // in flight, and their late settles must not close - or corrupt the count
    // of - the round that replaced it.
    const registry = rounds()
    const first = registry.open({ collabId: "c1", ceiling: 7, members: ["crane", "heron"], synthesizer: "crane" })!
    const second = registry.open({ collabId: "c1", ceiling: 9, members: ["crane", "heron"], synthesizer: "crane" })!
    expect(second.id).not.toBe(first.id)
    registry.settle("c1", { roundId: first.id, phase: "opinion" }, "crane", "answered")
    registry.settle("c1", { roundId: first.id, phase: "opinion" }, "heron", "answered")
    expect(registry.takeClosed("c1")).toBeUndefined()
  })

  test("the FIRST outcome for a member is the one that counts", () => {
    const registry = rounds()
    const round = registry.open({ collabId: "c1", ceiling: 7, members: ["crane"], synthesizer: "crane" })!
    const dispatch = { roundId: round.id, phase: "opinion" as const }
    registry.settle("c1", dispatch, "crane", "answered")
    // The worker settles every turn it joins, including one whose reply already
    // landed. "answered then silent" is one turn, not two.
    registry.settle("c1", dispatch, "crane", "silent")
    expect(registry.takeClosed("c1")!.settled.get("crane")).toBe("answered")
  })
})

describe("council round summary", () => {
  const closed = (outcomes: ReadonlyArray<readonly [string, CollabCouncil.Outcome]>) => {
    const registry = CollabCouncil.makeRegistry()
    const round = registry.open({
      collabId: "c1",
      ceiling: 7,
      members: outcomes.map(([slug]) => slug),
      synthesizer: outcomes[0]![0],
    })!
    for (const [slug, outcome] of outcomes) {
      registry.settle("c1", { roundId: round.id, phase: "opinion" }, slug, outcome)
    }
    return registry.takeClosed("c1")!
  }

  test("a whole council reads as n of n, with nothing else to report", () => {
    const summary = CollabCouncil.roundSummary(
      closed([
        ["crane", "answered"],
        ["heron", "answered"],
        ["ibis", "answered"],
      ]),
      (slug) => slug,
    )
    expect(summary).toBe("Council round: 3 of 3 answered.")
  })

  test("a member that failed is NAMED, never quietly missing", () => {
    // FAILURE HONESTY, half two. "2 of 3" alone tells the reader a member is
    // absent; it does not tell them which, or that it broke rather than passed.
    const summary = CollabCouncil.roundSummary(
      closed([
        ["crane", "answered"],
        ["heron", "failed"],
        ["ibis", "answered"],
      ]),
      (slug) => slug,
    )
    expect(summary).toContain("2 of 3 answered")
    expect(summary).toContain("heron")
    expect(summary).toContain("failed")
  })

  test("silence, a stop and a failure are three different things and read as three", () => {
    const summary = CollabCouncil.roundSummary(
      closed([
        ["crane", "silent"],
        ["heron", "stopped"],
        ["ibis", "failed"],
      ]),
      (slug) => slug,
    )
    expect(summary).toContain("0 of 3 answered")
    expect(summary).toContain("crane had nothing to add")
    expect(summary).toContain("heron was stopped")
    expect(summary).toContain("ibis failed")
  })

  test("the summary uses the DISPLAY name the room shows", () => {
    const summary = CollabCouncil.roundSummary(
      closed([
        ["crane", "answered"],
        ["heron", "stopped"],
      ]),
      (slug) => (slug === "heron" ? "Heron the Sceptic" : slug),
    )
    expect(summary).toContain("Heron the Sceptic was stopped")
  })
})

describe("council round openers", () => {
  test("an unaddressed human message opens a round in a council and nothing in a discuss room", () => {
    expect(CollabCouncil.opensRound("council", { authorKind: "human", kind: "say" })).toBe(true)
    expect(CollabCouncil.opensRound("discuss", { authorKind: "human", kind: "say" })).toBe(false)
  })

  test("the synthesizer's FOLLOW-UP question opens the next round", () => {
    expect(CollabCouncil.opensRound("council", { authorKind: "agent", kind: "council_question" })).toBe(true)
  })

  test("nothing else in the log opens one", () => {
    // An opinion must never open a round: a council whose answers re-asked the
    // question would never stop, and the hop budget counts ROUNDS.
    for (const kind of ["opinion", "synthesis", "round", "answer", "handoff", "task_done"] as const) {
      expect(CollabCouncil.opensRound("council", { authorKind: "agent", kind })).toBe(false)
    }
    expect(CollabCouncil.opensRound("council", { authorKind: "agent", kind: "say" })).toBe(false)
  })
})
