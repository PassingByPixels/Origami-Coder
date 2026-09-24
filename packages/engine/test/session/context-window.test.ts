import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"
import { isContextOverflow } from "@origami/llm"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { SessionWindowFit } from "../../src/session/window-fit"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpError, reply, TestLLMServer, type Item } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { SessionProjector } from "@origami/core/session/projector"

// ---------------------------------------------------------------------------
// t-tc20mj. The field case: session ses_f62afbce... on a self-hosted vLLM
// (Qwen3.8-Flash-Next, max_model_len 262144, no declared output limit). The
// engine sent max_tokens = 32000 with a 230k prompt, and vLLM answered this 400
// four times, the compaction's own request included. The text below is the
// log line verbatim (origami.log, 2026-09-14T02:51:11.925Z).
//
// The fixture endpoint behaves like vLLM: it refuses any request whose prompt
// plus max_tokens exceeds its window, and it counts the prompt with its OWN
// tokenizer, not the engine's estimator. The window here is scaled down from
// 262144 to keep the test fast; the arithmetic is the same.
// ---------------------------------------------------------------------------

const FIELD_400 =
  "This model's maximum context length is 262144 tokens. However, you requested 32000 output tokens and your prompt contains at least 230145 input tokens, for a total of at least 262145 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=230145)"

const WINDOW = 40_000

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

/** A vLLM-served model: a known window and NO declared output limit (`output: 0`),
 *  which is how every probed local model is written. */
function config(url: string) {
  return {
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: WINDOW, output: 0 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

/** The endpoint's own token count: the text the chat template renders, at
 *  `divisor` characters per token, plus a few tokens per message. JSON keys are
 *  not text the model sees, so they are not counted. */
function promptTokens(body: Record<string, unknown>, divisor: number) {
  let chars = 0
  let count = 0
  const text = (value: unknown) => {
    if (typeof value === "string") chars += value.length
    else if (Array.isArray(value)) for (const item of value) text(item)
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      if (typeof record.text === "string") chars += record.text.length
      if (record.function && typeof record.function === "object") {
        const fn = record.function as Record<string, unknown>
        if (typeof fn.arguments === "string") chars += fn.arguments.length
        if (typeof fn.name === "string") chars += fn.name.length
      }
    }
  }
  for (const message of (body.messages as Record<string, unknown>[] | undefined) ?? []) {
    count++
    text(message.content)
    text(message.tool_calls)
  }
  const tools = body.tools ? JSON.stringify(body.tools).length : 0
  return Math.ceil((chars + tools) / divisor) + 4 * count
}

function oversize(body: Record<string, unknown>, divisor: number) {
  const requested = typeof body.max_tokens === "number" ? body.max_tokens : 0
  return promptTokens(body, divisor) + requested > WINDOW
}

/** Queue `count` answers from a vLLM with a WINDOW-token window: the verbatim
 *  400 for any request that does not fit, otherwise `text` with the endpoint's
 *  own prompt count as usage — the number a real server reports back. */
const vllm = Effect.fn("test.vllm")(function* (
  llm: TestLLMServer["Service"],
  input: { count: number; divisor?: number; text?: string },
) {
  const divisor = input.divisor ?? 4
  for (let i = 0; i < input.count; i++) {
    yield* llm.pushMatch(
      (hit) => oversize(hit.body, divisor),
      httpError(400, { error: { message: FIELD_400, type: "BadRequestError", param: "input_tokens", code: 400 } }),
    )
    const ok: Item = reply()
      .text(input.text ?? "ok")
      .usage({ input: 0, output: 1 })
      .stop()
      .item()
    yield* llm.pushMatch((hit) => {
      if (oversize(hit.body, divisor)) return false
      if (ok.type !== "sse") return true
      for (const line of ok.tail) {
        const usage = (line as { usage?: Record<string, number> }).usage
        if (!usage) continue
        usage.prompt_tokens = promptTokens(hit.body, divisor)
        usage.total_tokens = usage.prompt_tokens + 1
      }
      return true
    }, ok)
  }
})

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
  text?: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  if (text) yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
  return msg
})

