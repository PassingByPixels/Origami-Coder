/**
 * t-gw71a9. The todo list must reach the client when the MODEL WRITES it, not
 * when the engine gets round to running the call.
 *
 * The owner's 0.4.145 capture: one step streamed [task, task, todowrite]. The
 * two sub-agent spawns ran first, ~6 s each, and the panel only filled in when
 * the todowrite itself executed — 11 s after the model had already written the
 * list.
 *
 * This drives the REAL pieces end to end: the real session processor reading a
 * real SSE batch of three tool calls off the test LLM server, the real event
 * bus, and the real ACP subscription, whose frames are timestamped as the
 * client would see them. The `task` stand-in is a slow tool, so "before the
 * first task finishes" is an observation, not an inference.
 */
import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { afterEach, describe, expect } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { Event, OrigamiClient } from "@origami/sdk/v2"
import { jsonSchema, tool } from "ai"
import { Effect, Layer, ManagedRuntime } from "effect"
import path from "path"
import type { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { SessionProjector } from "@origami/core/session/projector"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"
import { GlobalBus } from "@/bus/global"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, TestLLMServer } from "../lib/llm-server"

afterEach(async () => {
  await disposeAllInstances()
})

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

const cfg = (url: string) => ({
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
})

const agent = (): Agent.Info => ({
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
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
  ],
)

const it = testEffect(env)

// --------------------------------------------------------------------------
// The wire fixture: one assistant step carrying three tool calls.
// --------------------------------------------------------------------------

const chunk = (delta: object, finish?: string) => ({
  id: "chatcmpl-batch",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
})

const call = (index: number, id: string, name: string, args: string) =>
  chunk({
    role: "assistant",
    tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }],
  })

const TODOS = [
  { content: "read the ticket", status: "in_progress", priority: "high" },
  { content: "write the test", status: "pending", priority: "high" },
]

const batch = () => [
  call(0, "call_task_a", "task", JSON.stringify({ description: "A", prompt: "A" })),
  call(1, "call_task_b", "task", JSON.stringify({ description: "B", prompt: "B" })),
  call(2, "call_todo", "todowrite", JSON.stringify({ todos: TODOS })),
  chunk({}, "tool_calls"),
]

// --------------------------------------------------------------------------
// The tools. `task` stands in for a sub-agent spawn: slow, and it records when
// it ran. `todowrite` records the same, and is the tool whose INPUT the panel
// needs.
// --------------------------------------------------------------------------

/** How long the `task` stand-in occupies the runtime. */
const TASK_MS = 400

function makeTools(clock: { mark: (what: string) => void; onFirstTaskStart: () => void }) {
  let first = true
  const task = tool({
    description: "Spawn a sub-agent.",
    inputSchema: jsonSchema<{ description: string; prompt: string }>({
      type: "object",
      properties: { description: { type: "string" }, prompt: { type: "string" } },
      required: ["description", "prompt"],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const name = (input as { description: string }).description
      clock.mark(`task ${name} execute:start`)
      if (first) {
        first = false
        clock.onFirstTaskStart()
      }
      await new Promise((resolve) => setTimeout(resolve, TASK_MS))
      clock.mark(`task ${name} execute:end`)
      return { output: `child ${name} done` }
    },
  })
  const todowrite = tool({
    description: "Write the todo list.",
    inputSchema: jsonSchema<{ todos: unknown[] }>({
      type: "object",
      properties: { todos: { type: "array", items: { type: "object" } } },
      required: ["todos"],
      additionalProperties: false,
    }),
    execute: async () => {
      clock.mark("todowrite execute")
      return { output: "todos updated" }
    },
  })
  return { task, todowrite }
}

// --------------------------------------------------------------------------
// The client end: the real ACP subscription, fed off the real bus, recording
// every frame with the moment it arrived.
// --------------------------------------------------------------------------

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
type Frame = { at: number; params: SessionUpdateParams }
type Wired = {
  frames: Frame[]
  published: { at: number; part: SessionV1.Part }[]
  settle: Effect.Effect<void>
}

const wireSubscription = Effect.fnUntraced(function* (sessionId: string, cwd: string) {
  const sessions = yield* Session.Service
  const frames: Frame[] = []

  const sdk = {
    global: { event: () => Promise.resolve({ stream: (async function* () {})() }) },
    session: {
      get: (input?: { sessionID?: string }) =>
        input?.sessionID
          ? Effect.runPromise(
              sessions.get(input.sessionID as SessionID).pipe(
                Effect.map((info) => ({ data: info })),
                Effect.catchCause(() => Effect.succeed({ data: undefined })),
              ),
            )
          : Promise.resolve({ data: undefined }),
      messages: (input?: { sessionID?: string }) =>
        Effect.runPromise(
          sessions.messages({ sessionID: (input?.sessionID ?? "") as SessionID }).pipe(
            Effect.map((list) => ({ data: list })),
            Effect.catchCause(() => Effect.succeed({ data: [] })),
          ),
        ),
    },
  } as unknown as OrigamiClient

  const session = ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
  const connection = {
    sessionUpdate: (params: SessionUpdateParams) => {
      frames.push({ at: Date.now(), params })
      return Promise.resolve()
    },
  } satisfies Pick<AgentSideConnection, "sessionUpdate">
  const subscription = new ACPEvent.Subscription({ sdk, connection, session })

  yield* Effect.promise(() => Effect.runPromise(session.create({ id: sessionId, cwd })))

  // What the ENGINE published, recorded synchronously as the bus emits it. The
  // ACP pump below is a promise chain, so a frame can only ever be later than
  // the publication it came from; this is the engine's own timing.
  const published: { at: number; part: SessionV1.Part }[] = []

  // Serialized, like the real `for await` loop over one event stream.
  let pump: Promise<unknown> = Promise.resolve()
  const onEvent = (envelope: { payload?: unknown }) => {
    if (!envelope.payload) return
    const payload = envelope.payload as { type?: string; properties?: { part?: SessionV1.Part } }
    if (payload.type === "message.part.updated" && payload.properties?.part) {
      published.push({ at: Date.now(), part: payload.properties.part })
    }
    pump = pump.then(() => subscription.handle(envelope.payload as Event).catch(() => {}))
  }
  GlobalBus.on("event", onEvent)
  yield* Effect.addFinalizer(() => Effect.sync(() => void GlobalBus.off("event", onEvent)))

  const settle = Effect.promise(async () => {
    for (let pass = 0; pass < 20; pass++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await pump
    }
  })

  return { frames, published, settle }
})

// --------------------------------------------------------------------------

const seedUser = Effect.fn("todoBatch.user")(function* (sessionID: SessionID) {
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
    text: "go",
  })
  return msg
})

