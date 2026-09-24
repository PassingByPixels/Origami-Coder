// GOAL MODE's loop, driven through `SessionGoal.check` with real fakes.
//
// `check` takes every service it uses as an injected slice (`CheckDeps`), so
// the whole enforcement loop - critic spawn, verdict, round accounting,
// continuation injection, terminal verdicts - is exercised here with no engine
// instance, no provider and no model. What that buys is the assertions below:
// each one names a spend or a lie the loop could commit, and each one fails if
// the guard against it is removed. The RED proofs are recorded in the report
// for this change; the two the brief called out are marked in comments.
import { describe, expect, it } from "bun:test"
import { SessionV1 } from "@origami/core/v1/session"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Effect } from "effect"
import type { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionGoal } from "@/session/goal"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { onTurnEnd, resetTurnEndListeners, type StopReason } from "@/session/turn-end"
import type { SessionPrompt } from "@/session/prompt"

const PARENT = SessionID.make("ses_goal_parent")
const MODEL = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const info = (over: Partial<Session.Info> = {}): Session.Info => ({
  id: PARENT,
  slug: "goal",
  projectID: "prj_test" as Session.Info["projectID"],
  directory: "/repo",
  title: "goal chat",
  agent: "build",
  version: "0.0.0-test",
  time: { created: 1, updated: 1 },
  ...over,
})

const withGoal = (goal: Partial<Session.Goal>, over: Partial<Session.Info> = {}) =>
  info({
    metadata: Session.withGoal(
      { keepMe: "yes" },
      {
        text: "the tests pass",
        active: true,
        rounds: 0,
        maxRounds: 3,
        createdAt: 1,
        ...goal,
      },
    ),
    ...over,
  })

const criticAgent: Agent.Info = {
  name: SessionGoal.CRITIC_AGENT,
  mode: "subagent",
  native: true,
  hidden: true,
  permission: [{ permission: "*", pattern: "*", action: "deny" }],
  options: {},
}

const assistantReply = (text: string): SessionV1.WithParts => ({
  info: {
    id: MessageID.ascending(),
    sessionID: SessionID.make("ses_goal_critic"),
    role: "assistant",
    parentID: MessageID.make("msg_goal_parent"),
    mode: SessionGoal.CRITIC_AGENT,
    agent: SessionGoal.CRITIC_AGENT,
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: MODEL.modelID,
    providerID: MODEL.providerID,
    time: { created: 1, completed: 2 },
  },
  parts: [
    {
      id: PartID.ascending(),
      messageID: MessageID.ascending(),
      sessionID: SessionID.make("ses_goal_critic"),
      type: "text",
      text,
    },
  ],
})

type Harness = {
  deps: SessionGoal.CheckDeps
  /** Every `ops.prompt` the loop made, in order. */
  prompts: SessionPrompt.PromptInput[]
  /** Every goal record written to the session row, in order. */
  writes: (Session.Goal | undefined)[]
  /** Every terminal verdict announced on the turnEnd channel. */
  verdicts: StopReason[]
  row: () => Session.Info
}

