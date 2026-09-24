import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import type { ModelMessage } from "ai"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionImageCap } from "../../src/session/image-cap"
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
// The message is copied VERBATIM from the owner's failing session
// (`origami-session-Tsuru-2026-08-31-16-39-10.md`): GLM-5.3-Flash served by
// vLLM on the two DGX Sparks, started with
// `--limit-mm-per-prompt {image:4,video:1}`. Six PNG frames went into one turn,
// the endpoint refused, and the "continue" that followed carried the SAME six
// and was refused identically. That is the whole bug: nothing dropped, so no
// later turn could ever succeed.
//
// The `(parameter=image)` suffix is the server's, not ours and not the AI
// SDK's — grepping both for `parameter=` finds nothing — so it is reproduced
// rather than invented.
// ---------------------------------------------------------------------------

const CAP_MESSAGE = "At most 4 image(s) may be provided in one prompt. (parameter=image)"
const capBody = { error: { message: CAP_MESSAGE, type: "BadRequestError", param: "image", code: 400 } }

/** A 1x1 PNG. Small on purpose: these tests count pictures, they do not read them. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

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
 * A model that DECLARES image input, so the capability gate
 * (`ProviderTransform` -> `unsupportedParts`) keeps the pictures and the count
 * window is the only thing standing between the history and the wire.
 */
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
            attachment: true,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            modalities: {
              input: ["text", "image"] as ("text" | "image")[],
              output: ["text"] as "text"[],
            },
            cost: { input: 0, output: 0 },
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

/** `count` pictures, laid out the way `message-v2` hands them to an
 *  openai-compatible endpoint: one synthetic user message per attachment. */
function withImages(text: string, count: number): ModelMessage[] {
  return [
    { role: "user", content: [{ type: "text", text }] },
    ...Array.from({ length: count }, (_, i) => ({
      role: "user" as const,
      content: [
        { type: "text" as const, text: `Called the read tool with the following input: frame_${i}.png` },
        { type: "file" as const, data: PNG, mediaType: "image/png", filename: `frame_${i}.png` },
      ],
    })),
  ]
}

/** How many pictures a recorded request body actually carried. */
function imagesIn(body: Record<string, unknown>): number {
  const messages = body["messages"]
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if ((part as { type?: unknown }).type === "image_url") total++
    }
  }
  return total
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

