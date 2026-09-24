import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionStreamDrop } from "../../src/session/stream-drop"
import { SessionRetry } from "../../src/session/retry"
import { isRecord } from "@/util/record"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { SessionProjector } from "@origami/core/session/projector"
import { LLMEvent } from "@origami/llm"
import { sql } from "drizzle-orm"

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

const cfg = {
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
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
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

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

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
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
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
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
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
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, providerErrorLLM]])
const itProviderError = testEffect(providerErrorEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        LLMEvent.providerError({ message: "provider boom" }),
      ),
  }),
)
const fragmentFailureEnv = LayerNode.compile(root, [...replacements, [LLM.node, fragmentFailureLLM]])
const itFragmentFailure = testEffect(fragmentFailureEnv)

// origami_change-start (t-3kr4o4: empty terminal reply)
/**
 * A scripted OpenAI stream, one entry per request the step makes. The engine
 * re-sends the IDENTICAL request on a redo, so the fixture - not the request -
 * is what differs between attempts; entry 0 is the first attempt, entry 1 the
 * redo. Reset by each test that uses it.
 */
const emptyReplyStreams: LLMEvent[][] = []
let emptyReplyCalls = 0
const emptyReplyLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () => {
      const events = emptyReplyStreams[emptyReplyCalls] ?? []
      emptyReplyCalls++
      return Stream.fromIterable(events)
    },
  }),
)
const emptyReplyEnv = LayerNode.compile(root, [...replacements, [LLM.node, emptyReplyLLM]])
const itEmptyReply = testEffect(emptyReplyEnv)

/** What OpenAI's Responses API sends when a response ends `completed` carrying
 *  only a reasoning item: no message, no function call, finish reason "stop". */
