import { Buffer } from "node:buffer"
import { Effect, Schema, Stream } from "effect"
import * as Sse from "effect/unstable/encoding/Sse"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import {
  InvalidProviderOutputReason,
  InvalidRequestReason,
  LLMError,
  type ContentPart,
  type LLMRequest,
  type MediaPart,
  type ProviderMetadata,
  type ToolFileContent,
  type TextPart,
  type ToolResultPart,
} from "../schema"
import { isRecord } from "../utils/record"
export { isRecord }

export const Json = Schema.fromJsonString(Schema.Unknown)
export const decodeJson = Schema.decodeUnknownSync(Json)
export const encodeJson = Schema.encodeSync(Json)
const isJson = Schema.is(Schema.Json)
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
export const optionalArray = <const S extends Schema.Top>(schema: S) => Schema.optional(Schema.Array(schema))
export const optionalNull = <const S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

/**
 * GitHub Copilot's authoritative billed amount for a turn.
 *
 * Copilot bills in AIU, not in tokens: a premium request costs a multiple of the
 * token arithmetic, so the token fields are NOT a substitute for it. The amount
 * rides on the frame that closes the turn, beside `usage` and outside it —
 * `copilot_usage` at the top level of an OpenAI Chat chunk and of an Anthropic
 * `message_delta`, and under `response` on a Responses `response.completed`.
 * The engine reads it back as `metadata.copilot.totalNanoAiu` and divides by 1e11.
 */
export const CopilotUsage = Schema.Struct({ total_nano_aiu: optionalNull(Schema.Number) })
export type CopilotUsage = Schema.Schema.Type<typeof CopilotUsage>

/** `{ copilot: { totalNanoAiu } }`, or nothing when the field is absent or not
 *  a usable amount. The guard matches the AI SDK path's (finite, not negative),
 *  so a garbled frame costs the turn its amount rather than writing a nonsense cost. */
export const copilotMetadata = (usage: CopilotUsage | null | undefined): ProviderMetadata | undefined => {
  const total = usage?.total_nano_aiu
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return undefined
  return { copilot: { totalNanoAiu: total } }
}

/** Merge a copilot block into whatever metadata the protocol had already built. */
export const withCopilotMetadata = (
  metadata: ProviderMetadata | undefined,
  copilot: ProviderMetadata | undefined,
): ProviderMetadata | undefined => (copilot ? { ...metadata, ...copilot } : metadata)

/** Streaming tool-call accumulator. Adapters that build a tool call across
 *  multiple `tool-input-delta` chunks store the partial JSON input string here
 *  and finalize it with `readToolInput` once the call completes. */
export interface ToolAccumulator {
  readonly id: string
  readonly name: string
  readonly input: string
}

/**
 * `Usage.totalTokens` policy shared by every route. Honors a provider-supplied
 * total; otherwise falls back to `inputTokens + outputTokens` only when at least
 * one is defined, returning `undefined` when neither is known so routes don't
 * publish a misleading `0`. The computed fallback under-counts cache and
 * reasoning by design — it exists for providers that surface no total.
 */
export const totalTokens = (
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  total: number | undefined,
) => {
  if (total !== undefined) return total
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return (inputTokens ?? 0) + (outputTokens ?? 0)
}

/**
 * Subtract `subtrahend` from `total`, clamping to zero when the provider reports
 * a non-sensical breakdown (`cached_tokens > prompt_tokens`). Used when deriving
 * a non-overlapping field from an inclusive total. An `undefined` total returns
 * `undefined` (no fabricated counts); an `undefined` subtrahend returns `total`.
 */
export const subtractTokens = (total: number | undefined, subtrahend: number | undefined): number | undefined => {
  if (total === undefined) return undefined
  if (subtrahend === undefined) return total
  return Math.max(0, total - subtrahend)
}

/** Sum a list of optional token counts, returning `undefined` only when every
 *  value is `undefined` (so we don't fabricate a `0`). Used to derive the
 *  inclusive `inputTokens` from a provider that reports a non-overlapping breakdown. */
export const sumTokens = (...values: ReadonlyArray<number | undefined>): number | undefined => {
  if (values.every((value) => value === undefined)) return undefined
  return values.reduce((acc: number, value) => acc + (value ?? 0), 0)
}

