import { describe, expect, it } from "bun:test"
import { CollabState } from "@/collab/collab-state"

/**
 * The room STATE block: facts only, built fresh per turn, never overridable.
 *
 * There is deliberately no file behind it and no override seam to test - the
 * prose that used to sit above it (`collab-base.md`) is gone, and the base
 * prompt is now the one place the room's rules are written down.
 */

const roster = [
  { agentSlug: "collab-crane", displayName: "Crane" },
  { agentSlug: "collab-heron", displayName: "Heron" },
]

const block = (over: Partial<Parameters<typeof CollabState.roomState>[0]> = {}) =>
  CollabState.roomState({
    agentSlug: "collab-crane",
    displayName: "Crane",
    title: "Ship it",
    roster,
    lead: null,
    objective: null,
    hops: { remaining: 6 },
    tasks: [],
    ...over,
  })

describe("collab room state", () => {
  it("names the agent, the collab and every active member", () => {
    expect(block()).toContain('You are @collab-crane ("Crane"). Collab: "Ship it". Roster:')
    expect(block()).toContain("- @collab-heron: Heron")
  })

  it("marks which roster line is the reader", () => {
    // Without this an agent cannot tell its own handle from the others' and
    // @mentions itself, which costs a turn and terminates nothing.
    expect(block()).toContain("- @collab-crane: Crane (you)")
    expect(block()).toContain("- @collab-heron: Heron\n")
    expect(block({ agentSlug: "collab-heron", displayName: "Heron" })).toContain("- @collab-heron: Heron (you)")
  })

  it("names the lead, so unaddressed human messages have a known destination", () => {
    expect(block({ lead: "collab-heron" })).toContain(
      "@collab-heron leads this room - unaddressed human messages go to them.",
    )
  })

  it("says plainly when no lead is set", () => {
    expect(block({ lead: null })).toContain("No lead is set for this room.")
  })

  it("states the objective verbatim when the room has one", () => {
    expect(block({ objective: "cut the release" })).toContain("Objective: cut the release")
  })

  it("says nothing about an objective when none is set", () => {
    expect(block({ objective: null })).not.toContain("Objective:")
  })

  it("reports the hop budget as wakes left on the current human request", () => {
    expect(block({ hops: { remaining: 4 } })).toContain("This room has 4 wakes left on the current human request.")
  })

  it("uses the singular for exactly one wake left", () => {
    expect(block({ hops: { remaining: 1 } })).toContain("This room has 1 wake left on the current human request.")
  })

  it("says the budget is off rather than inventing a countdown when it is", () => {
    const text = block({ hops: { remaining: null } })
    expect(text).toContain("The hop budget is off - it runs until stopped.")
    expect(text).not.toContain("wakes left")
  })

  it("lists open and claimed tasks with their owners", () => {
    const text = block({
      tasks: [
        { id: "clbt_one", title: "fix the flaky test", state: "open", owner: null },
        { id: "clbt_two", title: "ship the release", state: "claimed", owner: "collab-heron" },
      ],
    })
    expect(text).toContain("Task board")
    expect(text).toContain("clbt_one [open] fix the flaky test")
    expect(text).toContain("clbt_two [claimed] ship the release (@collab-heron)")
  })

  // THE W8 UAT BUG. Every board tool - task_claim, task_done, task_accept,
  // task_reopen - takes a `taskId`, and this block was the only place an agent
  // could learn one. It printed the title, the state and the owner and NOT the
  // id, so a task the agent did not open itself (a human's, above all) could not
  // be named at all: the model guessed an id, `task_claim` refused with "there
  // is no task X on this board", and the board stayed open and unassigned while
  // the agent reported the work consumed.
  it("carries each task's ID, which is the only handle its board tools take", () => {
    const text = block({ tasks: [{ id: "clbt_humanadded", title: "Explain who you are", state: "open", owner: null }] })
    expect(text).toContain("clbt_humanadded")
    // And says what the id is FOR, so the model reaches for it rather than
    // matching on the title.
    expect(text).toContain("task_claim")
  })

  it("omits accepted tasks from the summary", () => {
    const text = block({
      tasks: [{ id: "clbt_old", title: "long since accepted", state: "accepted", owner: "collab-crane" }],
    })
    expect(text).not.toContain("long since accepted")
    expect(text).not.toContain("Task board")
  })

  it("says nothing about the board when there are no open tasks", () => {
    expect(block({ tasks: [] })).not.toContain("Task board")
  })

  it("caps the task list rather than flooding the prompt with the whole board", () => {
    const tasks: CollabState.TaskSummary[] = Array.from({ length: 10 }, (_, i) => ({
      id: `clbt_${i + 1}`,
      title: `task ${i + 1}`,
      state: "open" as const,
      owner: null,
    }))
    const text = block({ tasks })
    expect(text).toContain("task 1")
    expect(text).toContain(`task ${CollabState.TASK_LINES_MAX}`)
    expect(text).not.toContain(`task ${CollabState.TASK_LINES_MAX + 1}`)
    expect(text).not.toContain("task 10")
  })

  it("survives a roster of one, with no members other than the reader", () => {
    const solo = block({ roster: [{ agentSlug: "collab-crane", displayName: "Crane" }] })
    expect(solo).toContain("- @collab-crane: Crane (you)")
    expect(solo).not.toContain("heron")
  })

  it("carries STATE only - no prose, no rules, nothing a user could override", () => {
    // The whole point of the merge: the layer below the persona is facts. A
    // second document restating the base prompt's rules is what agents were
    // reading half of and contradicting the other half of.
    const text = block()
    expect(text).not.toContain("How this collab works")
    expect(text).not.toContain("REFERENCE")
    expect(text.startsWith("You are @collab-crane")).toBe(true)
  })
})
