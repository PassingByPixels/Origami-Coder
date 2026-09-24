// The five conditions of the continuation nudge, tested where they live.
//
// The loop-level proof (the nudge lands, the turn runs another step, the third
// stop is not nudged) is in `prompt.test.ts` against the real loop and a fake
// provider. This file pins the DECISION: the phrase set, the tail window, the
// provider scope and the bound, none of which need a session to be true.

import { describe, expect, test } from "bun:test"
import { SessionContinueNudge } from "@/session/continue-nudge"

const ack = (prose: string): SessionContinueNudge.Decision => ({
  providerID: "openai",
  finish: "stop",
  hasToolCallThisStep: false,
  sawToolCallThisTurn: true,
  prose,
  nudges: 0,
})

// The sentences the owner's own sessions ended turns on, verbatim including the
// typographic apostrophe the model actually emits.
const REAL_STOPS = [
  // t-40lsxf, second live sign-off. Missed by the FIRST widening too: no
  // subject on "Will report", and "completes" is not "complete". Both halves
  // of it were misses - "I'll confirm" needed a verb the list did not carry.
  "Now verified running: broker confirmed alive (17 tools), test launched against it. I'll confirm with the task's actual output — the PNG dimensions line is the pass/fail signal — rather than assuming. Will report when it completes.",
  // t-40lsxf. The stop the ORIGINAL eight-phrase list missed: same intent as
  // the five below it, a verb none of them named, and the turn ended. This
  // line is why the set is patterns over shapes now and not a transcript.
  "Underway. I will notify you only after the next pack is rebuilt, deployed, hash-verified, and ready for another live test.",
  "Understood. I’ll continue without interim reports and return only when the current code/table implementation and playable-build verification are complete.",
  "The Alchemist candidate is packed, deployed, and checkpointed. Live success/failure set-piece branch testing remains in progress; I’ll report when complete.",
  "The same sub-agent has resumed. I will resume the same test agent for both result branches.",
  "I am continuing until those checks are complete.",
  "Next I will implement:\n1. Fixed player, allied, and enemy formations.\n2. No player deployment phase.",
]

describe("SessionContinueNudge.isContinueIntent", () => {
  test("matches every stop the owner's session actually produced", () => {
    for (const prose of REAL_STOPS) {
      expect({ prose, hit: SessionContinueNudge.isContinueIntent(prose) }).toEqual({ prose, hit: true })
    }
  })

  test("reads a typographic apostrophe as an ASCII one", () => {
    // The set is written with ASCII quotes; models emit U+2019. Without the
    // normalisation this is the assertion that fails, and with it none of the
    // real stops above would ever have matched.
    expect(SessionContinueNudge.isContinueIntent("I’ll continue.")).toBe(true)
    expect(SessionContinueNudge.isContinueIntent("I'll continue.")).toBe(true)
  })

  test("does not fire on a reply that finished", () => {
    for (const prose of [
      "All done. The pack is deployed and both branches pass.",
      "That is everything you asked for. Anything else?",
      // t-40lsxf: the widened family must still keep its hands off these.
      // The first ends on "now", the second is a question the model is
      // right to be waiting on, and neither is a promise of more work.
      "Done. The tent opens only on the intro event now.",
      "Which faction should the astromancer join?",
      // The verb `confirm` earns its place only behind "will"/"I'll". A report
      // that something WAS confirmed is the opposite of a promise to confirm.
      "I confirmed the broker is up; nothing else to do.",
      "I stopped because the tool signature was wrong and I could not recover.",
      "Here is the summary of what changed and why.",
    ]) {
      expect({ prose, hit: SessionContinueNudge.isContinueIntent(prose) }).toEqual({ prose, hit: false })
    }
  })

  test("a summary that mentions continuing mid-text but ends on a conclusion does not fire", () => {
    // The shape a report takes when it NARRATES a plan it already carried out.
    // The trigger is real and early; the tail is a finding, so nothing fires.
    const summary =
      "I said I would continue with the table audit before the build, and I will report on it here. " +
      "y".repeat(SessionContinueNudge.TAIL_WINDOW) +
      " Both branches pass and the pack is deployed. Nothing is outstanding."
    expect(SessionContinueNudge.isContinueIntent(summary)).toBe(false)
  })

  test("only looks at the tail, so a promise made and then withdrawn does not fire", () => {
    const withdrawn =
      "Earlier I said I will continue without interim reports. " +
      "x".repeat(SessionContinueNudge.TAIL_WINDOW) +
      " That turned out to be wrong, so I have stopped and am handing back to you now."
    expect(SessionContinueNudge.isContinueIntent(withdrawn)).toBe(false)
  })

  test("empty prose is not an intent", () => {
    expect(SessionContinueNudge.isContinueIntent("")).toBe(false)
  })

  test("KNOWN LIMITATION: a past-tense report and a reply parked on the user both match", () => {
    // Not an endorsement - a record. `ONCE_CONDITION` and `WHEN_CONDITION` buy
    // recall over sign-offs like "once the pack is rebuilt" at the cost of these
    // two shapes, and the price is capped by the four gates around them and by
    // LIMIT: at most two extra steps in a turn that was ending anyway. Asserted
    // so the cost is visible and cannot change silently; `session/goal.ts`'s
    // `askedUser` is the guard that would close the second one.
    expect(SessionContinueNudge.isContinueIntent("The candidate was rebuilt once the source edits were complete.")).toBe(
      true,
    )
    expect(SessionContinueNudge.isContinueIntent("Let me know when you're ready.")).toBe(true)
  })
})