export const eventError = (route: string, message: string, raw?: string) =>
  new LLMError({
    module: "ProviderShared",
    method: "stream",
    reason: new InvalidProviderOutputReason({ route, message, raw }),
  })

export const parseJson = (route: string, input: string, message: string) =>
  Effect.try({
    try: () => decodeJson(input),
    catch: () => eventError(route, message, input),
  })

/** Join the `text` field of a list of parts with newlines. Used by routes that
 *  flatten system / message content arrays into one provider string (OpenAI Chat
 *  and Responses `system`, Gemini `systemInstruction.parts[].text`). */
export const joinText = (parts: ReadonlyArray<{ readonly text: string }>) => parts.map((part) => part.text).join("\n")

const escapeSystemUpdateText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** Stable fallback for chronological `Message.system(...)` updates on routes
 *  without that privileged role. The wrapper stays visibly lower-authority user
 *  text, keeps its temporal position, and XML-escapes content so it cannot close the wrapper. */
export const wrapSystemUpdate = (parts: ReadonlyArray<{ readonly text: string }>) =>
  `<system-update>\n${escapeSystemUpdateText(joinText(parts))}\n</system-update>`

/** Chronological system updates deliberately accept text only. Do not insert
 *  raw retrieved, tool, or web content into privileged updates: keep untrusted
 *  data in ordinary user/tool messages instead. */
export const systemUpdateText = Effect.fn("ProviderShared.systemUpdateText")(function* (
  route: string,
  message: LLMRequest["messages"][number],
) {
  const content: TextPart[] = []
  for (const part of message.content) {
    if (!supportsContent(part, ["text"])) return yield* unsupportedContent(route, "system", ["text"])
    content.push(part)
  }
  return content
})

/** Lower an unsupported privileged update into visible, in-order user text. */
export const wrappedSystemUpdate = Effect.fn("ProviderShared.wrappedSystemUpdate")(function* (
  route: string,
  message: LLMRequest["messages"][number],
) {
  const content = yield* systemUpdateText(route, message)
  return { type: "text" as const, text: wrapSystemUpdate(content), cache: content.at(-1)?.cache }
})

/**
 * Read the streamed JSON input of a tool call. Treats an empty string as `"{}"` —
 * providers occasionally finish a tool call without emitting input deltas.
 *
 * It REPORTS a bad parse instead of failing: the protocol marks the one call and
 * lets the rest of the stream (finish reason, usage, sibling calls) through.
 */
export const toolInputError = (route: string, name: string) => `Invalid JSON input for ${route} tool call ${name}`

