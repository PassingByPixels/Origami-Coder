import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionEffortTier } from "@/session/effort-tier"
import { ProviderEffortDemotion } from "@/provider/effort-demotion"
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
// Self-healing reasoning effort (t-48ffvz).
//
// The counterpart to degrade.test.ts, and the difference between the two is
// the point. There the endpoint refuses the FIELD and the repair is to stop
// sending it; here the field is accepted and one VALUE is not, and dropping
// the field would throw away a control the user chose over a wrong entry in a
// ladder. So the repair is one tier down, and the tier is struck off that
// model for this user permanently.
//
// The 400 body is the shape OpenAI's Responses API actually answers with: the
// refused value quoted in `message`, the accepted ones listed after it, and the
// field named in `param` rather than in the prose - which is why the classifier
// reads the response body and not only the message.
// ---------------------------------------------------------------------------

const rejects = (tier: string, supported: string) => ({
  error: {
    message: "Invalid value: " + JSON.stringify(tier) + ". Supported values are: " + supported + ".",
    type: "invalid_request_error",
    param: "reasoning.effort",
    code: "invalid_value",
  },
})

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
 * A reasoning model on an OpenAI-compatible transport, so `ProviderTransform`
 * gives it the plain low / medium / high ladder and the wire field is the real
 * `reasoning_effort`. No variants are declared here on purpose: the ladder
 * under test has to be the one the engine builds, not one the test hands it.
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
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
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

/** One turn on a chosen effort tier. `variant` is what the picker would have
 *  written on the user's message. */
const turn = Effect.fn("TestSession.turn")(function* (
  chatID: SessionID,
  dir: string,
  text: string,
  variant: string,
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
      model: { providerID: ref.providerID, modelID: ref.modelID, variant },
    } satisfies SessionV1.User,
    sessionID: chatID,
    model: mdl,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: text }],
    tools: {},
  } satisfies LLM.StreamInput)
  return { result, handle, messageID: msg.id, variants: Object.keys(mdl.variants ?? {}) }
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

beforeEach(() => {
  SessionEffortTier.reset()
  ProviderEffortDemotion.reset()
})
afterEach(() => {
  SessionEffortTier.reset()
  ProviderEffortDemotion.reset()
})

// ---------------------------------------------------------------------------
// Classification - the rule, in isolation
// ---------------------------------------------------------------------------

const BODY = JSON.stringify(rejects("high", "'low' and 'medium'"))