describe("SessionContinueNudge.shouldNudge", () => {
  test("fires on an OpenAI ack mid-task", () => {
    expect(SessionContinueNudge.decide(ack("Working on it. I'll continue.")).nudge).toBe(true)
  })

  test("never fires for another provider", () => {
    // The whole point of the guard being scoped: no other provider's behaviour
    // changes because of one provider's habit.
    for (const providerID of ["anthropic", "google", "xai", "opencode", "github-copilot", "test"]) {
      expect({
        providerID,
        nudged: SessionContinueNudge.decide({ ...ack("I'll continue."), providerID }).nudge,
      }).toEqual({ providerID, nudged: false })
    }
  })

  test("never fires before a tool has run in the turn", () => {
    // A one-shot conversational answer that happens to say "I'll continue" is
    // not a stalled task, and arguing with it would be the engine talking over
    // a finished reply.
    expect(
      SessionContinueNudge.decide({ ...ack("I'll continue."), sawToolCallThisTurn: false }).nudge,
    ).toBe(false)
  })

  test("never fires without a continuation tail", () => {
    expect(SessionContinueNudge.decide(ack("All done. The pack is deployed.")).nudge).toBe(false)
  })

  test("never fires on a step that made a tool call, or on a finish other than stop", () => {
    expect(SessionContinueNudge.decide({ ...ack("I'll continue."), hasToolCallThisStep: true }).nudge).toBe(false)
    for (const finish of ["length", "tool-calls", "unknown", "content-filter", "error", undefined]) {
      expect({
        finish,
        nudged: SessionContinueNudge.decide({ ...ack("I'll continue."), finish }).nudge,
      }).toEqual({ finish, nudged: false })
    }
  })

  test("is bounded: two nudges a turn and no more", () => {
    expect(SessionContinueNudge.decide({ ...ack("I'll continue."), nudges: 0 }).nudge).toBe(true)
    expect(SessionContinueNudge.decide({ ...ack("I'll continue."), nudges: 1 }).nudge).toBe(true)
    expect(SessionContinueNudge.decide({ ...ack("I'll continue."), nudges: 2 }).nudge).toBe(false)
    expect(SessionContinueNudge.LIMIT).toBe(2)
  })
})

