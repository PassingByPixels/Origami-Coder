/**
 * GOAL MODE — a durable per-session completion condition that keeps a chat
 * working across turns until an independent reviewer says the condition is met.
 *
 * The goal is one record on the session row's metadata bag. At the end of every
 * turn of a PRIMARY session that carries an active goal, this module:
 *
 *   1. lets the turn end normally — the check is FORKED from `SessionPrompt.loop`,
 *      never inline in `runLoop`, so the UI stays live and the user can interject;
 *   2. spawns a BLIND critic child session (`goal-critic`) told the condition and
 *      nothing else — it never sees the parent transcript, because a critic that
 *      reads the narrative grades the narrative. It may write to VALIDATE but
 *      never to repair the work; that contract lives in its prompt;
 *   3. on NOT MET with rounds left, injects ONE synthetic continuation turn
 *      carrying the critic's evidence verbatim;
 *   4. on any TERMINAL outcome, announces it on `origami/turnEnd` (turn-end.ts).
 *
 * The critic is a child session, not a `task` call, so the check cannot depend on
 * the model deciding to run it; the spawn MIRRORS `tool/task.ts` rather than
 * reusing it. Deliberately absent: mid-loop verdicts, because the `turnEnd`
 * taxonomy is TERMINAL labels only; and a goal for a subagent, since only a
 * session with no `parentID` runs the loop — which also stops the critic child
 * from starting a loop of its own.
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
import { SessionUsageLimit } from "./usage-limit"
import type { Err } from "./retry"

/** The hidden native subagent that does the verifying (agent/agent.ts). */
export const CRITIC_AGENT = "goal-critic"

/** The line the critic must end on, and the only thing parsed out of its run. */
export const VERDICT_MET = "VERDICT: MET"
export const VERDICT_NOT_MET = "VERDICT: NOT MET"

export type Verdict = "met" | "not_met"

/**
 * The verdict a critic run produced, or undefined when it produced none.
 *
 * Lenient in one direction only: wrappers (bold, code fence, bullet) are read,
 * but nothing is guessed — a run with no readable line answers undefined, which
 * the caller counts as an ERROR and never as met. Last match wins, because a
 * critic that restates the instruction at the top answers at the bottom.
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
 * Did this turn end with a question to the user still outstanding? The engine
 * has exactly one machine-readable "waiting on a human" state: an UNSETTLED
 * `question` tool call on the turn's last assistant message. A question asked in
 * prose is deliberately not detected — not machine readable without a second
 * model call.
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
 * worktree and the rules — no transcript, no plan, no summary of what the agent
 * says it did, because those are the claims under review.
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

/** The synthetic turn injected when a critic run failed but the goal survives it,
 *  so the loop never stalls silently with nothing in the transcript. */
