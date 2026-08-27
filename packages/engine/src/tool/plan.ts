import path from "path"
import { SessionV1 } from "@origami/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const Parameters = Schema.Struct({})

/**
 * The two planning agents this tool ends a turn for. `plan` delivers ONE file
 * and approval means "now build it"; `deep-plan` delivers a FOLDER and approval
 * means "handed over" - the user approved a piece of research, not a start
 * order. Everything below that differs between them differs for that reason.
 */
const PLANNING_AGENTS = ["plan", "deep-plan"] as const

type PlanningAgent = (typeof PLANNING_AGENTS)[number]

const planningAgent = (name: string): name is PlanningAgent => (PLANNING_AGENTS as readonly string[]).includes(name)

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // plan_exit only means something in a planning mode. If the model
          // calls it from another agent (e.g. build, out of habit after a
          // plan→build switch), there's no plan to exit — return a gentle note
          // instead of asking a confusing "switch to build?" question or erroring.
          if (!planningAgent(ctx.agent)) {
            return {
              title: "Not in plan mode",
              output:
                "You're in the build agent, so there's no plan to exit — plan_exit only applies in plan mode. " +
                "If you've drafted a plan, share it with the user and ask whether to proceed. " +
                "(Plan mode is entered from the mode selector.)",
              metadata: {},
            }
          }
          const deep = ctx.agent === "deep-plan"
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(
            instance.worktree,
            deep ? Session.planFolder(info, instance) : Session.plan(info, instance),
          )
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: deep
                  ? `Deep plan at ${plan} is complete. Deliver it and switch to the build agent?`
                  : `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                header: "Build Agent",
                custom: false,
                options: [
                  {
                    label: "Yes",
                    description: deep
                      ? "Switch to build agent — the plan folder is delivered, execution does not start"
                      : "Switch to build agent and start implementing the plan",
                  },
                  {
                    label: "No",
                    description: deep
                      ? "Stay in deep-plan mode — keep researching and refining"
                      : "Stay in plan mode — keep refining the plan",
                  },
                  {
                    label: "Revise",
                    description: deep
                      ? "Stay in deep-plan mode; you'll get a text box to tell the agent what to change"
                      : "Stay in plan mode; you'll get a text box to tell the agent what to change",
                  },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          // Only an explicit "Yes" switches to the build agent. "No", "Revise",
          // and a cancelled/empty answer all stay in the planning mode. When the
          // user picks "Revise" the SHELL captures their revision text and sends
          // it as the next planning turn — the engine just declines the switch.
          if (answers[0]?.[0] !== "Yes") yield* new Question.RejectedError()

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()
          // provider.defaultModel() carries no variant; a user-message model may.
          const modelVariant = lastUser?.info.role === "user" ? lastUser.info.model?.variant : undefined

          const msg: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          // The synthetic build message below only lands in the LEGACY message
          // table, while the permission ruleset resolves from the session's
          // persisted agent (SessionTable.agent) — which plan_exit never moved,
          // so after approval the plan agent's edit:deny ruleset stayed active
          // for the rest of the turn (edits denied, toggle stuck on plan).
          // setAgentModel is THE single durable agent/model write path (same one
          // createUserMessage uses on a normal mode switch): flip to build so the
          // next step runs with build permissions.
          yield* session.setAgentModel({
            sessionID: ctx.sessionID,
            agent: "build",
            model: {
              id: model.modelID,
              providerID: model.providerID,
              variant: modelVariant ?? "default",
            },
            time: Date.now(),
          })
          yield* session.updateMessage(msg)
          // THE ONE LINE THAT MAKES DEEP PLAN A DIFFERENT PRODUCT. Plan mode's
          // approval is a start order; deep plan's is a HANDOVER. The user
          // approved a researched, critiqued plan as a deliverable, and reading
          // that as "begin" would start a large piece of work nobody asked for
          // — which is precisely the outcome deep plan exists to prevent.
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: deep
              ? `The deep plan at ${plan} has been approved and DELIVERED. Do NOT begin executing it and do NOT create anything it describes. Briefly present what the folder contains — the phases in PLAN.md, the key decisions, and where the research and critique rounds live — then stop and wait for the user.`
              : `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
            synthetic: true,
          } satisfies SessionV1.TextPart)

          return {
            title: deep ? "Deep plan delivered" : "Switching to build agent",
            output: deep
              ? "User approved the deep plan. It is DELIVERED, not started — present the folder and wait for further instructions."
              : "User approved switching to build agent. Wait for further instructions.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