describe("SessionContinueNudge.text", () => {
  test("names the engine as the author and says WHICH evidence fired", () => {
    for (const kind of ["promise", "remaining"] as const) {
      const body = SessionContinueNudge.text(kind)
      expect(body).toContain("<engine-note>")
      expect(body).toContain("Origami engine wrote this line, not the user")
    }
    expect(SessionContinueNudge.text("promise")).toContain("said it would carry on")
    expect(SessionContinueNudge.text("remaining")).toContain("stated that work remains")
    expect(SessionContinueNudge.text("promise")).toContain(SessionContinueNudge.INSTRUCTION)
    expect(SessionContinueNudge.text("remaining")).toContain(SessionContinueNudge.REMAINING_INSTRUCTION)
  })

  // t-46a74d. The owner's hypothesis under test is that the words the model
  // READS shape what it does, so the engine's own lines carry no "do not" and
  // no "stop": they name the action wanted and nothing else.
  test("both instructions are positively framed", () => {
    expect(SessionContinueNudge.INSTRUCTION).toBe("Continue; carry out the step you named.")
    expect(SessionContinueNudge.REMAINING_INSTRUCTION).toBe(
      "Continue with the remaining work now, one tool call at a time.",
    )
    for (const line of [SessionContinueNudge.INSTRUCTION, SessionContinueNudge.REMAINING_INSTRUCTION]) {
      expect(line.toLowerCase()).not.toContain("do not")
      expect(line.toLowerCase()).not.toContain("never")
      expect(line.toLowerCase()).not.toContain("stop")
    }
  })

  test("the exhausted note states what happened, and rules on nothing", () => {
    // A fact the user can check, not a verdict on whether the model was right
    // to end the turn - the engine does not know that.
    expect(SessionContinueNudge.exhaustedNote("remaining")).toBe(
      "<engine-note>Two continuation nudges were sent this turn; the reply still describes remaining work.</engine-note>",
    )
    expect(SessionContinueNudge.exhaustedNote("promise")).toContain("still promises to continue")
  })
})

// ---------------------------------------------------------------------------
// origami_change (t-46a74d): the REMAINING-WORK family - prose that promises
// nothing and simply states what is not done.
// ---------------------------------------------------------------------------

/** The two stops from the owner's screenshot, verbatim. */
const SCREENSHOT_STOPS = [
  "I cannot truthfully claim completion yet. The required source changes, localization rows, repack, deployment, and relaunch remain undone.",
  "You are right. I stopped again after claiming I would execute. That is not acceptable. The source edit is now applied, but localization, packing, deployment, and relaunch are still incomplete.",
]

describe("SessionContinueNudge.statesRemainingWork", () => {
  test("matches both stops the promise family could not see", () => {
    for (const prose of SCREENSHOT_STOPS) {
      expect({ prose, hit: SessionContinueNudge.statesRemainingWork(prose) }).toEqual({ prose, hit: true })
      // And they are genuinely invisible to the promise family - which is why
      // the turn ended twice with the guard already shipped and armed.
      expect({ prose, promise: SessionContinueNudge.isContinueIntent(prose) }).toEqual({ prose, promise: false })
    }
  })

  test("does not fire on a reply that reports work FINISHED", () => {
    for (const prose of [
      "Done. All items complete.",
      "Nothing remains; the pack is installed.",
      "All done. The pack is deployed and both branches pass.",
      "I confirmed the broker is up; nothing else to do.",
    ]) {
      expect({ prose, hit: SessionContinueNudge.statesRemainingWork(prose) }).toEqual({ prose, hit: false })
    }
  })

  test("the earlier negatives stay clear of the new family too", () => {
    // The widening must not have quietly reclassified anything the promise
    // family was already right to leave alone.
    for (const prose of [
      "That is everything you asked for. Anything else?",
      "I stopped because the tool signature was wrong and I could not recover.",
      "Here is the summary of what changed and why.",
      "Done. The tent opens only on the intro event now.",
      "Which faction should the astromancer join?",
    ]) {
      expect({ prose, hit: SessionContinueNudge.statesRemainingWork(prose) }).toEqual({ prose, hit: false })
    }
  })
})

