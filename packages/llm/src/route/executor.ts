import { Cause, Context, Effect, Layer, Random } from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import {
  AuthenticationReason,
  ContentPolicyReason,
  HttpContext,
  HttpRateLimitDetails,
  HttpRequestDetails,
  HttpResponseDetails,
  InvalidRequestReason,
  LLMError,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
  UnknownProviderReason,
} from "../schema"
import { isContextOverflow } from "../provider-error"

export interface Interface {
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError>
}

export class Service extends Context.Service<Service, Interface>()("@origami/LLM/RequestExecutor") {}

const BODY_LIMIT = 16_384
const MAX_RETRIES = 2

/**
 * How many times the executor itself re-sends a request that failed with a
 * retryable status (429, 5xx). A caller that owns its own retry policy — the
 * engine's session loop does, with notices, per-family limits and degrade
 * classification — sets it to 0 so the two ladders do not stack.
 */
export const Retries = Context.Reference<number>("@origami/LLM/RequestExecutor/Retries", {
  defaultValue: () => MAX_RETRIES,
})
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 10_000
const REDACTED = "<redacted>"

// One source of truth for what counts as a sensitive name across headers,
// URL query keys, and field names embedded inside request/response bodies.
//
// `SENSITIVE_NAME` is used as both a substring matcher (for free-form header
// names like `Authorization` / `X-API-Key`) and as the body-field alternation
// list. `SHORT_QUERY_NAME` covers anchored short keys like `?key=…` / `?sig=…`
// that are too generic to redact substring-style without false positives.
const SENSITIVE_NAME_SOURCE =
  "authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|credential|signature|x-amz-signature"
const SENSITIVE_NAME = new RegExp(SENSITIVE_NAME_SOURCE, "i")
const SHORT_QUERY_NAME = /^(key|sig)$/i
const SENSITIVE_BODY_FIELD = new RegExp(`(?:${SENSITIVE_NAME_SOURCE}|key)`, "i")
const REDACT_JSON_FIELD = new RegExp(`("(?:${SENSITIVE_BODY_FIELD.source})"\\s*:\\s*)"[^"]*"`, "gi")
const REDACT_QUERY_FIELD = new RegExp(`((?:${SENSITIVE_BODY_FIELD.source})=)[^&\\s"]+`, "gi")

const isSensitiveHeaderName = (name: string) => SENSITIVE_NAME.test(name)

const isSensitiveQueryName = (name: string) => isSensitiveHeaderName(name) || SHORT_QUERY_NAME.test(name)

const redactHeaders = (headers: Headers.Headers, redactedNames: ReadonlyArray<string | RegExp>) =>
  Object.fromEntries(
    Object.entries(Headers.redact(headers, [...redactedNames, SENSITIVE_NAME])).map(([name, value]) => [
      name,
      String(value),
    ]),
  )

const redactUrl = (value: string) => {
  if (!URL.canParse(value)) return REDACTED
  const url = new URL(value)
  url.searchParams.forEach((_, key) => {
    if (isSensitiveQueryName(key)) url.searchParams.set(key, REDACTED)
  })
  return url.toString()
}

const normalizedHeaders = (headers: Headers.Headers) =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))

const requestId = (headers: Record<string, string>) => {
  return (
    headers["x-request-id"] ??
    headers["request-id"] ??
    headers["x-amzn-requestid"] ??
    headers["x-amz-request-id"] ??
    headers["x-goog-request-id"] ??
    headers["cf-ray"]
  )
}

const retryableStatus = (status: number) => status === 429 || status === 503 || status === 504 || status === 529