const reasoningOnlyStop = (): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.reasoningStart({ id: "reasoning-1" }),
  LLMEvent.reasoningDelta({ id: "reasoning-1", text: "planning the next tool call" }),
  LLMEvent.reasoningEnd({ id: "reasoning-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const textStop = (text: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-1" }),
  LLMEvent.textDelta({ id: "text-1", text }),
  LLMEvent.textEnd({ id: "text-1" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]
// origami_change-end

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        // 20k, not 100: auto-compaction now also requires enough REMOVABLE
        // history to be worth a generation (overflow.ts MIN_COMPACTABLE_HISTORY).
        // A 100-token session over a 20-token window overflows but has nothing
        // to compact, so it is no longer a compaction request.
        yield* llm.text("after", { usage: { input: 20_000, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        // A window the prompt fits (the request layer no longer sends a request
        // that cannot fit, t-tc20mj) and the reported 20k usage overflows.
        const mdl = { ...base, limit: { context: 16_000, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // t-3kr4o4: the second reply carries text as well as reasoning. A
        // terminal "stop" with NOTHING on it is now a defect the processor
        // redoes, so a content-free reply can no longer stand in for a good one.
        yield* llm.push(reply().reason("one").reset(), reply().reason("two").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("ok") // t-3kr4o4: see above - an empty reply is now redone, not accepted

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(MessageV2.Event.Updated.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

itFragmentFailure.live("session.processor effect tests retain partial legacy parts without v2 events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partial" }),
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
          ]),
        )
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

// ---------------------------------------------------------------------------
// Mid-stream provider drop (t-streamdrop)
//
// The frame below is what OpenRouter's gateway writes into a live SSE stream
// when the upstream provider goes quiet for too long — a long reasoning pause
// is the usual cause. `@ai-sdk/openai-compatible` parses it with its error
// schema and enqueues `{ type: "error", error: chunk.value.error.message }`,
// i.e. a BARE STRING, which is why the owner read the failure as
// `Internal error: "Upstream idle timeout exceeded"` — quotes and all, from
// `JSON.stringify` in `MessageV2.fromError`'s unknown fallthrough.
// ---------------------------------------------------------------------------
const IDLE_TIMEOUT_FRAME = { error: { message: "Upstream idle timeout exceeded", code: 524 } }

function chunkLine(delta: Record<string, unknown>) {
  return { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta }] }
}

/** Head that streams a little prose, then a tail that drops the stream. */
function droppedStream(text: string) {
  return raw({
    head: [chunkLine({ role: "assistant" }), chunkLine({ content: text })],
    tail: [IDLE_TIMEOUT_FRAME],
  })
}

const streamInput = (input: {
  chat: SessionID
  parent: { id: MessageID; time: { created: number }; agent: string }
  mdl: Provider.Model
  text: string
  tools?: Record<string, any>
}) =>
  ({
    user: {
      id: input.parent.id,
      sessionID: input.chat,
      role: "user",
      time: input.parent.time,
      agent: input.parent.agent,
      model: { providerID: ref.providerID, modelID: ref.modelID },
    } satisfies SessionV1.User,
    sessionID: input.chat,
    model: input.mdl,
    agent: agent(),
    system: [],
    messages: [{ role: "user", content: input.text }],
    tools: input.tools ?? {},
  }) satisfies LLM.StreamInput

it.live("session.processor retries a mid-stream gateway drop and re-sends the SAME context", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(droppedStream("half a th"))
        yield* llm.text("recovered")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "drop")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process(streamInput({ chat: chat.id, parent, mdl, text: "drop" }))
        const parts = yield* MessageV2.parts(msg.id)
        const inputs = yield* llm.inputs

        // The turn survived instead of dying at the drop.
        expect(value).toBe("continue")
        expect(handle.message.error).toBeUndefined()
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)

        // NO synthetic continuation. The retried request must carry byte-for-byte
        // the same messages as the first — not a "continue" turn, not the partial
        // assistant text fed back as context.
        expect(JSON.stringify(inputs[1]?.["messages"])).toBe(JSON.stringify(inputs[0]?.["messages"]))

        // The user is told, in the transcript, that a retry happened - as DATA.
        // t-q90gj9: never again as prose, which landed under the agent's name.
        const notices = parts.filter(
          (part): part is SessionV1.TextPart =>
            part.type === "text" && SessionStreamDrop.readNotice(part.metadata) !== undefined,
        )
        expect(notices.length).toBe(1)
        expect(notices[0]?.text).toBe("")
        expect(SessionStreamDrop.readNotice(notices[0]?.metadata)).toMatchObject({
          kind: "retrying",
          attempt: 1,
          max: SessionStreamDrop.LIMIT_DEFAULT,
          terminal: false,
        })
        expect(parts.some((part) => part.type === "text" && part.text.includes("Stream dropped"))).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor stops with a NAMED error once mid-stream drop retries are exhausted", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // One more failure than the family's attempt budget allows.
        for (let i = 0; i < SessionStreamDrop.LIMIT_DEFAULT + 1; i++) yield* llm.push(droppedStream("nope"))

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "drop")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process(streamInput({ chat: chat.id, parent, mdl, text: "drop" }))

        expect(value).toBe("stop")
        // Bounded: initial attempt plus exactly LIMIT_DEFAULT retries.
        expect(yield* llm.calls).toBe(SessionStreamDrop.LIMIT_DEFAULT + 1)
        // Honest: the failure is named, and it is no longer a JSON-quoted blob.
        const failure = handle.message.error
        expect(failure?.name).toBe("APIError")
        expect(SessionV1.APIError.isInstance(failure)).toBe(true)
        if (!SessionV1.APIError.isInstance(failure)) return
        expect(failure.data.message).toContain("Upstream idle timeout exceeded")
        expect(failure.data.message).not.toContain('"Upstream')
        expect(failure.data.metadata?.["code"]).toBe(SessionStreamDrop.CODE)
        // t-q90gj9: the ladder ENDING is said out loud. Without it the last card
        // the chat drew says "retrying" and never stops saying it.
        const stopped = (yield* MessageV2.parts(msg.id))
          .map((part) => SessionStreamDrop.readNotice(part.type === "text" ? part.metadata : undefined))
          .filter((n) => n?.kind === "stopped")
        expect(stopped.length).toBe(1)
        expect(stopped[0]).toMatchObject({ attempt: SessionStreamDrop.LIMIT_DEFAULT + 1, terminal: true })
        expect(stopped[0]?.detail).toContain("Upstream idle timeout exceeded")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor does NOT retry a drop once a tool call has run in the step", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // A tool call, executed, and THEN the gateway drops the stream. Re-sending
        // the identical request would let the model call the tool a second time —
        // harmless for a read, not harmless for a write.
        yield* llm.push(
          raw({
            head: [
              chunkLine({ role: "assistant" }),
              chunkLine({
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } },
                ],
              }),
              chunkLine({ tool_calls: [{ index: 0, function: { arguments: '{"query":"weather"}' } }] }),
            ],
            tail: [IDLE_TIMEOUT_FRAME],
          }),
        )
        yield* llm.text("must not be reached")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool drop")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process(
          streamInput({
            chat: chat.id,
            parent,
            mdl,
            text: "tool drop",
            tools: {
              lookup: tool({
                description: "Look up information",
                inputSchema: z.object({ query: z.string() }),
                execute: async (input: { query: string }) => ({
                  title: "Weather lookup",
                  output: `result:${input.query}`,
                  metadata: {},
                }),
              }),
            },
          }),
        )

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        const failure = handle.message.error
        expect(SessionV1.APIError.isInstance(failure)).toBe(true)
        if (!SessionV1.APIError.isInstance(failure)) return
        expect(failure.data.message).toContain("Upstream idle timeout exceeded")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

