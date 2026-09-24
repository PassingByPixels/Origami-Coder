// t-f6vig2. The sub-agent token riders, end to end through the REAL engine.
//
// test/acp/event.test.ts already proves the handler emits a rider when a FAKE
// sdk hands it a billed transcript. What it cannot prove is that a real
// background sub-agent's real step-finish produces such an event at all, that
// the real ancestor walk resolves the child to its registered parent, and that
// the real `<task_result>` turn carries a settled total. The drawer showed
// `0 / 0` on both, so the gap is here, not in the fake.
//
// So: the real task tool, the real Session service, the real event bus, and
// the real ACP Subscription reading through an SDK shim that calls the same
// Session service the engine writes to.

import { afterEach, describe, expect } from "bun:test"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { Event, OrigamiClient } from "@origami/sdk/v2"
import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Ripgrep } from "@origami/core/ripgrep"
import { Effect, ManagedRuntime } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FlockRouting } from "@/flock/routing"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import type { SessionPrompt } from "@/session/prompt"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"
import { GlobalBus } from "@/bus/global"
import { TASK_TOKENS_KEY } from "@/session/task-result"
import { RunStats } from "@/acp/run-stats"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

/** The figures the owner's live child actually carried (ticket t-f6vig2). */
const BILLED = { input: 19852, output: 322, reasoning: 30, cache: { read: 0, write: 0 } }

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    BackgroundJob.node,
    EventV2Bridge.node,
    Config.node,
    CrossSpawnSpawner.node,
    FlockRouting.node,
    Permission.node,
    Provider.node,
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    SessionStatus.node,
    Truncate.node,
    ToolRegistry.node,
    Database.node,
    RuntimeFlags.node,
    Ripgrep.node,
  ]),
  [[RuntimeFlags.node, RuntimeFlags.layer({ experimentalBackgroundSubagents: true })]],
)

const it = testEffect(layer)

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]

/** Every rider-only chunk that names a task session, in arrival order. */
function taskRiders(updates: readonly SessionUpdateParams[]) {
  return updates
    .filter((item) => item.update.sessionUpdate === "agent_message_chunk")
    .map((item) => (item.update as { _meta?: Record<string, unknown> })._meta)
    .filter((meta): meta is Record<string, unknown> => typeof meta?.["origami_task_session"] === "string")
}

/**
 * The ACP subscription, wired to the SAME engine this test writes through.
 *
 * `sdk.session.get`/`messages` go to the real Session service, which is what
 * `resolveRegisteredAncestor` walks and what `childSpend` sums - the two reads
 * the live rider path depends on. Events arrive off the real GlobalBus, the
 * same envelope shape `sdk.global.event` streams (event-v2-bridge.ts).
 */
const wireSubscription = Effect.fnUntraced(function* (parentSessionId: string, cwd: string) {
  const sessions = yield* Session.Service
  const updates: SessionUpdateParams[] = []
  /** t-ucndru. Every `session.messages` read the subscription makes, and its `limit`. */
  const reads: Array<{ sessionID: string; limit?: number }> = []

  const sdk = {
    global: {
      event: () => Promise.resolve({ stream: (async function* () {})() }),
    },
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
      messages: (input?: { sessionID?: string; limit?: number }) => {
        reads.push({ sessionID: input?.sessionID ?? "", ...(input?.limit ? { limit: input.limit } : {}) })
        return Effect.runPromise(
          sessions.messages({ sessionID: (input?.sessionID ?? "") as SessionID, limit: input?.limit }).pipe(
            Effect.map((list) => ({ data: list })),
            Effect.catchCause(() => Effect.succeed({ data: [] })),
          ),
        )
      },
      message:(input: { sessionID?: string; messageID: string }) =>
        Effect.runPromise(
          sessions.messages({ sessionID: (input.sessionID ?? "") as SessionID }).pipe(
            Effect.map((list) => ({ data: list.find((item) => item.info.id === input.messageID) })),
            Effect.catchCause(() => Effect.succeed({ data: undefined })),
          ),
        ),
    },
  } as unknown as OrigamiClient

  const session = ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
  const connection = {
    sessionUpdate: (params: SessionUpdateParams) => {
      updates.push(params)
      return Promise.resolve()
    },
  } satisfies Pick<AgentSideConnection, "sessionUpdate">
  const subscription = new ACPEvent.Subscription({ sdk, connection, session })

  yield* Effect.promise(() => Effect.runPromise(session.create({ id: parentSessionId, cwd })))

  // Serialized, like the real `for await` loop over one event stream.
  let pump: Promise<unknown> = Promise.resolve()
  const onEvent = (envelope: { payload?: unknown }) => {
    if (!envelope.payload) return
    pump = pump.then(() => subscription.handle(envelope.payload as Event).catch(() => {}))
  }
  GlobalBus.on("event", onEvent)
  yield* Effect.addFinalizer(() => Effect.sync(() => void GlobalBus.off("event", onEvent)))

  /** Let the bus drain: events are emitted from fibers this test does not hold. */
  const settle = Effect.promise(async () => {
    for (let pass = 0; pass < 20; pass++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      await pump
    }
  })

  return { updates, settle, reads }
})

