import type { Auth } from "@/auth"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Cause, Effect, FiberSet, Queue } from "effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient } from "effect/unstable/http"
import {
  Tool as NativeTool,
  ToolFailure,
  ToolRuntime,
  toDefinitions,
  type JsonSchema,
  type LLMEvent,
} from "@origami/llm"
import { RequestExecutor, type LLMClientShape } from "@origami/llm/route"
import { LLMNative } from "./native-request"
import { LLMNativeRoute } from "./native-route"
import { ProviderConcurrency } from "@/provider/concurrency"
import { ClaudeSubscription } from "@/provider/claude-subscription"
import { SessionProviderQueue } from "@/session/provider-queue"

export type RuntimeStatus =
  | { readonly type: "supported"; readonly apiKey: string | undefined; readonly baseURL?: string }
  | { readonly type: "unsupported"; readonly reason: string }
export type StreamResult =
  | { readonly type: "supported"; readonly stream: Stream.Stream<LLMEvent, unknown> }
  | { readonly type: "unsupported"; readonly reason: string }

type StreamInput = {
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly llmClient: LLMClientShape
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  /** Names declared to the model; every entry of `tools` stays dispatchable. */
  readonly activeTools?: ReadonlyArray<string>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly frequencyPenalty?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, any>
  readonly headers: Record<string, string>
  readonly abort: AbortSignal
  /** This turn's session. Only used to attribute a provider-queue wait to the
   *  right sub-agent row; absent = no waiting line, never a different request. */
  readonly sessionID?: string
  /** Set when this session is a SUB-AGENT. Its absence is what marks a parent
   *  step, which takes priority in the provider's permit queue. */
  readonly parentSessionID?: string
}

export function status(input: Pick<StreamInput, "model" | "provider" | "auth">): RuntimeStatus {
  return statusWithFetch(input, providerFetch(input))
}

// Every provider package with a native route; the family gate below decides
// whether it actually runs.
const ROUTED_NPM = new Set<string>([
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/anthropic",
  "@openrouter/ai-sdk-provider",
  "@ai-sdk/xai",
  "@ai-sdk/github-copilot",
  "@ai-sdk/mistral",
  "@ai-sdk/groq",
  "@ai-sdk/cerebras",
  "@ai-sdk/deepinfra",
  "@ai-sdk/togetherai",
  "@ai-sdk/perplexity",
  "@ai-sdk/alibaba",
  "venice-ai-sdk-provider",
  "@ai-sdk/vercel",
  ClaudeSubscription.NPM,
])

function statusWithFetch(
  input: Pick<StreamInput, "model" | "provider" | "auth">,
  fetch: typeof globalThis.fetch | undefined,
): RuntimeStatus {
  // Routing is by family (the wire protocol), never by provider id: a
  // self-hosted vLLM box and a hosted proxy that both speak OpenAI Chat are the
  // same family. Which families are on lives in native-route.ts.
  const npm = input.model.api.npm
  if (!ROUTED_NPM.has(npm))
    return {
      type: "unsupported",
      reason: `provider package has no native route: ${npm}`,
    }
  // Gate B for the subscription family: the CLI's own answers (present, version
  // at or above the floor, `auth status` loggedIn), read from the last probe.
  // No key and no fetch: the CLI holds the credential.
  if (npm === ClaudeSubscription.NPM) {
    const ready = ClaudeSubscription.readiness()
    return ready.type === "ready"
      ? { type: "supported", apiKey: undefined }
      : { type: "unsupported", reason: ready.reason }
  }
  if (input.auth?.type === "oauth" && !fetch) {
    return { type: "unsupported", reason: "OAuth auth requires a provider fetch override" }
  }

  const apiKey =
    typeof input.provider.options.apiKey === "string" && input.provider.options.apiKey !== ""
      ? input.provider.options.apiKey
      : input.provider.key
  // A local OpenAI-compatible endpoint (vLLM, LM Studio) has no key at all, and
  // neither has GitHub Copilot: its auth loader returns `apiKey: ""` because the
  // signer below overwrites Authorization on every call and deletes `x-api-key`.
  // A bridged signer is therefore authentication enough.
  if (!apiKey && npm !== "@ai-sdk/openai-compatible" && !fetch)
    return { type: "unsupported", reason: "API key is not configured" }

  return {
    type: "supported",
    apiKey,
    baseURL: typeof input.provider.options.baseURL === "string" ? input.provider.options.baseURL : undefined,
  }
}