const root = LayerNode.group([
  SessionCompaction.node,
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  [
    [SessionSummary.node, summary],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ] as const,
)

const it = testEffect(env)

/** One model step through the real request builder and the native route. */
const turn = Effect.fn("TestSession.turn")(function* (chatID: SessionID, dir: string, text: string) {
  const processors = yield* SessionProcessor.Service
  const provider = yield* Provider.Service
  const parent = yield* user(chatID, text)
  const msg = yield* assistant(chatID, parent.id, path.resolve(dir))
  const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: chatID, model: mdl })
  const result = yield* handle.process({
    user: {
      id: parent.id,
      sessionID: chatID,
      role: "user",
      time: parent.time,
      agent: parent.agent,
      model: { providerID: ref.providerID, modelID: ref.modelID },
    } satisfies SessionV1.User,
    sessionID: chatID,
    model: mdl,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: text }],
    tools: {},
  } satisfies LLM.StreamInput)
  return { result, handle }
})

/** Words, not one repeated character: a run of one character is a degenerate
 *  input for any estimator. */
function prose(chars: number, tag = "") {
  const words = ["window", "context", "tokens", "request", "compaction", "summary", "history", "model"]
  let out = tag
  for (let i = 0; out.length < chars; i++) out += words[i % words.length] + (i % 13 === 12 ? ".\n" : " ")
  return out.slice(0, chars)
}

describe("the field 400 is a context overflow", () => {
  test("the verbatim vLLM text is classified as context overflow", () => {
    expect(isContextOverflow(FIELD_400)).toBe(true)
  })
})

describe("max_tokens fits the remaining window (t-tc20mj)", () => {
  it.live("a prompt that leaves less than 32k of the window gets a max_tokens that fits, and the step runs", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          yield* vllm(llm, { count: 2 })
          const chat = yield* session.create({})
          // About 12k tokens of prompt: 12k + 32k does not fit a 40k window.
          const { result, handle } = yield* turn(chat.id, dir, prose(48_000))

          const inputs = yield* llm.inputs
          expect(inputs.length).toBe(1)
          const body = inputs[0]!
          expect(typeof body.max_tokens).toBe("number")
          expect(promptTokens(body, 4) + (body.max_tokens as number)).toBeLessThanOrEqual(WINDOW)
          expect(result).toBe("continue")
          expect(handle.message.error).toBeUndefined()
        }),
      { config },
    ),
  )

  it.live("a prompt that leaves less than the floor is not sent; the step asks for compaction", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          yield* vllm(llm, { count: 2 })
          const chat = yield* session.create({})
          // About 38k tokens: no max_tokens above the floor fits what is left.
          const { result } = yield* turn(chat.id, dir, prose(152_000))

          expect(yield* llm.calls).toBe(0)
          expect(result).toBe("compact")
        }),
      { config },
    ),
  )

  it.live("the estimate learns the endpoint's tokenizer from the reported usage", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          // A dense tokenizer: 3 characters per token, where the engine's
          // estimator assumes 4. Uncalibrated, the second request under-counts
          // its prompt by a quarter and overflows.
          yield* vllm(llm, { count: 3, divisor: 3 })
          const chat = yield* session.create({})
          const first = yield* turn(chat.id, dir, prose(8_000))
          expect(first.result).toBe("continue")
          const second = yield* turn(chat.id, dir, prose(64_000, "second "))
          expect(second.result).toBe("continue")

          const inputs = yield* llm.inputs
          expect(inputs.length).toBe(2)
          const body = inputs[1]!
          expect(promptTokens(body, 3) + (body.max_tokens as number)).toBeLessThanOrEqual(WINDOW)
        }),
      { config },
    ),
  )
})