export const readToolInput = (
  route: string,
  name: string,
  raw: string,
): { readonly ok: true; readonly input: unknown } | { readonly ok: false; readonly error: string } => {
  try {
    return { ok: true, input: decodeJson(raw || "{}") }
  } catch {
    return { ok: false, error: toolInputError(route, name) }
  }
}

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const
export const VIDEO_MIMES = ["video/mp4", "video/webm", "video/quicktime"] as const
export const AUDIO_MIMES = ["audio/wav", "audio/mp3", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac"] as const
export const MEDIA_MIMES = [...IMAGE_MIMES, ...VIDEO_MIMES, ...AUDIO_MIMES] as const
export const MAX_MEDIA_ENCODED_BYTES = 28 * 1024 * 1024
export const MAX_MEDIA_DECODED_BYTES = 20 * 1024 * 1024

// t-ub95jp: used only with the `length % 4 === 0` check beside it; together they
// accept the same strings as the original
// /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.
// The original answers false for ANY input from 5,505,020 characters (measured
// on bun 1.3.14), so it refused valid large images. This form has no repeated
// group and works at every size up to MAX_MEDIA_ENCODED_BYTES.
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/

export interface ValidatedMedia {
  readonly mime: string
  readonly base64: string
  readonly dataUrl: string
  readonly bytes: Uint8Array
}

/**
 * t-u54x6w: the fast answer for the common case, a valid image. It is exact:
 * a string that survives a base64 decode and re-encode unchanged is canonical,
 * non-empty base64 of a length divisible by 4, which is everything the two
 * patterns below accept. The patterns cost about 37 ms per 1.5 MB image on the
 * JS thread (every image of every request); the round trip costs about 0.4 ms.
 * Anything that is not canonical takes the original path unchanged, so a bad
 * image is refused with the same message as before.
 *
 * t-ub95jp: the round trip applies at every size up to the encoded limit, so a
 * valid image of 5,505,020+ characters is no longer refused as invalid. Over
 * the limit the original path runs, which refuses before it decodes anything.
 */
const DATA_URL_HEAD = /^data:([^;,]+);base64,/

const canonicalBase64 = (base64: string) => {
  if (!base64 || base64.length % 4 !== 0 || base64.length > MAX_MEDIA_ENCODED_BYTES) return undefined
  const bytes = Buffer.from(base64, "base64")
  return bytes.toString("base64") === base64 ? bytes : undefined
}

export const validateMedia = Effect.fn("ProviderShared.validateMedia")(function* (
  route: string,
  part: MediaPart,
  supportedMimes: ReadonlySet<string>,
) {
  const mime = part.mediaType.toLowerCase()
  if (!supportedMimes.has(mime)) return yield* invalidRequest(`${route} does not support media type ${part.mediaType}`)

  if (typeof part.data === "string") {
    const head = part.data.startsWith("data:") ? DATA_URL_HEAD.exec(part.data) : undefined
    if (head !== null) {
      const base64 = head ? part.data.slice(head[0].length) : part.data
      const bytes = canonicalBase64(base64)
      if (bytes) {
        // The checks the original path makes on a valid image, in its order.
        if (head && head[1]!.toLowerCase() !== mime)
          return yield* invalidRequest(`${route} media type ${part.mediaType} does not match data URL type ${head[1]}`)
        if (Buffer.byteLength(base64, "utf8") > MAX_MEDIA_ENCODED_BYTES)
          return yield* invalidRequest(`${route} media exceeds the ${MAX_MEDIA_ENCODED_BYTES} byte encoded limit`)
        if (bytes.byteLength > MAX_MEDIA_DECODED_BYTES)
          return yield* invalidRequest(`${route} media exceeds the ${MAX_MEDIA_DECODED_BYTES} byte decoded limit`)
        return { mime, base64, dataUrl: `data:${mime};base64,${base64}`, bytes } satisfies ValidatedMedia
      }
    }
  }

  let base64: string
  if (typeof part.data !== "string") {
    if (part.data.byteLength > MAX_MEDIA_DECODED_BYTES)
      return yield* invalidRequest(`${route} media exceeds the ${MAX_MEDIA_DECODED_BYTES} byte decoded limit`)
    base64 = Buffer.from(part.data).toString("base64")
  } else if (part.data.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/s.exec(part.data)
    if (!match) return yield* invalidRequest(`${route} media data URL must contain valid base64`)
    if (match[1]!.toLowerCase() !== mime)
      return yield* invalidRequest(`${route} media type ${part.mediaType} does not match data URL type ${match[1]}`)
    base64 = match[2]!
  } else {
    base64 = part.data
  }

  if (Buffer.byteLength(base64, "utf8") > MAX_MEDIA_ENCODED_BYTES)
    return yield* invalidRequest(`${route} media exceeds the ${MAX_MEDIA_ENCODED_BYTES} byte encoded limit`)
  if (!base64 || base64.length % 4 !== 0 || !base64Pattern.test(base64))
    return yield* invalidRequest(`${route} media must contain valid base64`)
  const bytes = Buffer.from(base64, "base64")
  if (bytes.byteLength > MAX_MEDIA_DECODED_BYTES)
    return yield* invalidRequest(`${route} media exceeds the ${MAX_MEDIA_DECODED_BYTES} byte decoded limit`)
  if (bytes.toString("base64") !== base64) return yield* invalidRequest(`${route} media must contain canonical base64`)
  return { mime, base64, dataUrl: `data:${mime};base64,${base64}`, bytes } satisfies ValidatedMedia
})

export const validateToolFile = (route: string, part: ToolFileContent, supportedMimes: ReadonlySet<string>) =>
  validateMedia(route, { type: "media", mediaType: part.mime, data: part.uri, filename: part.name }, supportedMimes)

export const trimBaseUrl = (value: string) => value.replace(/\/+$/, "")

export const toolResultText = (part: ToolResultPart) => {
  if (part.result.type === "text") return String(part.result.value)
  if (part.result.type === "error") {
    const value = part.result.value
    const prototype =
      typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value)
    const structured = Array.isArray(value) || prototype === Object.prototype || prototype === null
    return structured && isJson(value) ? encodeJson(value) : String(value)
  }
  return encodeJson(part.result.value)
}

