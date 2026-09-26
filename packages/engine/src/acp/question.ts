import type { AgentSideConnection, PermissionOption, RequestPermissionResponse } from "@agentclientprotocol/sdk"
import type { Event, OrigamiClient } from "@origami/sdk/v2"
import type { ACPSession } from "./session"
import { describeCause } from "./permission"
import { Effect } from "effect"

type QuestionEvent = Extract<Event, { type: "question.asked" }>
type Connection = Partial<Pick<AgentSideConnection, "requestPermission">>

// The engine asks the user a question by publishing `question.asked` and blocking
// on a Deferred (see question/index.ts). Over ACP the only interactive client call
// is `requestPermission`, so each question is surfaced as a permission prompt, the
// chosen option mapped back to its label, and the reply sent via
// `sdk.question.reply` - mirroring acp/permission.ts. A multi-select question
// (t-xum9v2) is marked `multiple: true` on `_meta.questions`; a client that knows
// it replies `optionIds` and every ticked label is returned. A client that does
// not still answers with one option, as before.
//
// A MULTI-question request is offered as ONE prompt, not N: ACP has no
// many-questions request, so the batch rides `_meta.questions` while the top-level
// `toolCall.title`/`options` keep describing the FIRST question, and a batch-aware
// client returns every answer in `_meta.answers`. `process` re-offers whatever is
// still unanswered, so the loop always shrinks by at least one.
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
      // `process` answers its own failures. This is the last net, and it is never silent.
      .catch((cause) => logAsk(request.id, "was not answered", cause))
      .finally(() => {
        if (this.queues.get(request.sessionID) === next) {
          this.queues.delete(request.sessionID)
        }
      })
    this.queues.set(request.sessionID, next)
  }

  private async process(event: QuestionEvent) {
    const request = event.properties
    const session = await Effect.runPromise(this.input.session.tryGet(request.sessionID)).catch((cause) => {
      logAsk(request.id, `could not resolve session ${request.sessionID}`, cause)
      return undefined
    })
    // NO SESSION, NO SILENCE (as acp/permission.ts). An early return left the
    // question pending with nobody to answer it. There is no session to read a
    // directory off, so the engine's own cwd is used.
    if (!session) {
      console.error(`[acp-question] ask ${request.id}: no registered session for ${request.sessionID}, rejecting it`)
      await this.reject(request.id, process.cwd())
      return
    }

    // t-tc2es2. ERRORS ANSWER THE QUESTION: a client that throws instead of
    // rejecting, or an answer the engine refused, rejects it (logged) instead
    // of leaving it pending with no timeout.
    try {
      await this.answer(request, session.cwd)
    } catch (cause) {
      logAsk(request.id, "failed, rejecting it", cause)
      await this.reject(request.id, session.cwd)
    }
  }

  private async answer(request: QuestionEvent["properties"], directory: string) {
    if (!this.input.connection.requestPermission || request.questions.length === 0) {
      await this.reject(request.id, directory)
      return
    }

    const answers: string[][] = []
    while (answers.length < request.questions.length) {
      // Offer everything still unanswered. A batch-aware client answers the lot in
      // one prompt; a legacy one answers only the head. `round` is always non-empty.
      const round = await this.ask(request, request.questions.slice(answers.length))
      if (!round) {
        await this.reject(request.id, directory)
        return
      }
      answers.push(...round)
    }

    // The SDK RETURNS `{ error }` on a non-2xx instead of throwing; throw it, so
    // `process` rejects the question rather than leaving it pending.
    const result = await this.input.sdk.question.reply({ requestID: request.id, directory, answers })
    if (result?.error) throw new Error(`the engine did not take the answer: ${describeCause(result.error)}`)
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
            ...(question.multiple ? { multiple: true } : {}),
          })),
        },
      })
      .catch((cause) => {
        // The client call failed: no answer, so the caller rejects the question. Logged here.
        logAsk(request.id, "prompt failed, rejecting it", cause)
        return undefined
      })

    return resolveAnswers(result, batch)
  }

  /** Best effort: there is nothing left to fall back to, so a failure is logged. */
  private async reject(requestID: string, directory: string) {
    const result = await this.input.sdk.question
      .reject({ requestID, directory })
      .catch((cause: unknown) => ({ error: cause }))
    if (result?.error) logAsk(requestID, "rejection was not delivered", result.error)
  }
}

/** One stderr line per failure, naming the ask. stderr, never stdout: stdout is the JSON-RPC channel. */
function logAsk(requestID: string, what: string, cause: unknown) {
  console.error(`[acp-question] ask ${requestID} ${what}: ${describeCause(cause)}`)
}

/** Name of the synthetic free-text option, and the reply when it carries none. */
export const OTHER_LABEL = "Other"

type Asked = QuestionEvent["properties"]["questions"][number]

/**
 * The permission options one question is offered with. The last entry is a
 * synthetic escape hatch: a permission prompt can only offer the answers the asker
 * pre-baked, so "Other" is appended with the next free index, leaving the existing
 * optionId-to-label mapping untouched. Free text comes back in `_meta.answerText`.
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
 * Free text the client attached to the outcome, if any. `_meta` is the
 * ACP-sanctioned extension bag: "Implementations MUST NOT make assumptions about
 * values at these keys", so it is read DEFENSIVELY - the key may be absent, null,
 * or any type at all - and yields text only for a non-empty string.
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
 * The reply text for ONE answered question. Typed free text WINS over the picked
 * option: a client that renders a text box next to the choices is telling us the
 * user wrote a real answer. Falling back in order: the option's own label, then
 * "Other" for the synthetic index.
 *
 * `optionId` is `unknown` because on the batched path it comes out of `_meta`. Only
 * a string or number is a pick - `null` and `""` must NOT coerce to index 0.
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
 * t-xum9v2. The labels of a multi-select answer: every ticked option, in the order
 * sent, with typed text in place of the bare "Other". An empty list is a real
 * answer ("none apply"); an id that names no option declines the whole ask.
 */
function ticked(optionIds: unknown[], typed: string | undefined, labels: string[]): string[] | undefined {
  const out: string[] = []
  for (const id of optionIds) {
    const label = answerFor(id, undefined, labels)
    if (label === undefined) return undefined
    if (label === OTHER_LABEL && Number(id) === labels.length && typed) continue
    if (!out.includes(label)) out.push(label)
  }
  if (typed) out.push(typed)
  return out
}

/**
 * Every answer this outcome carries, in the order the batch was offered.
 * `_meta.answers` is the batch reply: one `{ optionId, answerText }` per question a
 * "Question 1 of N" client showed. Absent or unusable means a legacy
 * single-question reply, which answers the HEAD only; the caller re-offers the
 * rest. `undefined` means the user declined.
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
      const question = batch[index]!
      if (question.multiple && Array.isArray(picked["optionIds"])) {
        const all = ticked(picked["optionIds"], trimmedText(picked["answerText"]), labelsOf(question))
        if (all === undefined) return undefined
        answers.push(all)
        continue
      }
      const answer = answerFor(picked["optionId"], trimmedText(picked["answerText"]), labelsOf(question))
      if (answer === undefined) return undefined
      answers.push([answer])
    }
    return answers
  }

  const single = answerFor(result.outcome.optionId, answerText(result.outcome), labelsOf(batch[0]!))
  return single === undefined ? undefined : [[single]]
}

export * as ACPQuestion from "./question"
