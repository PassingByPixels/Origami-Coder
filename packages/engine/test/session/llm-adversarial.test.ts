/**
 * ADVERSARIAL RUNTIME PARITY.
 *
 * `llm-parity.test.ts` replays RECORDED traffic through both runtimes and diffs
 * the event streams. That proves the happy paths a real provider produced. It
 * cannot prove the paths a real provider produces only when something goes
 * wrong, because nobody recorded a cassette of a provider misbehaving.
 *
 * This file is the other half: hand-built wire fixtures for the shapes that
 * break parsers, each driven through BOTH runtimes against the same bytes, with
 * the assertion stated as "native equals the AI SDK" or, where they must
 * differ, as the documented degrade with the reason written down.
 *
 * The upstream is a local `Bun.serve` that answers one queued response per
 * request, so a fixture is a byte sequence, not a mock of our own parser.
 */
import { ConfigV1 } from "@origami/core/v1/config/config"
import { SessionV1 } from "@origami/core/v1/session"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import { jsonSchema, tool } from "ai"
import type { Agent } from "@/agent/agent"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { LLMParityDiff } from "./llm-parity/diff"

// =============================================================================
// Upstream
// =============================================================================

type Queued = { path: string; response: Response | ((req: Request) => Response) }

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Queued[],
  requests: [] as Record<string, unknown>[],
}

/** Queue one canned answer. Each run of a fixture consumes exactly one. */
function enqueue(response: Response | ((req: Request) => Response), path = "/chat/completions") {
  state.queue.push({ path, response })
}

const SSE = { "Content-Type": "text/event-stream" } as const

/** An SSE body from already-serialised chunk objects, `[DONE]`-terminated. */
const sse = (...chunks: ReadonlyArray<unknown>) =>
  `${chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`

/** The same body, but split at byte offsets so a fixture can cut a UTF-8 rune. */
const sseBytes = (body: string, chunkSize: number) => {
  const bytes = new TextEncoder().encode(body)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
      controller.close()
    },
  })
}

const sseResponse = (body: BodyInit) => new Response(body, { status: 200, headers: SSE })

const delta = (d: object, finish: string | null = null) => ({
  id: "chatcmpl-adv",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: d, finish_reason: finish }],
})

const toolDelta = (index: number, id: string | undefined, name: string | undefined, args: string) =>
  delta({
    role: "assistant",
    tool_calls: [
      {
        index,
        ...(id ? { id } : {}),
        type: "function",
        function: { ...(name ? { name } : {}), arguments: args },
      },
    ],
  })

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      const url = new URL(req.url)
      try {
        state.requests.push((await req.json()) as Record<string, unknown>)
      } catch {
        state.requests.push({})
      }
      if (!next) return new Response("unexpected request", { status: 500 })
      if (!url.pathname.endsWith(next.path)) return new Response("not found", { status: 404 })
      return typeof next.response === "function" ? next.response(req) : next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
  state.requests.length = 0
})

afterAll(() => {
  void state.server?.stop()
})

// =============================================================================
// Runtimes
// =============================================================================

const PROVIDER = "adversarial"
const MODEL = "adversarial-model"

/**
 * `@ai-sdk/openai-compatible` is family `openai-compatible`, which the native
 * route table serves by default — so the two layers below are the two real
 * shipping paths for the same config, not a fake and a real one.
 */
const config = (): Partial<ConfigV1.Info> => ({
  enabled_providers: [PROVIDER],
  provider: {
    [PROVIDER]: {
      name: PROVIDER,
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "test-key", baseURL: `${state.server!.url.origin}/v1` },
      models: {
        [MODEL]: {
          name: MODEL,
          limit: { context: 128000, output: 8192 },
          tool_call: true,
          reasoning: true,
        },
      },
    },
  },
})

/**
 * Neither run is left to the route table's defaults: the AI SDK side is forced
 * off with the family list, the native side on with the legacy all-on flag.
 * A silent fallback would otherwise make "the two agree" vacuously true.
 */
const runtimeLayer = (native: boolean) =>
  AppNodeBuilder.build(LayerNode.group([Provider.node, LLM.node]), [
    [
      RuntimeFlags.node,
      RuntimeFlags.layer(
        native
          ? { experimentalNativeLlm: true, disableWebSockets: true }
          : { experimentalNativeLlm: false, nativeLlmFamilies: "none", disableWebSockets: true },
      ),
    ],
  ])

const aiSdkLayer = runtimeLayer(false)
const nativeLayer = runtimeLayer(true)

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Provider.node, LLM.node])))

const agent = {
  name: "test",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
} satisfies Agent.Info

