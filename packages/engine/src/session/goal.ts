/**
 * GOAL MODE — a durable per-session completion condition that keeps a chat
 * working across turns until an independent reviewer says the condition is met.
 *
 * THE SHAPE OF IT. The goal itself is one record on the session row's metadata
 * bag (`Session.goal` / `Session.withGoal`). At the end of every turn of a
 * PRIMARY session that carries an active goal, this module:
 *
 *   1. lets the turn end normally — the check is FORKED from `SessionPrompt.loop`,
 *      never inline in `runLoop`, so the UI stays live and the user can interject;
 *   2. spawns a BLIND critic child session (`goal-critic`) which is told the
 *      condition and nothing else, and must verify it with its own evidence -
 *      it never sees the parent transcript, because a critic that reads the
 *      narrative grades the narrative. It may WRITE TO VALIDATE (the missing
 *      test, a probe) but never to repair the work; that contract is stated in
 *      its prompt, which is the only place able to state it;
 *   3. on NOT MET with rounds left, injects ONE synthetic continuation turn
 *      carrying the critic's evidence verbatim;
 *   4. on any TERMINAL outcome, announces it on `origami/turnEnd` (turn-end.ts).
 *
 * WHY THE CRITIC IS A CHILD SESSION AND NOT A `task` CALL. The check must not
 * depend on the model deciding to run it, so the engine spawns the child itself.
 * The spawn MIRRORS `tool/task.ts` rather than reusing it: `runTask` is closed
 * over the task tool's own parameters, permission ask and flock routing, none of
 * which apply here. What is reused is the machinery that matters — the same
 * `TaskPromptOps` (`prompt` / `busy`), the same `deriveSubagentSessionPermission`,
 * and the same synthetic-text-part injection shape the background task drainer
 * uses to start a turn in an idle parent.
 *
 * WHAT IS DELIBERATELY NOT HERE. No mid-loop verdicts: the `turnEnd` taxonomy is
 * TERMINAL labels only (see turn-end.ts), and a still-working round has no
 * honest label in it. No goal for a subagent: only a session with no `parentID`
 * runs the loop, which also stops the critic child from starting a loop of its
 * own.
 */
import { PermissionV1 } from "@origami/core/v1/permission"
import { SessionV1 } from "@origami/core/v1/session"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Cause, Effect, Exit, Option } from "effect"
import { Agent } from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import type { TaskPromptOps } from "@/tool/task"
import { Session } from "./session"
import { MessageID, SessionID } from "./schema"
import { publishTurnEnd, type StopReason } from "./turn-end"

/** The hidden native subagent that does the verifying (agent/agent.ts). */
export const CRITIC_AGENT = "goal-critic"

/** The line the critic must end on, and the only thing parsed out of its run. */
export const VERDICT_MET = "VERDICT: MET"
export const VERDICT_NOT_MET = "VERDICT: NOT MET"

export type Verdict = "met" | "not_met"

/**
 * The verdict a critic run produced, or undefined when it produced none.
 *
 * LENIENT ON PURPOSE, in one direction only. Models wrap the line in bold, in
 * a code fence, or after a bullet, and refusing those would turn a correct
 * verdict into an error. What it will NOT do is guess: a run with no readable
 * line answers undefined, which the caller counts as an ERROR and never as met
 * — the expensive failure here is declaring a goal done that is not.
 *
 * Last match wins: a critic that restates the instruction at the top and gives
 * its real answer at the bottom is the common shape, and the bottom one is the
 * answer.
 */