const seedAssistant = Effect.fn("todoBatch.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  dir: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: dir, root: dir },
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

/** The todo list carried by a frame, whatever its kind. */
function todosOf(frame: Frame): unknown[] | undefined {
  const update = frame.params.update as { rawInput?: { todos?: unknown } }
  const todos = update.rawInput?.todos
  return Array.isArray(todos) ? todos : undefined
}

function isTodoCall(frame: Frame) {
  const update = frame.params.update as { toolCallId?: string }
  return update.toolCallId === "call_todo"
}

/** The todos carried by a stored tool part, whatever its status. */
function todosOfPart(part: SessionV1.Part): unknown[] | undefined {
  if (part.type !== "tool") return undefined
  const input = (part.state as { input?: { todos?: unknown } }).input
  return Array.isArray(input?.todos) ? input.todos : undefined
}

describe("acp.event — a batched todowrite reaches the client at WRITE time", () => {
  it.live("the todo list is published before the first task in the same batch executes", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const marks: { at: number; what: string }[] = []
          /** Everything the engine had published when the first `task` began. */
          let publishedAtFirstTask: SessionV1.Part[] = []
          let wired: Wired | undefined
          const clock = {
            mark: (what: string) => marks.push({ at: Date.now(), what }),
            onFirstTaskStart: () => {
              publishedAtFirstTask = (wired?.published ?? []).map((item) => item.part)
            },
          }

          yield* llm.push(raw({ head: batch() }))

          const { processors, session, provider } = yield* Effect.all({
            processors: SessionProcessor.Service,
            session: Session.Service,
            provider: Provider.Service,
          })

          const chat = yield* session.create({})
          wired = yield* wireSubscription(chat.id, path.resolve(dir))
          const parent = yield* seedUser(chat.id)
          const msg = yield* seedAssistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: ref,
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "go" }],
            tools: makeTools(clock) as never,
          } satisfies LLM.StreamInput)

          yield* wired.settle

          // THE ASSERTION. When the first sub-agent spawn began, the engine had
          // already published the todowrite call carrying the whole list: the
          // bridge's frame is a function of that publication, so the panel can
          // fill in at write time instead of waiting out both spawns.
          expect(marks.some((mark) => mark.what === "task A execute:start")).toBe(true)
          const todoAtFirstTask = publishedAtFirstTask.find((part) => todosOfPart(part) !== undefined)
          expect(todoAtFirstTask).toBeDefined()
          expect(todosOfPart(todoAtFirstTask!)).toEqual(TODOS)

          // ... and the client was sent that list, on a frame for that call.
          const todoFrames = wired.frames.filter((frame) => isTodoCall(frame) && todosOf(frame))
          expect(todoFrames.length).toBeGreaterThan(0)
          expect(todosOf(todoFrames[0]!)).toEqual(TODOS)

          // The batch still runs in the order the model wrote it: the stored
          // tool parts keep their call order, results and all.
          const parts = yield* MessageV2.parts(msg.id)
          const calls = parts
            .filter((part): part is SessionV1.ToolPart => part.type === "tool")
            .map((part) => part.callID)
          expect(calls).toEqual(["call_task_a", "call_task_b", "call_todo"])
        }),
      { config: (url) => cfg(url) as never },
    ),
  )
})