/** One parent session, one scripted critic reply per round. */
const harness = (input: {
  session: Session.Info
  /** Reply text for critic run N (index 0 = first). A `null` entry makes the
   *  critic PROMPT itself die, which is the "could not run it at all" error. */
  criticReplies: (string | null)[]
  /** `true` = busy for every check. An ARRAY answers each `busy` call in turn
   *  (the loop asks twice: once before the critic, once after), which is how a
   *  user arriving mid-critic is simulated. */
  busy?: boolean | boolean[]
  lastAssistant?: SessionV1.WithParts
  agent?: Agent.Info | undefined
}): Harness => {
  let row = input.session
  const prompts: SessionPrompt.PromptInput[] = []
  const writes: (Session.Goal | undefined)[] = []
  const verdicts: StopReason[] = []
  let criticRun = 0
  let busyCall = 0

  onTurnEnd((verdict) => verdicts.push(verdict.stopReason))

  const deps: SessionGoal.CheckDeps = {
    sessions: {
      get: () => Effect.succeed(row),
      create: () => Effect.succeed(info({ id: SessionID.make("ses_goal_critic"), parentID: row.id })),
      setMetadata: (write) =>
        Effect.sync(() => {
          row = { ...row, metadata: write.metadata }
          writes.push(Session.goal(row))
        }),
    },
    agents: {
      // `Agent.Interface.get` is DECLARED as returning `Info`, but the
      // implementation answers `agents[name]` and every caller checks for
      // undefined (tool/task.ts does the same). The fake tells the truth and
      // the cast is where the declared type stops matching it.
      get: () => Effect.succeed(("agent" in input ? input.agent : criticAgent) as Agent.Info),
    },
    ops: {
      busy: () =>
        Effect.sync(() => {
          if (Array.isArray(input.busy)) return input.busy[busyCall++] ?? false
          return input.busy ?? false
        }),
      prompt: (prompt) =>
        Effect.suspend(() => {
          prompts.push(prompt)
          // A prompt at the PARENT is the injected continuation; anything else
          // is a critic run, and answers from the script.
          if (prompt.sessionID === row.id) return Effect.succeed(assistantReply("ok"))
          const reply = input.criticReplies[criticRun++]
          // A REAL suspension point. A critic that answers synchronously lets
          // one `check` run start and finish before the next one begins, so the
          // re-entrancy test below would pass with no guard in place at all -
          // the harness, not the code, would be doing the serialising.
          return Effect.sleep("1 millis").pipe(
            Effect.andThen(() =>
              reply === null || reply === undefined
                ? Effect.die(new Error("critic exploded"))
                : Effect.succeed(assistantReply(reply)),
            ),
          )
        }),
    },
    worktree: "/repo",
    model: Effect.succeed(MODEL),
    lastAssistant: Effect.succeed(input.lastAssistant),
  }

  return { deps, prompts, writes, verdicts, row: () => row }
}

const run = async (h: Harness) => {
  await Effect.runPromise(SessionGoal.check(h.deps, PARENT))
}

const reset = () => {
  resetTurnEndListeners()
  SessionGoal.resetInFlight()
}

// ------------------------------ pure pieces -------------------------------

describe("SessionGoal.parseVerdict", () => {
  it("reads a plain verdict line", () => {
    expect(SessionGoal.parseVerdict("evidence\nVERDICT: MET")).toBe("met")
    expect(SessionGoal.parseVerdict("evidence\nVERDICT: NOT MET")).toBe("not_met")
  })

  it("never reads NOT MET as MET", () => {
    // The one-character difference that would declare unfinished work done.
    expect(SessionGoal.parseVerdict("**VERDICT: NOT MET**")).toBe("not_met")
    expect(SessionGoal.parseVerdict("- verdict: not met")).toBe("not_met")
    expect(SessionGoal.parseVerdict("VERDICT:  NOT   MET")).toBe("not_met")
  })

  it("survives the wrappers models actually emit", () => {
    expect(SessionGoal.parseVerdict("**VERDICT: MET**")).toBe("met")
    expect(SessionGoal.parseVerdict("```\nVERDICT: MET\n```")).toBe("met")
    expect(SessionGoal.parseVerdict("  > VERDICT:   MET  ")).toBe("met")
  })

  it("takes the LAST verdict, so a restated instruction never wins", () => {
    // The common shape: the critic echoes the required format at the top and
    // gives its real answer at the bottom.
    expect(SessionGoal.parseVerdict("end with VERDICT: MET\n...\nVERDICT: NOT MET")).toBe("not_met")
  })

  it("answers undefined rather than guessing", () => {
    expect(SessionGoal.parseVerdict("")).toBeUndefined()
    expect(SessionGoal.parseVerdict("I think it is basically done, yes.")).toBeUndefined()
    expect(SessionGoal.parseVerdict("MET")).toBeUndefined()
    expect(SessionGoal.parseVerdict("VERDICT: MAYBE")).toBeUndefined()
  })
})

describe("SessionGoal.criticPrompt", () => {
  it("carries the condition and the worktree", () => {
    const prompt = SessionGoal.criticPrompt({ condition: "the tests pass", worktree: "/repo" })
    expect(prompt).toContain("the tests pass")
    expect(prompt).toContain("/repo")
    expect(prompt).toContain(SessionGoal.VERDICT_MET)
    expect(prompt).toContain(SessionGoal.VERDICT_NOT_MET)
  })
})