const retryAfterMs = (headers: Record<string, string>) => {
  const millis = Number(headers["retry-after-ms"])
  if (Number.isFinite(millis)) return Math.max(0, millis)

  const value = headers["retry-after"]
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

const addRateLimitValue = (target: Record<string, string>, key: string, value: string) => {
  if (key.length > 0) target[key] = value
}

const rateLimitDetails = (headers: Record<string, string>, retryAfter: number | undefined) => {
  const limit: Record<string, string> = {}
  const remaining: Record<string, string> = {}
  const reset: Record<string, string> = {}

  Object.entries(headers).forEach(([name, value]) => {
    const openaiLimit = /^x-ratelimit-limit-(.+)$/.exec(name)?.[1]
    if (openaiLimit) return addRateLimitValue(limit, openaiLimit, value)

    const openaiRemaining = /^x-ratelimit-remaining-(.+)$/.exec(name)?.[1]
    if (openaiRemaining) return addRateLimitValue(remaining, openaiRemaining, value)

    const openaiReset = /^x-ratelimit-reset-(.+)$/.exec(name)?.[1]
    if (openaiReset) return addRateLimitValue(reset, openaiReset, value)

    const anthropic = /^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/.exec(name)
    if (!anthropic) return
    if (anthropic[2] === "limit") return addRateLimitValue(limit, anthropic[1], value)
    if (anthropic[2] === "remaining") return addRateLimitValue(remaining, anthropic[1], value)
    return addRateLimitValue(reset, anthropic[1], value)
  })

  if (
    retryAfter === undefined &&
    Object.keys(limit).length === 0 &&
    Object.keys(remaining).length === 0 &&
    Object.keys(reset).length === 0
  )
    return undefined

  return new HttpRateLimitDetails({
    retryAfterMs: retryAfter,
    limit: Object.keys(limit).length === 0 ? undefined : limit,
    remaining: Object.keys(remaining).length === 0 ? undefined : remaining,
    reset: Object.keys(reset).length === 0 ? undefined : reset,
  })
}

const requestDetails = (request: HttpClientRequest.HttpClientRequest, redactedNames: ReadonlyArray<string | RegExp>) =>
  new HttpRequestDetails({
    method: request.method,
    url: redactUrl(request.url),
    headers: redactHeaders(request.headers, redactedNames),
  })

const responseDetails = (
  response: HttpClientResponse.HttpClientResponse,
  redactedNames: ReadonlyArray<string | RegExp>,
) =>
  new HttpResponseDetails({
    status: response.status,
    headers: redactHeaders(response.headers, redactedNames),
  })

const secretValues = (request: HttpClientRequest.HttpClientRequest) => {
  const values = new Set<string>()
  const add = (value: string) => {
    if (value.length < 4) return
    values.add(value)
    values.add(encodeURIComponent(value))
  }

  Object.entries(request.headers).forEach(([name, value]) => {
    if (!isSensitiveHeaderName(name)) return
    add(value)
    const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1]
    if (bearer) add(bearer)
  })

  if (!URL.canParse(request.url)) return values
  new URL(request.url).searchParams.forEach((value, key) => {
    if (isSensitiveQueryName(key)) add(value)
  })
  return values
}

// Two passes: structural (redact `"name": "value"` and `name=value` patterns
// for any field name that looks sensitive) plus literal (replace any actual
// secret values we sent in the request, in case the response echoes one back).
const redactBody = (body: string, request: HttpClientRequest.HttpClientRequest) =>
  Array.from(secretValues(request)).reduce(
    (text, secret) => text.split(secret).join(REDACTED),
    body.replace(REDACT_JSON_FIELD, `$1"${REDACTED}"`).replace(REDACT_QUERY_FIELD, `$1${REDACTED}`),
  )

const responseBody = (body: string | void, request: HttpClientRequest.HttpClientRequest) => {
  if (body === undefined) return {}
  const redacted = redactBody(body, request)
  if (redacted.length <= BODY_LIMIT) return { body: redacted }
  return { body: redacted.slice(0, BODY_LIMIT), bodyTruncated: true }
}

/**
 * How much of a LONG refusal body still reaches the message. A body at or
 * under `MESSAGE_BODY_FULL` is quoted whole, as it always was.
 *
 * t-4aqhjb: past that the body used to be dropped ENTIRELY and the user read
 * "Provider request failed with HTTP 429" with no reason at all — and a
 * refusal that names a reason (a usage window, a concurrency cap, an oversized
 * part) is exactly the kind that runs long, because it explains itself. The
 * whole body is still on the error (`HttpContext.body`, 16 KB); this is only
 * about what the SENTENCE carries.
 */
const MESSAGE_BODY_FULL = 500
const MESSAGE_BODY_HEAD = 200

const providerMessage = (status: number, body: { readonly body?: string }) => {
  if (!body.body) return `Provider request failed with HTTP ${status}`
  if (body.body.length <= MESSAGE_BODY_FULL) return `Provider request failed with HTTP ${status}: ${body.body}`
  return `Provider request failed with HTTP ${status}: ${body.body.slice(0, MESSAGE_BODY_HEAD)}…`
}

