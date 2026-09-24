// Prefix stability — the end-to-end half of "make the cached prefix provably
// stable, and make cache visible".
//
// The fact that motivated it: over 60 days, 69.6% of measured cache drops
// happened WITHIN 300 SECONDS on the SAME model. That is not a TTL expiry and
// not a model change; the prefix moved. Nobody could say why, because the
// per-call system bytes lived only in `SessionPromptCapture`'s in-memory map
// and were never written down.
//
// So `step-finish` now persists two 16-hex digests — one for the joined system
// text, one for the offered tool block — plus the step's time to first token,
// which is the ONLY cache signal available from the 27% of turns that run on
// providers reporting no cache tokens at all.
//
// What these tests are for: proving the digest is a pure function of the bytes
// sent. Two turns that send the same prefix must persist the SAME pair, or the
// instrument would manufacture drops; a turn that really changes the tool block
// must persist a DIFFERENT tool hash with the system hash unmoved, or the
// instrument would hide them. Both halves run through the real prompt loop,
// the real request layer and the real database, because a digest computed
// correctly and then dropped on the way to SQLite would pass a unit test.

import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { jsonSchema } from "ai"
import path from "path"
import type { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { SessionProjector } from "@origami/core/session/projector"

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

/** The system blocks a turn sends. Held constant so a moving hash is a defect. */
const SYSTEM = ["You are Origami.", "<env>\n  Working directory: /w\n</env>"]

const SEARCH_SCHEMA = { type: "object" as const, properties: { q: { type: "string" as const } } }

const searchTool = (description: string) => ({
  description,
  inputSchema: jsonSchema(SEARCH_SCHEMA),
})

const user = Effect.fn("PrefixTest.user")(function* (sessionID: SessionID, text: string) {
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

const assistant = Effect.fn("PrefixTest.assistant")(function* (
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

/**
 * One turn, staging the prompt draft the way `session/prompt.ts` does.
 *
 * The draft matters: `SessionPromptCapture.record` is a deliberate no-op for a
 * request that staged none (compaction, title generation), so a turn that skips
 * it would record no digest and the assertions below would pass vacuously on
 * two absent fields. Staging it here is what makes this a test of the real
 * request path rather than of `undefined === undefined`.
 */
const turn = Effect.fn("PrefixTest.turn")(function* (input: {
  readonly chatID: SessionID
  readonly dir: string
  readonly text: string
  readonly tools: Record<string, unknown>
}) {
  const processors = yield* SessionProcessor.Service
  const provider = yield* Provider.Service
  const parent = yield* user(input.chatID, input.text)
  const msg = yield* assistant(input.chatID, parent.id, path.resolve(input.dir))
  const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
  const handle = yield* processors.create({ assistantMessage: msg, sessionID: input.chatID, model: mdl })
  SessionPromptCapture.draft(input.chatID, SessionPromptCapture.parts({ env: SYSTEM, instructions: [] }))
  const result = yield* handle.process({
    user: {
      id: parent.id,
      sessionID: input.chatID,
      role: "user",
      time: parent.time,
      agent: parent.agent,
      model: { providerID: ref.providerID, modelID: ref.modelID },
    } satisfies SessionV1.User,
    sessionID: input.chatID,
    model: mdl,
    agent: agent(),
    system: SYSTEM,
    messages: [{ role: "user", content: input.text }],
    tools: input.tools as never,
  } satisfies LLM.StreamInput)
  return { result, messageID: msg.id }
})

/** The persisted `step-finish` parts of one message, in order. */
const stepFinishes = Effect.fn("PrefixTest.stepFinishes")(function* (messageID: MessageID) {
  const parts = yield* MessageV2.parts(messageID)
  return parts.filter((part): part is SessionV1.StepFinishPart => part.type === "step-finish")
})

beforeEach(() => SessionPromptCapture.reset())

describe("the cache verdict survives to the database", () => {
  it.live(
    "a reporting provider gets a cause on a miss and facts alone on a hit",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            const session = yield* Session.Service
            // `cached: 0` is a MEASURED miss - the provider reported the field
            // and it was zero. `cached: 1200` on the second turn is a hit.
            yield* llm.text("first", { usage: { input: 1200, output: 8, cached: 0 } })
            yield* llm.text("second", { usage: { input: 1400, output: 9, cached: 1200 } })

            const chat = yield* session.create({})
            const tools = { grep: searchTool("Search files") }
            const first = yield* turn({ chatID: chat.id, dir, text: "hi", tools })
            const second = yield* turn({ chatID: chat.id, dir, text: "again", tools })

            const one = (yield* stepFinishes(first.messageID))[0]!
            const two = (yield* stepFinishes(second.messageID))[0]!

            // The session's first request: nothing to have been cached yet.
            expect(one.cache?.cause).toBe("cold")
            // A HIT carries the facts and NO cause - there is no question to
            // answer. The array was replaced, so the prefix did not survive,
            // and that fact is still recorded beside the hit.
            expect(two.cache).toBeDefined()
            expect(two.cache?.cause).toBeUndefined()
            expect(two.cache?.preserved).toBe(false)
            expect(two.cache?.idleMs).toBeGreaterThanOrEqual(0)
            // The test provider publishes no window, so none is claimed.
            expect(two.cache?.ttlSeconds).toBeUndefined()
          }),
        { config: (url) => config(url) },
      ),
    20_000,
  )
})

describe("the prefix digest survives to the database", () => {
  it.live(
    "two consecutive turns on one session persist the SAME system and tool hashes",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            const session = yield* Session.Service
            yield* llm.text("first", { usage: { input: 1200, output: 8 } })
            yield* llm.text("second", { usage: { input: 1400, output: 9 } })

            const chat = yield* session.create({})
            const tools = { grep: searchTool("Search files") }
            const first = yield* turn({ chatID: chat.id, dir, text: "hi", tools })
            const second = yield* turn({ chatID: chat.id, dir, text: "again", tools })

            const a = yield* stepFinishes(first.messageID)
            const b = yield* stepFinishes(second.messageID)
            expect(a).toHaveLength(1)
            expect(b).toHaveLength(1)
            const one = a[0]
            const two = b[0]

            // The claim: nothing in the digest is derived from the clock, the
            // call count or the message. Same prefix in, same pair out.
            expect(one.prefix).toBeDefined()
            expect(one.prefix?.system).toMatch(/^[0-9a-f]{16}$/)
            expect(one.prefix?.tools).toMatch(/^[0-9a-f]{16}$/)
            expect(two.prefix?.system).toBe(one.prefix!.system)
            expect(two.prefix?.tools).toBe(one.prefix!.tools)
            // The third half of the prefix (t-rylleg) is the ARRAY, and the
            // second turn sends a different one - so this digest SHOULD move.
            // It is what names a miss the other two digests cannot explain.
            expect(one.prefix?.history).toMatch(/^[0-9a-f]{16}$/)
            expect(two.prefix?.history).not.toBe(one.prefix?.history)

            // This provider reports no cache tokens at all, so both steps are
            // UNMEASURED and carry no verdict. A fabricated "the provider
            // missed" here is the exact dishonesty the block exists to avoid.
            expect(one.cache).toBeUndefined()
            expect(two.cache).toBeUndefined()

            // TTFT: a real reading, taken from the wall clock, on both steps.
            for (const part of [one, two]) {
              expect(typeof part.ttftMs).toBe("number")
              expect(Number.isFinite(part.ttftMs)).toBe(true)
              expect(part.ttftMs).toBeGreaterThanOrEqual(0)
            }
          }),
        { config: (url) => config(url) },
      ),
    20_000,
  )

  it.live(
    "a changed tool description moves the TOOL hash alone — the drop is named, not just seen",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            const session = yield* Session.Service
            yield* llm.text("first", { usage: { input: 1200, output: 8 } })
            yield* llm.text("second", { usage: { input: 1400, output: 9 } })

            const chat = yield* session.create({})
            const first = yield* turn({
              chatID: chat.id,
              dir,
              text: "hi",
              tools: { grep: searchTool("Search files") },
            })
            const second = yield* turn({
              chatID: chat.id,
              dir,
              text: "again",
              tools: { grep: searchTool("Search files, but faster") },
            })

            const a = (yield* stepFinishes(first.messageID))[0]
            const b = (yield* stepFinishes(second.messageID))[0]

            // This is the reading the cache panel needs: the prefix changed,
            // and the tool block is what changed it.
            expect(a.prefix).toBeDefined()
            expect(b.prefix?.tools).not.toBe(a.prefix?.tools)
            expect(b.prefix?.system).toBe(a.prefix?.system)
          }),
        { config: (url) => config(url) },
      ),
    20_000,
  )
})
