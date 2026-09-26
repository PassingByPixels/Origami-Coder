// origami_change (t-xsufpe): the plan exit nudge decision. The loop cases are
// in session/prompt.test.ts; these are the gates a loop test does not reach.
import { expect, test } from "bun:test"
import { SessionPlanExitNudge } from "@/session/plan-exit-nudge"

const stop = {
  agent: "plan",
  planMode: true,
  finish: "stop",
  hasToolCallThisStep: false,
  summaryOrError: false,
  prose: "Day 1: drive.",
  toolsThisTurn: [] as string[],
  nudges: 0,
}

test("a plan text stop is nudged", () => {
  expect(SessionPlanExitNudge.decide(stop).nudge).toBe(true)
})

test("never when native plan mode is off (legacy plan reminder path)", () => {
  expect(SessionPlanExitNudge.decide({ ...stop, planMode: false }).nudge).toBe(false)
})

test("never when plan_exit or question already ran this turn", () => {
  expect(SessionPlanExitNudge.decide({ ...stop, toolsThisTurn: ["read", "plan_exit"] }).nudge).toBe(false)
  expect(SessionPlanExitNudge.decide({ ...stop, toolsThisTurn: ["question"] }).nudge).toBe(false)
})

test("never for an empty step, a summary or an error", () => {
  expect(SessionPlanExitNudge.decide({ ...stop, prose: "  " }).nudge).toBe(false)
  expect(SessionPlanExitNudge.decide({ ...stop, summaryOrError: true }).nudge).toBe(false)
})

test("the text is the same for the same plan path", () => {
  expect(SessionPlanExitNudge.text("/p/plan.md")).toBe(SessionPlanExitNudge.text("/p/plan.md"))
  expect(SessionPlanExitNudge.text("/p/plan.md")).toContain("/p/plan.md")
})