// ---------------------------------------------------------------------------
// In-band provider errors the drop family does NOT recognise
//
// The frame above is a stream drop because its words say so. Most in-band
// errors are not: a rate limit, exhausted credits, a moderation block. Those
// must still reach the user as an error card carrying the PROVIDER'S sentence.
// On the AI SDK path they do (`ai-sdk.ts` -> `Effect.fail(event.error)`, the
// bare message). Native used to fail the chunk schema instead and the card read
// "ProviderShared.stream: Invalid openai/openai-chat stream event", which named
// the decoder rather than the fault; `openai-chat.ts` now decodes the frame and
// emits `provider-error`, which `processor.ts` throws on into the same halt.
// ---------------------------------------------------------------------------

/** OpenRouter's documented mid-stream shape: the error beside the chunk fields. */
const CREDITS_FRAME = {
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  error: { code: 402, message: "Insufficient credits for this request", metadata: { error_type: "payment" } },
  choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
}

it.live("session.processor shows the provider's own sentence for an in-band error", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(raw({ head: [chunkLine({ role: "assistant" }), chunkLine({ content: "sure" })], tail: [CREDITS_FRAME] }))

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "spend")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process(streamInput({ chat: chat.id, parent, mdl, text: "spend" }))

        // Not a drop, so it is not retried: one call, one error card.
        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        const failure = handle.message.error
        expect(failure).toBeDefined()
        const rendered = JSON.stringify(failure)
        expect(rendered).toContain("Insufficient credits for this request")
        expect(rendered).not.toContain("Invalid openai/openai-chat stream event")

        // The prose that arrived before the failure is still in the transcript.
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "text" && part.text === "sure")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

// ---------------------------------------------------------------------------
// t-h8s3xg. The frame that said NOTHING, and the one that said "rate limit".
//
// Three sessions on `openrouter / stealth/union-alpha` recorded
// `error: { name: "UnknownError", data: { message: "ERROR" } }` about 45 s into
// a stream. The provider's whole report was the word ERROR, and the transcript
// then named neither the provider, the model, the code nor how far in it died,
// while a SIBLING step in the same minutes got an honest HTTP 429.
//
// No cassette under test/fixtures/recordings carries a union-alpha mid-stream
// failure, and union-alpha is a paid lane, so the frames below are synthetic -
// in the documented OpenRouter shape, through the real `openai-chat` protocol,
// into the real `Session` message error.
// ---------------------------------------------------------------------------

/** The union-alpha shape: a whole report that is one machine word. */
const EMPTY_WORD_FRAME = {
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  error: { message: "ERROR", type: "ERROR", code: 500 },
  choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
}

/** The same word with a 4xx code. t-tc2itu made a 5xx uninformative frame
 *  retryable (it now continues), so the naming contract below is pinned on a
 *  code that still ends the step. */
const EMPTY_WORD_FRAME_4XX = { ...EMPTY_WORD_FRAME, error: { ...EMPTY_WORD_FRAME.error, code: 400 } }

/** The sibling fault, as it arrives mid-stream rather than in the headers. */
const RATE_LIMIT_FRAME = {
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  error: {
    code: 429,
    message: "stealth/union-alpha is temporarily rate-limited upstream",
    metadata: { error_type: "rate_limit" },
  },
  choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
}

