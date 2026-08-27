import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionDegrade } from "../../src/session/degrade"
import { SessionRetry } from "../../src/session/retry"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { SessionProjector } from "@origami/core/session/projector"

// ---------------------------------------------------------------------------
// Fixtures
//
// The 500 body is copied from the real endpoint that caused this work: a
// self-hosted DeepSeek V4 on vLLM, whose encoder asserts the effort against a
// list that does not contain "low", so a tier the engine synthesised from the
// MODEL NAME comes back as a 500 naming the field. Reproduced verbatim rather
// than invented, because the whole classifier turns on the shape of that text.
// ---------------------------------------------------------------------------

const DS4_MESSAGE = "Invalid reasoning effort: low"
const ds4Body = { error: { message: DS4_MESSAGE, type: "InternalServerError", code: 500 } }

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

/**
 * `reasoningEffort` sits on the MODEL's options, which is one of the four
 * writers `LLMRequestPrep.prepare` merges into the flat options record — the
 * same record `ProviderTransform.options` and the selected variant write into.
 * `@ai-sdk/openai-compatible` renames it to the wire field `reasoning_effort`
 * (node_modules/@ai-sdk/openai-compatible/dist/index.js:551), so the request
 * body these tests assert on is the real one, not a stand-in.
 */
function config(url: string, options: Record<string, unknown> = { reasoningEffort: "low" }) {
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
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options,
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

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
  return msg
})

const root = LayerNode.group([
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

/** One turn against the test endpoint. Returns the handle so the caller can read the message error. */
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
  return { result, handle, messageID: msg.id }
})

function apiError(input: { message: string; statusCode?: number; responseBody?: string }) {
  return Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
    new SessionV1.APIError({
      message: input.message,
      isRetryable: false,
      statusCode: input.statusCode,
      responseBody: input.responseBody,
    }).toObject(),
  )
}

// ---------------------------------------------------------------------------
// Classification — the rules, in isolation
// ---------------------------------------------------------------------------

describe("session.degrade.detect", () => {
  test("classifies the DS4 reasoning-effort rejection", () => {
    const knob = SessionDegrade.detect(apiError({ message: DS4_MESSAGE, statusCode: 500 }))
    expect(knob?.label).toBe("reasoning effort")
    expect(knob?.keys).toContain("reasoningEffort")
  })

  test("reads the knob out of the response body when the message is generic", () => {
    const knob = SessionDegrade.detect(
      apiError({
        message: "Internal Server Error",
        statusCode: 500,
        responseBody: JSON.stringify(ds4Body),
      }),
    )
    expect(knob?.label).toBe("reasoning effort")
  })

  test("classifies a 400 that rejects verbosity", () => {
    const knob = SessionDegrade.detect(
      apiError({ message: "Unsupported parameter: verbosity", statusCode: 400 }),
    )
    expect(knob?.label).toBe("text verbosity")
  })

  // The conservative half of the rule. Each of these WOULD be a knob rejection
  // under a looser reading, and each must fall through to the ordinary retry
  // path instead — an unparseable error must never gain a new failure mode.
  test("a knob name with no rejection wording is not a knob rejection", () => {
    expect(SessionDegrade.detect(apiError({ message: "reasoning effort budget exhausted", statusCode: 500 }))).toBeUndefined()
  })

  test("a rejection naming two knobs is not classified", () => {
    expect(
      SessionDegrade.detect(apiError({ message: "Invalid request: reasoning_effort and verbosity", statusCode: 400 })),
    ).toBeUndefined()
  })

  test("a rejection naming no knob is not classified", () => {
    expect(SessionDegrade.detect(apiError({ message: "Invalid request body", statusCode: 400 }))).toBeUndefined()
  })

  test("an error with no HTTP status is not classified", () => {
    expect(SessionDegrade.detect(apiError({ message: DS4_MESSAGE }))).toBeUndefined()
  })

  test("a non-API error is not classified", () => {
    expect(SessionDegrade.detect({ name: "", data: { message: DS4_MESSAGE } })).toBeUndefined()
  })

  test("401 and 403 are the auth class; 500 is not", () => {
    expect(SessionDegrade.isAuth(apiError({ message: "Unauthorized", statusCode: 401 }))).toBe(true)
    expect(SessionDegrade.isAuth(apiError({ message: "Forbidden", statusCode: 403 }))).toBe(true)
    expect(SessionDegrade.isAuth(apiError({ message: "boom", statusCode: 500 }))).toBe(false)
  })
})

describe("session.retry auth class", () => {
  /**
   * The discriminating case. A 401 that the SDK left `isRetryable: false` was
   * already dropped by the size checks below it, so it proves nothing about the
   * auth rule. A provider that MARKS its credential rejection retryable — and
   * `parseAPICallError` forces exactly that for openai 404s — used to buy the
   * full backoff ladder before the user was told their key was wrong.
   */
  const retryableAuth = (statusCode: number) =>
    Schema.decodeUnknownSync(SessionV1.APIError.Schema)(
      new SessionV1.APIError({ message: "Incorrect API key provided", isRetryable: true, statusCode }).toObject(),
    )

  test("a 401 marked retryable is still not retried", () => {
    expect(SessionRetry.retryable(retryableAuth(401), "test")).toBeUndefined()
  })

  test("a 403 marked retryable is still not retried", () => {
    expect(SessionRetry.retryable(retryableAuth(403), "test")).toBeUndefined()
  })

  test("a 500 marked retryable is unaffected", () => {
    expect(SessionRetry.retryable(retryableAuth(500), "test")).toEqual({ message: "Incorrect API key provided" })
  })
})