/**
 * Events that close the step's content: the step boundary itself, and the two
 * block ends a protocol emits when its stream runs out. Settled tool results are
 * flushed ahead of every one of them.
 */
const CLOSES_CONTENT = new Set(["step-finish", "reasoning-end", "text-end"])
const closesContent = (type: string) => CLOSES_CONTENT.has(type)

export function stream(input: StreamInput): StreamResult {
  const signer = providerFetch(input)
  const current = statusWithFetch(input, signer)
  if (current.type === "unsupported") return current
  // The per-provider cap, applied HERE and not only in provider.ts: that wrapper
  // only ever reaches the AI SDK, because the shallow copy it decorates is the
  // SDK factory's options object and this runtime reads the raw plugin signer
  // off `provider.options.fetch` (t-52cxcw). Both paths take permits from the
  // same table, so one provider's cap counts one provider's generations.
  const fetch = gatedFetch(input, signer)

  // Integration point with @origami/llm: native-request lowers session data into
  // an LLMRequest, then LLMClient handles route selection and transport.
  // ProviderTransform.providerOptions and the native LLM SDK both use OpenAI's
  // official wire field names, so for the OpenAI family this is identity, not
  // translation. The OpenAI-compatible and xAI families are the exceptions, both
  // handled in `nativeOptions` below.
  const tools = nativeTools(input.tools, input)
  const declared = input.activeTools
    ? Object.fromEntries(Object.entries(tools).filter(([name]) => input.activeTools!.includes(name)))
    : tools
  const options = nativeOptions(input.model, input.providerOptions ?? {})
  const request = LLMNative.request({
    model: input.model,
    apiKey: current.apiKey,
    baseURL: current.baseURL,
    // ProviderTransform.message mutates in place (applyCaching writes
    // providerOptions onto the message and its last part), so the caller's array
    // would carry this step's cache markers into the next step. Clone one level
    // down.
    messages: ProviderTransform.message(
      input.messages.map((message) =>
        Array.isArray(message.content)
          ? ({ ...message, content: message.content.map((part) => ({ ...part })) } as ModelMessage)
          : { ...message },
      ),
      input.model,
      input.providerOptions ?? {},
    ),
    // Every AI SDK adapter we mirror sends an explicit `auto` whenever tools are
    // declared and the caller set no choice; the native protocol omits an unset
    // choice. Defaulting here keeps the wire bytes identical on both paths.
    toolChoice: input.toolChoice ?? (Object.keys(declared).length ? "auto" : undefined),
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    frequencyPenalty: input.frequencyPenalty,
    maxOutputTokens: input.maxOutputTokens,
    providerOptions: options.providerOptions,
    http: options.http,
    headers: { ...providerHeaders(input.provider.options.headers), ...input.headers },
    // t-vs5p1y: the declared tools go in at construction. They used to be added
    // by `LLMRequest.update`, a second full construction that re-validated every
    // message of the window (31-65 ms per step in a big chat).
    definitions: toDefinitions(declared),
  })
  const stream = Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        // t-vs5p1y: the request was constructed just above; lowering it is the
        // next phase, in its own turn of the event loop.
        yield* Effect.yieldNow
        const settlements = yield* FiberSet.make<void>()
        const results = yield* Queue.unbounded<LLMEvent, Cause.Done>()
        // t-gw71a9. Calls parsed on this step and not yet launched.
        //
        // A dispatched tool holds the runtime for as long as it takes, and a
        // `task` spawn takes seconds. Launching one where it is PARSED stops
        // the stream reading the calls behind it, so a batch of
        // [task, task, todowrite] published the todo list only after two
        // sub-agents had spawned - 11 s after the model wrote it, with the
        // bytes sitting unparsed the whole time. Parsing is cheap and running
        // is not: every call in the step is published first, and the batch is
        // launched together at the step's next block end.
        const parsed: NativeToolCall[] = []
        const settle = (call: NativeToolCall) =>
          ToolRuntime.dispatch(tools, call).pipe(
            Effect.flatMap((dispatched) => Queue.offerAll(results, dispatched.events)),
            Effect.catchCause((cause) => Queue.failCause(results, cause)),
            Effect.asVoid,
            // Never immediately: the whole point is that the first tool's body
            // must not run before its siblings are launched. The set keeps them
            // in launch order, which is the order they were parsed in.
            FiberSet.run(settlements, { startImmediately: false }),
          )
        const launch = Effect.suspend(() => Effect.forEach(parsed.splice(0), settle, { discard: true }))
        const provider = input.llmClient
          .stream(request)
          .pipe(
            Stream.flatMap((event) => {
              if (event.type === "tool-call" && !event.providerExecuted) {
                // Repair before the call is published: the session records the
                // event it sees, so a repaired call must reach the processor
                // already repaired.
                const call = repairToolCall(tools, event)
                parsed.push(call)
                return Stream.make(call)
              }
              // Every dispatched tool must settle before the step closes, so its
              // result precedes `step-finish` as on the AI SDK path: the
              // processor cuts the stream at a step boundary when compaction is
              // due (`takeUntil(needsCompaction)`), and a result queued behind
              // that boundary would be dropped with the call left running
              // forever. The block-closing events are the same barrier one event
              // earlier, because some providers only close reasoning/text at the
              // end of the turn. Blocking here is free when no tool is
              // outstanding.
              if (closesContent(event.type))
                return Stream.fromEffect(
                  launch.pipe(
                    Effect.andThen(FiberSet.awaitEmpty(settlements)),
                    Effect.andThen(Queue.clear(results)),
                  ),
                ).pipe(
                  Stream.flatMap((settled) => Stream.fromIterable(settled)),
                  Stream.concat(Stream.make(event)),
                )
              return Stream.make(event)
            }),
            Stream.concat(
              Stream.fromEffectDrain(
                // `launch` again: a stream that ends with no block-closing
                // event at all still owes its calls a result.
                launch.pipe(
                  Effect.andThen(FiberSet.awaitEmpty(settlements)),
                  Effect.andThen(Queue.end(results)),
                  Effect.asVoid,
                ),
              ),
            ),
          )
        return provider.pipe(Stream.concat(Stream.fromQueue(results)))
      }),
    ),
  )

  const limited = input.model.api.npm === ClaudeSubscription.NPM ? processPermit(input, stream) : stream

  return {
    ...current,
    // The session loop owns retries (notices, per-family limits, degrade and
    // image-cap classification); the executor's own ladder is switched off so a
    // 5xx reaches the loop after one attempt, as it does on the AI SDK path.
    stream: (fetch ? limited.pipe(Stream.provideService(FetchHttpClient.Fetch, fetch)) : limited).pipe(
      Stream.provideService(RequestExecutor.Retries, 0),
    ),
  }
}

