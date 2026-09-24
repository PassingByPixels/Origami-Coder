import { isRecord } from "@/util/record"
import { ProviderError } from "@/provider/error"
import { SessionStreamDrop } from "./stream-drop"

/**
 * A provider-written ERROR FRAME, read into something a user can act on
 * (t-h8s3xg).
 *
 * `packages/llm`'s protocols hand the engine the provider's own sentence and
 * the raw payload. `session/processor.ts` used to throw that sentence and
 * nothing else, which is right while the sentence says something. Three
 * sessions on `openrouter / stealth/union-alpha` recorded
 * `UnknownError: "ERROR"` - the provider's whole report was the word ERROR -
 * and the transcript then named neither the provider, the model, the code, nor
 * how far into the stream it died.
 *
 * TWO CASES ARE LIFTED OUT, AND ONLY TWO:
 *
 * 1. An UNINFORMATIVE sentence (empty, `error`, or the payload's own
 *    `type`/`code` echoed back) is rewritten as
 *    `<provider> · <model>: <sentence> (code <code>, <n> s into the stream)`
 *    and carries the raw payload as `responseBody`, so the error row has
 *    something to show.
 * 2. An upstream RATE LIMIT reported mid-stream is read as the HTTP 429 it
 *    would have been had it arrived in the headers: retryable, statusCode 429,
 *    and the words `ProviderError` writes for that status - the same sentence
 *    the sibling step in those same minutes got.
 *
 * EVERYTHING ELSE STAYS BARE. `SessionStreamDrop.detect` reads the provider's
 * words to decide a drop, and a prefix in front of them would silently end the
 * bounded redo those faults depend on - so a sentence the drop classifier
 * recognises is never touched, however short it is.
 */

/** A rate limit as a provider spells it in a frame: the status, the OpenAI
 *  error code, or the words themselves. Deliberately narrow - a false positive
 *  here would make a permanent failure retry three times. */
const RATE_LIMIT = /\brate[\s_-]?limit|too many requests\b/i

export type Detail = {
  readonly statusCode?: number
  readonly isRetryable: boolean
  readonly responseBody?: string
  readonly metadata?: Record<string, string>
}

export type Described = {
  readonly message: string
  readonly detail: Detail
}

/** The one payload record under `providerMetadata` (`{ openai: {...} }`), or
 *  undefined when the event carried none. */
export function payloadOf(providerMetadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(providerMetadata)) return undefined
  for (const value of Object.values(providerMetadata)) if (isRecord(value)) return value
  return undefined
}

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined

/** A sentence that tells the user nothing: absent, the bare word `error`, or
 *  the payload's own machine `type`/`code` used as the report. */
function uninformative(sentence: string, payload: Record<string, unknown> | undefined): boolean {
  const text = sentence.trim()
  if (text === "") return true
  if (/^error$/i.test(text)) return true
  const echoes = [stringOf(payload?.["type"]), stringOf(payload?.["code"])]
  return echoes.some((value) => value !== undefined && value.trim().toLowerCase() === text.toLowerCase())
}

/**
 * A payload code that means the upstream itself failed (5xx), read the same
 * way a 5xx status arriving in the HEADERS would be: transient, and worth the
 * same bounded retry `retry.ts` already gives a header-carried 5xx. Narrow on
 * purpose - only a numeric 5xx in the field the 429 branch already reads
 * (`code`/`status`/`statusCode`), or the word "overloaded" in the type/code,
 * which several providers use in place of a status.
 */
function serverFailureStatus(payload: Record<string, unknown> | undefined): number | undefined {
  const raw = payload?.["code"] ?? payload?.["status"] ?? payload?.["statusCode"]
  const status = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined
  if (status !== undefined && Number.isInteger(status) && status >= 500 && status < 600) return status
  const words = [stringOf(payload?.["type"]), stringOf(payload?.["code"])].filter((v): v is string => v !== undefined)
  if (words.some((word) => /overloaded/i.test(word))) return 502
  return undefined
}

function rateLimited(sentence: string, payload: Record<string, unknown> | undefined): boolean {
  if (RATE_LIMIT.test(sentence)) return true
  const status = payload?.["code"] ?? payload?.["status"] ?? payload?.["statusCode"]
  if (status === 429 || status === "429") return true
  const code = stringOf(payload?.["code"]) ?? ""
  const type = stringOf(payload?.["type"]) ?? ""
  if (RATE_LIMIT.test(code) || RATE_LIMIT.test(type)) return true
  const nested = payload?.["metadata"]
  return isRecord(nested) ? RATE_LIMIT.test(JSON.stringify(nested)) : false
}

/** The raw payload, redacted, as the string `APIError.responseBody` takes. */
function body(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload === undefined) return undefined
  try {
    return ProviderError.redactSecrets(JSON.stringify(payload))
  } catch {
    return undefined
  }
}

/**
 * What to throw for one `provider-error` event, or `undefined` when the
 * provider's sentence already stands on its own and must be thrown bare.
 */
export function describe(input: {
  readonly sentence: string
  readonly providerMetadata: unknown
  readonly providerID: string
  readonly modelID: string
  readonly elapsedMs: number | undefined
}): Described | undefined {
  const payload = payloadOf(input.providerMetadata)
  // The drop family owns its own words. Checked FIRST: "terminated" is one
  // word and would otherwise read as uninformative.
  if (SessionStreamDrop.detect(input.sentence) !== undefined) return undefined

  if (rateLimited(input.sentence, payload)) {
    const responseBody = body(payload)
    return {
      // The 429 branch's own words, from the 429 branch's own function.
      message: ProviderError.statusMessage(input.providerID, { statusCode: 429, responseBody }),
      detail: { statusCode: 429, isRetryable: true, responseBody, metadata: { code: "rate_limit" } },
    }
  }

  if (!uninformative(input.sentence, payload)) return undefined

  const sentence = input.sentence.trim() === "" ? "no message" : input.sentence.trim()
  const code = stringOf(payload?.["code"]) ?? stringOf(payload?.["type"])
  const seconds = input.elapsedMs === undefined ? undefined : Math.max(0, Math.round(input.elapsedMs / 1000))
  const context = [
    ...(code !== undefined && code.trim() !== "" ? [`code ${code}`] : []),
    ...(seconds !== undefined ? [`${seconds} s into the stream`] : []),
  ]
  const tail = context.length > 0 ? ` (${context.join(", ")})` : ""
  // A 5xx (or "overloaded") payload code is the mid-stream twin of a 5xx that
  // arrived in the HEADERS - transient, and `retry.ts` already retries any
  // APIError whose status is >= 500 regardless of this flag. Leaving
  // isRetryable false here (the only branch that used to) is what let a
  // 502 mid-stream end the turn instead of taking the bounded retry a
  // header-carried 502 would have gotten for free.
  const status = serverFailureStatus(payload)
  return {
    message: `${input.providerID} · ${input.modelID}: ${sentence}${tail}`,
    detail: {
      ...(status !== undefined ? { statusCode: status } : {}),
      isRetryable: status !== undefined,
      responseBody: body(payload),
      ...(code !== undefined && code.trim() !== "" ? { metadata: { code } } : {}),
    },
  }
}

export * as SessionProviderErrorFrame from "./provider-error-frame"
