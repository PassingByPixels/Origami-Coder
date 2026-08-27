import type { AgentSideConnection, PermissionOption, RequestPermissionResponse } from "@agentclientprotocol/sdk"
import type { Event, OrigamiClient } from "@origami/sdk/v2"
import type { ACPSession } from "./session"
import { Effect } from "effect"

type QuestionEvent = Extract<Event, { type: "question.asked" }>
type Connection = Partial<Pick<AgentSideConnection, "requestPermission">>

// The engine asks the user a question by publishing `question.asked` and
// blocking on a Deferred (see question/index.ts). Over ACP the only
// interactive client call available is `requestPermission`, so we surface each
// question as a permission prompt, map the chosen option back to its label, and
// reply via `sdk.question.reply` — mirroring acp/permission.ts exactly.
//
// Two kinds of question reach an ACP client: plan_exit's single Yes/No
// "switch to build agent?" prompt, and — since the LLM-facing `question` tool
// is now enabled for ACP (see registry.ts questionEnabled) — the model's own
// ask-the-user calls. A multi-select question degrades to the single chosen
// option (faithful for the common single-select case) and never silently drops
// the request.
//
// A MULTI-question request is offered as ONE prompt, not N. ACP has no
// many-questions request, so the batch rides `_meta` — the sanctioned
// extension bag — as `_meta.questions`, while the top-level `toolCall.title`
// and `options` keep describing the FIRST question exactly as before. A client
// that reads `_meta.questions` renders the whole set ("Question 1 of N") and
// returns every answer in `_meta.answers`; a client that ignores it sees the
// unchanged single-question prompt it has always seen. Whatever comes back,
// `process` re-offers the questions still unanswered, so no question is
// dropped and the loop always shrinks by at least one.
export class Handler {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly input: {
      sdk: OrigamiClient
      connection: Connection
      session: ACPSession.Interface
    },
  ) {}

  handle(event: QuestionEvent) {
    const request = event.properties
    const previous = this.queues.get(request.sessionID) ?? Promise.resolve()
    const next = previous
      .then(() => this.process(event))
      .catch(() => {})
      .finally(() => {
        if (this.queues.get(request.sessionID) === next) {
          this.queues.delete(request.sessionID)
        }
      })
    this.queues.set(request.sessionID, next)
  }

  private async process(event: QuestionEvent) {
    const request = event.properties
    const session = await Effect.runPromise(this.input.session.tryGet(request.sessionID))
    if (!session) return

    if (!this.input.connection.requestPermission || request.questions.length === 0) {
      await this.reject(request.id, session.cwd)
      return
    }

    const answers: string[][] = []
    while (answers.length < request.questions.length) {
      // Offer everything still unanswered. A batch-aware client answers the lot
      // in one prompt; a legacy one answers only the head, and the next round
      // re-offers the rest. Either way `round` is non-empty, so this terminates.
      const round = await this.ask(request, request.questions.slice(answers.length))
      if (!round) {
        await this.reject(request.id, session.cwd)
        return
      }
      answers.push(...round)
    }

    await this.input.sdk.question.reply({ requestID: request.id, directory: session.cwd, answers }).catch(() => {})
  }

  /** One permission prompt offering `batch`; the answers it produced, or undefined when declined. */
  private async ask(
    request: QuestionEvent["properties"],
    batch: QuestionEvent["properties"]["questions"],
  ): Promise<string[][] | undefined> {
    const head = batch[0]
    if (!head || !this.input.connection.requestPermission) return undefined

    const result = await this.input.connection
      .requestPermission({
        sessionId: request.sessionID,
        toolCall: {
          toolCallId: request.tool?.callID ?? request.id,
          status: "pending",
          title: head.question,
          kind: "other",
        },
        options: promptOptions(head),
        _meta: {
          questions: batch.map((question) => ({
            question: question.question,
            header: question.header,
            options: promptOptions(question),
          })),
        },
      })
      .catch(() => undefined)

    return resolveAnswers(result, batch)
  }

  private async reject(requestID: string, directory: string) {
    await this.input.sdk.question.reject({ requestID, directory }).catch(() => {})
  }
}

/** Name of the synthetic free-text option, and the reply when it carries none. */
export const OTHER_LABEL = "Other"