type NativeToolCall = Extract<LLMEvent, { readonly type: "tool-call" }>

/**
 * The repair-only tool of `tool/invalid.ts`: registered and dispatchable, never
 * offered to the model (`SessionPromptCapture.REPAIR_ONLY_TOOLS`).
 */
const INVALID_TOOL = "invalid"

/**
 * Native mirror of the AI SDK path's `experimental_repairToolCall`
 * (session/llm.ts). Both runtimes must degrade a broken call the same way.
 *
 * Two repairs, in the AI SDK's order: a tool name that differs from a real tool
 * only by case is renamed; a call the protocol could not read becomes a call to
 * `invalid` carrying the requested tool and the protocol's message, so the model
 * gets a tool result and can try again. A call that is neither is untouched.
 */
function repairToolCall(tools: Record<string, unknown>, event: NativeToolCall): NativeToolCall {
  const lower = event.name.toLowerCase()
  // The casing fix must fall through, not return: a call can be both mis-cased
  // and unreadable, and returning here would dispatch it to the real tool with
  // `invalid: true` and the raw argument string still on the event.
  const named = lower !== event.name && !tools[event.name] && tools[lower] ? { ...event, name: lower } : event
  if (!named.invalid) return named
  const { invalid: _invalid, error, ...rest } = named
  return {
    ...rest,
    name: INVALID_TOOL,
    input: { tool: named.name, error: error ?? `Invalid input for tool call ${named.name}` },
  }
}

// Keys `@ai-sdk/openai-compatible` maps to a dedicated wire field instead of
// spreading verbatim (its `openaiCompatibleLanguageModelChatOptions` shape).
const COMPATIBLE_VERBATIM_EXCLUDED = new Set(["reasoningEffort", "textVerbosity", "user"])

export type NativeOptions = {
  readonly providerOptions?: Record<string, Record<string, unknown>>
  readonly http?: { readonly body: Record<string, unknown> }
}

/**
 * Lower the engine's provider options onto the native request.
 *
 * The engine keys an OpenAI-compatible model's options by its provider id
 * (`{ vllm: { reasoningEffort, chat_template_kwargs } }`) because that is what
 * `@ai-sdk/openai-compatible` reads: it maps `reasoningEffort` and
 * `textVerbosity` to wire fields and spreads every other key verbatim into the
 * body. The native OpenAI Chat protocol instead reads typed options under
 * `openai` and takes free-form body fields through the `http.body` overlay, so
 * this is a real translation, kept in one place so the runtimes cannot drift.
 *
 * A field the overlay refuses (it protects protocol-owned keys such as
 * `temperature` or `thinking`) fails the request loudly with the field named.
 */