// ------------------------------- the loop ---------------------------------

describe("SessionGoal.check — when it does nothing at all", () => {
  it("ignores a session with no goal", async () => {
    reset()
    const h = harness({ session: info(), criticReplies: ["VERDICT: NOT MET"] })
    await run(h)
    expect(h.prompts).toHaveLength(0)
    expect(h.verdicts).toHaveLength(0)
  })

  it("ignores a goal that is already cleared", async () => {
    reset()
    const h = harness({ session: withGoal({ active: false }), criticReplies: ["VERDICT: NOT MET"] })
    await run(h)
    expect(h.prompts).toHaveLength(0)
  })

  it("never runs for a SUBAGENT session, including the critic child it spawns", async () => {
    // Without this the critic's own turn end would start a critic of its own,
    // forever, each one paying for a model call.
    reset()
    const h = harness({
      session: withGoal({}, { parentID: SessionID.make("ses_someone_else") }),
      criticReplies: ["VERDICT: NOT MET"],
    })
    await run(h)
    expect(h.prompts).toHaveLength(0)
  })

  it("steps aside when a turn is already running", async () => {
    // A user message (or a background result) got there first. That turn ends
    // with a check of its own; talking over it would double the spend.
    reset()
    const h = harness({ session: withGoal({}), criticReplies: ["VERDICT: NOT MET"], busy: true })
    await run(h)
    expect(h.prompts).toHaveLength(0)
    expect(h.verdicts).toHaveLength(0)
  })
})

describe("SessionGoal.check — a turn parked on the user", () => {
  const parked = (): SessionV1.WithParts => {
    const reply = assistantReply("what should I do?")
    return {
      info: reply.info,
      parts: [
        {
          id: PartID.ascending(),
          messageID: MessageID.ascending(),
          sessionID: PARENT,
          type: "tool",
          callID: "call_1",
          tool: "question",
          state: { status: "running", input: {}, time: { start: 1 } },
        },
      ],
    }
  }

  // RED PROOF (brief test 3): with the `askedUser` branch removed from
  // `check`, this fails on all three assertions - the critic runs, a round is
  // spent and a continuation is injected on top of a question the user has not
  // answered yet.
  it("spends no round, injects nothing, and reports parked", async () => {
    reset()
    const h = harness({
      session: withGoal({ rounds: 1 }),
      criticReplies: ["VERDICT: NOT MET"],
      lastAssistant: parked(),
    })
    await run(h)
    expect(h.prompts).toHaveLength(0)
    expect(h.verdicts).toEqual(["asked_user"])
    expect(Session.goal(h.row())?.rounds).toBe(1)
    expect(Session.goal(h.row())?.active).toBe(true)
  })

  it("does not treat a SETTLED question as parked", async () => {
    reset()
    const answered = parked()
    answered.parts[0] = {
      ...(answered.parts[0] as SessionV1.ToolPart),
      state: {
        status: "completed",
        input: {},
        output: "answered",
        title: "q",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }
    const h = harness({ session: withGoal({}), criticReplies: ["VERDICT: MET"], lastAssistant: answered })
    await run(h)
    expect(h.verdicts).toEqual(["success"])
  })
})

describe("SessionGoal.check — NOT MET", () => {
  // RED PROOF (brief test 2, first half): drop the `inFlight` claim or the
  // single-injection path and `prompts` grows past two.
  it("runs the critic once and injects exactly one continuation", async () => {
    reset()
    const h = harness({ session: withGoal({}), criticReplies: ["missing: nothing runs the suite\nVERDICT: NOT MET"] })
    await run(h)
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[0]!.sessionID).toBe(SessionID.make("ses_goal_critic"))
    expect(h.prompts[1]!.sessionID).toBe(PARENT)
  })

  it("hands the critic's evidence back verbatim, marked synthetic", async () => {
    reset()
    const h = harness({ session: withGoal({}), criticReplies: ["missing: nothing runs the suite\nVERDICT: NOT MET"] })
    await run(h)
    const part = h.prompts[1]!.parts[0] as { type: "text"; text: string; synthetic?: boolean }
    expect(part.synthetic).toBe(true)
    expect(part.text).toContain("missing: nothing runs the suite")
    expect(part.text).toContain("The goal is not yet met. Continue working toward: the tests pass")
  })

  it("spends exactly one round, and spends it BEFORE the turn it pays for", async () => {
    reset()
    const h = harness({ session: withGoal({ rounds: 1 }), criticReplies: ["VERDICT: NOT MET"] })
    await run(h)
    expect(Session.goal(h.row())?.rounds).toBe(2)
    expect(Session.goal(h.row())?.active).toBe(true)
    // The write lands before the continuation prompt: a crash in between must
    // not lose the count, or an unreachable condition would loop unbounded.
    expect(h.writes).toHaveLength(1)
  })

  it("announces no verdict mid-loop", async () => {
    // The taxonomy is TERMINAL labels only. `success` here would be a lie and
    // any error label a different one.
    reset()
    const h = harness({ session: withGoal({}), criticReplies: ["VERDICT: NOT MET"] })
    await run(h)
    expect(h.verdicts).toHaveLength(0)
  })
})