const responseHttp = (input: {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly redactedNames: ReadonlyArray<string | RegExp>
  readonly body: ReturnType<typeof responseBody>
  readonly requestId?: string | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
}) =>
  new HttpContext({
    request: requestDetails(input.request, input.redactedNames),
    response: responseDetails(input.response, input.redactedNames),
    ...input.body,
    requestId: input.requestId,
    rateLimit: input.rateLimit,
  })

const statusReason = (input: {
  readonly status: number
  readonly message: string
  readonly retryAfterMs?: number | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
  readonly http: HttpContext
}) => {
  const body = input.http.body ?? ""
  if (/content[-_\s]?policy|content_filter|safety/i.test(body)) {
    return new ContentPolicyReason({ message: input.message, http: input.http })
  }
  if (input.status === 401) {
    return new AuthenticationReason({ message: input.message, kind: "invalid", http: input.http })
  }
  if (input.status === 403) {
    return new AuthenticationReason({ message: input.message, kind: "insufficient-permissions", http: input.http })
  }
  if (input.status === 429) {
    if (/insufficient[-_\s]?quota|quota[-_\s]?exceeded/i.test(body)) {
      return new QuotaExceededReason({ message: input.message, http: input.http })
    }
    return new RateLimitReason({
      message: input.message,
      retryAfterMs: input.retryAfterMs,
      rateLimit: input.rateLimit,
      http: input.http,
    })
  }
  if (
    input.status === 400 ||
    input.status === 404 ||
    input.status === 409 ||
    input.status === 413 ||
    input.status === 422
  ) {
    return new InvalidRequestReason({
      message: input.message,
      classification: isContextOverflow(body) ? "context-overflow" : undefined,
      http: input.http,
    })
  }
  if (input.status >= 500 || retryableStatus(input.status)) {
    return new ProviderInternalReason({
      message: input.message,
      status: input.status,
      retryAfterMs: input.retryAfterMs,
      http: input.http,
    })
  }
  return new UnknownProviderReason({ message: input.message, status: input.status, http: input.http })
}

const statusError =
  (request: HttpClientRequest.HttpClientRequest, redactedNames: ReadonlyArray<string | RegExp>) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      if (response.status < 400) return response
      const body = yield* response.text.pipe(Effect.catch(() => Effect.void))
      const headers = normalizedHeaders(response.headers)
      const retryAfter = retryAfterMs(headers)
      const rateLimit = rateLimitDetails(headers, retryAfter)
      const details = responseBody(body, request)
      return yield* new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: statusReason({
          status: response.status,
          message: providerMessage(response.status, details),
          retryAfterMs: retryAfter,
          rateLimit,
          http: responseHttp({
            request,
            response,
            redactedNames,
            body: details,
            requestId: requestId(headers),
            rateLimit,
          }),
        }),
      })
    })

/**
 * The sentences along a thrown value's `cause` chain, outermost first. Effect's
 * fetch client wraps whatever `fetch` threw as `TransportError({ request,
 * cause })` with NO description, so without this the user read a bare "HTTP
 * transport failed" for every kind of fault — a signer's "xAI token refresh
 * failed (429)", Bun's "The socket connection was closed unexpectedly", a
 * refused connection — and the engine's stream-drop notice carried the same
 * blank. Node/Bun put the useful part one level down (`fetch failed` ->
 * cause: ECONNRESET), hence the walk.
 */
const causeText = (value: unknown): string | undefined => {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = value
  while (current !== undefined && current !== null && parts.length < 4 && !seen.has(current)) {
    seen.add(current)
    if (typeof current === "string") {
      if (current.trim()) parts.push(current.trim())
      break
    }
    if (!(current instanceof Error)) break
    const message = current.message.trim()
    const code = (current as { code?: unknown }).code
    const line = message && typeof code === "string" && !message.includes(code) ? `${message} (${code})` : message || (typeof code === "string" ? code : "")
    if (line && !parts.includes(line)) parts.push(line)
    current = (current as { cause?: unknown }).cause
  }
  return parts.length ? parts.join(": ") : undefined
}

const transportMessage = (cause: unknown) => {
  const text = causeText(cause)
  return text ? `HTTP transport failed: ${text}` : "HTTP transport failed"
}