const alpha = tool({
  description: "Echo a value back.",
  inputSchema: jsonSchema<{ value: string }>({
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  }),
  execute: async (input) => ({ echoed: (input as { value?: string }).value ?? null }),
})

type StreamOptions = {
  readonly tools?: Record<string, unknown>
  readonly interrupt?: (events: ReadonlyArray<{ type: string }>) => boolean
}

/**
 * Run the whole engine LLM service on one isolated runtime, so the native flag
 * owns LLM and every transitive dependency, and collect the event stream.
 * Returns an Exit so a fixture that FAILS one runtime is still comparable.
 */
const runOn = (layer: Layer.Layer<LLM.Service>, options: StreamOptions = {}) =>
  Effect.gen(function* () {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    const model = yield* Provider.use.getModel(ProviderV2.ID.make(PROVIDER), ModelV2.ID.make(MODEL))
    const sessionID = SessionID.make(`session-adv-${Math.random().toString(36).slice(2)}`)
    const user = {
      id: MessageID.make(`msg_adv-${Math.random().toString(36).slice(2)}`),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: ProviderV2.ID.make(PROVIDER), modelID: model.id },
    } satisfies SessionV1.User

    return yield* Effect.promise(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const seen: { type: string }[] = []
          const stream = LLM.Service.use((svc) =>
            svc
              .stream({
                user,
                sessionID,
                model,
                agent,
                system: ["You are a helpful assistant."],
                messages: [{ role: "user", content: "Go." }],
                tools: (options.tools ?? {}) as never,
                retries: 0,
              })
              .pipe(
                Stream.tap((event) => Effect.sync(() => seen.push(event as unknown as { type: string }))),
                Stream.runDrain,
              ),
          )
          if (!options.interrupt) {
            const exit = yield* stream.pipe(Effect.exit)
            return { exit, seen }
          }
          const fiber = yield* stream.pipe(Effect.forkScoped)
          // Poll observable state; never sleep a guessed duration.
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline && !options.interrupt(seen)) yield* Effect.sleep("5 millis")
          yield* Fiber.interrupt(fiber)
          return { exit: Exit.void, seen }
        }).pipe(Effect.scoped, Effect.provide(layer), Effect.provideService(InstanceRef, ctx)),
      ),
    )
  })

const types = (seen: ReadonlyArray<{ type: string }>) => seen.map((event) => event.type)

/** The semantic view the recorded-parity suite diffs on. */
const view = (seen: ReadonlyArray<unknown>) => LLMParityDiff.semantic(seen as never)

const same = (aiSdk: ReadonlyArray<unknown>, native: ReadonlyArray<unknown>) =>
  LLMParityDiff.describe(LLMParityDiff.diff(view(aiSdk), view(native)))

// =============================================================================
// Fixtures
// =============================================================================

