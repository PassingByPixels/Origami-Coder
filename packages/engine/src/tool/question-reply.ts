import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { QuestionID } from "../question/schema"
import { Session } from "@/session/session"
import { SubagentQuestion } from "@/session/subagent-question"
import { SubagentQuestionRoute } from "@/session/subagent-question-route"

/**
 * THE PARENT'S END of a sub-agent's question (t-po041k).
 *
 * It mirrors `flock_reply`: a question arrived in this chat as a peer-message
 * envelope naming a request id, and this is the one call that releases the
 * agent waiting on it. Nothing written in the chat reaches the child — the
 * envelope says so, and this tool is the reason that sentence is true.
 *
 * NO PERMISSION GATE, deliberately, and this is the security line worth stating
 * plainly: answering a question is not granting a permission. The child's own
 * ruleset still decides every tool call it makes with the answer. A gate here
 * would only put a dialog in front of the user for the one thing this ticket
 * exists to keep off their screen.
 */

export const Parameters = Schema.Struct({
  request_id: Schema.String.annotate({
    description: 'The request id from the sub-agent question envelope, e.g. "que_...".',
  }),
  answers: Schema.mutable(Schema.Array(Schema.String)).annotate({
    description:
      "One answer per question the sub-agent asked, in the order it asked them. Where the envelope listed options, answer with one of those labels.",
  }),
})

type Metadata = { requestID: string; answered: boolean }

const DESCRIPTION = [
  `ANSWER a question one of your own sub-agents asked you — it arrived in this chat tagged "${SubagentQuestion.QUESTION_KIND}".`,
  "The agent is blocked until you call this, and it cannot read anything you write in the chat.",
  "Give one answer per question, in the order the envelope listed them.",
  "Answer yourself when you know the answer; ask the user first only when the decision is theirs.",
].join(" ")

function refusal(requestID: string, output: string) {
  return { title: "question_reply: refused", metadata: { requestID, answered: false }, output }
}

export const QuestionReplyTool = Tool.define<typeof Parameters, Metadata, Question.Service | Session.Service>(
  "question_reply",
  Effect.gen(function* () {
    const question = yield* Question.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const requestID = params.request_id.trim()
          if (!requestID) return refusal(requestID, "Refused: request_id is empty. It is on the question envelope.")
          const pending = yield* question.list()
          const target = pending.find((row) => row.id === requestID)
          if (!target) {
            // Named alternatives, not a bare miss: the model must be able to
            // fix the id inside the same turn rather than guess again.
            const open = pending.map((row) => row.id)
            return refusal(
              requestID,
              `Refused: no sub-agent is waiting on request ${requestID}. It may have been answered or the agent may have stopped.` +
                ` Open requests right now: ${open.length ? open.join(", ") : "(none)"}.`,
            )
          }
          // Your OWN sub-agents only. `Question.list()` spans every session this
          // engine holds, and an agent answering a question asked in somebody
          // else's chat is the cross-tree reach children are denied elsewhere.
          const mine = yield* SubagentQuestionRoute.descendsFrom(sessions, target.sessionID, ctx.sessionID).pipe(
            Effect.catch(() => Effect.succeed(false)),
          )
          if (!mine) {
            return refusal(
              requestID,
              `Refused: request ${requestID} was asked by a session that is not one of your sub-agents.` +
                " You can only answer agents you launched.",
            )
          }
          if (params.answers.length !== target.questions.length) {
            return refusal(
              requestID,
              `Refused: that agent asked ${target.questions.length} question${target.questions.length > 1 ? "s" : ""}` +
                ` and you gave ${params.answers.length} answer${params.answers.length === 1 ? "" : "s"}.` +
                " Answer every question, in order.",
            )
          }
          // One label per question. The child's tool result joins each answer
          // array, so a single-element array is the honest shape for free text.
          const answers = params.answers.map((answer) => [answer])
          const replied = yield* question.reply({ requestID: QuestionID.make(requestID), answers }).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
          if (!replied) {
            return refusal(requestID, `Refused: request ${requestID} is no longer waiting for an answer.`)
          }
          return {
            title: `question_reply ${requestID}`,
            metadata: { requestID, answered: true },
            output: "The sub-agent has your answer and has resumed. It will report back on its own.",
          }
        }),
    }
  }),
)