export const errorText = (error: unknown) => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return String(error)
  if (error === null) return "null"
  if (error === undefined) return "undefined"
  return "Unknown stream error"
}

/** `framing` step for Server-Sent Events. Decodes UTF-8, runs the SSE channel
 *  decoder, and drops empty / `[DONE]` keep-alive events so `decodeChunk` sees
 *  one JSON string per element. The channel's `Retry` control event is dropped
 *  (no client-driven retries) so the public error channel stays `LLMError`. */
export const sseFraming = (bytes: Stream.Stream<Uint8Array, LLMError>): Stream.Stream<string, LLMError> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.catchTag("Retry", () => Stream.empty),
    Stream.filter((event) => event.data.length > 0 && event.data !== "[DONE]"),
    Stream.map((event) => event.data),
  )

/** Canonical invalid-request constructor, so route context or trace metadata
 *  can be added to `InvalidRequestReason` in one place. */
export const invalidRequest = (message: string) =>
  new LLMError({
    module: "ProviderShared",
    method: "request",
    reason: new InvalidRequestReason({ message }),
  })

export const matchToolChoice = <Auto, None, Required, Tool>(
  route: string,
  toolChoice: NonNullable<LLMRequest["toolChoice"]>,
  cases: {
    readonly auto: () => Auto
    readonly none: () => None
    readonly required: () => Required
    readonly tool: (name: string) => Tool
  },
) =>
  Effect.gen(function* () {
    if (toolChoice.type === "auto") return cases.auto()
    if (toolChoice.type === "none") return cases.none()
    if (toolChoice.type === "required") return cases.required()
    if (!toolChoice.name) return yield* invalidRequest(`${route} tool choice requires a tool name`)
    return cases.tool(toolChoice.name)
  })

type ContentType = ContentPart["type"]

const formatContentTypes = (types: ReadonlyArray<ContentType>) => {
  if (types.length <= 1) return types[0] ?? ""
  if (types.length === 2) return `${types[0]} and ${types[1]}`
  return `${types.slice(0, -1).join(", ")}, and ${types.at(-1)}`
}

export const supportsContent = <const Type extends ContentType>(
  part: ContentPart,
  types: ReadonlyArray<Type>,
): part is Extract<ContentPart, { readonly type: Type }> => (types as ReadonlyArray<ContentType>).includes(part.type)

export const unsupportedContent = (
  route: string,
  role: LLMRequest["messages"][number]["role"],
  types: ReadonlyArray<ContentType>,
) => invalidRequest(`${route} ${role} messages only support ${formatContentTypes(types)} content for now`)

/** Build a `validate` step from a Schema decoder. Any decode error is translated
 *  into `LLMError` carrying the original parse-error message. */
export const validateWith =
  <A, I, E extends { readonly message: string }>(decode: (input: I) => Effect.Effect<A, E>) =>
  (payload: I) =>
    decode(payload).pipe(Effect.mapError((error) => invalidRequest(error.message)))

/** Build an HTTP POST with a JSON body. Sets `content-type: application/json`
 *  AFTER caller-supplied headers so routes cannot send JSON with a stale content
 *  type. The body is passed pre-encoded so routes choose their own encoder. */
export const jsonPost = (input: { readonly url: string; readonly body: string; readonly headers?: Headers.Input }) =>
  HttpClientRequest.post(input.url).pipe(
    HttpClientRequest.setHeaders(Headers.set(Headers.fromInput(input.headers), "content-type", "application/json")),
    HttpClientRequest.bodyText(input.body, "application/json"),
  )

export * as ProviderShared from "./shared"
