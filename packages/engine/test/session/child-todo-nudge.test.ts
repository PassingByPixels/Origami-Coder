// t-v4qvq1: the child todo nudge's decision, tested where it lives. The loop
// proof (the nudge lands, the turn runs one more step, the prefix bytes hold,
// the parent reads the post-nudge reply) is in `prompt.test.ts`.

import { describe, expect, test } from "bun:test"
import { SessionChildTodoNudge } from "@/session/child-todo-nudge"

// The owner's reader child at its first stop: 3 items, 1 in progress, 1 pending.
const stop = (over: Partial<SessionChildTodoNudge.Decision> = {}): SessionChildTodoNudge.Decision => ({
  child: true,
  finish: "stop",
  hasToolCallThisStep: false,
  sawToolCallThisTurn: true,
  summaryOrError: false,
  open: 2,
  nudges: 0,
  otherNudges: 0,
  ...over,
})

describe("child todo nudge decision", () => {
  test("a child that stops with open todos after doing work is nudged", () => {
    expect(SessionChildTodoNudge.decide(stop()).nudge).toBe(true)
  })

  test("never more than one per turn", () => {
    expect(SessionChildTodoNudge.decide(stop({ nudges: 1 })).nudge).toBe(false)
  })

  test("a primary session is never nudged", () => {
    expect(SessionChildTodoNudge.decide(stop({ child: false })).nudge).toBe(false)
  })

  test("a turn with no tool call (no progress) is never nudged", () => {
    expect(SessionChildTodoNudge.decide(stop({ sawToolCallThisTurn: false })).nudge).toBe(false)
  })

  test("a closed list is never nudged", () => {
    expect(SessionChildTodoNudge.decide(stop({ open: 0 })).nudge).toBe(false)
  })

  test("only a clean stop: length, error, summary and tool-call steps are left alone", () => {
    expect(SessionChildTodoNudge.decide(stop({ finish: "length" })).nudge).toBe(false)
    expect(SessionChildTodoNudge.decide(stop({ finish: undefined })).nudge).toBe(false)
    expect(SessionChildTodoNudge.decide(stop({ hasToolCallThisStep: true })).nudge).toBe(false)
    expect(SessionChildTodoNudge.decide(stop({ summaryOrError: true })).nudge).toBe(false)
  })

  test("an OpenAI continuation nudge already spent this turn blocks it, so the two never stack", () => {
    expect(SessionChildTodoNudge.decide(stop({ otherNudges: 1 })).nudge).toBe(false)
  })

  test("ORIGAMI_CONTINUE_NUDGE=off silences it", () => {
    expect(SessionChildTodoNudge.decide(stop({ enabled: false })).nudge).toBe(false)
  })
})

describe("open items", () => {
  test("completed, cancelled and failed are closed; everything else is open", () => {
    expect(
      SessionChildTodoNudge.openCount([
        { status: "completed" },
        { status: "cancelled" },
        { status: "failed" },
        { status: "in_progress" },
        { status: "pending" },
      ]),
    ).toBe(2)
  })
})
