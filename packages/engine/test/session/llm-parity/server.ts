/**
 * Record/replay HTTP server for the LLM runtime parity harness.
 *
 * The scenario's provider `baseURL` points here, so BOTH runtimes reach it
 * through their own real transports — the AI SDK through its `fetch`, the
 * native runtime through `RequestExecutor` over `FetchHttpClient`. Nothing is
 * faked inside either runtime; the only substitution is the endpoint.
 *
 * Record mode forwards to the real upstream and appends every exchange to a
 * cassette. Replay mode serves interaction N to the Nth request of a run and
 * keeps every request body so the caller can diff what each runtime sent.
 */

import { NodeFileSystem } from "@effect/platform-node"
import { HttpRecorderInternal } from "@origami/http-recorder/internal"
import { Effect, Layer, ManagedRuntime } from "effect"
import path from "node:path"
import { redactRecordedBody } from "./redact"

/** Cassettes live beside the other engine test data, not in `fixtures/recordings`. */
export const CASSETTE_DIR = path.join(import.meta.dir, "..", "..", "cassettes")

export type Mode = "record" | "replay"

/** One request a runtime sent during the current run. */
export type CapturedRequest = { readonly path: string; readonly body: string }

/**
 * Request headers forwarded upstream in record mode, on top of `content-type`
 * and `accept`. An allowlist, not a passthrough: a hosted provider needs the
 * credential the plugin's fetch override put on the request (`authorization`,
 * `x-api-key`, `chatgpt-account-id`) plus the routing and attribution headers
 * some of them require, and nothing else a local runtime happens to add.
 *
 * Every one of these is also allowed through the cassette redactor, so the
 * header NAME is visible in the file; `authorization` and `x-api-key` are in
 * the recorder's default redact set and land as `[REDACTED]`.
 */
export const FORWARDED_HEADERS: ReadonlyArray<string> = [
  "authorization",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "chatgpt-account-id",
  "session-id",
  "user-agent",
  "http-referer",
  "x-title",
  // GitHub Copilot's IDE-auth headers. `/responses` refuses a request without
  // `Editor-Version` ("missing Editor-Version header for IDE auth", measured
  // 2026-09-04); `/chat/completions` tolerated their absence, which hid it.
  "editor-version",
  "editor-plugin-version",
  "copilot-integration-id",
  "openai-intent",
  "x-initiator",
  "x-github-api-version",
  "copilot-vision-request",
]

export type StartOptions = {
  readonly mode: Mode
  /** Cassette name relative to `CASSETTE_DIR`, without `.json`. */
  readonly cassette: string
  /** Real upstream base URL. Contacted in record mode; in replay mode only its path prefix is used. */
  readonly realBaseURL: string
  /** Sent as `Authorization: Bearer <key>` in record mode when present, overriding a forwarded one. */
  readonly apiKey?: string
  /**
   * Record-mode transform for the body sent UPSTREAM. The captured request and
   * the cassette both keep the runtime's original body — that is the baseline
   * replay diffs against, and a runtime on replay sends the untransformed body
   * because the transform belongs to the real endpoint, not to the runtime.
   */
  readonly forwardBody?: (body: string) => string
  readonly metadata?: Record<string, unknown>
}

export type Server = {
  /** Provider `baseURL` to write into the test config. */
  readonly baseURL: string
  /** The recorded requests, in cassette order. Empty in record mode. */
  readonly recorded: ReadonlyArray<CapturedRequest>
  /**
   * Ends the current run: returns the requests it sent, then clears the
   * capture buffer and rewinds the replay cursor so the next runtime replays
   * the same cassette from interaction 0.
   */
  readonly requests: () => CapturedRequest[]
  readonly close: () => Promise<void>
}

