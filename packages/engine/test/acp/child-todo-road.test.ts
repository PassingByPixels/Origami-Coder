/**
 * t-gyp8fj. The road a SUB-AGENT's todo list travels, driven end to end.
 *
 * A child's `todowrite` is never forwarded as a tool call: acp/event.ts degrades
 * it to one tagged text line — `> todowrite` — under the PARENT's session id, and
 * the host uses that line as a SIGNAL to read the child's stored session through
 * `subagent_transcript` (packages/vscode/src/dashboard/subagentTodos.ts). Two
 * things therefore have to hold at the same moment:
 *
 *   1. the parent connection receives the `> todowrite` chunk, carrying
 *      `_meta.origami_child_session`, and
 *   2. a transcript read taken AT THAT MOMENT already returns the list.
 *
 * The second is the one nothing tested. The signal is sent at tool START, so the
 * read races the child's stored input — and on 0.4.146 the child thinks first,
 * which moves every timing on this road.
 *
 * Real pieces only: the real session processor over a real SSE stream from the
 * test LLM server, the real event bus, the real ACP subscription with a recording
 * connection, and the real `subagent-transcript` projection.
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
import { SubagentTranscript } from "@/acp/subagent-transcript"
import { GlobalBus } from "@/bus/global"
import { disposeAllInstances, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"

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

const TODOS = [
  { content: "read the ticket", status: "in_progress", priority: "high" },
  { content: "write the test", status: "pending", priority: "high" },
]

/** The child's only tool. Slow on purpose: the signal is sent at tool START, so
 *  a read that only succeeds once the tool has FINISHED must show up as red. */
const TODO_MS = 300

function makeTools(mark: (what: string) => void) {
  /** A tool called with NO arguments at all. Its stored input is `{}` at every
   *  stage, which is exactly the placeholder a pending part carries — so it is
   *  the case that proves the rule above costs a LATER line, never a lost one. */
  const ping = tool({
    description: "Say hello.",
    inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
    execute: async () => {
      mark("ping execute")
      return { output: "pong" }
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
      mark("todowrite execute:start")
      await new Promise((resolve) => setTimeout(resolve, TODO_MS))
      mark("todowrite execute:end")
      return { output: "todos updated" }
    },
  })
  return { todowrite, ping }
}

/** The child's step on the wire: it thinks, then calls `todowrite` and `ping`.
 *  Hand-built rather than `reply()` because the two calls need their own indices
 *  — the same shape todo-batch-frames.test.ts uses. */
const chunk = (delta: object, finish?: string) => ({
  id: "chatcmpl-child",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
})

const callLine = (index: number, id: string, name: string, args: string) =>
  chunk({ role: "assistant", tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] })

const childStep = () => [
  chunk({ role: "assistant" }),
  chunk({ reasoning_content: "weighing the plan" }),
  chunk({ reasoning_content: " a little longer" }),
  callLine(0, "call_todo", "todowrite", JSON.stringify({ todos: TODOS })),
  callLine(1, "call_ping", "ping", "{}"),
  chunk({}, "tool_calls"),
]

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
type Frame = { at: number; params: SessionUpdateParams }

/** What the host's `saysTodoWrite` matches, kept character-for-character:
 *  packages/vscode/src/dashboard/subagentTodos.ts. */
const SAYS_TODOWRITE = /^>\s*todowrite\b/m

function childChunk(frame: Frame): { child: string; text: string; part?: unknown } | undefined {
  const update = frame.params.update as {
    sessionUpdate?: string
    content?: { type?: string; text?: string }
    _meta?: { origami_child_session?: unknown; origami_task_part?: unknown }
  }
  if (update.sessionUpdate !== "agent_message_chunk") return undefined
  const child = update._meta?.origami_child_session
  if (typeof child !== "string" || update.content?.type !== "text") return undefined
  return { child, text: update.content.text ?? "", part: update._meta?.origami_task_part }
}

/** The extension's own decode, over the projected transcript: the LAST todowrite
 *  tool entry's `rawInput.todos` (subagentTodos.ts `todosFromTranscript`). */
function todosFromTranscript(result: { entries: readonly unknown[] }): unknown[] | undefined {
  for (let i = result.entries.length - 1; i >= 0; i--) {
    const entry = result.entries[i] as { type?: string; toolCall?: Record<string, unknown> }
    if (entry?.type !== "tool" || !entry.toolCall) continue
    const meta = entry.toolCall["_meta"] as { origami_tool_name?: unknown } | undefined
    if (meta?.origami_tool_name !== "todowrite") continue
    const todos = (entry.toolCall["rawInput"] as { todos?: unknown } | undefined)?.todos
    if (Array.isArray(todos)) return todos
  }
  return undefined
}