describe("session.llm — adversarial runtime parity", () => {
  // ---------------------------------------------------------------- 1 ------
  it.instance(
    "a tool call whose arguments PARSE but violate the schema reaches the tool on both runtimes",
    () =>
      Effect.gen(function* () {
        // `{"value": 42}` is valid JSON and wrong for the schema (value: string).
        // Neither runtime validates a tool input at the protocol layer — every
        // tool is built with `jsonSchema(plainObject)`, whose `validate` is
        // undefined — so BOTH must dispatch the call and let the tool answer.
        // A native-side schema check here would silently change what the model
        // is told.
        const body = () =>
          sse(toolDelta(0, "call_schema", "alpha", '{"value":42}'), delta({}, "tool_calls"))
        // `LLM.stream` runs ONE step — the session processor drives the loop —
        // so each runtime consumes exactly one queued response.
        enqueue(sseResponse(body()))
        const aiSdk = yield* runOn(aiSdkLayer, { tools: { alpha } })
        enqueue(sseResponse(body()))
        const native = yield* runOn(nativeLayer, { tools: { alpha } })

        expect(Exit.isSuccess(aiSdk.exit)).toBe(true)
        expect(Exit.isSuccess(native.exit)).toBe(true)
        // The call is dispatched, not rewritten to `invalid`, on both.
        const nameOf = (seen: ReadonlyArray<unknown>) =>
          (seen as { type: string; name?: string }[]).filter((e) => e.type === "tool-call").map((e) => e.name)
        expect(nameOf(native.seen)).toEqual(["alpha"])
        expect(nameOf(aiSdk.seen)).toEqual(nameOf(native.seen))
        expect(same(aiSdk.seen, native.seen)).toBe("equal")
      }),
    { config },
  )

  // ---------------------------------------------------------------- 2 ------
  it.instance(
    "reasoning_content followed by a leaked <think> span: the leaked span is SUPPRESSED, and both runtimes agree the answer is clean",
    () =>
      Effect.gen(function* () {
        // vLLM emits a reasoning model's thinking in BOTH the dedicated field
        // and, leaked, as `<think>` markup on `delta.content`. The openai-chat
        // parser suppresses the leaked copy once a dedicated field has been seen
        // this turn (`ParserState.reasoningSeen`) so the same text is not
        // counted twice. What must NOT happen either way is a `<think>` tag
        // reaching the answer.
        const body = () =>
          sse(
            delta({ reasoning_content: "native" }),
            delta({ content: "<think>leaked</think>Answer." }),
            delta({}, "stop"),
          )
        enqueue(sseResponse(body()))
        const aiSdk = yield* runOn(aiSdkLayer)
        enqueue(sseResponse(body()))
        const native = yield* runOn(nativeLayer)

        const textOf = (seen: ReadonlyArray<unknown>) =>
          (seen as { type: string; text?: string }[])
            .filter((e) => e.type === "text-delta")
            .map((e) => e.text ?? "")
            .join("")
        const reasoningOf = (seen: ReadonlyArray<unknown>) =>
          (seen as { type: string; text?: string }[])
            .filter((e) => e.type === "reasoning-delta")
            .map((e) => e.text ?? "")
            .join("")

        // The answer is identical and tag-free on both paths. That is the part
        // that reaches the user and the transcript, and it agrees.
        expect(textOf(native.seen)).toBe("Answer.")
        expect(textOf(aiSdk.seen)).toBe("Answer.")
        expect(textOf(native.seen)).not.toContain("think")

        // KNOWN DIVERGENCE, pinned here so it is a decision and not a surprise.
        // The AI SDK path keeps the leaked span as a SECOND reasoning block; the
        // native path DROPS it, because `ParserState.reasoningSeen` in
        // `packages/llm/src/protocols/openai-chat.ts` suppresses think-tag
        // reasoning once a turn has used `reasoning_content` (added 2026-08-10
        // because vLLM sends the same thinking on both channels, where appending
        // would show it twice). The cost is that a leaked span carrying NEW text
        // is lost on native and kept on the AI SDK path. Whether that trade is
        // right is an owner call; that it EXISTS is measured here.
        expect(reasoningOf(aiSdk.seen)).toBe("nativeleaked")
        expect(reasoningOf(native.seen)).toBe("native")
      }),
    { config },
  )

  // ---------------------------------------------------------------- 3 ------
  it.instance(
    "a stream that ends without a finish_reason still ends the turn on both runtimes",
    () =>
      Effect.gen(function* () {
        // The provider sends content and then closes cleanly, never sending a
        // choice with a `finish_reason`. `@ai-sdk/openai-compatible` finishes at
        // its flush with reason "unknown". A consumer that never sees a terminal
        // finish has an assistant message that never completes.
        const body = () => sse(delta({ content: "hi" }))
        enqueue(sseResponse(body()))
        const aiSdk = yield* runOn(aiSdkLayer)
        enqueue(sseResponse(body()))
        const native = yield* runOn(nativeLayer)

        expect(Exit.isSuccess(aiSdk.exit)).toBe(true)
        expect(Exit.isSuccess(native.exit)).toBe(true)
        expect(types(aiSdk.seen)).toContain("finish")
        expect(types(native.seen), "native ended the stream with no terminal finish event").toContain("finish")
        // The open text block must be closed too, or the consumer's block never
        // ends.
        expect(types(native.seen)).toContain("text-end")
        expect(same(aiSdk.seen, native.seen)).toBe("equal")
      }),
    { config },
  )

  // ---------------------------------------------------------------- 4 ------
  it.instance(
    "a turn with no usage block anywhere finishes on both runtimes",
    () =>
      Effect.gen(function* () {
        const body = () => sse(delta({ content: "hi" }), delta({}, "stop"))
        enqueue(sseResponse(body()))
        const aiSdk = yield* runOn(aiSdkLayer)
        enqueue(sseResponse(body()))
        const native = yield* runOn(nativeLayer)

        expect(Exit.isSuccess(native.exit)).toBe(true)
        expect(types(native.seen).at(-1)).toBe("finish")
        expect(same(aiSdk.seen, native.seen)).toBe("equal")
      }),
    { config },
  )

  // ---------------------------------------------------------------- 5 ------
  it.instance(
    "an HTTP 429 carrying retry-after fails both runtimes with the provider's own sentence",
    () =>
      Effect.gen(function* () {
        const rateLimited = () =>
          new Response(JSON.stringify({ error: { message: "Rate limit reached for requests", type: "rate_limit" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "retry-after": "42" },
          })
        enqueue(rateLimited())
        const aiSdk = yield* runOn(aiSdkLayer)
        enqueue(rateLimited())
        const native = yield* runOn(nativeLayer)

        // Both must FAIL — a 429 swallowed into a successful empty turn would
        // look to the user like the model answered with nothing.
        expect(Exit.isFailure(aiSdk.exit), "the AI SDK path swallowed a 429").toBe(true)
        expect(Exit.isFailure(native.exit), "the native path swallowed a 429").toBe(true)
        // ...and the failure must carry the provider's words, because that text
        // is what `session/stream-drop.ts` and the retry policy classify on.
        const text = (exit: Exit.Exit<unknown, unknown>) =>
          Exit.isFailure(exit) ? JSON.stringify(exit.cause) : ""
        expect(text(native.exit)).toContain("Rate limit reached")
        expect(text(aiSdk.exit)).toContain("Rate limit reached")
      }),
    { config },
  )

  // ---------------------------------------------------------------- 6 ------
  it.instance(
    "an abort mid tool call tears the turn down on both runtimes without a dangling execution",
    () =>
      Effect.gen(function* () {
        // The upstream announces a tool call and then holds the socket open.
        // Interrupting there is the "user pressed stop while a tool was running"
        // case; neither runtime may leave the stream running.
        const hanging = () =>
          sseResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder()
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(toolDelta(0, "call_abort", "alpha", '{"value":"x"}'))}\n\n`),
                )
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta({}, "tool_calls"))}\n\n`))
                // never closed, never [DONE] — the second turn's request hangs
              },
            }),
          )
        const untilToolCall = (seen: ReadonlyArray<{ type: string }>) => seen.some((e) => e.type === "tool-call")

        enqueue(hanging())
        const aiSdk = yield* runOn(aiSdkLayer, { tools: { alpha }, interrupt: untilToolCall })
        enqueue(hanging())
        const native = yield* runOn(nativeLayer, { tools: { alpha }, interrupt: untilToolCall })

        // The interrupt returns, which is the assertion: a runtime that does not
        // honour it hangs here until the 10 s poll deadline and then fails the
        // last-event check below.
        expect(types(native.seen)).toContain("tool-call")
        expect(types(aiSdk.seen)).toContain("tool-call")
        // Nothing after the interrupt: no finish is invented for an aborted turn.
        expect(types(native.seen)).not.toContain("finish")
        expect(types(aiSdk.seen)).not.toContain("finish")
      }),
    { config },
    30_000,
  )

  // ---------------------------------------------------------------- 7 ------
  it.instance(
    "two tool calls that share one id are both announced, and both runtimes agree",
    () =>
      Effect.gen(function* () {
        // A model that repeats an id is a routine glitch. The danger is not the
        // announcement, it is a consumer keyed by id: two results under one id
        // means one answer is lost or crossed. Whatever the engine does, it must
        // do the same on both runtimes.
        const body = () =>
          sse(
            toolDelta(0, "call_same", "alpha", '{"value":"one"}'),
            toolDelta(1, "call_same", "alpha", '{"value":"two"}'),
            delta({}, "tool_calls"),
          )
        enqueue(sseResponse(body()))
        const aiSdk = yield* runOn(aiSdkLayer, { tools: { alpha } })
        enqueue(sseResponse(body()))
        const native = yield* runOn(nativeLayer, { tools: { alpha } })

        const calls = (seen: ReadonlyArray<unknown>) =>
          (seen as { type: string; id?: string }[]).filter((e) => e.type === "tool-call").map((e) => e.id)
        expect(calls(native.seen)).toEqual(["call_same", "call_same"])
        expect(calls(aiSdk.seen)).toEqual(calls(native.seen))
        // Both inputs must reach the tool: a de-duplicating consumer would drop
        // one execution and the model would wait for a result that never comes.
        const results = (seen: ReadonlyArray<unknown>) =>
          (seen as { type: string; result?: { value?: { echoed?: string } } }[])
            .filter((e) => e.type === "tool-result")
            .map((e) => e.result?.value?.echoed)
        expect(results(native.seen)).toEqual(["one", "two"])
        expect(results(aiSdk.seen)).toEqual(results(native.seen))
        // KNOWN DIVERGENCE, and it is NOT about the shared id — fixture 7b below
        // shows the same shape with distinct ids. The AI SDK settles call A
        // before announcing call B; native announces both calls and then settles
        // both. Same events, same step-finish, different interleaving. No
        // recorded cassette carries two parallel tool calls in one turn, which is
        // why the recorded-parity suite never saw it.
        expect(same(aiSdk.seen, native.seen)).not.toBe("equal")
      }),
    { config },
  )

  // ---------------------------------------------------------------- 8 ------
  it.instance(
    "a multi-byte rune split across two transport chunks arrives whole on both runtimes",
    () =>
      Effect.gen(function* () {
        // The body is sliced every 7 bytes, which lands inside the 2-, 3- and
        // 4-byte sequences below. A per-chunk (non-streaming) UTF-8 decode turns
        // each cut rune into U+FFFD, silently corrupting the answer.
        const text = "héllo 🌍 日本語 — ok"
        const body = () => sseBytes(sse(delta({ content: text }), delta({}, "stop")), 7)
        enqueue(sseResponse(body()))
        const aiSdk = yield* runOn(aiSdkLayer)
        enqueue(sseResponse(body()))
        const native = yield* runOn(nativeLayer)

        const textOf = (seen: ReadonlyArray<unknown>) =>
          (seen as { type: string; text?: string }[])
            .filter((e) => e.type === "text-delta")
            .map((e) => e.text ?? "")
            .join("")
        expect(textOf(native.seen)).toBe(text)
        expect(textOf(native.seen)).not.toContain("�")
        expect(textOf(aiSdk.seen)).toBe(text)
      }),
    { config },
  )

  // ---------------------------------------------------------------- 9 ------
  it.instance(
    "a 64 KiB+ tool argument survives the stream and reaches the tool intact on both runtimes",
    () =>
      Effect.gen(function* () {
        const blob = "x".repeat(70 * 1024)
        // Split across many deltas, the way a real provider streams a long
        // argument string.
        const args = JSON.stringify({ value: blob })
        const pieces: unknown[] = [toolDelta(0, "call_big", "alpha", "")]
        for (let i = 0; i < args.length; i += 4096) pieces.push(toolDelta(0, undefined, undefined, args.slice(i, i + 4096)))
        pieces.push(delta({}, "tool_calls"))
        const body = () => sse(...pieces)
        enqueue(sseResponse(body()))
        const aiSdk = yield* runOn(aiSdkLayer, { tools: { alpha } })
        enqueue(sseResponse(body()))
        const native = yield* runOn(nativeLayer, { tools: { alpha } })

        const inputLen = (seen: ReadonlyArray<unknown>) =>
          (seen as { type: string; input?: { value?: string } }[])
            .filter((e) => e.type === "tool-call")
            .map((e) => e.input?.value?.length)
        expect(inputLen(native.seen)).toEqual([blob.length])
        expect(inputLen(aiSdk.seen)).toEqual([blob.length])
        expect(same(aiSdk.seen, native.seen)).toBe("equal")
      }),
    { config },
    30_000,
  )
  // --------------------------------------------------------------- 7b ------
  it.instance(
    "the parallel tool-call interleaving differs between runtimes even with DISTINCT ids",
    () =>
      Effect.gen(function* () {
        // Isolates the divergence in fixture 7 from the shared id. Two ordinary
        // parallel calls, two ordinary ids: the AI SDK emits
        // call(a) ... result(a), call(b), result(b) and native emits
        // call(a) ... call(b), result(a), result(b). Both end with the same
        // `step-finish` / `finish`, and every result still precedes the step
        // close, so nothing is lost - only the transcript order moves. No
        // recorded cassette carries two parallel tool calls in one turn, which
        // is why the recorded-parity suite never saw this.
        const body = () =>
          sse(
            toolDelta(0, "call_a", "alpha", '{"value":"one"}'),
            toolDelta(1, "call_b", "alpha", '{"value":"two"}'),
            delta({}, "tool_calls"),
          )
        enqueue(sseResponse(body()))
        const aiSdk = yield* runOn(aiSdkLayer, { tools: { alpha } })
        enqueue(sseResponse(body()))
        const native = yield* runOn(nativeLayer, { tools: { alpha } })

        expect(types(aiSdk.seen).slice(-5)).toEqual([
          "tool-result",
          "tool-call",
          "tool-result",
          "step-finish",
          "finish",
        ])
        expect(types(native.seen).slice(-5)).toEqual([
          "tool-call",
          "tool-result",
          "tool-result",
          "step-finish",
          "finish",
        ])
        // The SET of events, and the step outcome, DO agree.
        expect(types(native.seen).toSorted()).toEqual(types(aiSdk.seen).toSorted())
        expect(types(native.seen).at(-1)).toBe("finish")
      }),
    { config },
  )
})
