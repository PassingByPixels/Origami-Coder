// Wake rules v2. One table, one row per rule of the contract, plus the two
// properties the whole stack rests on: it is MECHANICAL (kind + address, never
// prose) and it is FAIL-CLOSED.

import { describe, expect, it } from "bun:test"
import { CollabRules } from "@/collab/rules"
import type { CollabStore } from "@/collab/store"

const alice = { agentSlug: "alice", displayName: "Alice Reviewer" }
const bob = { agentSlug: "bob", displayName: "Bob Builder" }
const carol = { agentSlug: "carol", displayName: "Carol" }
const roster = [alice, bob, carol]

const message = (input: {
  authorId: string
  authorKind?: "human" | "agent"
  kind?: CollabStore.MessageKind
  mentions?: string[]
}): CollabRules.Message => ({
  authorId: input.authorId,
  authorKind: input.authorKind ?? "agent",
  kind: input.kind ?? "say",
  mentions: input.mentions ?? [],
})

const decide = (subject: CollabRules.Subject, input: Partial<CollabRules.Input> & { message: CollabRules.Message }) =>
  CollabRules.decide({ subject, roster, lead: "alice", ...input })

describe("wake rules v2 - one row per rule", () => {
  it("1. never wakes an agent on its own message, whatever kind it is", () => {
    expect(decide(alice, { message: message({ authorId: "alice", kind: "handoff", mentions: ["alice"] }) })).toBe(
      "skip",
    )
    expect(decide(alice, { message: message({ authorId: "alice", kind: "say" }) })).toBe("skip")
  })

  it("2. a human message with addresses wakes EXACTLY the addressed agents", () => {
    const addressed = message({ authorId: "user", authorKind: "human", mentions: ["bob", "carol"] })
    expect(decide(bob, { message: addressed })).toBe("reply")
    expect(decide(carol, { message: addressed })).toBe("reply")
    // Not even the lead, which is the point of addressing it.
    expect(decide(alice, { message: addressed })).toBe("skip")
  })

  it("2. an address that is no longer on the roster does not widen the reach", () => {
    // carol has left. The message still reaches bob, and nobody else is pulled
    // in to cover for her - the M2 "fan out to everyone" fallback is gone.
    const active = [alice, bob]
    const addressed = message({ authorId: "user", authorKind: "human", mentions: ["bob", "carol"] })
    expect(CollabRules.decide({ subject: bob, message: addressed, roster: active, lead: "alice" })).toBe("reply")
    expect(CollabRules.decide({ subject: alice, message: addressed, roster: active, lead: "alice" })).toBe("skip")
  })

  it("2. an address that resolves to NOBODY active wakes nobody at all", () => {
    const active = [alice, bob]
    const addressed = message({ authorId: "user", authorKind: "human", mentions: ["carol"] })
    expect(CollabRules.decide({ subject: alice, message: addressed, roster: active, lead: "alice" })).toBe("skip")
    expect(CollabRules.decide({ subject: bob, message: addressed, roster: active, lead: "alice" })).toBe("skip")
  })

  it("3. an unaddressed human message wakes the LEAD alone", () => {
    const open = message({ authorId: "user", authorKind: "human" })
    expect(decide(alice, { message: open })).toBe("reply")
    expect(decide(bob, { message: open })).toBe("skip")
    expect(decide(carol, { message: open })).toBe("skip")
  })

  it("3. with no lead, an unaddressed human message wakes nobody", () => {
    const open = message({ authorId: "user", authorKind: "human" })
    for (const subject of roster) expect(decide(subject, { message: open, lead: null })).toBe("skip")
    for (const subject of roster) expect(decide(subject, { message: open, lead: undefined })).toBe("skip")
  })

  it("4. an answer wakes nobody - the asker already holds it as a tool result", () => {
    const answer = message({ authorId: "bob", kind: "answer", mentions: ["alice"] })
    expect(decide(alice, { message: answer })).toBe("skip")
    expect(decide(carol, { message: answer })).toBe("skip")
  })

  it("5. an ask or a hand-off schedules nothing - the runner routes both directly", () => {
    for (const kind of ["ask", "handoff"] as const) {
      const directed = message({ authorId: "alice", kind, mentions: ["bob"] })
      // Even the target: an ask runs nested inside the caller's turn, and a
      // hand-off is queued by the runner. A rule that said "reply" here would
      // give the target a SECOND turn for the same message.
      expect(decide(bob, { message: directed })).toBe("skip")
      expect(decide(carol, { message: directed })).toBe("skip")
    }
  })

  it("6. a completed task wakes whoever opened it, and only them", () => {
    const done = message({ authorId: "bob", kind: "task_done" })
    const task = { createdBy: "alice", owner: "bob" }
    expect(decide(alice, { message: done, task })).toBe("reply")
    expect(decide(carol, { message: done, task })).toBe("skip")
  })

  it("6. a completed task wakes nobody when the human opened it, or when it is your own", () => {
    const done = message({ authorId: "bob", kind: "task_done" })
    expect(decide(alice, { message: done, task: { createdBy: "user", owner: "bob" } })).toBe("skip")
    // bob opened it AND completed it: waking bob would be waking the author.
    expect(decide(bob, { message: done, task: { createdBy: "bob", owner: "bob" } })).toBe("skip")
    // No task loaded is not an excuse to wake the room.
    expect(decide(alice, { message: done })).toBe("skip")
  })

  it("6. a reopened task wakes its owner, and only them", () => {
    const reopen = message({ authorId: "alice", kind: "task_reopen" })
    const task = { createdBy: "alice", owner: "bob" }
    expect(decide(bob, { message: reopen, task })).toBe("reply")
    expect(decide(alice, { message: reopen, task })).toBe("skip")
    expect(decide(carol, { message: reopen, task })).toBe("skip")
    expect(decide(bob, { message: reopen, task: { createdBy: "alice", owner: null } })).toBe("skip")
  })

  it("6. a HUMAN board move reaches the agent that has to act, not the lead", () => {
    // The human rules route conversation. A board row carries the human's name
    // but is not a question for the lead, and treating it as one would both
    // spend a turn per checkbox AND shadow the rule that knows who is on the
    // hook for the work.
    const done = message({ authorId: "user", authorKind: "human", kind: "task_done" })
    expect(decide(alice, { message: done, task: { createdBy: "alice", owner: "bob" } })).toBe("reply")
    const reopen = message({ authorId: "user", authorKind: "human", kind: "task_reopen" })
    expect(decide(bob, { message: reopen, task: { createdBy: "user", owner: "bob" } })).toBe("reply")
    expect(decide(alice, { message: reopen, task: { createdBy: "user", owner: "bob" } })).toBe("skip")
  })

  it("7. everything else wakes nobody, whoever wrote it", () => {
    for (const kind of ["say", "system", "task_open", "task_claim", "task_accept"] as const) {
      const entry = message({ authorId: "bob", kind })
      for (const subject of [alice, carol]) expect(decide(subject, { message: entry })).toBe("skip")
    }
    // Board bookkeeping the human did is still bookkeeping: not one turn.
    for (const kind of ["task_open", "task_claim", "task_accept"] as const) {
      const entry = message({ authorId: "user", authorKind: "human", kind })
      for (const subject of roster) expect(decide(subject, { message: entry })).toBe("skip")
    }
  })
})

