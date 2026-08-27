import { describe, expect, test } from "bun:test"
import { EOL } from "os"
import { accumulateExitError, resolveSessionError } from "@/cli/cmd/run/session.error"
import { createDescendantCheck } from "@/cli/cmd/run/permission.descendant"

const RUN = "ses_run"
const CHILD = "ses_child"
const STRANGER = "ses_stranger"

const TREE: Record<string, string | undefined> = {
  [CHILD]: RUN,
  [STRANGER]: "ses_other_run",
}

// Reuses the SAME descendant check the permission path uses - one notion of "is this
// mine", not two that can drift.
function isDescendant() {
  return createDescendantCheck({ rootSessionID: RUN, parentOf: async (id) => TREE[id] })
}

function stepLimitError() {
  return {
    name: "UnknownError",
    data: { message: "Stopped after reaching the 100-step limit for a single turn." },
  }
}

describe("resolveSessionError", () => {
  // The gap: a subagent that hits the max-steps backstop publishes session.error but
  // never sets assistantMessage.error, so the task tool reports SUCCESS and the run
  // printed nothing at all. In a cron log that is a clean record of work that did not
  // happen.
  test("a subagent's error reaches the output sink", async () => {
    const report = await resolveSessionError({
      event: { sessionID: CHILD, error: stepLimitError() },
      runSessionID: RUN,
      isDescendant: isDescendant(),
    })

    expect(report).toBeDefined()
    expect(report!.text).toContain("Stopped after reaching the 100-step limit")
  })

  test("a subagent's error is attributed so a log reader can tell it apart", async () => {
    const child = await resolveSessionError({
      event: { sessionID: CHILD, error: stepLimitError() },
      runSessionID: RUN,
      isDescendant: isDescendant(),
    })
    const own = await resolveSessionError({
      event: { sessionID: RUN, error: stepLimitError() },
      runSessionID: RUN,
      isDescendant: isDescendant(),
    })

    expect(child!.text).toBe(`subagent ${CHILD}: Stopped after reaching the 100-step limit for a single turn.`)
    expect(child!.own).toBe(false)
    // The main agent's own error carries no subagent prefix - the two are distinguishable.
    expect(own!.text).toBe("Stopped after reaching the 100-step limit for a single turn.")
    expect(own!.own).toBe(true)
    expect(own!.text).not.toContain("subagent")
  })

  test("an unrelated session's error is not ours to print", async () => {
    const report = await resolveSessionError({
      event: { sessionID: STRANGER, error: stepLimitError() },
      runSessionID: RUN,
      isDescendant: isDescendant(),
    })
    expect(report).toBeUndefined()
  })

  test("an event without an error is ignored", async () => {
    const report = await resolveSessionError({
      event: { sessionID: RUN },
      runSessionID: RUN,
      isDescendant: isDescendant(),
    })
    expect(report).toBeUndefined()
  })

  test("falls back to the error name when there is no data.message", async () => {
    const report = await resolveSessionError({
      event: { sessionID: RUN, error: { name: "ContextOverflowError" } },
      runSessionID: RUN,
      isDescendant: isDescendant(),
    })
    expect(report!.text).toBe("ContextOverflowError")
  })
})

describe("accumulateExitError", () => {
  // The inverse bug this guards: the task tool already hands a failed subagent to its
  // parent as <task_error>. A parent that recovers and finishes has genuinely
  // succeeded, so a subagent error must NOT flip the run's exit code - otherwise
  // crons report failure for runs that worked, and the exit code stops meaning
  // anything.
  test("a subagent error does NOT flip the exit code when the parent recovered", async () => {
    const report = await resolveSessionError({
      event: { sessionID: CHILD, error: stepLimitError() },
      runSessionID: RUN,
      isDescendant: isDescendant(),
    })

    expect(accumulateExitError(undefined, report!)).toBeUndefined()
  })

  test("the run's OWN error still sets the exit code", async () => {
    const report = await resolveSessionError({
      event: { sessionID: RUN, error: stepLimitError() },
      runSessionID: RUN,
      isDescendant: isDescendant(),
    })

    expect(accumulateExitError(undefined, report!)).toBe("Stopped after reaching the 100-step limit for a single turn.")
  })

  test("a subagent error never erases an existing failure either", async () => {
    const child = await resolveSessionError({
      event: { sessionID: CHILD, error: stepLimitError() },
      runSessionID: RUN,
      isDescendant: isDescendant(),
    })
    expect(accumulateExitError("earlier failure", child!)).toBe("earlier failure")
  })

  test("multiple own errors accumulate", async () => {
    const own = await resolveSessionError({
      event: { sessionID: RUN, error: { name: "Boom", data: { message: "second" } } },
      runSessionID: RUN,
      isDescendant: isDescendant(),
    })
    expect(accumulateExitError("first", own!)).toBe(`first${EOL}second`)
  })
})