describe("SessionContinueNudge.decide", () => {
  const stop = (prose: string, nudges = 0) => ({
    providerID: "openai",
    finish: "stop",
    hasToolCallThisStep: false,
    sawToolCallThisTurn: true,
    prose,
    nudges,
  })

  test("a remaining-work stop is nudged, and says so", () => {
    const verdict = SessionContinueNudge.decide(stop(SCREENSHOT_STOPS[0]!))
    expect(verdict).toMatchObject({
      nudge: true,
      kind: "remaining",
      instruction: SessionContinueNudge.REMAINING_INSTRUCTION,
      reason: "the tail states work remains",
    })
  })

  test("a promise still wins over the remaining family when both could read", () => {
    const verdict = SessionContinueNudge.decide(stop("I'll continue; the rest is still incomplete."))
    expect(verdict).toMatchObject({ nudge: true, kind: "promise" })
  })

  test("shares one budget: the third remaining-work stop in a turn is not nudged", () => {
    expect(SessionContinueNudge.decide(stop(SCREENSHOT_STOPS[0]!, 1)).nudge).toBe(true)
    const spent = SessionContinueNudge.decide(stop(SCREENSHOT_STOPS[0]!, 2))
    expect(spent).toMatchObject({ nudge: false, exhausted: "remaining" })
  })

  // The log line these feed is the whole point of the Verdict shape: three
  // tickets have opened with a screenshot and no way to tell why the guard was
  // quiet.
  test("every candidate stop is reportable, and only candidates are", () => {
    expect(SessionContinueNudge.decide(stop("Done. All items complete."))).toMatchObject({
      nudge: false,
      considered: true,
      reason: "the tail claims nothing",
    })
    expect(SessionContinueNudge.decide({ ...stop("anything"), providerID: "anthropic" })).toMatchObject({
      nudge: false,
      considered: false,
    })
    expect(SessionContinueNudge.decide({ ...stop("anything"), sawToolCallThisTurn: false })).toMatchObject({
      nudge: false,
      considered: false,
      reason: "no tool has run in this turn",
    })
  })

  // origami_change (t-53vyxf): ORIGAMI_CONTINUE_NUDGE=off, so a prompt-shape
  // experiment measures the shape and not the shape plus this guard.
  test("switched off, a stop that WOULD be nudged is not", () => {
    // The proof is the pair: the same decision, one field apart. Asserting only
    // the "off" half would pass against a stop that was never a candidate.
    const promise = stop("I'll continue with the remaining files.")
    expect(SessionContinueNudge.decide(promise)).toMatchObject({ nudge: true, kind: "promise" })
    expect(SessionContinueNudge.decide({ ...promise, enabled: false })).toMatchObject({
      nudge: false,
      considered: false,
      reason: "the continuation nudge is off",
    })
    // The remaining-work family goes with it - one switch, not one per family.
    const remaining = stop("The deployment and relaunch remain undone.")
    expect(SessionContinueNudge.decide(remaining)).toMatchObject({ nudge: true, kind: "remaining" })
    expect(SessionContinueNudge.decide({ ...remaining, enabled: false }).nudge).toBe(false)
  })

  test("left unset it is ON, which is the default the switch may not move", () => {
    const promise = stop("I'll continue with the remaining files.")
    expect(SessionContinueNudge.decide({ ...promise, enabled: true })).toMatchObject({ nudge: true })
    expect(SessionContinueNudge.decide(promise)).toEqual(
      SessionContinueNudge.decide({ ...promise, enabled: true }),
    )
  })
})