describe("wake rules v2 - the properties the stack rests on", () => {
  it("reads the ADDRESS list, never the prose - a written @name wakes nobody", () => {
    // The rule input carries no text at all any more. This is the assertion
    // that the type says so: an agent discussing "@alice" with a third agent
    // used to give alice a turn, and two agents talking about a colleague
    // could keep the room awake indefinitely.
    const chat = message({ authorId: "bob", kind: "say" })
    expect("text" in chat).toBe(false)
    expect(decide(alice, { message: chat })).toBe("skip")
  })

  it("takes the FIRST rule that has an opinion, not the last", () => {
    const always: CollabRules.Rule = { name: "always", evaluate: () => "reply" }
    const own = message({ authorId: "alice" })
    expect(CollabRules.decide({ subject: alice, message: own }, [CollabRules.SELF, always])).toBe("skip")
    expect(CollabRules.decide({ subject: alice, message: own }, [always, CollabRules.SELF])).toBe("reply")
  })

  it("stops at 'skip' when a rule throws instead of falling through to a later rule", () => {
    const exploding: CollabRules.Rule = {
      name: "boom",
      evaluate: () => {
        throw new Error("rule is broken")
      },
    }
    // HUMAN_LEAD sits after the broken rule and would answer "reply". Fail-
    // closed means the broken rule ends evaluation, so it never runs.
    expect(
      CollabRules.decide(
        { subject: alice, message: message({ authorId: "user", authorKind: "human" }), lead: "alice" },
        [exploding, CollabRules.HUMAN_LEAD],
      ),
    ).toBe("skip")
  })

  it("is silent, not permissive, when every rule abstains", () => {
    const abstains: CollabRules.Rule = { name: "abstains", evaluate: () => undefined }
    expect(
      CollabRules.decide({ subject: alice, message: message({ authorId: "user", authorKind: "human" }) }, [abstains]),
    ).toBe("skip")
  })

  it("takes the address list as given when the roster is unknown", () => {
    const addressed = message({ authorId: "user", authorKind: "human", mentions: ["bob"] })
    expect(CollabRules.decide({ subject: bob, message: addressed })).toBe("reply")
    expect(CollabRules.decide({ subject: alice, message: addressed })).toBe("skip")
  })
})

// The C14 composer preview: "who would answer this?" before it is sent. The
// point of testing it HERE, beside the stack it runs on, is that it must never
// become a second policy - a preview that is right where the room is wrong
// teaches the user a routing rule the room does not have.
describe("wake rules v2 - the composer preview", () => {
  it("names exactly the agents an addressed draft would wake", () => {
    expect(CollabRules.wakeSet({ roster, lead: "alice", mentions: ["bob", "carol"] })).toEqual(["bob", "carol"])
  })

  it("names the LEAD alone for an unaddressed draft, and nobody when the seat is empty", () => {
    expect(CollabRules.wakeSet({ roster, lead: "alice", mentions: [] })).toEqual(["alice"])
    expect(CollabRules.wakeSet({ roster, lead: null, mentions: [] })).toEqual([])
  })

  it("wakes nobody for an address that is not on the roster", () => {
    expect(CollabRules.wakeSet({ roster: [alice, bob], lead: "alice", mentions: ["carol"] })).toEqual([])
  })

  it("answers in ROSTER order, whatever order the draft named them in", () => {
    expect(CollabRules.wakeSet({ roster, lead: "alice", mentions: ["carol", "alice"] })).toEqual(["alice", "carol"])
  })

  it("runs the SAME stack the runner fans out on, rather than a copy of it", () => {
    // Swapping the stack has to change the answer. If it did not, the preview
    // would be re-deriving the policy instead of evaluating it.
    expect(CollabRules.wakeSet({ roster, lead: "alice", mentions: ["bob"] }, [CollabRules.SILENT])).toEqual([])
  })
})