const toHttpError = (redactedNames: ReadonlyArray<string | RegExp>) => (error: unknown) => {
  const transportError = (input: {
    readonly message: string
    readonly kind?: string | undefined
    readonly request?: HttpClientRequest.HttpClientRequest | undefined
  }) =>
    new LLMError({
      module: "RequestExecutor",
      method: "execute",
      reason: new TransportReason({
        message: input.message,
        kind: input.kind,
        url: input.request ? redactUrl(input.request.url) : undefined,
        http: input.request ? new HttpContext({ request: requestDetails(input.request, redactedNames) }) : undefined,
      }),
    })

  if (Cause.isTimeoutError(error)) {
    return transportError({ message: error.message, kind: "Timeout" })
  }
  if (!HttpClientError.isHttpClientError(error)) {
    return transportError({ message: transportMessage(error) })
  }
  const request = "request" in error ? error.request : undefined
  if (error.reason._tag === "TransportError") {
    return transportError({
      message: error.reason.description ?? transportMessage(error.reason.cause),
      kind: error.reason._tag,
      request,
    })
  }
  return transportError({
    message: `HTTP transport failed: ${error.reason._tag}`,
    kind: error.reason._tag,
    request,
  })
}

const retryDelay = (error: LLMError, attempt: number) => {
  if (error.retryAfterMs !== undefined) return Effect.succeed(Math.min(error.retryAfterMs, MAX_DELAY_MS))
  return Random.nextBetween(
    Math.min(BASE_DELAY_MS * 2 ** attempt * 0.8, MAX_DELAY_MS),
    Math.min(BASE_DELAY_MS * 2 ** attempt * 1.2, MAX_DELAY_MS),
  ).pipe(Effect.map((delay) => Math.round(delay)))
}

const retryStatusFailures = <A, R>(
  effect: Effect.Effect<A, LLMError, R>,
  retries = MAX_RETRIES,
  attempt = 0,
): Effect.Effect<A, LLMError, R> =>
  Effect.catchTag(effect, "LLM.Error", (error): Effect.Effect<A, LLMError, R> => {
    if (!error.retryable || retries <= 0) return Effect.fail(error)
    return retryDelay(error, attempt).pipe(
      Effect.flatMap((delay) => Effect.sleep(delay)),
      Effect.flatMap(() => retryStatusFailures(effect, retries - 1, attempt + 1)),
    )
  })

/**
 * A pooled connection the server closed while we were busy. Bun keeps
 * keep-alive sockets between calls; a provider drops an idle one after a few
 * seconds, and the next request — typically the step after a long tool run —
 * fails on the first write with "The socket connection was closed
 * unexpectedly (ECONNRESET)" before a single response byte. That is not the
 * provider refusing anything, it is a dead socket, and the only right answer
 * is to send the same request again at once on a fresh connection. The AI SDK
 * path never showed the owner this because it hid the retry; the native path
 * surfaced it as a "Stream dropped … retrying" line on every such step
 * (2026-09-04, OpenAI and Grok). Limited to failures of `http.execute` — that
 * call returns once the headers are in, so a retry here can never repeat a
 * response the caller has started to read.
 */
const STALE_SOCKET = /closed unexpectedly|ECONNRESET|EPIPE|socket hang up|other side closed/i
const isStaleSocket = (error: LLMError) => error.reason._tag === "Transport" && STALE_SOCKET.test(error.reason.message)

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const send = (request: HttpClientRequest.HttpClientRequest, redactedNames: ReadonlyArray<string | RegExp>) =>
      http.execute(request).pipe(Effect.mapError(toHttpError(redactedNames)))
    const executeOnce = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const redactedNames = yield* Headers.CurrentRedactedNames
        return yield* send(request, redactedNames).pipe(
          Effect.catch((error) => (isStaleSocket(error) ? send(request, redactedNames) : Effect.fail(error))),
          Effect.flatMap(statusError(request, redactedNames)),
        )
      })
    return Service.of({
      execute: (request) =>
        Effect.gen(function* () {
          const retries = yield* Retries
          return yield* retryStatusFailures(executeOnce(request), retries)
        }),
    })
  }),
)

export const fetchLayer = layer.pipe(Layer.provide(FetchHttpClient.layer))

export * as RequestExecutor from "./executor"