export function parseVerdict(text: string): Verdict | undefined {
  const pattern = /VERDICT\s*[:\-]\s*[*_`"'\s]*(NOT[\s_-]+MET|MET)\b/gi
  let found: Verdict | undefined
  for (const match of text.matchAll(pattern)) {
    found = /^NOT/i.test(match[1]!) ? "not_met" : "met"
  }
  return found
}

/**
 * Did this turn end with a question to the user still outstanding?
 *
 * The engine has exactly one machine-readable "waiting on a human" state: an
 * UNSETTLED `question` tool call on the turn's last assistant message. A turn
 * that ends that way was interrupted or cancelled with the ask still on screen,
 * which is the client's `parked: awaiting your answer` verdict exactly.
 *
 * It does NOT try to detect a question asked in prose. That is not machine
 * readable without a second model call, and the cost of guessing wrong is the
 * loop either burning a round on a genuinely blocked agent or stalling on one
 * that only sounded blocked. Out of scope; named here so the limit is visible.
 */
export function askedUser(last: SessionV1.WithParts | undefined): boolean {
  if (!last) return false
  return last.parts.some(
    (part) =>
      part.type === "tool" &&
      part.tool === "question" &&
      (part.state.status === "pending" || part.state.status === "running"),
  )
}

/**
 * The critic's whole briefing. BLIND BY CONSTRUCTION: the condition, the
 * worktree, and the rules. No transcript, no plan, no summary of what the agent
 * says it did — those are the very claims under review.
 */
export function criticPrompt(input: { condition: string; worktree: string }): string {
  return [
    "You are an adversarial verifier. Decide ONE question and nothing else:",
    "is the completion condition below TRUE of the workspace as it stands right now?",
    "",
    "COMPLETION CONDITION:",
    input.condition,
    "",
    `WORKTREE: ${input.worktree}`,
    "",
    "RULES:",
    "- You have NOT been told what anyone did, and you must not ask. Gather your OWN evidence:",
    "  read the files, run the tests, run the build, diff the tree.",
    "- A claim you cannot point at (a file and line, a command and its output) is not evidence.",
    "- Assume the condition is NOT met until your own evidence says otherwise. Partly done is NOT met.",
    "- Code that compiles is not code that works. A test that was not run is not a test that passed.",
    "- You may WRITE, but ONLY to validate: a test that does not exist yet, a probe script, a scratch",
    "  harness. NEVER change project source, config, or an existing test to make the condition pass -",
    "  a check you had to soften is itself a NOT MET. Name every file you created or changed in your",
    "  evidence, and delete your probes when you are done with them.",
    "",
    "END YOUR REPLY WITH EXACTLY ONE OF THESE LINES, ON ITS OWN LINE, AS THE LAST LINE:",
    VERDICT_MET,
    VERDICT_NOT_MET,
    "",
    "Immediately above that line, list the evidence you gathered. If the verdict is NOT MET, say",
    "precisely what is missing or wrong and how you checked — that text is handed straight back to",
    "the agent as its next instruction, so vagueness there costs a whole round.",
  ].join("\n")
}

/** The synthetic turn that keeps the agent going, carrying the critic's own words. */
export function continuationText(input: {
  condition: string
  evidence: string
  round: number
  maxRounds: number
}): string {
  return [
    "[goal] An independent reviewer checked the workspace against this session's completion",
    `condition and did NOT pass it. Round ${input.round} of ${input.maxRounds}.`,
    "",
    "REVIEWER REPORT:",
    input.evidence.trim(),
    "",
    `The goal is not yet met. Continue working toward: ${input.condition}`,
    "Do not argue with the report — check it, then fix what it names. If the report is wrong, prove it",
    "with evidence of your own in this turn.",
  ].join("\n")
}

/** The synthetic turn that ends a goal which ran out of rounds. */
export function exhaustedText(input: { condition: string; maxRounds: number; evidence: string }): string {
  return [
    `[goal] Stopped. The completion condition was not verified met after ${input.maxRounds} continuation`,
    "rounds, so the goal has been CLEARED and this loop will not continue on its own.",
    "",
    `CONDITION: ${input.condition}`,
    "",
    "LAST REVIEWER REPORT:",
    input.evidence.trim(),
    "",
    "Tell the user honestly and briefly: what is actually done, what is not, and what you would do next.",
    "Do not claim the goal is met.",
  ].join("\n")
}

/** The synthetic turn that ends a goal whose critic could not be run or read. */
export function criticFailedText(input: { condition: string; reason: string }): string {
  return [
    "[goal] Stopped. The goal verification step failed twice in a row, so the goal has been CLEARED",
    "and this loop will not continue on its own. Nothing about the work itself is implied by this.",
    "",
    `CONDITION: ${input.condition}`,
    `FAILURE: ${input.reason}`,
    "",
    "Tell the user honestly and briefly: what is done, what is unverified, and what you would do next.",
  ].join("\n")
}

/** A one-line goal report, for the `goal` tool's `status` action. */
export function describe(goal: Session.Goal | undefined): string {
  if (!goal) return "No goal is set for this session."
  const state = goal.active
    ? `active, round ${goal.rounds}/${goal.maxRounds}`
    : goal.completed
      ? "met (verified) and cleared"
      : `cleared${goal.lastVerdict ? ` (${goal.lastVerdict})` : ""}`
  return `Goal [${state}]: ${goal.text}`
}

// ------------------------------- the loop --------------------------------

/**
 * Sessions with a check in flight. A turn that ends while its predecessor's
 * check is still running must NOT start a second critic — two of them would
 * each read the round count, each find room, and each inject.
 *
 * The claim is released BEFORE the continuation is injected, deliberately: the
 * injected turn ends by forking its OWN check, and a claim held across the
 * injection would silently stop the loop after exactly one round.
 */
const inFlight = new Set<string>()

/** Test seam: the claim set is process-wide. */
export function resetInFlight(): void {
  inFlight.clear()
}

export type CheckDeps = {
  // The exact slice each service is used through, rather than the whole
  // interface. It is the honest contract - this module reads three session
  // methods and one agent method - and it is what lets a test build a real
  // fake instead of casting a stub at a thirty-method interface.
  sessions: Pick<Session.Interface, "get" | "create" | "setMetadata">
  agents: Pick<Agent.Interface, "get">
  ops: Pick<TaskPromptOps, "prompt" | "busy">
  worktree: string
  /** The chat's live model. The critic runs on it — no small-model routing in v1. */
  model: Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }>
  /** The turn that just ended, for the `asked_user` test. */
  lastAssistant: Effect.Effect<SessionV1.WithParts | undefined>
}

/** What one critic run produced. */
export type CriticOutcome =
  | { kind: "met"; evidence: string }
  | { kind: "not_met"; evidence: string }
  | { kind: "error"; reason: string }

/**
 * Spawn the blind critic and read its verdict.
 *
 * Mirrors `tool/task.ts`'s child-session path: create a child under the parent
 * with the subagent-derived permission ruleset, prompt it through the same
 * `TaskPromptOps.prompt`, take the LAST text part as the answer, and treat an
 * error recorded ON the assistant message as a real failure rather than a
 * hollow success (a context overflow does not throw).
 */
/**
 * The critic child's SESSION ruleset.
 *
 * `deriveSubagentSessionPermission` alone is not enough here, and finding that
 * out is what this function exists for. It deliberately carries the parent
 * chat's auto-approve PRESET through to the child - a user who pressed YOLO
 * means it for the whole chat - so a bypassed chat would hand its verifier a
 * `"*": "allow"`, and with it everything the definition denied.
 *
 * WHAT THAT COSTS CHANGED when the critic gained write-to-validate: `edit` is
 * now the definition's own decision, so a preset granting it grants nothing new.
 * What a preset must still never re-open is `task` and `send_message` - a critic
 * that can delegate hands the judgement to something with fewer restrictions,
 * and one that can message the agent under review can be argued with.
 *
 * So the agent's OWN ruleset is re-appended last. `Permission.evaluate` takes
 * the LAST matching rule, so the definition wins over the chat's preset. It is
 * written as "reassert the definition" rather than as a list of denied tool
 * names on purpose: a list would silently fail to cover the next mutating tool
 * anyone adds.
 */
export function criticPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  critic: Agent.Info
}): PermissionV1.Ruleset {
  return [
    ...deriveSubagentSessionPermission({
      parentSessionPermission: input.parentSessionPermission,
      subagent: input.critic,
    }),
    ...input.critic.permission,
  ]
}

export const runCritic = Effect.fn("SessionGoal.runCritic")(function* (
  deps: CheckDeps,
  parent: Session.Info,
  condition: string,
) {
  const critic = yield* deps.agents.get(CRITIC_AGENT)
  if (!critic) return { kind: "error", reason: `the ${CRITIC_AGENT} agent is not available` } satisfies CriticOutcome
  const child = yield* deps.sessions
    .create({
      parentID: parent.id,
      title: `Goal check (@${CRITIC_AGENT} subagent)`,
      agent: critic.name,
      permission: criticPermission({ parentSessionPermission: parent.permission ?? [], critic }),
    })
    .pipe(Effect.exit)
  if (Exit.isFailure(child))
    return {
      kind: "error",
      reason: `could not create the critic session: ${Cause.pretty(child.cause)}`,
    } satisfies CriticOutcome

  const model = yield* deps.model
  const exit = yield* deps.ops
    .prompt({
      messageID: MessageID.ascending(),
      sessionID: child.value.id,
      agent: critic.name,
      model,
      parts: [{ type: "text", text: criticPrompt({ condition, worktree: deps.worktree }) }],
    })
    // Exit, not ignore: `ops.prompt` is `Effect.catch(Effect.die)`, so EVERY
    // failure it has arrives as a defect, and a defect escaping here would take
    // down the forked check with nothing recorded about why.
    .pipe(Effect.exit)
  if (Exit.isFailure(exit))
    return { kind: "error", reason: `the critic run failed: ${Cause.pretty(exit.cause)}` } satisfies CriticOutcome

  const result = exit.value
  const failure = result.info.role === "assistant" ? result.info.error : undefined
  if (failure) return { kind: "error", reason: `the critic run failed: ${failure.name}` } satisfies CriticOutcome

  const evidence = result.parts.findLast((part) => part.type === "text")?.text ?? ""
  const verdict = parseVerdict(evidence)
  if (!verdict) return { kind: "error", reason: "the critic produced no readable VERDICT line" } satisfies CriticOutcome
  return { kind: verdict, evidence } satisfies CriticOutcome
})

/**
 * One post-turn goal check for one session. Safe to call after every turn of
 * every session: it answers immediately for the overwhelming majority that
 * carry no goal.
 */
export const check = Effect.fn("SessionGoal.check")(function* (deps: CheckDeps, sessionID: SessionID) {
  const found = yield* deps.sessions.get(sessionID).pipe(Effect.option)
  if (Option.isNone(found)) return
  const session = found.value
  // A subagent never runs a goal loop of its own — including the critic child
  // this very module spawns, which is the reason the guard is FIRST.
  if (session.parentID) return
  const goal = Session.goal(session)
  if (!goal?.active) return

  // Parked on a human beats everything below it: no round is spent and nothing
  // is injected, because the agent is not the thing that is stuck.
  if (askedUser(yield* deps.lastAssistant)) {
    yield* write(deps, sessionID, { ...goal, lastVerdict: "asked_user" })
    publishTurnEnd(sessionID, "asked_user")
    return
  }

  // A turn already running means the user (or a background result) got there
  // first. That turn ends with a check of its own, so this one steps aside
  // rather than talking over it.
  const busy = yield* deps.ops.busy(sessionID).pipe(Effect.catchCause(() => Effect.succeed(false)))
  if (busy) return

  if (inFlight.has(sessionID)) return
  inFlight.add(sessionID)
  const notice = yield* settle(deps, session, goal).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(sessionID))))
  if (!notice) return

  // Re-read: the critic run took real time, and a user message that landed
  // during it owns the session now. Injecting on top of that would be the goal
  // loop talking over the human.
  const stillIdle = yield* deps.ops.busy(sessionID).pipe(
    Effect.catchCause(() => Effect.succeed(true)),
    Effect.map((b) => !b),
  )
  if (!stillIdle) return
  const current = yield* deps.sessions.get(sessionID).pipe(Effect.option)
  const agent = Option.isSome(current) ? current.value.agent : undefined
  yield* deps.ops
    .prompt({
      messageID: MessageID.ascending(),
      sessionID,
      ...(agent ? { agent } : {}),
      // Synthetic, exactly like the background task drainer's injected result:
      // the model must read it, and the user must not be shown an instruction
      // written on their behalf as if they had typed it.
      parts: [{ type: "text", synthetic: true, text: notice }],
    })
    .pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Exit.isFailure(exit)
          ? Effect.logError("goal continuation injection failed", {
              "session.id": sessionID,
              cause: Cause.pretty(exit.cause),
            })
          : Effect.void,
      ),
    )
})

/**
 * Run the critic, record the outcome on the session row, announce any TERMINAL
 * verdict, and return the text to inject (or undefined for "inject nothing").
 *
 * Every branch WRITES BEFORE IT RETURNS. The round count is the only thing
 * standing between an unreachable condition and an unbounded spend, so it is
 * persisted before the turn it pays for is started, never after.
 */
const settle = Effect.fn("SessionGoal.settle")(function* (deps: CheckDeps, session: Session.Info, goal: Session.Goal) {
  const outcome = yield* runCritic(deps, session, goal.text)

  if (outcome.kind === "met") {
    yield* write(deps, session.id, {
      ...goal,
      active: false,
      completed: true,
      criticErrors: 0,
      lastVerdict: "success",
    })
    publishTurnEnd(session.id, "success")
    return undefined
  }

  if (outcome.kind === "error") {
    const errors = (goal.criticErrors ?? 0) + 1
    // ONE bad critic run is not a broken feature — a provider hiccup, a model
    // that forgot the line. Two in a row is, and carrying on would mean paying
    // for a verifier that cannot verify.
    if (errors < 2) {
      yield* write(deps, session.id, { ...goal, criticErrors: errors })
      yield* Effect.logWarning("goal critic run failed; goal left active", {
        "session.id": session.id,
        reason: outcome.reason,
      })
      return undefined
    }
    yield* write(deps, session.id, {
      ...goal,
      active: false,
      criticErrors: errors,
      lastVerdict: "error_during_execution",
    })
    publishTurnEnd(session.id, "error_during_execution")
    return criticFailedText({ condition: goal.text, reason: outcome.reason })
  }

  if (goal.rounds >= goal.maxRounds) {
    yield* write(deps, session.id, { ...goal, active: false, criticErrors: 0, lastVerdict: "error_max_turns" })
    publishTurnEnd(session.id, "error_max_turns")
    return exhaustedText({ condition: goal.text, maxRounds: goal.maxRounds, evidence: outcome.evidence })
  }

  const round = goal.rounds + 1
  yield* write(deps, session.id, { ...goal, rounds: round, criticErrors: 0 })
  // No `turnEnd` here on purpose: the taxonomy is TERMINAL labels only, and
  // "still working" has no honest label in it. Announcing `success` would lie
  // and announcing an error label would lie differently.
  return continuationText({
    condition: goal.text,
    evidence: outcome.evidence,
    round,
    maxRounds: goal.maxRounds,
  })
})

/** Read-modify-write of the goal record, carrying every other metadata key. */
const write = Effect.fn("SessionGoal.write")(function* (deps: CheckDeps, sessionID: SessionID, next: Session.Goal) {
  const current = yield* deps.sessions.get(sessionID).pipe(Effect.option)
  if (Option.isNone(current)) return
  yield* deps.sessions.setMetadata({
    sessionID,
    metadata: Session.withGoal(current.value.metadata, next),
  })
})

export type { StopReason }

export * as SessionGoal from "./goal"