describe("SessionGoal.check — the round budget", () => {
  // RED PROOF (brief test 2, second half): change `goal.rounds >= goal.maxRounds`
  // to `>` and this fails - an eleventh round is injected and the verdict is
  // never announced, which is the unbounded-spend bug the budget exists for.
  it("stops at maxRounds with error_max_turns and clears the goal", async () => {
    reset()
    const h = harness({ session: withGoal({ rounds: 3, maxRounds: 3 }), criticReplies: ["VERDICT: NOT MET"] })
    await run(h)
    expect(h.verdicts).toEqual(["error_max_turns"])
    const goal = Session.goal(h.row())!
    expect(goal.active).toBe(false)
    expect(goal.rounds).toBe(3)
    expect(goal.completed).toBeUndefined()
  })

  it("tells the model to report honestly rather than claim the goal is met", async () => {
    reset()
    const h = harness({
      session: withGoal({ rounds: 3, maxRounds: 3 }),
      criticReplies: ["still failing\nVERDICT: NOT MET"],
    })
    await run(h)
    const part = h.prompts[1]!.parts[0] as { text: string }
    expect(part.text).toContain("Do not claim the goal is met")
    expect(part.text).toContain("still failing")
  })

  it("does not stop one round early", async () => {
    reset()
    const h = harness({ session: withGoal({ rounds: 2, maxRounds: 3 }), criticReplies: ["VERDICT: NOT MET"] })
    await run(h)
    expect(h.verdicts).toHaveLength(0)
    expect(Session.goal(h.row())?.rounds).toBe(3)
    expect(Session.goal(h.row())?.active).toBe(true)
  })
})

describe("SessionGoal.check — MET", () => {
  it("clears the goal, records it verified, and announces success", async () => {
    reset()
    const h = harness({ session: withGoal({ rounds: 2 }), criticReplies: ["the suite is green\nVERDICT: MET"] })
    await run(h)
    expect(h.verdicts).toEqual(["success"])
    const goal = Session.goal(h.row())!
    expect(goal.active).toBe(false)
    expect(goal.completed).toBe(true)
    expect(goal.lastVerdict).toBe("success")
  })

  it("injects nothing — a met goal ends the session's own work", async () => {
    reset()
    const h = harness({ session: withGoal({}), criticReplies: ["VERDICT: MET"] })
    await run(h)
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]!.sessionID).toBe(SessionID.make("ses_goal_critic"))
  })
})

