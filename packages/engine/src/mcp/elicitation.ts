import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client"
import { Effect } from "effect"
import { LocalContext } from "@/util/local-context"
import { Question } from "@/question"
import type { MessageID, SessionID } from "@/session/schema"

/**
 * MRTR (protocol revision 2026-07-28) replaces the server->client elicitation
 * request with an `input_required` result on the ORIGINAL call. The SDK fulfils
 * it automatically (`ClientOptions.inputRequired.autoFulfill`, default `true`)
 * by dispatching the embedded request to the handler registered for
 * `elicitation/create` and then retrying the call. We keep that default: the
 * alternative (`autoFulfill: false`) hands us a typed error per call site and we
 * would have to re-implement the retry loop the SDK already owns.
 *
 * The consequence is that the elicitation handler runs INSIDE
 * `client.callTool()`, on the caller's async stack but with no argument that
 * says which session asked. One MCP client is shared by every session, so a
 * field on the client would race between concurrent tool calls. The caller
 * identity therefore travels in AsyncLocalStorage, established at the two tool
 * call sites (`session/tools.ts` and `tool/code-mode.ts`) and read here.
 */
export interface Caller {
  readonly sessionID: SessionID
  readonly messageID?: MessageID
  readonly callID?: string
}

/**
 * Per-call state. `dismissed` latches when the human dismisses an elicitation:
 * the SDK RETRIES the original call after a `cancel`, and a server that answers
 * every non-acceptance with the same `input_required` would otherwise put the
 * prompt back in front of the human on every round, up to `maxRounds`. Once
 * dismissed, later rounds of the SAME call answer `cancel` without asking again.
 * The remaining rounds are wasted round trips, bounded by the SDK's `maxRounds`,
 * but the human is asked exactly once.
 */
interface Entry {
  readonly caller: Caller
  dismissed: boolean
}

const storage = LocalContext.create<Entry>("mcp.elicitation")

/** Runs `fn` with `caller` visible to any elicitation raised inside it. */
export function withCaller<R>(caller: Caller, fn: () => R): R {
  return storage.provide({ caller, dismissed: false }, fn)
}

function entry(): Entry | undefined {
  try {
    return storage.use()
  } catch {
    return undefined
  }
}

/** The caller of the in-flight MCP request, or undefined outside a tool call. */
export function caller(): Caller | undefined {
  return entry()?.caller
}

type FormParams = Extract<ElicitRequest["params"], { requestedSchema: unknown }>
type FieldSchema = FormParams["requestedSchema"]["properties"][string]

const HEADER_MAX = 30

const header = (value: string) => (value.length <= HEADER_MAX ? value : value.slice(0, HEADER_MAX - 1) + "...")

/** Choice labels a field offers, or [] when it wants free text. */
function choices(field: FieldSchema): { label: string; description: string }[] {
  if (field.type === "boolean") {
    return [
      { label: "Yes", description: "Answer yes" },
      { label: "No", description: "Answer no" },
    ]
  }
  if ("enum" in field && Array.isArray(field.enum)) {
    const names = "enumNames" in field && Array.isArray(field.enumNames) ? field.enumNames : undefined
    return field.enum.map((value, index) => ({ label: value, description: names?.[index] ?? value }))
  }
  if ("oneOf" in field && Array.isArray(field.oneOf)) {
    return field.oneOf.map((entry) => ({ label: entry.const, description: entry.title }))
  }
  if (field.type === "array") {
    const items = field.items
    if ("enum" in items && Array.isArray(items.enum)) {
      const names = "enumNames" in items && Array.isArray(items.enumNames) ? items.enumNames : undefined
      return items.enum.map((value, index) => ({ label: value, description: names?.[index] ?? value }))
    }
    if ("oneOf" in items && Array.isArray(items.oneOf)) {
      return items.oneOf.map((entry) => ({ label: entry.const, description: entry.title }))
    }
  }
  return []
}

/** One MCP form field becomes one question in the standard question-tool UX. */
function toQuestion(name: string, field: FieldSchema, message: string, first: boolean): Question.Info {
  const title = "title" in field && field.title ? field.title : name
  const detail = "description" in field && field.description ? field.description : title
  const options = choices(field)
  return {
    // The server's overall message only makes sense once, so it leads the first
    // question rather than repeating on every field.
    question: first ? `${message} - ${detail}` : detail,
    header: header(title),
    options,
    multiple: field.type === "array",
    // A field with a fixed choice list must not accept free text; anything else
    // has no list to pick from and would be unanswerable without it.
    custom: options.length === 0,
  }
}

/** Turn the selected labels back into the value type the field declared. */
function toValue(field: FieldSchema, answer: readonly string[]): string | number | boolean | string[] | undefined {
  if (answer.length === 0) return undefined
  if (field.type === "array") return [...answer]
  const first = answer[0]!
  if (field.type === "boolean") return first.toLowerCase() === "yes" || first.toLowerCase() === "true"
  if (field.type === "number" || field.type === "integer") {
    const parsed = Number(first)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return first
}

/**
 * Ask the human an MCP elicitation through the question tool's UX.
 *
 * `decline` (rather than `cancel`) is the answer whenever we structurally
 * cannot ask - no session to ask in, or a `url`-mode elicitation that wants a
 * server-rendered page we do not host. `cancel` is reserved for the case the
 * spec means it for: the human saw the question and dismissed it.
 */
export const handle = Effect.fn("MCP.elicitation")(function* (request: ElicitRequest) {
  const params = request.params
  const current = entry()
  if (!current) {
    yield* Effect.logWarning("MCP elicitation outside a tool call; declining", { mode: params.mode })
    return { action: "decline" } satisfies ElicitResult
  }
  // The human already said no on an earlier round of this same call. Asking
  // again is nagging, not asking.
  if (current.dismissed) return { action: "cancel" } satisfies ElicitResult
  const who = current.caller
  if (params.mode === "url") {
    yield* Effect.logWarning("MCP url-mode elicitation is not supported; declining", { url: params.url })
    return { action: "decline" } satisfies ElicitResult
  }

  const fields = Object.entries(params.requestedSchema.properties)
  if (fields.length === 0) return { action: "accept", content: {} } satisfies ElicitResult

  const question = yield* Question.Service
  const questions = fields.map(([name, field], index) => toQuestion(name, field, params.message, index === 0))

  return yield* question
    .ask({
      sessionID: who.sessionID,
      questions,
      tool: who.messageID && who.callID ? { messageID: who.messageID, callID: who.callID } : undefined,
    })
    .pipe(
      Effect.map((answers) => {
        const content: Record<string, string | number | boolean | string[]> = {}
        fields.forEach(([name, field], index) => {
          const value = toValue(field, answers[index] ?? [])
          if (value !== undefined) content[name] = value
        })
        return { action: "accept", content } satisfies ElicitResult
      }),
      // Dismissing the prompt is the human saying no to THIS elicitation, which
      // is exactly what the spec's `cancel` means. Latch it so the retry rounds
      // this same call still performs do not ask again.
      Effect.catchTag("QuestionRejectedError", () =>
        Effect.sync(() => {
          current.dismissed = true
          return { action: "cancel" } satisfies ElicitResult
        }),
      ),
    )
})

export * as McpElicitation from "./elicitation"