describe("session.effort-tier.isRejected", () => {
  test("a 400 that refuses the tier the request carried is a tier rejection", () => {
    expect(
      SessionEffortTier.isRejected(
        apiError({
          message: rejects("high", "'low' and 'medium'").error.message,
          statusCode: 400,
          responseBody: BODY,
        }),
        "high",
      ),
    ).toBe(true)
  })

  test("422 counts too", () => {
    expect(
      SessionEffortTier.isRejected(apiError({ message: "Invalid value", statusCode: 422, responseBody: BODY }), "high"),
    ).toBe(true)
  })

  // The conservative half. Each of these WOULD be a tier rejection under a
  // looser reading, and each has to fall through to a path that already works.
  test("a rejection that names the field but NOT the sent tier is left to the knob path", () => {
    // degrade.ts's case verbatim: the endpoint refuses `reasoning_effort`
    // itself. Demoting a tier here would retry a request the endpoint can never
    // accept, and would eventually strike every tier off a working model.
    expect(
      SessionEffortTier.isRejected(
        apiError({ message: "Unsupported parameter: reasoning_effort", statusCode: 400 }),
        "high",
      ),
    ).toBe(false)
  })

  test("a rejection that names a tier but not the field is not acted on", () => {
    expect(
      SessionEffortTier.isRejected(
        apiError({ message: "Invalid value: high for verbosity", statusCode: 400 }),
        "high",
      ),
    ).toBe(false)
  })

  test("the field named without rejection wording is not a refusal", () => {
    expect(
      SessionEffortTier.isRejected(apiError({ message: "reasoning.effort high accepted", statusCode: 400 }), "high"),
    ).toBe(false)
  })

  test("a 500 and a 429 are not tier rejections", () => {
    expect(
      SessionEffortTier.isRejected(apiError({ message: "x", statusCode: 500, responseBody: BODY }), "high"),
    ).toBe(false)
    expect(
      SessionEffortTier.isRejected(apiError({ message: "x", statusCode: 429, responseBody: BODY }), "high"),
    ).toBe(false)
  })

  test("no tier was sent, so nothing can be refused", () => {
    expect(
      SessionEffortTier.isRejected(apiError({ message: "x", statusCode: 400, responseBody: BODY }), undefined),
    ).toBe(false)
  })

  test("high inside xhigh is not a match for high", () => {
    const body = JSON.stringify(rejects("xhigh", "'low' and 'medium'"))
    const error = apiError({ message: "Invalid value", statusCode: 400, responseBody: body })
    expect(SessionEffortTier.isRejected(error, "high")).toBe(false)
    expect(SessionEffortTier.isRejected(error, "xhigh")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// End to end, against a real HTTP endpoint that answers the 400
// ---------------------------------------------------------------------------

describe("session effort demotion end to end", () => {
  it.live(
    "demotes the refused tier, retries ONCE one tier down, and says so in the chat",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            const session = yield* Session.Service
            // ONE rejection. Everything after it is answered normally, so the
            // turn can only complete if the second request carried a tier the
            // endpoint accepts.
            yield* llm.error(400, rejects("high", "'low' and 'medium'"))

            const chat = yield* session.create({})
            const { result, handle, messageID } = yield* turn(chat.id, dir, "hi", "high")
            expect(result).toBe("continue")
            expect(handle.message.error).toBeUndefined()

            const inputs = yield* llm.inputs
            expect(inputs.length).toBe(2)
            expect(inputs[0]!["reasoning_effort"]).toBe("high")
            // ONE tier down - not dropped, and not back to the bottom.
            expect(inputs[1]!["reasoning_effort"]).toBe("medium")

            // The user is told, in the chat, what was refused and what ran.
            const parts = yield* MessageV2.parts(messageID)
            const notice = parts.find((part) => part.type === "text" && part.text.includes("reasoning effort"))
            expect(notice?.type === "text" ? notice.text : "").toBe(
              "high reasoning effort is not supported by this model - retried at medium.",
            )

            // And it is remembered for the MODEL, not just for the turn.
            expect(ProviderEffortDemotion.demoted("test", "test-model")).toEqual(["high"])

            // The effort menu loses it NOW, not at the next launch. The provider
            // list is built once per directory and cached, so without the
            // invalidation the struck-off tier would stay selectable - and every
            // selection of it would fail.
            const provider = yield* Provider.Service
            const after = yield* provider.getModel(ref.providerID, ref.modelID)
            expect(Object.keys(after.variants ?? {})).toEqual(["low", "medium"])
          }),
        { config: (url) => config(url) },
      ),
    15_000,
  )

  it.live(
    "a SECOND refusal surfaces the provider's own error instead of walking the ladder down",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            const session = yield* Session.Service
            // The endpoint refuses `high`, then refuses `medium` as well. Five
            // more are queued: if the engine kept demoting it would eat them.
            yield* llm.error(400, rejects("high", "'low' and 'medium'"))
            for (let i = 0; i < 5; i++) yield* llm.error(400, rejects("medium", "'low'"))

            const chat = yield* session.create({})
            const { result, handle } = yield* turn(chat.id, dir, "hi", "high")

            expect(result).toBe("stop")
            expect(yield* llm.calls).toBe(2)
            const error = handle.message.error
            expect(SessionV1.APIError.isInstance(error!) ? error.data.message : "").toInclude("Invalid value")
            expect(SessionV1.APIError.isInstance(error!) ? error.data.message : "").toInclude("medium")
          }),
        { config: (url) => config(url) },
      ),
    15_000,
  )

  it.live(
    "a tier demoted before the engine started is never offered and never sent",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            // Written by an EARLIER run, before this provider list was built.
            // The store is the only thing carried over, exactly as it would be
            // across a restart.
            ProviderEffortDemotion.record("test", "test-model", "high")

            const session = yield* Session.Service
            const chat = yield* session.create({})
            const { result, variants } = yield* turn(chat.id, dir, "hi", "high")

            expect(result).toBe("continue")
            // The picker reads this list, so the tier is gone from the UI too.
            expect(variants).toEqual(["low", "medium"])
            // And a session still holding the withdrawn choice is carried down
            // rather than sent with no effort at all.
            const inputs = yield* llm.inputs
            expect(inputs.length).toBe(1)
            expect(inputs[0]!["reasoning_effort"]).toBe("medium")
          }),
        { config: (url) => config(url) },
      ),
    15_000,
  )
})