export function criticRetryFailedText(input: { condition: string; reason: string }): string {
  return [
    `[goal] Goal check failed (${input.reason}); the goal stays armed, next round in 1.`,
    "",
    `CONDITION: ${input.condition}`,
    "",
    "This is a verification hiccup, not a verdict on the work. Continue toward the condition above;",
    "the goal will be checked again after the next round.",
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

/**
 * The hard usage-limit error the last turn ended on, read with the same
 * detector `retry.ts` already uses on the SAME turn (`session/usage-limit.ts`)
 * - no repeat inside the window can change the answer, so this is a fact
 * about the turn that just ended, not a new classifier.
 */
function usageLimit(
  last: SessionV1.WithParts | undefined,
): { limit: SessionUsageLimit.Limit; provider: string } | undefined {
  if (!last || last.info.role !== "assistant" || !last.info.error) return undefined
  const limit = SessionUsageLimit.detect(last.info.error)
  if (!limit) return undefined
  return { limit, provider: last.info.providerID }
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
 * check is still running must NOT start a second critic — both would read the
 * round count, find room, and inject. The claim is released BEFORE the
 * continuation is injected, deliberately: the injected turn forks its OWN check,
 * and a claim held across the injection would stop the loop after one round.
 */
const inFlight = new Set<string>()

/** Test seam: the claim set is process-wide. */
export function resetInFlight(): void {
  inFlight.clear()
}

export type CheckDeps = {
  // The exact slice each service is used through, so a test can build a real
  // fake instead of casting a stub at a thirty-method interface.
  sessions: Pick<Session.Interface, "get" | "create" | "setMetadata">
  agents: Pick<Agent.Interface, "get">
  ops: Pick<TaskPromptOps, "prompt" | "busy">
  worktree: string
  /** The chat's live model. The critic runs on it — no small-model routing. */
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
 * The critic child's SESSION ruleset.
 *
 * `deriveSubagentSessionPermission` alone is not enough: it carries the parent
 * chat's auto-approve PRESET through to the child, so a bypassed chat would hand
 * its verifier a `"*": "allow"` and with it everything the definition denied. A
 * preset must never re-open `task` or `send_message` — a critic that can
 * delegate hands the judgement to something less restricted, and one that can
 * message the agent under review can be argued with. So the agent's OWN ruleset
 * is re-appended last: `Permission.evaluate` takes the LAST matching rule, so
 * the definition wins. Written as "reassert the definition" rather than a list
 * of denied tool names, which would miss the next mutating tool anyone adds.
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

/**
 * The critic's error text, for the WARN log line and `criticRetryFailedText` /
 * `criticFailedText`. `failure.name` alone (`"UnknownError"`, `"APIError"`)
 * told nobody what actually happened - three WARNs in one burst carried only
 * that (t-tauw49 B#8). Names the provider and model the critic ran on (its
 * own model call, same as the parent's), the HTTP status when the provider
 * gave one, and the provider's own sentence rather than the error's class name.
 */
function criticFailureReason(model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }, failure: Err): string {
  const isAPIError = SessionV1.APIError.isInstance(failure)
  const status = isAPIError && failure.data.statusCode !== undefined ? ` (status ${failure.data.statusCode})` : ""
  const sentence = isAPIError ? failure.data.message : failure.name
  return `${model.providerID}/${model.modelID}${status}: ${sentence}`
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
    // Exit, not ignore: `ops.prompt` is `Effect.catch(Effect.die)`, so every
    // failure arrives as a defect, and one escaping here would take down the
    // forked check with nothing recorded about why.
    .pipe(Effect.exit)
  if (Exit.isFailure(exit))
    return { kind: "error", reason: `the critic run failed: ${Cause.pretty(exit.cause)}` } satisfies CriticOutcome

  const result = exit.value
  // An error recorded ON the assistant message is a real failure, not a hollow
  // success: a context overflow does not throw.
  const failure = result.info.role === "assistant" ? result.info.error : undefined
  if (failure) return { kind: "error", reason: `the critic run failed: ${criticFailureReason(model, failure)}` } satisfies CriticOutcome

  const evidence = result.parts.findLast((part) => part.type === "text")?.text ?? ""
  const verdict = parseVerdict(evidence)
  if (!verdict) return { kind: "error", reason: "the critic produced no readable VERDICT line" } satisfies CriticOutcome
  return { kind: verdict, evidence } satisfies CriticOutcome
})

/** One post-turn goal check. Safe to call after every turn of every session: it
 *  answers immediately for the majority that carry no goal. */
export const check = Effect.fn("SessionGoal.check")(function* (deps: CheckDeps, sessionID: SessionID) {
  const found = yield* deps.sessions.get(sessionID).pipe(Effect.option)
  if (Option.isNone(found)) return
  const session = found.value
  // A subagent never runs a goal loop of its own — including the critic child
  // this very module spawns, which is the reason the guard is FIRST.
  if (session.parentID) return
  const goal = Session.goal(session)
  if (!goal?.active) return

  const lastAssistant = yield* deps.lastAssistant

  // Parked on a human beats everything below: no round spent, nothing injected.
  if (askedUser(lastAssistant)) {
    yield* write(deps, sessionID, { ...goal, lastVerdict: "asked_user" })
    publishTurnEnd(sessionID, "asked_user")
    return
  }

  // A hard usage limit beats everything below too, and for the same reason a
  // parked question does: nothing here can make the next call succeed. Before
  // this check, `check` ran straight into `settle`, which spent a critic call
  // (retried once) against the SAME spent window, then injected a continuation
  // that started the build turn again - seven requests in seven seconds against
  // a window that would not reset for another 2.9 hours (t-tauw49 B#8). No round
  // is spent and nothing is injected: injecting a turn here would only place
  // another call against the same limit.
  const limit = usageLimit(lastAssistant)
  if (limit) {
    yield* write(deps, sessionID, {
      ...goal,
      active: false,
      lastVerdict: SessionUsageLimit.notice(limit.limit, limit.provider),
    })
    publishTurnEnd(sessionID, "error_during_execution")
    return
  }

  // A turn already running ends with a check of its own, so this one steps
  // aside rather than talking over it.
  const busy = yield* deps.ops.busy(sessionID).pipe(Effect.catchCause(() => Effect.succeed(false)))
  if (busy) return

  if (inFlight.has(sessionID)) return
  inFlight.add(sessionID)
  const notice = yield* settle(deps, session, goal).pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(sessionID))))
  if (!notice) return

  // Re-read: the critic run took real time, and a user message that landed
  // during it owns the session now.
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
      // Synthetic, like the background task drainer's injected result: the model
      // must read it, but it must not appear as if the user typed it.
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
  let outcome = yield* runCritic(deps, session, goal.text)
  // One retry, immediately, before a failed run counts against the goal at all.
  if (outcome.kind === "error") {
    outcome = yield* runCritic(deps, session, goal.text)
  }

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
    // One bad critic run is a hiccup; two in a row is a verifier that cannot.
    if (errors < 2) {
      yield* write(deps, session.id, { ...goal, criticErrors: errors })
      yield* Effect.logWarning("goal critic run failed; goal left active", {
        "session.id": session.id,
        reason: outcome.reason,
      })
      // Visible, not silent: a round with nothing injected here is a round the
      // user never sees end.
      return criticRetryFailedText({ condition: goal.text, reason: outcome.reason })
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
