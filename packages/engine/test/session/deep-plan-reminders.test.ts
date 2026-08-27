// WHICH MODE PROMPT A TURN GETS. Deep plan and plan share one injection point
// (`SessionReminders.apply`, experimental regime), and the whole difference
// between the two products lives in what that point chooses: the brief on the
// way IN, and the handover on the way OUT.
//
// Guarded in BOTH directions on purpose. A selector written as "is this a
// planning agent?" passes every deep-plan assertion here while quietly handing
// plan mode the deep-plan brief, and nothing else in the build would notice: a
// mode prompt is a synthetic text part nobody diffs.
import { describe, expect } from "bun:test"
import { SessionV1 } from "@origami/core/v1/session"
import { FSUtil } from "@origami/core/fs-util"
import { Effect, Layer } from "effect"
import type { Agent } from "@/agent/agent"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionReminders } from "@/session/reminders"
import { testEffect } from "../lib/effect"

const WORKTREE = "/workspace"
const SLUG = "add-a-thing"
const CREATED = 1_770_000_000_000
/** What `Session.plan` / `Session.planFolder` build from the row above. */
const STEM = `${CREATED}-${SLUG}`

/** Which paths the run is to report as already on disk. */
let present = new Set<string>()

const fsys = Layer.mock(FSUtil.Service)({
  existsSafe: (p: string) => Effect.succeed(present.has(p)),
  ensureDir: () => Effect.void,
} as never)

// updatePart PERSISTS the mode prompt (that is why the brief is injected once
// on entry and not on every step), so the mock has to hand the part back.
const sessions = Layer.mock(Session.Service)({
  updatePart: (part: unknown) => Effect.succeed(part),
} as never)

const layer = Layer.mergeAll(RuntimeFlags.layer({ experimentalPlanMode: true }), fsys, sessions)
const { effect: it } = testEffect(layer)

const instance = {
  directory: WORKTREE,
  worktree: WORKTREE,
  project: {
    id: "prj_test",
    worktree: WORKTREE,
    vcs: "git",
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
}

const session = { slug: SLUG, time: { created: CREATED } } as unknown as Session.Info

function messages(previousAgent?: string): SessionV1.WithParts[] {
  const user = {
    info: { id: "msg_u1", sessionID: "ses_dp", role: "user", time: { created: 1_000 } },
    parts: [{ id: "prt_1", sessionID: "ses_dp", messageID: "msg_u1", type: "text", text: "plan the thing" }],
  } as unknown as SessionV1.WithParts
  if (!previousAgent) return [user]
  const assistant = {
    info: { id: "msg_a1", sessionID: "ses_dp", role: "assistant", agent: previousAgent, time: { created: 2_000 } },
    parts: [],
  } as unknown as SessionV1.WithParts
  return [user, assistant]
}

/** Run one turn and return the synthetic text the regime injected, if any. */
const inject = (agentName: string, previousAgent?: string) =>
  Effect.gen(function* () {
    const window = messages(previousAgent)
    yield* SessionReminders.apply({
      messages: window,
      agent: { name: agentName } as Agent.Info,
      session,
      todos: [],
    })
    return window[0]!.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && part.synthetic === true)
      .map((part) => part.text)
      .join("\n---\n")
  }).pipe(Effect.provideService(InstanceRef, instance as never))

// Phrases that appear in exactly ONE of the four prompts, so a mix-up cannot
// read as a pass. NOT the two opening lines: "Deep Plan mode is active."
// CONTAINS "Plan mode is active.", so the obvious pair let the deep-plan brief
// satisfy the plan-mode assertion. Section headings are unique to their file.
const PLAN_BRIEF = "## Plan Workflow"
const DEEP_BRIEF = "## Phase 3 - Adversarial critique"
const PLAN_SWITCH = "changed from plan to build"
const DEEP_SWITCH = "changed from deep-plan to build"