const seed = Effect.fnUntraced(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "parent" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

/**
 * Prompt ops that BILL the child for one step and PERSIST the parent's
 * injected result turn.
 *
 * Both halves have to be stored, not just returned: the rider path is driven
 * by `message.part.updated` events, and only a stored part emits one. The
 * stub in task.test.ts returns an unsaved object, which is why nothing there
 * ever exercised this.
 */
const billingOps = (input: {
  parentSessionId: string
  sessions: Session.Interface
  /** false drives a child that RAN but was never billed - no step-finish, no
   *  message-level totals. Nothing measured must post nothing. */
  billed?: boolean
  /** How many step-finish parts the child's turn leaves behind. More than one
   *  is a child that took several model round trips, which is what makes
   *  "one reader per step" countable. */
  steps?: number
  /** t-ucndru. One step's figures, when a test needs cache and cost to be non-zero. */
  tokens?: typeof BILLED
  cost?: number
  /** t-ucndru. Runs after each child step-finish is stored, before the next one. */
  afterStep?: (sessionID: string) => Effect.Effect<void>
  onParent?: (input: SessionPrompt.PromptInput) => void
}): TaskPromptOps => ({
  cancel: () => Effect.void,
  busy: () => Effect.succeed(false),
  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt: (promptInput) =>
    Effect.gen(function* () {
      const id = MessageID.ascending()
      const info: SessionV1.Assistant = {
        id,
        role: "assistant",
        parentID: promptInput.messageID ?? MessageID.ascending(),
        sessionID: promptInput.sessionID,
        mode: promptInput.agent ?? "general",
        agent: promptInput.agent ?? "general",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: promptInput.model?.modelID ?? ref.modelID,
        providerID: promptInput.model?.providerID ?? ref.providerID,
        time: { created: Date.now() },
        finish: "stop",
      }
      const isParent = promptInput.sessionID === input.parentSessionId
      if (isParent) input.onParent?.(promptInput)

      // The parent's injected turn: persist the USER part the tool wrote,
      // metadata and all - that part IS the terminal marker on the wire.
      if (isParent) {
        const injectedID = promptInput.messageID ?? MessageID.ascending()
        yield* input.sessions.updateMessage({
          id: injectedID,
          role: "user",
          sessionID: promptInput.sessionID,
          agent: promptInput.agent ?? "build",
          model: ref,
          time: { created: Date.now() },
        })
        for (const part of promptInput.parts ?? []) {
          if (part.type !== "text") continue
          yield* input.sessions.updatePart({
            id: PartID.ascending(),
            messageID: injectedID,
            sessionID: promptInput.sessionID,
            type: "text",
            text: part.text,
            ...(part.metadata ? { metadata: part.metadata as Record<string, unknown> } : {}),
          } as never)
        }
      }

      yield* input.sessions.updateMessage(info)
      const text = {
        id: PartID.ascending(),
        messageID: id,
        sessionID: promptInput.sessionID,
        type: "text" as const,
        text: isParent ? "ack" : "child done",
      }
      yield* input.sessions.updatePart(text as never)
      if (!isParent && input.billed !== false) {
        // What the engine leaves behind for a billed round trip.
        for (let step = 0; step < (input.steps ?? 1); step++) {
          yield* input.sessions.updatePart({
            id: PartID.ascending(),
            messageID: id,
            sessionID: promptInput.sessionID,
            type: "step-finish",
            reason: "stop",
            cost: input.cost ?? 0,
            tokens: input.tokens ?? BILLED,
          } as never)
          if (input.afterStep) yield* input.afterStep(promptInput.sessionID)
        }
      }
      return { info, parts: [text] } as unknown as SessionV1.WithParts
    }),
})

describe("sub-agent token riders (t-f6vig2)", () => {
  it.instance("a background child's real spend reaches the parent live and on the terminal marker", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const instance = yield* TestInstance
      const { chat, assistant } = yield* seed()
      const wired = yield* wireSubscription(chat.id, instance.directory)
      const def = yield* (yield* TaskTool).init()
      const launchWrites: Array<Record<string, unknown>> = []

      const started = yield* def.execute(
        { description: "count the cache", prompt: "count it", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: billingOps({ parentSessionId: chat.id, sessions }), bypassAgentCheck: true },
          messages: [],
          metadata: (value) => Effect.sync(() => void launchWrites.push(value.metadata ?? {})),
          ask: () => Effect.void,
        },
      )

      yield* awaitWithTimeout(
        jobs.wait({ id: started.metadata.sessionId, timeout: 5_000 }),
        "the background child never settled",
        "10 seconds",
      )
      yield* wired.settle

      const child = started.metadata.sessionId
      const riders = taskRiders(wired.updates).filter((meta) => meta["origami_task_session"] === child)
      const spent = riders.filter((meta) => !!meta[TASK_TOKENS_KEY])

      // (1) A LIVE rider, off the child's own step-finish.
      expect(spent.length).toBeGreaterThan(0)
      expect(spent[0]?.[TASK_TOKENS_KEY]).toEqual({
        input: BILLED.input,
        output: BILLED.output,
        reasoning: BILLED.reasoning,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        // t-ffziaz. One step so far, and its context is the whole prompt it
        // sent - here the input itself, since this child reported no cache.
        steps: 1,
        context: BILLED.input,
      })

      // (2) The terminal marker carries the settled total, not zeros.
      const terminal = riders.filter((meta) => meta["origami_task_state"] === "completed")
      expect(terminal.length).toBeGreaterThan(0)
      expect(terminal.at(-1)?.[TASK_TOKENS_KEY]).toEqual({
        input: BILLED.input,
        output: BILLED.output,
        reasoning: BILLED.reasoning,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        steps: 1,
        context: BILLED.input,
      })

      // (3) No all-zero placeholder at spawn: blank is the honest answer for
      // "nothing measured yet", and a numeric 0/0 is what the drawer printed.
      expect(launchWrites.length).toBeGreaterThan(0)
      expect(launchWrites[0]).not.toHaveProperty(TASK_TOKENS_KEY)
      // ...and no write EVER carries an all-zero one: a late zero overwrites a
      // real figure, because a tool_call_update re-sends the call's metadata.
      for (const write of [...launchWrites, started.metadata as Record<string, unknown>]) {
        const value = write[TASK_TOKENS_KEY] as { input?: number; output?: number } | undefined
        if (value) expect(value.input).toBe(BILLED.input)
      }
    }),
  )

  /**
   * t-fijy8a F7. The child's transcript was read TWICE per step-finish - here
   * (acp/event.ts childTokens) and again in tool/task.ts refreshTokens - for
   * two riders carrying the same number.
   *
   * The count is what is asserted, not the plumbing: a child billed for TWO
   * steps produces a chunk rider per step (the surviving reader), and the
   * launcher's tool call is written ONCE, at the end. Before the fix the tool
   * call carried one write per step as well, and each of those writes was a
   * full transcript read.
   */
  it.instance("reads the child's transcript once per step: the task call is written once, at the end", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const instance = yield* TestInstance
      const { chat, assistant } = yield* seed()
      const wired = yield* wireSubscription(chat.id, instance.directory)
      const def = yield* (yield* TaskTool).init()
      const writes: Array<Record<string, unknown>> = []

      const started = yield* def.execute(
        { description: "two steps", prompt: "work twice", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: billingOps({ parentSessionId: chat.id, sessions, steps: 2 }),
            bypassAgentCheck: true,
          },
          messages: [],
          metadata: (value) => Effect.sync(() => void writes.push(value.metadata ?? {})),
          ask: () => Effect.void,
        },
      )
      yield* awaitWithTimeout(
        jobs.wait({ id: started.metadata.sessionId, timeout: 5_000 }),
        "the two-step child never settled",
        "10 seconds",
      )
      yield* wired.settle

      const child = started.metadata.sessionId
      const riders = taskRiders(wired.updates).filter((meta) => meta["origami_task_session"] === child)
      // The surviving reader, once per step-finish (the terminal marker adds its
      // own settled total, so only the running riders are counted here).
      const live = riders.filter((meta) => !!meta[TASK_TOKENS_KEY] && !meta["origami_task_state"])
      expect(live.length).toBe(2)

      // The engine-side reader is down to one, at the end.
      expect(writes.filter((write) => !!write[TASK_TOKENS_KEY]).length).toBe(1)
      // ...and it still carries the figure: the part-metadata rider is part of
      // the wire shape, it just stopped being re-derived every step.
      expect(writes.at(-1)?.[TASK_TOKENS_KEY]).toEqual({
        input: BILLED.input * 2,
        output: BILLED.output * 2,
        reasoning: BILLED.reasoning * 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        // t-ffziaz. The counts above DOUBLE over two steps; these two do not -
        // that is the whole point of carrying them. `context` is one step's.
        steps: 2,
        context: BILLED.input,
      })
    }),
  )

  it.instance("a child that ran but was never billed posts no token rider at all", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const instance = yield* TestInstance
      const { chat, assistant } = yield* seed()
      const wired = yield* wireSubscription(chat.id, instance.directory)
      const def = yield* (yield* TaskTool).init()
      const writes: Array<Record<string, unknown>> = []

      const started = yield* def.execute(
        { description: "say nothing", prompt: "nothing", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: billingOps({ parentSessionId: chat.id, sessions, billed: false }),
            bypassAgentCheck: true,
          },
          messages: [],
          metadata: (value) => Effect.sync(() => void writes.push(value.metadata ?? {})),
          ask: () => Effect.void,
        },
      )
      yield* awaitWithTimeout(
        jobs.wait({ id: started.metadata.sessionId, timeout: 5_000 }),
        "the unbilled child never settled",
        "10 seconds",
      )
      yield* wired.settle

      // Not one zero, anywhere: not on the call, not on the wire.
      for (const write of [...writes, started.metadata as Record<string, unknown>]) {
        expect(write).not.toHaveProperty(TASK_TOKENS_KEY)
      }
      expect(taskRiders(wired.updates).filter((meta) => !!meta[TASK_TOKENS_KEY])).toEqual([])
    }),
  )

  /**
   * t-ucndru (lazy loading L3, plan 5.3). A child's step used to re-read the
   * child's WHOLE transcript for its rider, every step, so a child of S steps
   * and T MB read about S x T / 2 MB over its life. The rider now comes from the
   * child's session ROW, plus the step-finish part the event carries.
   *
   * The figures must not move: each rider equals the old reader, RunStats.stat
   * over the child's stored messages AT THAT STEP, `steps` included. That also
   * proves the order: a row read before the projector applied the step would
   * show one step (and one step's tokens) too few.
   */
  it.instance("a child step reads the child's row, never its transcript, and the rider equals RunStats.stat", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const instance = yield* TestInstance
      const { chat, assistant } = yield* seed()
      const wired = yield* wireSubscription(chat.id, instance.directory)
      const def = yield* (yield* TaskTool).init()
      const writes: Array<Record<string, unknown>> = []

      // The engine side (tool/task.ts refreshTokens) reads through this same service.
      const messages = sessions.messages
      const engineReads: Array<{ sessionID: string; limit?: number }> = []
      Object.assign(sessions, {
        messages: (input: Parameters<typeof messages>[0]) => {
          engineReads.push({ sessionID: input.sessionID, ...(input.limit ? { limit: input.limit } : {}) })
          return messages(input)
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => void Object.assign(sessions, { messages })))

      // The old figure, taken after each step once the subscription has handled it.
      const expected: Array<Record<string, number | undefined>> = []
      const oldFigure = (sessionID: string) =>
        messages({ sessionID: sessionID as SessionID }).pipe(
          Effect.map((stored) => {
            const stat = RunStats.stat(sessionID, stored as never)
            return {
              input: stat.tokens?.input,
              output: stat.tokens?.output,
              reasoning: stat.tokens?.reasoning ?? 0,
              cacheRead: stat.tokens?.cacheRead ?? 0,
              cacheWrite: stat.tokens?.cacheWrite ?? 0,
              cost: stat.cost ?? 0,
              steps: stat.steps,
              context: stat.context,
            }
          }),
        )
      const afterStep = (sessionID: string) =>
        Effect.gen(function* () {
          yield* wired.settle
          expected.push(yield* oldFigure(sessionID))
        }).pipe(Effect.orDie)

      const step = { input: 1200, output: 80, reasoning: 5, cache: { read: 9000, write: 300 } }
      const started = yield* def.execute(
        { description: "three steps", prompt: "work", subagent_type: "general", background: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: billingOps({ parentSessionId: chat.id, sessions, steps: 3, tokens: step, cost: 0.25, afterStep }),
            bypassAgentCheck: true,
          },
          messages: [],
          metadata: (value) => Effect.sync(() => void writes.push(value.metadata ?? {})),
          ask: () => Effect.void,
        },
      )
      yield* awaitWithTimeout(
        jobs.wait({ id: started.metadata.sessionId, timeout: 5_000 }),
        "the three-step child never settled",
        "10 seconds",
      )
      yield* wired.settle
      const child = started.metadata.sessionId

      // (1) Not one whole-transcript read of the child, by the ACP handler or the task tool.
      const whole = (list: ReadonlyArray<{ sessionID: string; limit?: number }>) =>
        list.filter((read) => read.sessionID === child && !read.limit)
      expect(whole(wired.reads)).toEqual([])
      expect(whole(engineReads)).toEqual([])

      // (2) One live rider per step, each equal to the old figure at that step.
      const riders = taskRiders(wired.updates).filter((meta) => meta["origami_task_session"] === child)
      const live = riders
        .filter((meta) => !!meta[TASK_TOKENS_KEY] && !meta["origami_task_state"])
        .map((meta) => meta[TASK_TOKENS_KEY])
      expect(expected.map((figure) => figure.steps)).toEqual([1, 2, 3])
      expect(live).toEqual(expected)

      // (3) The settled total, on the terminal marker and on the task call, is the same figure.
      const final = expected.at(-1)
      expect(final?.context).toBe(step.input + step.cache.read + step.cache.write)
      const terminal = riders.filter((meta) => meta["origami_task_state"] === "completed")
      expect(terminal.at(-1)?.[TASK_TOKENS_KEY]).toEqual(final)
      expect(writes.filter((write) => !!write[TASK_TOKENS_KEY]).at(-1)?.[TASK_TOKENS_KEY]).toEqual(final)
    }),
  )

  it.instance("a resumed background child (task_id) gets the same riders", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const instance = yield* TestInstance
      const { chat, assistant } = yield* seed()
      const wired = yield* wireSubscription(chat.id, instance.directory)
      const def = yield* (yield* TaskTool).init()
      const ops = billingOps({ parentSessionId: chat.id, sessions })
      const context = (metadata: (value: { metadata?: Record<string, unknown> }) => Effect.Effect<void>) => ({
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: ops, bypassAgentCheck: true },
        messages: [],
        metadata,
        ask: () => Effect.void,
      })

      const first = yield* def.execute(
        { description: "count the cache", prompt: "count it", subagent_type: "general", background: true },
        context(() => Effect.void),
      )
      yield* awaitWithTimeout(
        jobs.wait({ id: first.metadata.sessionId, timeout: 5_000 }),
        "the first child never settled",
        "10 seconds",
      )
      yield* wired.settle

      const resumeWrites: Array<Record<string, unknown>> = []
      const resumed = yield* def.execute(
        {
          description: "count again",
          prompt: "carry on",
          subagent_type: "general",
          background: true,
          task_id: first.metadata.sessionId,
        },
        context((value) => Effect.sync(() => void resumeWrites.push(value.metadata ?? {}))),
      )
      yield* awaitWithTimeout(
        jobs.wait({ id: resumed.metadata.sessionId, timeout: 5_000 }),
        "the resumed child never settled",
        "10 seconds",
      )
      yield* wired.settle

      const child = first.metadata.sessionId
      expect(resumed.metadata.sessionId).toBe(child)

      // A resume must never post a zero over a figure the client already has.
      for (const write of resumeWrites) {
        const value = write[TASK_TOKENS_KEY] as { input?: number } | undefined
        if (value) expect(value.input).toBeGreaterThan(0)
      }
      expect(resumed.metadata[TASK_TOKENS_KEY]).not.toEqual({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      })

      // The second turn's spend is ADDITIVE over the child's whole transcript.
      const riders = taskRiders(wired.updates).filter(
        (meta) => meta["origami_task_session"] === child && !!meta[TASK_TOKENS_KEY],
      )
      expect(riders.length).toBeGreaterThan(0)
      expect((riders.at(-1)?.[TASK_TOKENS_KEY] as { input: number }).input).toBe(BILLED.input * 2)
    }),
  )
})