describe("session.degrade.strip", () => {
  test("removes both spellings of a recorded knob and nothing else", () => {
    SessionDegrade.reset()
    const sessionID = "strip-test"
    const options = { reasoningEffort: "low", reasoning_effort: "low", textVerbosity: "low", store: false }
    expect(SessionDegrade.strip(sessionID, options)).toBe(options)
    SessionDegrade.record(sessionID, SessionDegrade.KNOBS[0])
    expect(SessionDegrade.strip(sessionID, options)).toEqual({ textVerbosity: "low", store: false })
    SessionDegrade.reset()
  })
})

// ---------------------------------------------------------------------------
// End to end, against a real HTTP endpoint that answers the DS4 500
// ---------------------------------------------------------------------------

describe("session.degrade end to end", () => {
  it.live("drops the rejected knob, retries ONCE, and says so in the chat", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          // Six queued rejections: if the engine still retried blind, it would
          // eat five of them (RETRY_LIMIT_DEFAULT is 8) before giving up.
          for (let i = 0; i < 6; i++) yield* llm.error(500, ds4Body)

          const chat = yield* session.create({})
          const { handle, messageID } = yield* turn(chat.id, dir, "hi")

          const inputs = yield* llm.inputs
          expect(inputs.length).toBe(2)
          expect(inputs[0]!["reasoning_effort"]).toBe("low")
          expect(inputs[1]!).not.toHaveProperty("reasoning_effort")

          const parts = yield* MessageV2.parts(messageID)
          const notice = parts.find((part) => part.type === "text" && part.text.includes("reasoning effort"))
          expect(notice).toBeDefined()
          expect(notice?.type === "text" ? notice.text : "").toBe(
            "reasoning effort not supported by this endpoint — used the default.",
          )

          // The provider's own words reach the message the client renders.
          const error = handle.message.error
          expect(error).toBeDefined()
          expect(SessionV1.APIError.isInstance(error!) ? error.data.message : "").toInclude(DS4_MESSAGE)
        }),
      { config: (url) => config(url) },
    ),
    15_000,
  )

  it.live("the degraded retry completes the turn, and the next turn never re-sends the knob", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          // One rejection only; the server answers everything after it normally.
          yield* llm.error(500, ds4Body)

          const chat = yield* session.create({})
          const first = yield* turn(chat.id, dir, "hi")
          expect(first.result).toBe("continue")
          expect(first.handle.message.error).toBeUndefined()

          const second = yield* turn(chat.id, dir, "again")
          expect(second.result).toBe("continue")

          const inputs = yield* llm.inputs
          expect(inputs.length).toBe(3)
          expect(inputs[0]!["reasoning_effort"]).toBe("low")
          // Attempt 2 is the degraded retry; request 3 is a WHOLE NEW TURN that
          // never had to learn the lesson again.
          expect(inputs[1]!).not.toHaveProperty("reasoning_effort")
          expect(inputs[2]!).not.toHaveProperty("reasoning_effort")

          // ...and the second turn says nothing, because nothing degraded in it.
          const parts = yield* MessageV2.parts(second.messageID)
          expect(parts.some((part) => part.type === "text" && part.text.includes("not supported"))).toBe(false)
        }),
      { config: (url) => config(url) },
    ),
  )

  it.live("a 401 is reported at once, with no retry", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          for (let i = 0; i < 4; i++) {
            yield* llm.error(401, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } })
          }

          const chat = yield* session.create({})
          const { result, handle } = yield* turn(chat.id, dir, "hi")

          expect(result).toBe("stop")
          expect(yield* llm.calls).toBe(1)
          const error = handle.message.error
          expect(SessionV1.APIError.isInstance(error!) ? error.data.message : "").toInclude(
            "Incorrect API key provided",
          )
        }),
      { config: (url) => config(url) },
    ),
  )

  it.live("an unclassifiable 5xx still takes the ordinary retry path", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const previous = process.env["ORIGAMI_SESSION_RETRY_LIMIT"]
          process.env["ORIGAMI_SESSION_RETRY_LIMIT"] = "1"
          try {
            const session = yield* Session.Service
            for (let i = 0; i < 4; i++) {
              yield* llm.error(500, { error: { message: "Internal server error", type: "server_error" } })
            }

            const chat = yield* session.create({})
            const { result } = yield* turn(chat.id, dir, "hi")

            expect(result).toBe("stop")
            // Initial attempt plus the one retry the cap allows — unchanged by
            // the classifier, which is the point: it must not touch this class.
            expect(yield* llm.calls).toBe(2)
            const inputs = yield* llm.inputs
            expect(inputs[1]!["reasoning_effort"]).toBe("low")
          } finally {
            if (previous === undefined) delete process.env["ORIGAMI_SESSION_RETRY_LIMIT"]
            else process.env["ORIGAMI_SESSION_RETRY_LIMIT"] = previous
          }
        }),
      { config: (url) => config(url) },
    ),
  )
})