it.live("session.processor names provider, model, code and elapsed time for an uninformative frame", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({ head: [chunkLine({ role: "assistant" }), chunkLine({ content: "working" })], tail: [EMPTY_WORD_FRAME_4XX] }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "go")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(yield* handle.process(streamInput({ chat: chat.id, parent, mdl, text: "go" }))).toBe("stop")

        const failure = handle.message.error
        expect(failure?.name).not.toBe("UnknownError")
        expect(SessionV1.APIError.isInstance(failure)).toBe(true)
        if (!SessionV1.APIError.isInstance(failure)) return
        // Provider, model, the provider's own word, its code, and the reading
        // that says this was not a request that never started.
        expect(failure.data.message).toContain("test · test-model: ERROR")
        expect(failure.data.message).toMatch(/\(code 400, \d+ s into the stream\)$/)
        // The raw payload, so the transcript's error row has it to show.
        expect(failure.data.responseBody).toContain('"type":"ERROR"')
        expect(failure.data.isRetryable).toBe(false)
        // The prose that arrived before the failure is still in the transcript.
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "text" && part.text === "working")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor retries a 5xx uninformative frame instead of ending the step (t-tc2itu)", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({ head: [chunkLine({ role: "assistant" }), chunkLine({ content: "working" })], tail: [EMPTY_WORD_FRAME] }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "go")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(yield* handle.process(streamInput({ chat: chat.id, parent, mdl, text: "go" }))).toBe("continue")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor keeps an INFORMATIVE sentence bare", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // The control for the test above: the 402 frame already says what
        // happened, so nothing may be put in front of it - the stream-drop
        // classifier reads exactly these words.
        yield* llm.push(raw({ head: [chunkLine({ role: "assistant" })], tail: [CREDITS_FRAME] }))

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "spend")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process(streamInput({ chat: chat.id, parent, mdl, text: "spend" }))

        const failure = handle.message.error
        const message = isRecord(failure?.data) ? failure.data["message"] : undefined
        expect(message).toBe("Insufficient credits for this request")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor reads a mid-stream rate limit as the 429 it is", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        // Retryable is the POINT of this case, so the ladder is pinned to zero
        // attempts here: what is under test is the classification, not the
        // ladder that reads it.
        const previous = process.env["ORIGAMI_SESSION_RETRY_LIMIT"]
        process.env["ORIGAMI_SESSION_RETRY_LIMIT"] = "0"
        try {
          yield* llm.push(raw({ head: [chunkLine({ role: "assistant" })], tail: [RATE_LIMIT_FRAME] }))

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "go")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

          yield* handle.process(streamInput({ chat: chat.id, parent, mdl, text: "go" }))

          const failure = handle.message.error
          expect(SessionV1.APIError.isInstance(failure)).toBe(true)
          if (!SessionV1.APIError.isInstance(failure)) return
          // The HTTP 429 branch's own words and status, not a new vocabulary.
          expect(failure.data.statusCode).toBe(429)
          expect(failure.data.isRetryable).toBe(true)
          expect(failure.data.message).toContain("Too Many Requests")
          expect(failure.data.message).toContain("stealth/union-alpha is temporarily rate-limited upstream")
          // And the retry ladder reads it as retryable, which is what
          // "classified like the 429 path" has to mean.
          expect(SessionRetry.retryable(failure, "test")).toBeDefined()
        } finally {
          if (previous === undefined) delete process.env["ORIGAMI_SESSION_RETRY_LIMIT"]
          else process.env["ORIGAMI_SESSION_RETRY_LIMIT"] = previous
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

// ---------------------------------------------------------------------------
// Terminal-event-free clean EOF, and the prose that decides what it costs
//
// The bodies below are WELL-FORMED SSE that never name a finish reason the
// engine can read: either no `finish_reason` at all, or one no runtime maps
// (`end_turn_v2`). Both arrive on the AI SDK path as `step-finish` carrying the
// literal `"unknown"` - the SDK synthesises the finish either way, so usage
// presence does not tell them apart.
//
// "Nobody told us how this ended" is one fact; what to DO about it is decided
// by a second one - whether the attempt produced prose:
//
//   prose + unknown -> keep the attempt and let the loop continue. A redo would
//     re-bill a whole generation, and a gateway that mangles the reason once
//     mangles it every time, so the ladder ends in a named error over content
//     that was fine.
//   no prose + unknown -> nothing worth carrying forward, so the stream-drop
//     family's bounded DISCARD-AND-REDO is the sound repair.
// ---------------------------------------------------------------------------

/** A finish reason no runtime maps, so both runtimes write it as "unknown". */
const NOVEL_FINISH = "end_turn_v2"

function finishChunk(reason: string) {
  return { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: reason }] }
}

/** A body that says nothing and ends cleanly, never saying how the step ended. */
function silentStream() {
  return raw({ head: [chunkLine({ role: "assistant" })] })
}

/** Real prose, then a finish reason the engine cannot read. */
function novelFinishStream(text: string) {
  return raw({
    head: [chunkLine({ role: "assistant" }), chunkLine({ content: text })],
    tail: [finishChunk(NOVEL_FINISH)],
  })
}