describe("SessionGoal.check — a critic that cannot be read", () => {
  // RED PROOF (t-3mxhgr, acceptance test 1): on the unfixed code, `settle`
  // returned `undefined` from the errors<2 branch — nothing was injected, the
  // round never got a transcript line, and the goal loop stalled silently.
  // Verified red against the pre-fix goal.ts: `h.prompts` was 1 (the sole
  // critic attempt, no retry) and no PARENT prompt existed to assert on.
  it("posts a visible system line and stays armed when the critic run throws, after one retry", async () => {
    reset()
    const h = harness({ session: withGoal({}), criticReplies: [null, null] })
    await run(h)
    expect(h.verdicts).toHaveLength(0)
    const goal = Session.goal(h.row())!
    expect(goal.active).toBe(true)
    expect(goal.completed).toBeUndefined()
    expect(goal.criticErrors).toBe(1)
    // Both the original attempt and the retry ran before the failure counted,
    // then the failure landed in the transcript instead of leaving the round
    // with nothing injected — the next round still fires because a
    // continuation was actually sent to the parent session.
    expect(h.prompts).toHaveLength(3)
    expect(h.prompts[0]!.sessionID).toBe(SessionID.make("ses_goal_critic"))
    expect(h.prompts[1]!.sessionID).toBe(SessionID.make("ses_goal_critic"))
    expect(h.prompts[2]!.sessionID).toBe(PARENT)
    const part = h.prompts[2]!.parts[0] as { type: "text"; text: string; synthetic?: boolean }
    expect(part.synthetic).toBe(true)
    expect(part.text).toContain("the critic run failed")
    expect(part.text).toContain("the goal stays armed")
  })

  // Acceptance test 2: a second consecutive failure (across two separate
  // `check` calls, i.e. two turns) pauses the goal, visibly, naming it.
  it("pauses the goal with a visible line naming it after two consecutive critic failures", async () => {
    reset()
    const h = harness({ session: withGoal({ criticErrors: 1 }), criticReplies: [null, null] })
    await run(h)
    expect(h.verdicts).toEqual(["error_during_execution"])
    const goal = Session.goal(h.row())!
    expect(goal.active).toBe(false)
    expect(goal.completed).toBeUndefined()
    expect(h.prompts).toHaveLength(3)
    expect(h.prompts[2]!.sessionID).toBe(PARENT)
    const part = h.prompts[2]!.parts[0] as { type: "text"; text: string }
    expect(part.text).toContain("CONDITION: the tests pass")
    expect(part.text).toContain("has been CLEARED")
  })

  it("counts an unreadable verdict as an error and never as met", async () => {
    reset()
    const h = harness({ session: withGoal({}), criticReplies: ["I reckon it is fine", "still no verdict"] })
    await run(h)
    expect(h.verdicts).toHaveLength(0)
    const goal = Session.goal(h.row())!
    expect(goal.active).toBe(true)
    expect(goal.completed).toBeUndefined()
    expect(goal.criticErrors).toBe(1)
  })

  it("counts a critic run that dies the same way", async () => {
    reset()
    const h = harness({ session: withGoal({}), criticReplies: [null, null] })
    await run(h)
    expect(Session.goal(h.row())?.criticErrors).toBe(1)
    expect(Session.goal(h.row())?.active).toBe(true)
  })

  it("recovers silently when the retry reads a verdict — the hiccup never counts", async () => {
    reset()
    const h = harness({ session: withGoal({}), criticReplies: [null, "VERDICT: NOT MET"] })
    await run(h)
    expect(h.verdicts).toHaveLength(0)
    const goal = Session.goal(h.row())!
    expect(goal.active).toBe(true)
    // The retry succeeded, so this is an ordinary NOT MET round, not a strike.
    expect(goal.criticErrors).toBeUndefined()
    expect(goal.rounds).toBe(1)
  })

  it("resets the count on any readable verdict, so two SEPARATE hiccups do not retire it", async () => {
    reset()
    const h = harness({ session: withGoal({ criticErrors: 1 }), criticReplies: ["VERDICT: NOT MET"] })
    await run(h)
    expect(Session.goal(h.row())?.criticErrors).toBeUndefined()
    expect(Session.goal(h.row())?.active).toBe(true)
  })

  it("errors rather than passing when the critic agent is missing", async () => {
    reset()
    const h = harness({ session: withGoal({}), criticReplies: [], agent: undefined })
    await run(h)
    expect(Session.goal(h.row())?.criticErrors).toBe(1)
    expect(Session.goal(h.row())?.active).toBe(true)
    // No critic session could even be created, but the failure is still
    // reported visibly rather than leaving the round with nothing injected.
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]!.sessionID).toBe(PARENT)
  })
})