describe("SessionReminders - which planning brief a turn is given", () => {
  it("gives deep-plan the deep-plan brief, and NOT plan mode's", () =>
    Effect.gen(function* () {
      present = new Set()
      const text = yield* inject("deep-plan")
      expect(text).toContain(DEEP_BRIEF)
      expect(text).not.toContain(PLAN_BRIEF)
    }))

  it("gives plan the plan brief, and NOT deep plan's", () =>
    Effect.gen(function* () {
      present = new Set()
      const text = yield* inject("plan")
      expect(text).toContain(PLAN_BRIEF)
      expect(text).not.toContain(DEEP_BRIEF)
    }))

  it("names the plan FOLDER in the deep-plan brief, wherever it is referred to", () =>
    Effect.gen(function* () {
      present = new Set()
      const folder = Session.planFolder(session, instance as never)
      const text = yield* inject("deep-plan")
      // `${planFolder}` appears more than once in the prompt - the folder
      // header and the write-boundary rule - so a `String.replace` with a
      // string pattern would have filled in only the first and left the model
      // reading a literal `${planFolder}` as its boundary.
      expect(text.split(folder).length - 1).toBeGreaterThan(1)
      expect(text).not.toContain("${planFolder}")
      expect(text).not.toContain("${planInfo}")
      // A folder, not plan mode's single markdown file.
      expect(folder.endsWith(STEM)).toBe(true)
      expect(text).not.toContain(`${STEM}.md`)
    }))

  it("tells a resumed deep plan the folder is already there", () =>
    Effect.gen(function* () {
      const folder = Session.planFolder(session, instance as never)
      present = new Set([folder])
      const text = yield* inject("deep-plan")
      expect(text).toContain("That folder already exists")
      expect(text).not.toContain("does not exist yet")
    }))

  it("injects the brief on ENTRY only, not on every following turn", () =>
    Effect.gen(function* () {
      present = new Set()
      // Same agent as the last assistant turn = already briefed; the prompt is
      // persisted in the transcript, so re-injecting it would pay for it again
      // every step.
      expect(yield* inject("deep-plan", "deep-plan")).toBe("")
      expect(yield* inject("plan", "plan")).toBe("")
      // ...but switching BETWEEN the two planning modes is an entry, not a
      // continuation: the agent is now working to a different contract.
      expect(yield* inject("deep-plan", "plan")).toContain(DEEP_BRIEF)
      expect(yield* inject("plan", "deep-plan")).toContain(PLAN_BRIEF)
    }))
})

describe("SessionReminders - what a planning agent is told on the way out", () => {
  it("tells a deep plan it is DELIVERED, never that it should execute", () =>
    Effect.gen(function* () {
      const folder = Session.planFolder(session, instance as never)
      present = new Set([folder])
      const text = yield* inject("build", "deep-plan")
      expect(text).toContain(DEEP_SWITCH)
      expect(text).toContain("Do NOT begin executing it")
      // THE LINE THAT MATTERS. Plan mode's handover says exactly this, and
      // inheriting it would turn an approved plan into a start order.
      expect(text).not.toContain("execute on the plan defined within it")
      expect(text).not.toContain(PLAN_SWITCH)
    }))

  it("still tells a plan-mode chat to execute", () =>
    Effect.gen(function* () {
      const plan = Session.plan(session, instance as never)
      present = new Set([plan])
      const text = yield* inject("build", "plan")
      expect(text).toContain(PLAN_SWITCH)
      expect(text).toContain("execute on the plan defined within it")
      expect(text).not.toContain(DEEP_SWITCH)
    }))

  it("says nothing about a plan that was never written", () =>
    Effect.gen(function* () {
      present = new Set()
      const text = yield* inject("build", "deep-plan")
      expect(text).toContain(DEEP_SWITCH)
      // No folder on disk = no folder to present. Naming one would send the
      // build agent looking for a directory that does not exist.
      expect(text).not.toContain("The delivered deep plan is at")
    }))
})

describe("Session.planFolder", () => {
  it("is the plan file's own path without the .md, so the two can never drift", () =>
    Effect.gen(function* () {
      const file = Session.plan(session, instance as never)
      const folder = Session.planFolder(session, instance as never)
      expect(file).toBe(`${folder}.md`)
      expect(folder.endsWith(STEM)).toBe(true)
    }))

  it("follows the plans root, so a non-vcs project keeps its global plans", () =>
    Effect.gen(function* () {
      const global = { ...instance, project: { ...instance.project, vcs: undefined } }
      const folder = Session.planFolder(session, global as never)
      expect(folder).not.toContain(WORKTREE)
      expect(folder.endsWith(STEM)).toBe(true)
      expect(Session.plan(session, global as never)).toBe(`${folder}.md`)
    }))
})