const problem = (detail: string) =>
  new Response(JSON.stringify({ error: { message: detail } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  })

const decodeBody = (response: { readonly body: string; readonly bodyEncoding?: "text" | "base64" }) =>
  response.bodyEncoding === "base64" ? Buffer.from(response.body, "base64") : response.body

export const start = async (options: StartOptions): Promise<Server> => {
  const upstream = new URL(options.realBaseURL)
  const basePath = upstream.pathname.replace(/\/$/, "")
  // The default allow list is content-type/accept/openai-beta, which would drop
  // every forwarded credential from the cassette silently. Allowing them puts
  // the header name in the file with `[REDACTED]` for the value. The ChatGPT
  // account id is added to the redact list too: it names the owner's account
  // and has no business in a committed cassette. The body pass removes the
  // per-account `safety_identifier` that OpenAI and Copilot echo in responses.
  const redactor = HttpRecorderInternal.Redactor.make({
    allowRequestHeaders: FORWARDED_HEADERS,
    headers: ["chatgpt-account-id"],
    body: redactRecordedBody,
  })
  const runtime = ManagedRuntime.make(
    HttpRecorderInternal.Cassette.fileSystem({ directory: CASSETTE_DIR }).pipe(Layer.provide(NodeFileSystem.layer)),
  )
  const cassette = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* HttpRecorderInternal.Cassette.Service
    }),
  )

  const interactions =
    options.mode === "replay" ? await runtime.runPromise(cassette.read(options.cassette)) : ([] as const)

  let captured: CapturedRequest[] = []
  let cursor = 0
  // Appends land in request-start order even if two requests overlap.
  let tail: Promise<void> = Promise.resolve()

  const record = async (request: Request, incoming: URL, body: string) => {
    const previous = tail
    let release: () => void = () => {}
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const target = `${upstream.origin}${incoming.pathname}${incoming.search}`
      const headers: Record<string, string> = {}
      const contentType = request.headers.get("content-type")
      if (contentType) headers["content-type"] = contentType
      const accept = request.headers.get("accept")
      if (accept) headers["accept"] = accept
      for (const name of FORWARDED_HEADERS) {
        const value = request.headers.get(name)
        if (value) headers[name] = value
      }
      // The bearer override replaces whatever the caller set, so a config
      // placeholder still records with the real key — EXCEPT when the caller
      // already sent `x-api-key`. That is Anthropic's credential header, and
      // the Messages API reads an added `Authorization: Bearer` as an OAuth
      // token: two credentials on one request, and it refuses. The x-api-key
      // the caller sent is the same config key this override would use, and it
      // is forwarded already.
      if (options.apiKey && !headers["x-api-key"]) headers["authorization"] = `Bearer ${options.apiKey}`

      const forwarded = options.forwardBody ? options.forwardBody(body) : body
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : forwarded,
      })
      const text = await response.text()
      const responseContentType = response.headers.get("content-type") ?? "text/plain"

      await previous
      await runtime.runPromise(
        cassette.append(
          options.cassette,
          {
            transport: "http",
            request: redactor.request({ method: request.method, url: target, headers, body }),
            response: redactor.response({
              status: response.status,
              headers: { "content-type": responseContentType },
              body: text,
            }),
          },
          options.metadata,
        ),
      )
      return new Response(text, { status: response.status, headers: { "content-type": responseContentType } })
    } finally {
      release()
    }
  }

  const replay = (request: Request, incoming: URL) => {
    const index = cursor
    cursor += 1
    const interaction = interactions[index]
    if (!interaction)
      return problem(
        `cassette "${options.cassette}" holds ${interactions.length} interactions; request ${index + 1} (${request.method} ${incoming.pathname}) has none`,
      )
    if (interaction.transport !== "http")
      return problem(`cassette "${options.cassette}" interaction ${index} is not an http interaction`)
    const recorded = new URL(interaction.request.url).pathname
    if (interaction.request.method !== request.method || recorded !== incoming.pathname)
      return problem(
        `cassette "${options.cassette}" interaction ${index} is ${interaction.request.method} ${recorded}; request was ${request.method} ${incoming.pathname}`,
      )
    // A fixture recorded before the recorder kept response headers has none;
    // every cassette here is a streamed response, and a client that sniffs
    // the content type would otherwise refuse to parse it.
    return new Response(decodeBody(interaction.response), {
      status: interaction.response.status,
      headers: { "content-type": "text/event-stream", ...interaction.response.headers },
    })
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // A JIT-loading local model can hold the connection open for minutes.
    idleTimeout: 255,
    fetch: async (request) => {
      const incoming = new URL(request.url)
      const body = await request.text()
      // Cassette traffic is the inference POST, and only that: every
      // interaction in every cassette here is a POST. A GET on this server is
      // the openai-compat context probe (GET <baseURL>/v1/models, see
      // `src/origami/openai-compat-context.ts`), which `provider.ts` registers
      // for a config provider whose `limit.context` is 0 - the value these
      // entries declare on purpose (CONTEXT_UNDECLARED in `scenarios.ts`).
      // It is not an LLM round trip: counting it would fail the interaction
      // count, and serving it from the cassette would hand the probe turn 1 of
      // the conversation and leave the runtime replaying from interaction 1.
      // 404 is what the probe met when these cassettes were recorded (the
      // loader did not exist yet) and it swallows a non-200 as "nothing to
      // add", so both runtimes see the declared window either way.
      if (request.method !== "POST")
        return new Response(JSON.stringify({ error: { message: `parity server serves the cassette POST only; ${request.method} ${incoming.pathname} is not cassette traffic` } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      captured.push({ path: incoming.pathname, body })
      return options.mode === "record" ? await record(request, incoming, body) : replay(request, incoming)
    },
  })

  return {
    baseURL: `http://127.0.0.1:${server.port}${basePath}`,
    recorded: interactions.flatMap((interaction) =>
      interaction.transport === "http"
        ? [{ path: new URL(interaction.request.url).pathname, body: interaction.request.body }]
        : [],
    ),
    requests: () => {
      const sent = captured
      captured = []
      cursor = 0
      return sent
    },
    close: async () => {
      await server.stop(true)
      await runtime.dispose()
    },
  }
}

export * as LLMParityServer from "./server"