describe("SessionGoal.check — the critic is BLIND", () => {
  // The whole point of the design: the critic verifies the CONDITION, not the
  // agent's account of what it did. If the parent transcript ever reaches this
  // prompt, the critic starts grading a narrative.
  it("sends the condition and the rules, and no transcript", async () => {
    reset()
    const transcript = "I refactored the auth module and everything works now, trust me."
    const h = harness({
      session: withGoal({ text: "bun test packages/engine passes with 0 failures" }),
      criticReplies: ["VERDICT: NOT MET"],
      lastAssistant: assistantReply(transcript),
    })
    await run(h)
    const sent = (h.prompts[0]!.parts[0] as { text: string }).text
    expect(sent).toContain("bun test packages/engine passes with 0 failures")
    expect(sent).toContain("/repo")
    expect(sent).not.toContain(transcript)
    expect(sent).not.toContain("refactored")
    expect(sent).not.toContain("goal chat")
  })

  it("gives the critic a session of its own, parented to the chat", async () => {
    reset()
    const h = harness({ session: withGoal({}), criticReplies: ["VERDICT: NOT MET"] })
    await run(h)
    expect(h.prompts[0]!.sessionID).not.toBe(PARENT)
    expect(h.prompts[0]!.agent).toBe(SessionGoal.CRITIC_AGENT)
  })
})

describe("SessionGoal.check — the user arriving mid-check", () => {
  it("does not inject on top of a turn that started while the critic was running", async () => {
    // The critic is a whole model run: seconds to minutes. A user message that
    // lands in that window OWNS the session, and the loop must not talk over
    // it. The busy state is therefore re-read AFTER the critic, not just before.
    reset()
    const h = harness({
      session: withGoal({}),
      criticReplies: ["VERDICT: NOT MET"],
      busy: [false, true],
    })
    await run(h)
    // The critic still ran and the round is still spent - the verification
    // happened and was paid for. What must not happen is the injection.
    expect(Session.goal(h.row())?.rounds).toBe(1)
    expect(h.prompts.filter((prompt) => prompt.sessionID === PARENT)).toHaveLength(0)
  })
})

describe("SessionGoal.check — re-entrancy", () => {
  it("never starts a second check while one is in flight for the same session", async () => {
    // Two turns settling at once would each read the same round count, each
    // find room, and each inject: the loop would fan out instead of stepping.
    reset()
    const h = harness({ session: withGoal({}), criticReplies: ["VERDICT: NOT MET", "VERDICT: NOT MET"] })
    await Promise.all([run(h), run(h)])
    const injections = h.prompts.filter((prompt) => prompt.sessionID === PARENT)
    expect(injections).toHaveLength(1)
  })
})

// t-tc2itu, acceptance 1: a HARD usage limit on the build turn that just ended
// must stop the goal outright, not spend a critic call (or two, with the
// retry) against the same spent window.
//
// The fixture is the ChatGPT-backend body `session/usage-limit.ts` already
// parses: `{"error":{"type":"usage_limit_reached","plan_type":"plus",
// "resets_in_seconds":10374}}`, the exact shape and a `resets_in_seconds`
// inside the 10368-10374 range the 429 burst in t-tauw49 B#8 logged
// (session ses_f645ce6faffegDHGQuMFLIySIg, openai / gpt-5.6-sol, 7 requests
// in 7.2 s).
const usageLimitReply = (): SessionV1.WithParts => {
  const reply = assistantReply("")
  return {
    info: {
      ...reply.info,
      error: {
        name: "APIError",
        data: {
          message: "Too Many Requests",
          statusCode: 429,
          isRetryable: true,
          responseBody: JSON.stringify({
            error: { type: "usage_limit_reached", plan_type: "plus", resets_in_seconds: 10374 },
          }),
        },
      },
    },
    parts: [],
  } as unknown as SessionV1.WithParts
}

