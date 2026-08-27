/**
 * Request/response bridge between the `browser` tool and the VS Code client.
 *
 * The engine drives no browser of its own. The VS Code extension owns the
 * integrated browser and answers the ACP ext method `origami/browser`; this
 * module is the ONE place that wire shape is written down, so the tool never
 * imports the acp layer and the acp layer never hand-rolls a payload.
 *
 * Module state, like session/prompt-capture.ts and for the same reason: the
 * ACP process boots the engine in-process (cli/cmd/acp.ts starts the server AND
 * the ACP agent), so the handler registered at connection setup is the handler
 * a tool call finds. One connection per process, so the handler registered at
 * setup lives for the process lifetime; nothing clears it at teardown.
 *
 * EVERY ACP client registers, not only VS Code - acp/agent.ts calls
 * registerConnection on every connection, because at that point no one knows
 * which client is on the other end. So `available()` means "a client is
 * attached", NOT "a browser can be driven". A client that does not implement
 * `origami/browser` answers method-not-found, and `send` turns that back into
 * the same `UNAVAILABLE` prose as no client at all - a Zed user must be told
 * their client has no browser, not that "the VS Code browser failed".
 */

/** `probe` is bridge-internal: it asks the client what it can drive, and is never offered to the model. */
export type Action =
  | "probe"
  | "open"
  | "navigate"
  | "screenshot"
  | "read"
  | "click"
  | "type"
  | "hover"
  | "drag"
  | "dialog"
  | "raw"

export type Request = {
  readonly action: Action
  readonly url?: string
  readonly selector?: string
  /** `drag` only: the element to drop onto. Its client tool names the two ends separately. */
  readonly toSelector?: string
  readonly text?: string
  /** `type` only: a key or combination pressed instead of typed. */
  readonly key?: string
  /** `dialog` only: accept the dialog, or dismiss it. */
  readonly accept?: boolean
  /** `raw` only: the Playwright snippet the client runs against the page. */
  readonly code?: string
}

export type Response = {
  readonly ok: boolean
  readonly error?: string
  readonly url?: string
  readonly pageText?: string
  readonly imageBase64?: string
  readonly imageMime?: string
  readonly tools?: readonly string[]
}

export type Handler = (request: Request) => Promise<Response>

export const METHOD = "origami/browser"

/**
 * How long one browser request may take. A page load plus a screenshot is the
 * slow case; past this the client is treated as not answering, because a tool
 * call that never returns freezes the whole turn.
 */
export const TIMEOUT_MS = 30_000

export const UNAVAILABLE =
  "The browser tool drives the VS Code integrated browser, so it needs the Origami VS Code client. " +
  "This session is attached to a client that cannot open one. Use the fetch tool for page content, " +
  "or reopen the session in VS Code to drive a real browser."

let handler: Handler | undefined

/** Install the client-side handler, or clear it with `undefined` when the connection ends. */
export function register(next: Handler | undefined): void {
  handler = next
}

export function available(): boolean {
  return handler !== undefined
}

/** The subset of an ACP connection this bridge needs. Typed here so the tool layer stays free of acp imports. */
export type Connection = {
  extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
}

/** Wire a live ACP connection in. The acp layer calls this and nothing else. */
export function registerConnection(connection: Connection): void {
  register((request) => connection.extMethod(METHOD, toWire(request)).then(fromWire))
}

/**
 * Ask the client to act. Never rejects and never hangs: a missing client, a
 * client error and a timeout all come back as `ok: false` with prose the model
 * can read, because the caller is a tool result, not an exception handler.
 */
export async function send(request: Request, timeoutMs: number = TIMEOUT_MS): Promise<Response> {
  const current = handler
  if (!current) return { ok: false, error: UNAVAILABLE }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      current(request),
      new Promise<Response>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              ok: false,
              error: `The VS Code browser did not answer "${request.action}" within ${Math.round(timeoutMs / 1000)}s.`,
            }),
          timeoutMs,
        )
      }),
    ])
  } catch (error) {
    if (isMethodNotFound(error)) return { ok: false, error: UNAVAILABLE }
    return { ok: false, error: `The VS Code browser failed to handle "${request.action}": ${messageOf(error)}` }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Absent keys stay absent: a `url: undefined` on the wire is not the same request as no url at all. */
export function toWire(request: Request): Record<string, unknown> {
  return {
    action: request.action,
    ...(request.url !== undefined ? { url: request.url } : {}),
    ...(request.selector !== undefined ? { selector: request.selector } : {}),
    ...(request.toSelector !== undefined ? { toSelector: request.toSelector } : {}),
    ...(request.text !== undefined ? { text: request.text } : {}),
    ...(request.key !== undefined ? { key: request.key } : {}),
    ...(request.accept !== undefined ? { accept: request.accept } : {}),
    ...(request.code !== undefined ? { code: request.code } : {}),
  }
}

/**
 * Decode a client reply. Anything that is not `ok: true` with the documented
 * field types is a failure, not a partially trusted success - the extension is
 * built against this contract sight-unseen, so a reply that drifts must read as
 * a refusal rather than surface a half-filled result to the model.
 */
export function fromWire(raw: Record<string, unknown> | undefined | null): Response {
  const error = stringOf(raw?.["error"])
  if (raw?.["ok"] !== true) {
    return { ok: false, error: error ?? "The VS Code browser refused the request and gave no reason." }
  }
  const url = stringOf(raw["url"])
  const pageText = stringOf(raw["pageText"])
  const imageBase64 = stringOf(raw["imageBase64"])
  const imageMime = stringOf(raw["imageMime"])
  const rawTools = raw["tools"]
  const tools = Array.isArray(rawTools)
    ? rawTools.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined
  return {
    ok: true,
    ...(error !== undefined ? { error } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(pageText !== undefined ? { pageText } : {}),
    ...(imageBase64 !== undefined ? { imageBase64 } : {}),
    ...(imageMime !== undefined ? { imageMime } : {}),
    ...(tools !== undefined ? { tools } : {}),
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The JSON-RPC "method does not exist" code. Read off the rejection's `code`
 * rather than by importing the ACP SDK's RequestError: this module is kept free
 * of acp imports, the code is the wire contract every SDK carries (the TS one
 * builds it in RequestError.methodNotFound, the Rust one sends the same -32601),
 * and a client is free to reject with any object that has it.
 */
const METHOD_NOT_FOUND = -32601

function isMethodNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === METHOD_NOT_FOUND
}

export * as BrowserBridge from "./bridge"