type Asked = QuestionEvent["properties"]["questions"][number]

/**
 * The permission options one question is offered with.
 *
 * The last entry is a synthetic escape hatch. A permission prompt can only
 * offer the answers the asker pre-baked, so a user whose real answer is none of
 * them had to pick a wrong one or dismiss the prompt (which rejects the whole
 * question). "Other" is appended with the next free index so the existing
 * optionId-to-label mapping is untouched, and a client that supports free text
 * returns it in `_meta.answerText`.
 */
function promptOptions(question: Asked): PermissionOption[] {
  const options: PermissionOption[] = question.options.map((option, index) => ({
    optionId: String(index),
    kind: index === 0 ? "allow_once" : "reject_once",
    name: option.label,
  }))
  options.push({ optionId: String(question.options.length), kind: "reject_once", name: OTHER_LABEL })
  return options
}

/** A non-empty trimmed string, or undefined for anything else at all. */
function trimmedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Free text the client attached to the outcome, if any.
 *
 * `_meta` is the ACP-sanctioned extension bag: "Implementations MUST NOT make
 * assumptions about values at these keys". So this reads it DEFENSIVELY - the
 * key may be absent, null, or any type at all - and yields text only for a
 * non-empty string.
 */
function answerText(outcome: unknown): string | undefined {
  return trimmedText(metaOf(outcome)?.answerText)
}

/** The outcome's `_meta` bag when it is one, read as defensively as answerText. */
function metaOf(outcome: unknown): Record<string, unknown> | undefined {
  if (typeof outcome !== "object" || outcome === null) return undefined
  const meta = (outcome as { _meta?: unknown })._meta
  if (typeof meta !== "object" || meta === null) return undefined
  return meta as Record<string, unknown>
}

/**
 * The reply text for ONE answered question.
 *
 * Typed free text WINS over the picked option, whichever option that was: a
 * client that renders a text box next to the choices is telling us the user
 * wrote a real answer, and silently replying with the button's label instead
 * would discard it. Falling back in order: the option's own label, then
 * "Other" for the synthetic index (an "Other" pick with no text is still an
 * answer, not a rejection).
 *
 * `optionId` is `unknown` because on the batched path it comes out of `_meta`.
 * Only a string or number is a pick — `null` and `""` must NOT coerce to index 0
 * and silently answer with the first label the user never chose.
 */
function answerFor(optionId: unknown, typed: string | undefined, labels: string[]): string | undefined {
  if (typed) return typed
  if (typeof optionId !== "string" && typeof optionId !== "number") return undefined
  if (typeof optionId === "string" && optionId.trim() === "") return undefined
  const index = Number(optionId)
  if (!Number.isInteger(index) || index < 0 || index > labels.length) return undefined
  return index === labels.length ? OTHER_LABEL : labels[index]
}

/**
 * Every answer this outcome carries, in the order the batch was offered.
 *
 * `_meta.answers` is the batch reply: one `{ optionId, answerText }` per
 * question a "Question 1 of N" client showed. Absent (or unusable) means a
 * legacy single-question reply, which answers the HEAD only — the caller then
 * re-offers the rest. A short array is fine for the same reason. `undefined`
 * means the user declined, and the whole request is rejected.
 */
function resolveAnswers(
  result: RequestPermissionResponse | undefined,
  batch: ReadonlyArray<Asked>,
): string[][] | undefined {
  if (!result || result.outcome.outcome !== "selected") return undefined
  const labelsOf = (question: Asked) => question.options.map((option) => option.label)

  const batched = metaOf(result.outcome)?.answers
  if (Array.isArray(batched) && batched.length > 0) {
    const answers: string[][] = []
    for (const [index, entry] of batched.slice(0, batch.length).entries()) {
      const picked = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {}
      const answer = answerFor(picked["optionId"], trimmedText(picked["answerText"]), labelsOf(batch[index]!))
      if (answer === undefined) return undefined
      answers.push([answer])
    }
    return answers
  }

  const single = answerFor(result.outcome.optionId, answerText(result.outcome), labelsOf(batch[0]!))
  return single === undefined ? undefined : [[single]]
}

export * as ACPQuestion from "./question"