describe("compaction's own request fits the window (t-tc20mj)", () => {
  it.live("a history larger than the window compacts in one request that fits, keeping the newest turns", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const compaction = yield* SessionCompaction.Service
          yield* vllm(llm, { count: 2, text: "Summary of the work so far." })
          const chat = yield* session.create({})
          const root = path.resolve(dir)
          // Six turns of about 9k tokens each: 54k of history in a 40k window.
          for (let i = 0; i < 6; i++) {
            const asked = yield* user(chat.id, prose(2_000, `question-${i} `))
            yield* assistant(chat.id, asked.id, root, prose(34_000, `answer-${i} `))
          }
          yield* compaction.create({ sessionID: chat.id, agent: "build", model: ref, auto: true })
          const messages = yield* session.messages({ sessionID: chat.id })
          const marker = messages.at(-1)!

          const result = yield* compaction.process({
            parentID: marker.info.id,
            messages,
            sessionID: chat.id,
            auto: true,
          })

          const inputs = yield* llm.inputs
          expect(inputs.length).toBe(1)
          const body = inputs[0]!
          expect(promptTokens(body, 4) + (body.max_tokens as number)).toBeLessThanOrEqual(WINDOW)
          // What was left out is the OLDEST history; the newest head turn is sent.
          const sent = JSON.stringify(body.messages)
          expect(sent).not.toContain("answer-0 ")
          expect(sent).toContain("answer-4 ")
          expect(result).toBe("continue")
          const after = yield* session.messages({ sessionID: chat.id })
          const written = after.findLast((item) => item.info.role === "assistant" && item.info.summary)
          expect(written?.info.role === "assistant" ? written.info.error : "missing").toBeUndefined()
        }),
      { config },
    ),
  )
})

describe("SessionWindowFit", () => {
  test("no known window: the request is left alone", () => {
    expect(SessionWindowFit.fit({ context: 0, estimate: 999_999, requested: 32_000 })).toEqual({
      maxOutputTokens: 32_000,
      short: false,
    })
  })

  test("the clamp never raises max_tokens above what was asked", () => {
    expect(SessionWindowFit.fit({ context: 262_144, estimate: 1_000, requested: 32_000 }).maxOutputTokens).toBe(32_000)
  })

  test("the field numbers: a 230k prompt in a 262k window gets max_tokens that fits", () => {
    const fit = SessionWindowFit.fit({ context: 262_144, estimate: 230_145, requested: 32_000 })
    expect(fit.short).toBe(false)
    expect(230_145 + fit.maxOutputTokens).toBeLessThanOrEqual(262_144)
  })

  test("a requested max below the floor is its own floor", () => {
    // A model that declares 1024 output tokens is not short while 1024 fits.
    // Margin at 100k is 2,000, so 96,000 leaves 2,000: short for the 4,096
    // floor, not for a 1,024 request.
    expect(SessionWindowFit.fit({ context: 100_000, estimate: 96_000, requested: 1_024 }).short).toBe(false)
    expect(SessionWindowFit.fit({ context: 100_000, estimate: 96_000, requested: 32_000 }).short).toBe(true)
  })

  test("calibration only ever raises the estimate, and at most doubles it", () => {
    const id = "calibration-test"
    SessionWindowFit.reset()
    expect(SessionWindowFit.calibrate(id, 1_000)).toBe(1_000)
    SessionWindowFit.sent(id, 1_000)
    SessionWindowFit.observe(id, 1_330)
    expect(SessionWindowFit.calibrate(id, 3_000)).toBe(3_990)
    SessionWindowFit.sent(id, 1_000)
    SessionWindowFit.observe(id, 500)
    expect(SessionWindowFit.calibrate(id, 3_000)).toBe(3_000)
    SessionWindowFit.sent(id, 1_000)
    SessionWindowFit.observe(id, 9_000)
    expect(SessionWindowFit.calibrate(id, 3_000)).toBe(6_000)
    SessionWindowFit.reset()
  })

  test("a usage report with no request estimate behind it changes nothing", () => {
    const id = "calibration-orphan"
    SessionWindowFit.reset()
    SessionWindowFit.observe(id, 50_000)
    expect(SessionWindowFit.calibrate(id, 1_000)).toBe(1_000)
    SessionWindowFit.reset()
  })
})
