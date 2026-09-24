import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { QuestionID } from "../question/schema"
import { Permission } from "@/permission"
import type { AgentPost } from "@/session/agent-post"
import { Session } from "@/session/session"
import { SubagentQuestion } from "@/session/subagent-question"
import { SubagentQuestionRoute } from "@/session/subagent-question-route"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
  /** Set when the question went to the parent agent instead of the user. */
  askedParent?: string
}

/**
 * t-po041k. A SUB-AGENT'S QUESTION GOES TO ITS PARENT, never to the user.
 *
 * The child's own window does not exist, so the ask used to park on a Deferred
 * that `acp/question.ts` could not surface (a child session is not in the ACP
 * session store) and the parent's `task` call froze behind it for the life of
 * the session. Routing it up gives the question somewhere to land and the
 * parent's model somebody to answer to — it decides, or it asks the user in its
 * own chat, which is where the permission to ask actually lives.
 *
 * `relay` runs INSIDE `Question.ask`, after the entry is pending, so a parent
 * that answers instantly cannot beat the request it is answering. The whole
 * wait runs inside `Permission.blockWhile`, because the only deadline a parked
 * child has left is the 4 h job ceiling and this wait must not spend it.
 */
export const relayToParent = (
  input: {
    sessionID: Session.Info["id"]
    requestID: QuestionID
    routing: SubagentQuestionRoute.Routing
  },
  // The POST and the locate, as seams. Production passes nothing; the flow test
  // hands in a capturing pair rather than standing up a second engine, which is
  // the same trade `flock/deliver.ts` makes for the same wire.
  deps: AgentPost.PostDeps = {},
) =>
  Effect.fn("QuestionTool.relay")(function* (request: Question.Request) {
    const outcome = yield* Effect.promise(() =>
      SubagentQuestion.deliver({
        label: input.routing.label,
        sessionID: input.sessionID,
        requestID: input.requestID,
        ancestors: input.routing.ancestors,
        questions: request.questions.map((q) => ({
          question: q.question,
          ...(q.options?.length ? { options: q.options.map((option) => option.label) } : {}),
        })),
      }, deps),
    )
    if (outcome.ok) return
    // A refusal, not a hang: the child is told nobody could be reached and
    // carries on under its own judgement, exactly as a cancelled question does.
    yield* Effect.logWarning("subagent question not delivered", { sessionID: input.sessionID, reason: outcome.reason })
    return yield* Effect.fail(new Question.RejectedError())
  })

/** The result for a question that came back with no answers. The WORDS differ
 *  by route and that difference is the point: a top-level chat's question was
 *  really dismissed by the user, while a child's either never reached a chat or
 *  was abandoned by the parent's agent - the user may never have seen it. */
function unanswered(
  questions: ReadonlyArray<{ question: string }>,
  routing: SubagentQuestionRoute.Routing | undefined,
) {
  const listed = questions.map((q) => `"${q.question}"`).join(", ")
  const tail =
    ". Do not ask them again. Continue the task using your own best judgement, " +
    "and say which assumption you made in place of each answer."
  return {
    title: `Cancelled ${questions.length} question${questions.length > 1 ? "s" : ""}`,
    output: routing
      ? `Your questions did NOT reach the main agent, or it did not answer them: ${listed}${tail}`
      : `The user CANCELLED your questions and gave no answers: ${listed}${tail}`,
    metadata: { answers: [] as ReadonlyArray<Question.Answer> },
  }
}

export const QuestionTool = Tool.define<
  typeof Parameters,
  Metadata,
  Question.Service | Permission.Service | Session.Service
>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const routing = yield* SubagentQuestionRoute.routingFor(sessions, ctx.sessionID).pipe(
            // A session the store cannot produce is not a reason to lose the
            // question; fall back to asking the user, which is what every
            // top-level chat does anyway.
            Effect.catch(() => Effect.succeed(undefined)),
          )
          const requestID = QuestionID.ascending()
          const ask = question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            ...(ctx.callID ? { tool: { messageID: ctx.messageID, callID: ctx.callID } } : {}),
            ...(routing
              ? { id: requestID, relay: relayToParent({ sessionID: ctx.sessionID, requestID, routing }) }
              : {}),
          })
          const answers = yield* (routing ? permission.blockWhile(ctx.sessionID, ask) : ask).pipe(
            // Dismissing the prompt is a decline to answer, not a failure. Left
            // as a RejectedError it reaches SessionProcessor.failToolCall, which
            // sets `ctx.blocked` and halts the turn. Answer the tool call
            // normally instead, so the model learns the questions went
            // unanswered and carries on. plan_exit is deliberately not given
            // this treatment: it throws RejectedError to mean "stay in plan
            // mode" (tool/plan.ts).
            //
            // HERE rather than around the whole `execute`, because the sentence
            // depends on `routing`: on the parent route nobody cancelled
            // anything — either the envelope never reached a chat, or the
            // parent's agent stopped — and telling a child "the user CANCELLED
            // your questions" would name a person who was never shown them.
            Effect.catchTag("QuestionRejectedError", () => Effect.succeed(undefined)),
          )
          if (!answers) return unanswered(params.questions, routing)

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: routing
              ? `Asked the main agent ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`
              : `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: routing
              ? `The main agent answered your questions: ${formatted}. Continue with those answers in mind.`
              : `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
              ...(routing ? { askedParent: routing.label } : {}),
            },
          }
        }).pipe(
          Effect.orDie,
        ),
    }
  }),
)