/** The same unreadable reason, with nothing said before it. */
function novelFinishOnlyStream() {
  return raw({ head: [chunkLine({ role: "assistant" })], tail: [finishChunk(NOVEL_FINISH)] })
}

/** Like `assistant`, but with no finish - the state a fresh step starts in. */
const unfinishedAssistant = Effect.fn("TestSession.unfinishedAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg = yield* assistant(sessionID, parentID, root)
  const fresh: SessionV1.Assistant = { ...msg, finish: undefined }
  yield* session.updateMessage(fresh)
  return fresh
})

it.live("session.processor retries a SILENT finish-less clean EOF instead of answering continue", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(silentStream())
        yield* llm.text("recovered")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "eof")
        const msg = yield* unfinishedAssistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process(streamInput({ chat: chat.id, parent, mdl, text: "eof" }))
        const parts = yield* MessageV2.parts(msg.id)

        // One bounded retry, not a silent re-step: the SECOND call is the retry
        // the family spends, and it is the one that produced a real answer.
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(handle.message.finish).toBe("stop")
        expect(handle.message.error).toBeUndefined()

        // The redo, not the dead attempt, is what the user reads.
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)

        // And the user is told, in the chat, that a retry happened.
        const notices = parts.filter(
          (part): part is SessionV1.TextPart =>
            part.type === "text" && SessionStreamDrop.readNotice(part.metadata) !== undefined,
        )
        expect(notices.length).toBe(1)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor ends the turn with a NAMED error once finish-less EOF retries are exhausted", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // One more finish-less body than the family's attempt budget allows.
        for (let i = 0; i < SessionStreamDrop.LIMIT_DEFAULT + 1; i++) yield* llm.push(silentStream())
        yield* llm.text("must not be reached")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "eof")
        const msg = yield* unfinishedAssistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process(streamInput({ chat: chat.id, parent, mdl, text: "eof" }))

        // Bounded: the initial attempt plus exactly LIMIT_DEFAULT retries. Never
        // once per step up to the agent's cap.
        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(SessionStreamDrop.LIMIT_DEFAULT + 1)

        const failure = handle.message.error
        expect(failure?.name).toBe("APIError")
        expect(SessionV1.APIError.isInstance(failure)).toBe(true)
        if (!SessionV1.APIError.isInstance(failure)) return
        expect(failure.data.metadata?.["code"]).toBe(SessionStreamDrop.CODE)
        expect(failure.data.message.toLowerCase()).toContain("no finish")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor keeps an unreadable finish reason that FOLLOWED real prose", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(novelFinishStream("here is the first half"))
        yield* llm.text("must not be reached")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "novel")
        const msg = yield* unfinishedAssistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process(streamInput({ chat: chat.id, parent, mdl, text: "novel" }))
        const parts = yield* MessageV2.parts(msg.id)

        // No redo at all: the generation is kept rather than re-billed, and the
        // decision about what happens NEXT is left to the loop.
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
        expect(handle.message.finish).toBe("unknown")
        expect(parts.some((part) => part.type === "text" && part.text === "here is the first half")).toBe(true)

        // Nothing was announced as a dropped stream, because nothing dropped.
        expect(
          parts.some((part) => part.type === "text" && isRecord(part.metadata) && "origami_retry" in part.metadata),
        ).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor still redoes an unreadable finish reason that carried NO prose", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // The named-but-unreadable sibling of the silent EOF above: same verdict,
        // because the attempt left nothing behind that is worth carrying forward.
        yield* llm.push(novelFinishOnlyStream())
        yield* llm.text("recovered")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "novel")
        const msg = yield* unfinishedAssistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process(streamInput({ chat: chat.id, parent, mdl, text: "novel" }))
        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(handle.message.finish).toBe("stop")
        expect(handle.message.error).toBeUndefined()
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
        const notices = parts.filter(
          (part): part is SessionV1.TextPart =>
            part.type === "text" && SessionStreamDrop.readNotice(part.metadata) !== undefined,
        )
        expect(notices.length).toBe(1)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

// ---------------------------------------------------------------------------
// origami_change-start (t-3kr4o4): OpenAI ends a step "stop" with nothing on it
// ---------------------------------------------------------------------------

const emptyReplyInput = (chatID: SessionID, parent: SessionV1.User, mdl: any) =>
  ({
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
    messages: [{ role: "user", content: "carry on" }],
    tools: {},
  }) satisfies LLM.StreamInput

