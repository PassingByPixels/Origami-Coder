import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderV2 } from "@origami/core/provider"
import { isContextOverflow, type LLMError } from "@origami/llm"

export class HeaderTimeoutError extends Error {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(public readonly ms: number) {
    super(`Provider response headers timed out after ${ms}ms`)
  }
}

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * A provider-written ERROR FRAME the engine has read (t-h8s3xg).
 *
 * `session/processor.ts` throws the provider's bare sentence for an ordinary
 * frame, because the stream-drop classifier is written against those words.
 * The two frames `session/provider-error-frame.ts` lifts out - an
 * uninformative sentence and a mid-stream rate limit - carry the fields an
 * `APIError` is made of, so the transcript's error row gets a status, a
 * retryable flag and the raw payload instead of `UnknownError: ERROR`.
 */
export class StreamFrameError extends Error {
  public override readonly name = "ProviderStreamFrameError"

  constructor(
    message: string,
    public readonly api: {
      readonly statusCode?: number
      readonly isRetryable: boolean
      readonly responseBody?: string
      readonly metadata?: Record<string, string>
    },
  ) {
    super(message)
  }
}

export class ConcurrencyTimeoutError extends Error {
  public override readonly name = "ProviderConcurrencyTimeoutError"

  constructor(
    public readonly providerID: ProviderV2.ID,
    public readonly maxConcurrent: number,
    public readonly ms: number,
  ) {
    super(
      `Timed out after ${Math.round(ms / 1000)}s waiting for a free slot on provider "${providerID}" (max_concurrent=${maxConcurrent}). A previous generation may be wedged — cancel it or raise max_concurrent.`,
    )
  }
}

// Provider errors flow into Session.Event.Error and from there into
// transcripts, logs, and session exports. A provider that echoes the request
// back (common on 401/400) puts the API key in all three. Scrub the
// well-known credential shapes before the error leaves this module.
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI sk-... / Anthropic sk-ant-...
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
]
const SECRET_QUERY = /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|auth|secret|signature)=)[^&#\s"']+/gi
const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
])

export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]")
  }
  return out.replace(SECRET_QUERY, "$1[redacted]")
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADER_NAMES.has(name.toLowerCase()) ? "[redacted]" : redactSecrets(value)
  }
  return out
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
type ErrorShape = Pick<APICallError, "message" | "statusCode" | "responseBody">

function message(providerID: ProviderV2.ID, e: ErrorShape) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `origami auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

/**
 * The words an HTTP failure of this status produces, for a fault that arrived
 * with no headers of its own (t-h8s3xg). The SAME `message()` the AI SDK and
 * native branches call, starting from the same status text `parseLLMError`
 * starts from, so a mid-stream 429 and a header 429 read alike.
 */
export function statusMessage(
  providerID: ProviderV2.ID | string,
  input: { statusCode: number; responseBody?: string },
): string {
  return redactSecrets(
    message(providerID as ProviderV2.ID, {
      message: STATUS_CODES[input.statusCode] ?? "",
      statusCode: input.statusCode,
      responseBody: input.responseBody,
    }),
  )
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const raw = json(input)
  const body = typeof raw?.message === "string" ? (json(raw.message) ?? raw) : raw
  if (!body) return

  const responseBody = redactSecrets(JSON.stringify(body))
  if (body.type !== "error") return

  switch (body?.error?.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? redactSecrets(body.error.message) : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
    case "server_is_overloaded":
    case "server_error":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? redactSecrets(body.error.message) : "Server error.",
        isRetryable: true,
        responseBody,
      }
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderV2.ID; error: APICallError }): ParsedAPICallError {
  const m = redactSecrets(message(input.providerID, input.error))
  const body = json(input.error.responseBody)
  const responseBody = input.error.responseBody ? redactSecrets(input.error.responseBody) : input.error.responseBody
  if (isContextOverflow(m) || input.error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody,
    }
  }

  const metadata = input.error.url ? { url: redactSecrets(input.error.url) } : undefined
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: redactHeaders(input.error.responseHeaders),
    responseBody,
    metadata,
  }
}


/**
 * The native runtime's typed failure, read into the same shape the AI SDK
 * path produces, so every classifier downstream (`SessionDegrade`,
 * `SessionImageCap`, `SessionRetry`, the overflow gate) sees one vocabulary.
 * `@origami/llm` already carries the HTTP status, headers and redacted body on
 * `reason.http`; a missing-credential failure has no HTTP exchange at all and
 * is reported as a 401 so the auth short-circuit fires for it too.
 */
export function parseLLMError(input: { providerID: ProviderV2.ID; error: LLMError }): ParsedAPICallError {
  const reason = input.error.reason
  const http = "http" in reason ? reason.http : undefined
  const statusCode =
    http?.response?.status ??
    ("status" in reason && typeof reason.status === "number" ? reason.status : undefined) ??
    (reason._tag === "Authentication" ? 401 : undefined)
  const responseBody = http?.body ? redactSecrets(http.body) : undefined
  const body = json(http?.body)
  // The executor's own sentence ("Provider request failed with HTTP 400: …")
  // would double the body; the AI SDK path starts from the status text and
  // `message` appends the provider's sentence once. Same words on both paths.
  const base =
    statusCode !== undefined && reason.message.startsWith("Provider request failed with HTTP")
      ? (STATUS_CODES[statusCode] ?? "")
      : reason.message
  const m = redactSecrets(message(input.providerID, { message: base, statusCode, responseBody: http?.body }))
  if (
    (reason._tag === "InvalidRequest" && reason.classification === "context-overflow") ||
    isContextOverflow(m) ||
    statusCode === 413 ||
    body?.error?.code === "context_length_exceeded"
  ) {
    return { type: "context_overflow", message: m, responseBody }
  }
  return {
    type: "api_error",
    message: m,
    statusCode,
    isRetryable: reason.retryable || (statusCode !== undefined && statusCode >= 500),
    responseHeaders: redactHeaders(http?.response?.headers),
    responseBody,
    metadata: http?.request?.url ? { url: redactSecrets(http.request.url) } : undefined,
  }
}

export * as ProviderError from "./error"