export function nativeOptions(model: Provider.Model, raw: Record<string, unknown>): NativeOptions {
  const keyed = ProviderTransform.providerOptions(model, raw)
  // xAI speaks the OpenAI Responses wire, so the field names already match; only
  // the namespace differs. The engine keys them under "xai" (what @ai-sdk/xai
  // reads), the native Responses protocol reads `providerOptions.openai` and
  // nothing else. Re-key, do not translate.
  if (model.api.npm === "@ai-sdk/xai" && isRecord(keyed.xai)) return { providerOptions: { openai: keyed.xai } }
  // GitHub Copilot is the same re-key, one namespace along: the engine keys it
  // under "copilot", the native protocols read `providerOptions.openai`. The
  // field names are OpenAI's own, so this moves the block, it does not translate.
  if (model.api.npm === "@ai-sdk/github-copilot" && isRecord(keyed.copilot))
    return { providerOptions: { openai: keyed.copilot } }
  if (model.api.npm !== "@ai-sdk/openai-compatible") return { providerOptions: keyed }
  const source: Record<string, unknown> = Object.assign({}, ...Object.values(keyed).filter(isRecord))
  const openai: Record<string, unknown> = {}
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (key === "reasoningEffort") openai.reasoningEffort = value
    else if (key === "textVerbosity") body.verbosity = value
    else if (COMPATIBLE_VERBATIM_EXCLUDED.has(key)) body[key] = value
    else body[key] = value
  }
  return {
    providerOptions: Object.keys(openai).length ? { openai } : undefined,
    http: Object.keys(body).length ? { body } : undefined,
  }
}

// Families whose OAuth plugin signer (`provider.options.fetch`) may carry a
// native request. Keyed by family, but deliberately not open-ended:
// snowflake-cortex installs the same signer shape on an OpenAI-compatible model,
// and an open check would move its OAuth traffic to native with no cassette
// behind it.
const OAUTH_FAMILIES = new Set<LLMNativeRoute.Family>(["openai", "xai", "copilot"])

/**
 * Copilot is bridged by provider id as well as by family, because its Claude
 * rows are declared `@ai-sdk/anthropic`; see the definition in native-route.ts.
 */
const isCopilotProvider = LLMNativeRoute.isCopilotProvider

const bodyDecoder = new TextDecoder()

/**
 * Re-materialise a native request body in the shape a plugin signer expects.
 *
 * Every signer under src/plugin/ was written against the AI SDK, which hands the
 * `fetch` override a string body; the native runtime reaches the same signer
 * through Effect's fetch client, which sends a text body as a Uint8Array. Without
 * this decode the signers silently do nothing on the native path.
 *
 * Decoding as UTF-8 text is right for the whole class: `ProviderShared.jsonPost`
 * is the only body builder in @origami/llm's HTTP transport, so every byte body
 * crossing this bridge is UTF-8 JSON. A Raw, FormData or Stream body is passed
 * through untouched, as on the AI SDK path.
 */
export function signerBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body === "string" || body === null || body === undefined) return body
  if (body instanceof ArrayBuffer) return bodyDecoder.decode(body)
  if (ArrayBuffer.isView(body)) return bodyDecoder.decode(body)
  return body
}

function providerFetch(input: Pick<StreamInput, "model" | "provider" | "auth">): typeof globalThis.fetch | undefined {
  if (input.auth?.type !== "oauth") return undefined
  if (!OAUTH_FAMILIES.has(LLMNativeRoute.family(input.model.api.npm)) && !isCopilotProvider(input.model))
    return undefined
  const value: unknown = input.provider.options.fetch
  if (typeof value !== "function") return undefined
  const signer = value as typeof globalThis.fetch
  return ((request: RequestInfo | URL, init?: RequestInit) =>
    signer(request, init ? { ...init, body: signerBody(init.body) } : init)) as typeof globalThis.fetch
}

/** The provider's configured cap, or undefined for unlimited. Same key and same
 *  meaning as the AI SDK path reads in provider.ts. */
export function concurrencyLimit(provider: Provider.Info): number | undefined {
  const value: unknown = provider.options["max_concurrent"]
  return typeof value === "number" && value > 0 ? value : undefined
}