itEmptyReply.live("session.processor redoes a terminal stop that produced nothing", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        emptyReplyStreams.length = 0
        emptyReplyCalls = 0
        // Attempt 1 is the defect: reasoning only, finish "stop". Attempt 2 is
        // the same request answered properly, which is what the redo buys.
        emptyReplyStreams.push(reasoningOnlyStop(), textStop("recovered"))

        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "carry on")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process(emptyReplyInput(chat.id, parent as SessionV1.User, mdl))

        // The turn carries on with real content instead of ending on an empty
        // assistant message. Without the guard this is one call and no text.
        expect(emptyReplyCalls).toBe(2)
        expect(value).toBe("continue")
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
        // The redo is STATED, not silent: the stream-drop family writes its
        // notice into the transcript, carrying the provider-truth sentence - now
        // in the notice's `detail` rather than in prose under the agent's name.
        expect(
          parts.some((part) =>
            SessionStreamDrop.readNotice(part.type === "text" ? part.metadata : undefined)?.detail.includes(
              "The provider ended the reply with no content.",
            ),
          ),
        ).toBe(true)
        expect(msg.error).toBeUndefined()
      }),
    { config: cfg },
  ),
)

itEmptyReply.live("session.processor leaves a terminal stop that produced prose alone", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        emptyReplyStreams.length = 0
        emptyReplyCalls = 0
        emptyReplyStreams.push(textStop("done"), textStop("never asked for"))

        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "carry on")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process(emptyReplyInput(chat.id, parent as SessionV1.User, mdl))

        // A real answer is never re-billed: exactly one request.
        expect(emptyReplyCalls).toBe(1)
        const parts = yield* MessageV2.parts(msg.id)
        expect(parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
        expect(parts.some((part) => part.type === "text" && part.text.includes("Stream dropped"))).toBe(false)
      }),
    { config: cfg },
  ),
)
// origami_change-end

// origami_change: journal coalescing (t-rz12wq). A running tool rewrites its
// WHOLE part on every progress callback, and every rewrite used to append a
// journal row - 13,489 rows for 1,033 parts in the largest session measured. The
// part table and the bus must still see every update (that is the chat), while
// the journal sees the opening state, the close, and at most one row per
// coalescing window in between.
it.live("session.processor effect tests coalesce streaming tool progress out of the journal", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        let published = 0
        const off = yield* events.listen((evt) => {
          if (evt.type === SessionV1.Event.PartUpdated.type) {
            const data = evt.data as typeof SessionV1.Event.PartUpdated.data.Type
            if (data.part.type === "tool") published++
          }
          return Effect.void
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              // Eight progress reports in a row, the way a streaming shell or a
              // sub-agent reports one.
              execute: async (input, options) => {
                for (let step = 0; step < 8; step++) {
                  await Effect.runPromise(
                    handle.updateToolCall(options.toolCallId, (part) => ({
                      ...part,
                      state: {
                        status: "running",
                        input: input as Record<string, unknown>,
                        title: `step ${step}`,
                        metadata: { step },
                        time: { start: 1 },
                      },
                    })),
                  )
                }
                return { title: "Weather lookup", output: `result:${input.query}`, metadata: { source: "test" } }
              },
            }),
          },
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        const rows = yield* db
          .all<{ n: number }>(
            sql`SELECT count(*) AS n FROM ${sql.identifier("event")}
                WHERE aggregate_id = ${chat.id} AND type LIKE 'message.part.updated.%'
                  AND json_extract(data, '$.part.id') = ${call?.id ?? ""}`,
          )
          .pipe(Effect.orDie)

        expect(value).toBe("continue")
        // The chat is unchanged: the part table holds the finished call, and the
        // bus carried every one of the eight progress updates.
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.output).toBe("result:weather")
        expect(published).toBeGreaterThanOrEqual(10)
        // The journal did not: opening state, the running transition, the close.
        expect(rows[0]?.n).toBeLessThanOrEqual(4)
        // ...and what it kept is the finished call, not a half-streamed one.
        const last = yield* db
          .all<{ data: string }>(
            sql`SELECT data FROM ${sql.identifier("event")}
                WHERE aggregate_id = ${chat.id} AND type LIKE 'message.part.updated.%'
                  AND json_extract(data, '$.part.id') = ${call.id}
                ORDER BY seq DESC LIMIT 1`,
          )
          .pipe(Effect.orDie)
        expect(JSON.parse(last[0]!.data).part.state.status).toBe("completed")
      }),
    { config: (url) => providerCfg(url) },
  ),
)
// origami_change-end