/** One turn carrying `images` pictures. */
const turn = Effect.fn("TestSession.turn")(function* (
  chatID: SessionID,
  dir: string,
  text: string,
  images: number,
) {
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
    messages: withImages(text, images),
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
// Classification — the rule, in isolation
// ---------------------------------------------------------------------------

describe("session.imageCap.detect", () => {
  test("reads the number out of the real vLLM refusal", () => {
    expect(SessionImageCap.detect(apiError({ message: CAP_MESSAGE, statusCode: 400 }))).toBe(4)
  })

  test("the status code is not part of the rule — the same sentence at 500, and with none", () => {
    expect(SessionImageCap.detect(apiError({ message: CAP_MESSAGE, statusCode: 500 }))).toBe(4)
    expect(SessionImageCap.detect(apiError({ message: CAP_MESSAGE }))).toBe(4)
  })

  test("reads it out of the response body when the message is generic", () => {
    expect(
      SessionImageCap.detect(
        apiError({ message: "Internal Server Error", statusCode: 500, responseBody: JSON.stringify(capBody) }),
      ),
    ).toBe(4)
  })

  test("accepts the plural spelling a different server might use", () => {
    expect(SessionImageCap.detect(apiError({ message: "At most 16 images may be provided in one prompt." }))).toBe(16)
  })

  // The conservative half. Each of these WOULD be a cap under a looser reading,
  // and each must fall through to the ordinary retry path instead.
  test("prose that merely mentions images is not a cap", () => {
    expect(SessionImageCap.detect(apiError({ message: "You may provide at most 4 images per day", statusCode: 429 }))).toBeUndefined()
  })

  test("a refusal with no number is not a cap", () => {
    expect(SessionImageCap.detect(apiError({ message: "Too many images in one prompt.", statusCode: 400 }))).toBeUndefined()
  })

  test("a non-API error is not a cap", () => {
    expect(SessionImageCap.detect({ name: "", data: { message: CAP_MESSAGE } })).toBeUndefined()
  })
})

describe("session.imageCap.clamp", () => {
  test("identity until something was learned, then the smaller number wins", () => {
    SessionImageCap.reset()
    const model = { limit: { context: 1, output: 1 } } as any
    expect(SessionImageCap.clamp("clamp-test", model)).toBe(model)

    SessionImageCap.record("clamp-test", 4)
    expect(SessionImageCap.clamp("clamp-test", model).limit.images).toBe(4)

    // A model that already declares a TIGHTER cap is left alone.
    const tighter = { limit: { context: 1, output: 1, images: 2 } } as any
    expect(SessionImageCap.clamp("clamp-test", tighter)).toBe(tighter)
    SessionImageCap.reset()
  })

  test("the tightest cap seen wins, and the default is what it is measured against", () => {
    SessionImageCap.reset()
    const model = { limit: { context: 1, output: 1 } } as any
    SessionImageCap.record("tight", 4)
    SessionImageCap.record("tight", 16)
    expect(SessionImageCap.limit("tight")).toBe(4)
    expect(SessionImageCap.clamp("tight", model).limit.images).toBe(4)
    // A cap ABOVE the engine's own window changes nothing on the wire.
    SessionImageCap.record("loose", ProviderTransform.IMAGE_WINDOW_DEFAULT + 8)
    expect(SessionImageCap.clamp("loose", model)).toBe(model)
    SessionImageCap.reset()
  })
})

// ---------------------------------------------------------------------------
// End to end, against an HTTP endpoint that answers the real refusal
// ---------------------------------------------------------------------------

describe("session.imageCap end to end", () => {
  it.live("clamps the window to the server's number, retries ONCE with FEWER images, and says so", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          SessionImageCap.reset()
          const session = yield* Session.Service
          yield* llm.error(400, capBody)

          const chat = yield* session.create({})
          const { result, messageID } = yield* turn(chat.id, dir, "what is on these frames?", 6)
          expect(result).toBe("continue")

          const inputs = yield* llm.inputs
          expect(inputs.length).toBe(2)
          // The first attempt sent everything the history held...
          expect(imagesIn(inputs[0]!)).toBe(6)
          // ...the retry sends exactly what the endpoint said it takes.
          expect(imagesIn(inputs[1]!)).toBe(4)

          const parts = yield* MessageV2.parts(messageID)
          const notice = parts.find((part) => part.type === "text" && part.text.includes("at most 4 image"))
          expect(notice?.type === "text" ? notice.text : "").toBe(SessionImageCap.notice(4))
          SessionImageCap.reset()
        }),
      { config: (url) => config(url) },
    ),
    15_000,
  )

  it.live("never spends the retry ladder re-sending the same pictures", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          SessionImageCap.reset()
          const session = yield* Session.Service
          // A 5xx is the dangerous shape: `SessionRetry.retryable` retries every
          // 5xx, so before this work six queued refusals would have been eaten
          // one after another (RETRY_LIMIT_DEFAULT is 8) with an identical body
          // each time. Exactly two requests must leave: the original and the one
          // clamped retry.
          for (let i = 0; i < 6; i++) yield* llm.error(500, capBody)

          const chat = yield* session.create({})
          const { result, handle } = yield* turn(chat.id, dir, "still failing?", 6)

          expect(result).toBe("stop")
          expect(yield* llm.calls).toBe(2)
          const inputs = yield* llm.inputs
          expect(imagesIn(inputs[0]!)).toBe(6)
          expect(imagesIn(inputs[1]!)).toBe(4)

          // The endpoint's own words are what the user is left with.
          const error = handle.message.error
          expect(SessionV1.APIError.isInstance(error!) ? error.data.message : "").toInclude(
            "At most 4 image(s) may be provided in one prompt.",
          )
          SessionImageCap.reset()
        }),
      { config: (url) => config(url) },
    ),
    15_000,
  )

  it.live("the LATER turn is already clamped — the softlock cannot come back", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          SessionImageCap.reset()
          const session = yield* Session.Service
          yield* llm.error(400, capBody)

          const chat = yield* session.create({})
          const first = yield* turn(chat.id, dir, "look at these", 6)
          expect(first.result).toBe("continue")

          // The "continue" that used to fail forever, because it carried the
          // same six pictures.
          const second = yield* turn(chat.id, dir, "continue", 6)
          expect(second.result).toBe("continue")

          const inputs = yield* llm.inputs
          expect(inputs.length).toBe(3)
          expect(imagesIn(inputs[2]!)).toBe(4)

          // ...and the second turn says nothing, because nothing was learned in it.
          const parts = yield* MessageV2.parts(second.messageID)
          expect(parts.some((part) => part.type === "text" && part.text.includes("at most 4 image"))).toBe(false)
          SessionImageCap.reset()
        }),
      { config: (url) => config(url) },
    ),
    15_000,
  )
})