/**
 * The transport this runtime will use, gated on the provider's `max_concurrent`.
 *
 * Returns `signer` unchanged when the provider has no cap, so an uncapped
 * provider keeps the exact transport it had (and, with no signer, Effect's own
 * default fetch client) rather than gaining a wrapper for nothing.
 *
 * PARENT PRIORITY, not a reserved slot: a request from a session with no
 * `parentSessionID` is a parent step and jumps the permit queue ahead of every
 * queued child. A reserved slot would cost the fan-out a permanent permit — with
 * `max_concurrent: 2` the acceptance case (four streams, two in flight) would
 * run one at a time. Priority costs nothing and bounds the parent's wait by the
 * longest generation already IN FLIGHT instead of by the depth of a fan-out that
 * can keep growing.
 */
function gatedFetch(
  input: Pick<StreamInput, "model" | "provider" | "sessionID" | "parentSessionID">,
  signer: typeof globalThis.fetch | undefined,
): typeof globalThis.fetch | undefined {
  const max = concurrencyLimit(input.provider)
  if (max === undefined) return signer
  const providerID = input.model.providerID
  const sessionID = input.sessionID
  const notice = sessionID
    ? {
        onWait: (ahead: number) =>
          SessionProviderQueue.publishProviderQueue({ sessionID, providerID, state: { type: "waiting", ahead } }),
        onStart: () =>
          SessionProviderQueue.publishProviderQueue({ sessionID, providerID, state: { type: "started" } }),
      }
    : undefined
  return ProviderConcurrency.limitFetch(
    providerID,
    max,
    signer ?? ((target: any, init?: any) => globalThis.fetch(target, init)),
    { priority: input.parentSessionID === undefined, ...(notice ? { notice } : {}) },
  ) as typeof globalThis.fetch
}

/**
 * The per-window cap on CLI processes (t-tija5f). The subscription route never
 * calls `fetch`, so `gatedFetch` cannot hold its permits: one permit is held for
 * the life of each step's stream instead, from the same per-provider table and
 * with the same parent priority. Default `ClaudeSubscription.DEFAULT_CONCURRENCY`.
 */
function processPermit<E, R>(
  input: Pick<StreamInput, "model" | "provider" | "sessionID" | "parentSessionID">,
  stream: Stream.Stream<LLMEvent, E, R>,
): Stream.Stream<LLMEvent, E, R> {
  const max = concurrencyLimit(input.provider) ?? ClaudeSubscription.DEFAULT_CONCURRENCY
  const providerID = input.model.providerID
  const sessionID = input.sessionID
  const priority = input.parentSessionID === undefined
  const acquire = Effect.promise(async () => {
    const sem = ProviderConcurrency.providerSemaphore(providerID, max)
    const queued = sem.free <= 0
    if (queued && sessionID)
      SessionProviderQueue.publishProviderQueue({
        sessionID,
        providerID,
        state: { type: "waiting", ahead: sem.waitingAhead(priority) },
      })
    await sem.acquire(priority)
    if (queued && sessionID)
      SessionProviderQueue.publishProviderQueue({ sessionID, providerID, state: { type: "started" } })
    return sem
  })
  return Stream.unwrap(
    Effect.acquireRelease(acquire, (sem) => Effect.sync(() => sem.release())).pipe(Effect.as(stream)),
  )
}

function providerHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function nativeSchema(value: unknown): JsonSchema {
  if (!value || typeof value !== "object") return { type: "object", properties: {} }
  if ("jsonSchema" in value && value.jsonSchema && typeof value.jsonSchema === "object")
    return value.jsonSchema as JsonSchema
  return asSchema(value as Parameters<typeof asSchema>[0]).jsonSchema as JsonSchema
}

export function nativeTools(tools: Record<string, Tool>, input: Pick<StreamInput, "messages" | "abort">) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, item]) => [
      name,
      // Tool execution remains origami-owned. The native runtime only adapts
      // the @origami/llm tool call back into the AI SDK Tool.execute shape.
      NativeTool.make({
        description: item.description ?? "",
        jsonSchema: nativeSchema(item.inputSchema),
        execute: (args: unknown, ctx) =>
          Effect.tryPromise({
            try: () => {
              if (!item.execute) throw new Error(`Tool has no execute handler: ${name}`)
              return item.execute(args, {
                toolCallId: ctx?.id ?? name,
                messages: input.messages,
                abortSignal: input.abort,
              })
            },
            catch: (error) => new ToolFailure({ message: errorMessage(error), error }),
          }),
      }),
    ]),
  )
}

export * as LLMNativeRuntime from "./native-runtime"
