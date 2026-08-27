import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./goal.txt"
import { Session } from "@/session/session"
import { SessionGoal } from "@/session/goal"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["set", "clear", "status"]).annotate({
    description: "set = start/replace the goal, clear = stop the loop, status = report the current goal",
  }),
  condition: Schema.optional(Schema.String).annotate({
    description:
      "Required for `set`. The completion condition, written so a reviewer who cannot see this conversation can check it against the workspace alone.",
  }),
  max_rounds: Schema.optional(Schema.Finite).annotate({
    description: "Optional for `set`. How many continuation rounds the goal may spend before it gives up (default 10).",
  }),
})

type Metadata = {
  goal?: Session.Goal
}

/**
 * The model-facing half of GOAL MODE. The engine half - the critic, the
 * continuation and the round budget - is session/goal.ts, which reads exactly
 * the record this tool writes.
 *
 * Modelled on `todowrite`: one small tool, one write to per-session state, and
 * the permission ask so a ruleset can close it. The read (`status`) is NOT
 * behind the ask - prompting a human to approve a report of state they already
 * own is a prompt that teaches people to click through prompts.
 */
export const GoalTool = Tool.define<typeof Parameters, Metadata, Session.Service>(
  "goal",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          const current = Session.goal(session)

          if (params.action === "status") {
            return {
              title: current?.active ? "Goal active" : "No active goal",
              output: SessionGoal.describe(current),
              metadata: { ...(current ? { goal: current } : {}) },
            }
          }

          yield* ctx.ask({
            permission: "goal",
            patterns: ["*"],
            always: ["*"],
            metadata: { action: params.action },
          })

          if (params.action === "clear") {
            if (!current) {
              return { title: "No goal to clear", output: "This session had no goal set.", metadata: {} }
            }
            yield* sessions.setMetadata({
              sessionID: ctx.sessionID,
              metadata: Session.withGoal(session.metadata, undefined),
            })
            return {
              title: "Goal cleared",
              output: `Goal cleared. The session will no longer continue on its own.\nWas: ${current.text}`,
              metadata: {},
            }
          }

          const condition = params.condition?.trim()
          if (!condition) {
            return {
              title: "Goal not set",
              output:
                "`set` needs a `condition`: the completion condition, written so a reviewer who cannot see this conversation can check it against the workspace alone. Nothing was changed.",
              metadata: { ...(current ? { goal: current } : {}) },
            }
          }

          // A `set` always RESTARTS the budget, including a set that repeats the
          // same words. Carrying the old round count over would let a re-set
          // silently inherit an almost-spent budget and stop after one round,
          // which reads as the feature being broken rather than as the budget
          // being where the user left it.
          const rounds =
            params.max_rounds !== undefined && Number.isFinite(params.max_rounds) && params.max_rounds >= 1
              ? Math.floor(params.max_rounds)
              : Session.GOAL_MAX_ROUNDS_DEFAULT
          const next: Session.Goal = {
            text: condition,
            active: true,
            rounds: 0,
            maxRounds: rounds,
            createdAt: Date.now(),
          }
          yield* sessions.setMetadata({
            sessionID: ctx.sessionID,
            metadata: Session.withGoal(session.metadata, next),
          })
          return {
            title: "Goal set",
            output: [
              `Goal set (up to ${rounds} continuation rounds): ${condition}`,
              "",
              "At the end of every turn an independent reviewer will check this condition against",
              "the workspace and report MET or NOT MET. A NOT MET report comes back to you as your next turn.",
              "Call this tool with action=clear to stop.",
            ].join("\n"),
            metadata: { goal: next },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
