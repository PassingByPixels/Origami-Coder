import { describe, expect } from "bun:test"
import { SessionV1 } from "@origami/core/v1/session"
import { EventV2 } from "@origami/core/event"
import { SessionProjector } from "@origami/core/session/projector"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { Todo } from "@/session/todo"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Todo.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  // The todo list is keyed by session on its own table, so it does NOT travel
  // with the messages and parts fork copies. Without this the fork opens with a
  // transcript full of todowrite calls and an empty list, and both readers of
  // the stored list - the `${todos}` command substitution and the
  // post-compaction reminder - report "no plan" for a chat that has one.
  it.instance("copies the todo list onto a fork", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const todo = yield* Todo.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "with-todos" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      // NESTED on purpose: the fork's insert is an explicit field map, so a
      // column left out of it is a column the fork silently drops - and a plan
      // that arrives flattened reads as a different plan.
      const todos = [
        { content: "reproduce the failure", status: "completed", priority: "high", depth: 0 },
        { content: "read the stack trace", status: "completed", priority: "high", depth: 1 },
        { content: "fix the parser", status: "in_progress", priority: "high", depth: 0 },
      ]
      yield* todo.update({ sessionID: created.id, todos })

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      // Order matters as much as content: the list is a sequence of steps, and
      // with nesting the order is also what says which step owns which.
      expect(yield* todo.get(fork.id)).toEqual(todos)
      // And the copy is a copy - writing the fork's list must not move the
      // parent's.
      yield* todo.update({ sessionID: fork.id, todos: [{ content: "ship", status: "pending", priority: "low" }] })
      expect(yield* todo.get(created.id)).toEqual(todos)
    }),
  )

  // The per-chat SUB-AGENT model override. It rides the session row's existing
  // metadata bag (no column, no migration, for a value only the task tool
  // reads), which makes the merge the load-bearing part: metadata is SHARED, and
  // `patch` replaces the whole record.
  it.instance("sets and clears the sub-agent override without disturbing other metadata", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(
        session.create({ title: "sub-override", metadata: { source: "sdk", trace: { id: "abc" } } }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      yield* session.setSubagentModel({
        sessionID: created.id,
        model: { providerID: ProviderV2.ID.make("openrouter"), modelID: ModelV2.ID.make("qwen3-coder") },
      })
      const set = yield* session.get(created.id)
      expect(SessionNs.subagentModel(set)).toEqual({
        providerID: ProviderV2.ID.make("openrouter"),
        modelID: ModelV2.ID.make("qwen3-coder"),
      })
      // Everything else the session was carrying is still there.
      expect(set.metadata?.source).toBe("sdk")
      expect(set.metadata?.trace).toEqual({ id: "abc" })

      yield* session.setSubagentModel({ sessionID: created.id, model: undefined })
      const cleared = yield* session.get(created.id)
      expect(SessionNs.subagentModel(cleared)).toBeUndefined()
      expect(cleared.metadata?.source).toBe("sdk")
    }),
  )

  // t-lmqe0g: the sub-agent CONTEXT override rides the same metadata object as
  // the model pick, not a column of its own.
  it.instance("round-trips a context override alongside the sub-agent model", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "sub-context" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      yield* session.setSubagentModel({
        sessionID: created.id,
        model: {
          providerID: ProviderV2.ID.make("lmstudio"),
          modelID: ModelV2.ID.make("qwen3-30b"),
          context: 131072,
        },
      })
      const set = yield* session.get(created.id)
      expect(SessionNs.subagentModel(set)).toEqual({
        providerID: ProviderV2.ID.make("lmstudio"),
        modelID: ModelV2.ID.make("qwen3-30b"),
        context: 131072,
      })

      // Re-picking the SAME model with no context clears just the context half,
      // not the whole override — direct write, not a merge, matches how the ACP
      // layer re-sends the full desired state on every pick.
      yield* session.setSubagentModel({
        sessionID: created.id,
        model: { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("qwen3-30b") },
      })
      const recleared = yield* session.get(created.id)
      expect(SessionNs.subagentModel(recleared)).toEqual({
        providerID: ProviderV2.ID.make("lmstudio"),
        modelID: ModelV2.ID.make("qwen3-30b"),
      })
    }),
  )

  it.instance("reads no override from a session that has none, or a broken one", () =>
    Effect.gen(function* () {
      // A half-formed value must read as ABSENT: falling through to the flock
      // binding is right, spawning children on `undefined/undefined` is not.
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(
        session.create({ title: "broken-override", metadata: { subagentModel: { providerID: "openrouter" } } }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      expect(SessionNs.subagentModel(yield* session.get(created.id))).toBeUndefined()
    }),
  )

  it.instance("drops a non-positive or non-numeric context, keeping the model", () =>
    Effect.gen(function* () {
      // t-lmqe0g: a corrupted/adversarial context value must not poison the
      // model half of the override — read it as absent, same as a broken model.
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(
        session.create({
          title: "bad-context",
          metadata: { subagentModel: { providerID: "lmstudio", modelID: "qwen3-30b", context: -5 } },
        }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      expect(SessionNs.subagentModel(yield* session.get(created.id))).toEqual({
        providerID: ProviderV2.ID.make("lmstudio"),
        modelID: ModelV2.ID.make("qwen3-30b"),
      })
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})
