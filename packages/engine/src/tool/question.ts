import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
            },
          }
        }).pipe(
          // Dismissing the prompt is a DECLINE TO ANSWER, not a failure. Left as
          // a RejectedError it reaches SessionProcessor.failToolCall, which sets
          // `ctx.blocked` and halts the turn — the user cancels a clarifying ask
          // and the whole run stops. Answer the tool call normally instead, so
          // the model learns the questions went unanswered and carries on.
          // plan_exit is deliberately NOT given this treatment: it throws
          // RejectedError to MEAN "stay in plan mode" (tool/plan.ts).
          Effect.catchTag("QuestionRejectedError", () =>
            Effect.succeed({
              title: `Cancelled ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
              output:
                "The user CANCELLED your questions and gave no answers: " +
                params.questions.map((q) => `"${q.question}"`).join(", ") +
                ". Do not ask them again. Continue the task using your own best judgement, " +
                "and say which assumption you made in place of each answer.",
              metadata: { answers: [] as ReadonlyArray<Question.Answer> },
            }),
          ),
          Effect.orDie,
        ),
    }
  }),
)