const seedUser = Effect.fn("childTodo.user")(function* (sessionID: SessionID) {
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

const seedAssistant = Effect.fn("childTodo.assistant")(function* (
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

describe("acp.event — a sub-agent's todo list reaches the parent's client", () => {
  it.live("the `> todowrite` chunk arrives and a transcript read taken on it returns the list", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const marks: string[] = []
          const frames: Frame[] = []
          /** Every transcript read fired off a `> todowrite` chunk, exactly as the
           *  host's puller fires it: on the chunk, not after the turn. */
          const pulls: { at: number; todos: unknown[] | undefined; entries: number }[] = []
          const reads: Promise<void>[] = []

          const { processors, session, provider } = yield* Effect.all({
            processors: SessionProcessor.Service,
            session: Session.Service,
            provider: Provider.Service,
          })

          const chat = yield* session.create({})
          const child = yield* session.create({ parentID: chat.id, title: "Sub-agent 1" })
          const cwd = path.resolve(dir)

          // --- the client end: the real ACP subscription over the real bus ---
          const sdk = {
            global: { event: () => Promise.resolve({ stream: (async function* () {})() }) },
            session: {
              get: (input?: { sessionID?: string }) =>
                input?.sessionID
                  ? Effect.runPromise(
                      session.get(input.sessionID as SessionID).pipe(
                        Effect.map((info) => ({ data: info })),
                        Effect.catchCause(() => Effect.succeed({ data: undefined })),
                      ),
                    )
                  : Promise.resolve({ data: undefined }),
              messages: (input?: { sessionID?: string }) =>
                Effect.runPromise(
                  session.messages({ sessionID: (input?.sessionID ?? "") as SessionID }).pipe(
                    Effect.map((list) => ({ data: list })),
                    Effect.catchCause(() => Effect.succeed({ data: [] })),
                  ),
                ),
              message: () => Promise.resolve({ data: undefined }),
            },
          } as unknown as OrigamiClient

          const acp = ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
            ACPSession.Service.use((service) => Effect.succeed(service)),
          )

          /** The host's read: `subagent_transcript` for the child, projected by the
           *  engine's own projection — the same call the drawer's ↗ makes. */
          const readTranscript = () =>
            Effect.runPromise(
              session.messages({ sessionID: child.id }).pipe(
                Effect.map((messages) => SubagentTranscript.project(child.id, messages as never, cwd)),
              ),
            )

          const connection = {
            sessionUpdate: (params: SessionUpdateParams) => {
              frames.push({ at: Date.now(), params })
              const chunk = childChunk({ at: Date.now(), params })
              // The host's signal, and its answer: one pull per `> todowrite` line.
              if (chunk && SAYS_TODOWRITE.test(chunk.text)) {
                reads.push(
                  readTranscript().then((result) => {
                    pulls.push({ at: Date.now(), todos: todosFromTranscript(result), entries: result.entries.length })
                  }),
                )
              }
              return Promise.resolve()
            },
          } satisfies Pick<AgentSideConnection, "sessionUpdate">

          const subscription = new ACPEvent.Subscription({ sdk, connection, session: acp })
          // ONLY the parent is registered with the ACP layer — a sub-agent session
          // never is, which is the whole reason its events need forwarding.
          yield* Effect.promise(() => Effect.runPromise(acp.create({ id: chat.id, cwd })))

          let pump: Promise<unknown> = Promise.resolve()
          const onEvent = (envelope: { payload?: unknown }) => {
            if (!envelope.payload) return
            pump = pump.then(() => subscription.handle(envelope.payload as Event).catch(() => {}))
          }
          GlobalBus.on("event", onEvent)
          yield* Effect.addFinalizer(() => Effect.sync(() => void GlobalBus.off("event", onEvent)))

          // --- the child's turn: it THINKS, then writes its todo list ---
          yield* llm.push(raw({ head: childStep() }))
          yield* llm.push(reply().text("done").stop().item())

          const user = yield* seedUser(child.id)
          const msg = yield* seedAssistant(child.id, user.id, cwd)
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: child.id, model: mdl })

          yield* handle.process({
            user: {
              id: user.id,
              sessionID: child.id,
              role: "user",
              time: user.time,
              agent: user.agent,
              model: ref,
            } satisfies SessionV1.User,
            sessionID: child.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "go" }],
            tools: makeTools((what) => marks.push(what)) as never,
          } satisfies LLM.StreamInput)

          yield* Effect.promise(async () => {
            for (let pass = 0; pass < 20; pass++) {
              await new Promise((resolve) => setTimeout(resolve, 10))
              await pump
            }
            await Promise.all(reads)
          })

          // 1. The child's thought reached the parent, marked as thought.
          const chunks = frames.map((frame) => childChunk(frame)).filter((c) => c !== undefined)
          expect(chunks.every((c) => c!.child === child.id)).toBe(true)
          expect(chunks.filter((c) => c!.part === "reasoning").map((c) => c!.text).join("")).toContain("weighing the plan")

          // 2. The `> todowrite` line reached it too — the host's ONLY signal.
          const signals = chunks.filter((c) => SAYS_TODOWRITE.test(c!.text))
          expect(signals.length).toBeGreaterThan(0)
          expect(signals[0]!.part).toBeUndefined() // never marked reasoning, or the host never sees it

          // 3. And a read taken ON that signal already carries the list.
          expect(pulls.length).toBe(signals.length)
          expect(marks).toContain("todowrite execute:start")
          expect(pulls[0]!.todos).toEqual(TODOS)

          // 4. And the no-argument call still got its ONE line: deferred to the
          //    frame that settled it, never dropped.
          const ping = chunks.filter((c) => /^>\s*ping\b/m.test(c!.text))
          expect(marks).toContain("ping execute")
          expect(ping.length).toBe(1)
        }),
      { config: (url) => cfg(url) as never },
    ),
  )
})