describe("SessionGoal.check — a hard usage limit on the turn that just ended", () => {
  // RED PROOF: on the unfixed `check`, only `askedUser` short-circuits before
  // `settle`. With this fixture and the guard removed, `settle` runs the critic
  // (which the harness scripts to answer "VERDICT: NOT MET"), spends a round,
  // and injects a continuation back at the PARENT — three more calls against
  // a window that will not reset for hours. Verified red against the pre-fix
  // `goal.ts`: `h.prompts` was 2 and a round was spent.
  it("spends no round, runs no critic, and clears the goal at once", async () => {
    reset()
    const h = harness({
      session: withGoal({ rounds: 1 }),
      criticReplies: ["VERDICT: NOT MET"],
      lastAssistant: usageLimitReply(),
    })
    await run(h)
    expect(h.prompts).toHaveLength(0)
    expect(h.verdicts).toEqual(["error_during_execution"])
    const goal = Session.goal(h.row())!
    expect(goal.active).toBe(false)
    expect(goal.rounds).toBe(1)
  })

  it("says when it can resume, in the recorded verdict", async () => {
    reset()
    const h = harness({ session: withGoal({}), criticReplies: ["VERDICT: NOT MET"], lastAssistant: usageLimitReply() })
    await run(h)
    const goal = Session.goal(h.row())!
    expect(goal.lastVerdict).toContain("usage limit reached")
    expect(goal.lastVerdict).toContain("resets in")
    expect(SessionGoal.describe(goal)).toContain("resets in")
  })

  it("still runs the critic for an ordinary provider error that is not a hard limit", async () => {
    // The short-circuit is narrow: an unrelated failure (or none) on the last
    // assistant message must not silently swallow the critic step.
    reset()
    const h = harness({
      session: withGoal({}),
      criticReplies: ["VERDICT: NOT MET"],
      lastAssistant: assistantReply("ordinary reply, no error"),
    })
    await run(h)
    expect(h.prompts.length).toBeGreaterThan(0)
  })
})

describe("SessionGoal.runCritic — the failure text", () => {
  // t-tc2itu, acceptance 3: the critic's error text used to be JUST the error
  // class name (`the critic run failed: APIError`) - three WARNs in the
  // t-tauw49 B#8 burst carried nothing else. It must name the provider, the
  // model, the status and the provider's own sentence.
  const deps = (failure: { name: string; data: Record<string, unknown> }): SessionGoal.CheckDeps => ({
    sessions: {
      get: () => Effect.succeed(info()),
      create: () => Effect.succeed(info({ id: SessionID.make("ses_goal_critic"), parentID: PARENT })),
      setMetadata: () => Effect.void,
    },
    agents: { get: () => Effect.succeed(criticAgent) },
    ops: {
      busy: () => Effect.succeed(false),
      prompt: () =>
        Effect.succeed({
          info: { ...assistantReply("").info, error: failure } as SessionV1.WithParts["info"],
          parts: [],
        }),
    },
    worktree: "/repo",
    model: Effect.succeed(MODEL),
    lastAssistant: Effect.succeed(undefined),
  })

  it("names the provider, model, status and the provider's sentence for an APIError", async () => {
    reset()
    const outcome = await Effect.runPromise(
      SessionGoal.runCritic(
        deps({
          name: "APIError",
          data: { message: "You exceeded your current quota, please check your plan and billing details.", statusCode: 429, isRetryable: true },
        }),
        info(),
        "the tests pass",
      ),
    )
    expect(outcome.kind).toBe("error")
    const reason = (outcome as { kind: "error"; reason: string }).reason
    expect(reason).toContain(MODEL.providerID)
    expect(reason).toContain(MODEL.modelID)
    expect(reason).toContain("429")
    expect(reason).toContain("You exceeded your current quota")
  })

  it("still names the provider and model when the failure carries no HTTP status", async () => {
    reset()
    const outcome = await Effect.runPromise(
      SessionGoal.runCritic(deps({ name: "ContentFilterError", data: { message: "blocked by the safety filter" } }), info(), "the tests pass"),
    )
    expect(outcome.kind).toBe("error")
    const reason = (outcome as { kind: "error"; reason: string }).reason
    expect(reason).toContain(MODEL.providerID)
    expect(reason).toContain(MODEL.modelID)
    expect(reason).not.toContain("(status")
  })
})
