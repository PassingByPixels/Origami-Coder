// t-uhxos2. A reopened fork shows its whole sub-agent roster at once.
//
// Driven through the REAL Session service and the real store (the harness of
// test/session/goal-metadata.test.ts): `Session.fork` copies the source's messages,
// so a fork's task cards point at the SOURCE's sub-agents. The roster of a fork must
// be exactly the sub-agents its history has cards for - the set 0.4.172 drew from a
// whole replay - read from rows, on a connection that never saw the fork being made.
//
// "Cards as 0.4.172 builds them" = every `task` tool part of the chat's stored
// messages that carries `state.metadata.sessionId` (acp/event.ts `withTaskSession`
// puts that id on each task card; the webview makes one card per id, and a roster
// row becomes a card only at depth 1: webview panes/chatHistory.ts `rosterCardsFrom`).
import { describe, expect } from "bun:test"
import { SessionProjector } from "@origami/core/session/projector"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Database } from "@origami/core/database/database"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import type { SessionV1 } from "@origami/core/v1/session"
import type { OrigamiClient } from "@origami/sdk/v2"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Todo } from "@/session/todo"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import * as ACPService from "@/acp/service"
import { ACPHistoryStore } from "@/acp/history-store"
import type { ACPHistory } from "@/acp/history"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node, // the store the Session service writes, exposed to the roster read
      Session.node,
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

/** Separate the millisecond stamps, so "created before the fork point" is never a tie. */
const tick = () => Effect.promise(() => Bun.sleep(3))

/** A sub-agent of `parent`, and its task card in `parent`'s history, in the order a real
 *  turn writes them: the assistant message first, then the child session (tool/task.ts
 *  creates it while the tool runs), then the task part naming it. */
const spawn = Effect.fnUntraced(function* (parent: SessionID, title: string, card = true) {
  const sessions = yield* Session.Service
  yield* tick()
  if (!card) return (yield* sessions.create({ parentID: parent, title })).id
  const messageID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: messageID,
    sessionID: parent,
    role: "assistant",
    time: { created: Date.now() },
    parentID: MessageID.ascending(),
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Info)
  yield* tick()
  const child = yield* sessions.create({ parentID: parent, title })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: parent,
    messageID,
    type: "tool",
    callID: `call_${title}`,
    tool: "task",
    state: {
      status: "completed",
      input: { description: title, prompt: "go", subagent_type: "explore" },
      output: "done",
      title,
      metadata: { sessionId: child.id },
      time: { start: Date.now(), end: Date.now() },
    },
  } as unknown as SessionV1.Part)
  return child.id
})

/** The cards 0.4.172 draws for a chat: one per task part's child id, in its WHOLE history. */
const cards = Effect.fnUntraced(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const ids = new Set<string>()
  for (const message of yield* sessions.messages({ sessionID })) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "task") continue
      const id = (part.state as { metadata?: { sessionId?: unknown } }).metadata?.sessionId
      if (typeof id === "string") ids.add(id)
    }
  }
  return [...ids].sort()
})

const rosterCards = (tree: ACPHistoryStore.Descendants) =>
  tree.rows.filter((row) => row.depth === 1).map((row) => row.id).sort()

/** Source S with two carded children (one with a grandchild), forked, then the source goes on. */
const family = Effect.fnUntraced(function* () {
  const sessions = yield* Session.Service
  const source = yield* sessions.create({ title: "source chat" })
  const c1 = yield* spawn(source.id, "c1")
  const g1 = yield* spawn(c1, "g1", false)
  const c2 = yield* spawn(source.id, "c2")
  yield* tick()
  const fork = yield* sessions.fork({ sessionID: source.id })
  const late = yield* spawn(source.id, "late") // after the fork: not in the fork's history
  const own = yield* spawn(fork.id, "own") // the fork's own sub-agent
  return { source: source.id, fork: fork.id, c1, g1, c2, late, own }
})

describe("fork roster from the durable fork link", () => {
  it.instance("stores the source and the fork point on the fork's row", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const source = yield* sessions.create({ title: "source chat" })
      const before = Date.now()
      const fork = yield* sessions.fork({ sessionID: source.id })
      const reread = yield* sessions.get(fork.id)
      expect(reread.fork?.sessionID).toBe(source.id)
      expect(reread.fork!.time).toBeGreaterThanOrEqual(before)
      expect(reread.fork!.time).toBeLessThanOrEqual(reread.time.created)
      expect((yield* sessions.get(source.id)).fork).toBeUndefined()
    }),
  )

  it.instance("a fork's roster = the cards of its whole history: source children up to the fork point + its own", () =>
    Effect.gen(function* () {
      const f = yield* family()
      const tree = yield* ACPHistoryStore.roster(f.fork)
      expect(rosterCards(tree)).toEqual(yield* cards(f.fork))
      expect(rosterCards(tree)).toEqual([f.c1, f.c2, f.own].sort())
      expect(tree.rows.map((row) => row.id)).not.toContain(f.late)
      // A carded child's own sub-agents come with it, one level down.
      expect(tree.rows.find((row) => row.id === f.g1)).toMatchObject({ parentId: f.c1, depth: 2 })
      // The source's own roster is unchanged: every child it has.
      expect(rosterCards(yield* ACPHistoryStore.roster(f.source))).toEqual(yield* cards(f.source))
    }),
  )

  it.instance("follows a chain: a fork of a fork, with both sources going on after it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const f = yield* family()
      yield* tick()
      const second = yield* sessions.fork({ sessionID: f.fork })
      const afterSecond = yield* spawn(f.fork, "after-second")
      const sourceLater = yield* spawn(f.source, "source-later")
      const own = yield* spawn(second.id, "own-2")
      const tree = yield* ACPHistoryStore.roster(second.id)
      expect(rosterCards(tree)).toEqual(yield* cards(second.id))
      expect(rosterCards(tree)).toEqual([f.c1, f.c2, f.own, own].sort())
      for (const id of [f.late, afterSecond, sourceLater]) expect(tree.rows.map((row) => row.id)).not.toContain(id)
    }),
  )

  it.instance("a fork at a message cuts at that message", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const source = yield* sessions.create({ title: "source chat" })
      const c1 = yield* spawn(source.id, "c1")
      yield* tick()
      const cutAt = (yield* sessions.messages({ sessionID: source.id })).length
      const c2 = yield* spawn(source.id, "c2")
      const cut = (yield* sessions.messages({ sessionID: source.id }))[cutAt]!.info.id
      const fork = yield* sessions.fork({ sessionID: source.id, messageID: cut })
      const tree = yield* ACPHistoryStore.roster(fork.id)
      expect(rosterCards(tree)).toEqual(yield* cards(fork.id))
      expect(rosterCards(tree)).toEqual([c1])
      expect(tree.rows.map((row) => row.id)).not.toContain(c2)
    }),
  )
})

describe("old forks (made before the link existed)", () => {
  /** Remove the link, as a fork made by 0.4.172 has none. */
  const unlink = Effect.fnUntraced(function* (id: SessionID) {
    const { db } = yield* Database.Service
    yield* db.run(sql`UPDATE session SET fork_session_id = NULL, fork_time = NULL WHERE id = ${id}`)
  })

  it.instance("finds the source from the task cards of its oldest page, bounded to one page", () =>
    Effect.gen(function* () {
      const f = yield* family()
      yield* unlink(f.fork)
      const tree = yield* ACPHistoryStore.roster(f.fork)
      expect(rosterCards(tree)).toEqual(yield* cards(f.fork))
      expect(tree.rows.map((row) => row.id)).not.toContain(f.late)
    }),
  )

  it.instance("a chat whose title is not a fork title is never scanned: its roster is its own", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const f = yield* family()
      yield* unlink(f.fork)
      yield* sessions.setTitle({ sessionID: f.fork, title: "renamed" })
      expect(rosterCards(yield* ACPHistoryStore.roster(f.fork))).toEqual([f.own])
    }),
  )
})

describe("a NEW connection reopening a fork", () => {
  it.instance("sends the full roster in the restore's roster notification", () =>
    Effect.gen(function* () {
      const f = yield* family()
      const context = yield* Effect.context<Database.Service>()
      const run = <A>(effect: Effect.Effect<A, never, Database.Service>) =>
        Effect.runPromise(effect.pipe(Effect.provide(context)))
      const reader = {
        countMessages: (id: string) => run(ACPHistoryStore.countMessages(id)),
        descendants: (id: string, limit?: number | null) => run(ACPHistoryStore.descendants(id, limit)),
        roster: (id: string) => run(ACPHistoryStore.roster(id)),
      } satisfies ACPHistoryStore.Reader
      const notes: { method: string; params: Record<string, unknown> }[] = []
      const sdk = {
        config: {
          providers: () => Promise.resolve({ data: { providers: [], default: {} } }),
          get: () => Promise.resolve({ data: {} }),
        },
        app: { agents: () => Promise.resolve({ data: [] }), skills: () => Promise.resolve({ data: [] }) },
        command: { list: () => Promise.resolve({ data: [] }) },
        session: {
          get: (input: { sessionID: string }) => Promise.resolve({ data: { id: input.sessionID, title: "source chat (fork #1)" } }),
          messages: () => Promise.resolve({ data: [] }),
          todo: () => Promise.resolve({ data: [] }),
          status: () => Promise.resolve({ data: {} }),
        },
        mcp: { add: () => Promise.resolve({ data: {} }) },
      } as unknown as OrigamiClient
      const service = ACPService.make({
        sdk,
        connection: {
          sessionUpdate: () => Promise.resolve(),
          extNotification: (method: string, params: Record<string, unknown>) => {
            notes.push({ method, params })
            return Promise.resolve()
          },
        } as never,
        history: reader,
      })

      yield* Effect.promise(() =>
        Effect.runPromise(service.loadSession({ cwd: "/workspace", sessionId: f.fork, mcpServers: [] })),
      )

      const roster = notes.find((note) => note.method === "origami/subagentRoster")?.params as
        | ACPHistory.SubagentRoster
        | undefined
      expect(roster?.sessionId).toBe(f.fork)
      expect(roster!.rows.filter((row) => row.depth === 1).map((row) => row.id).sort()).toEqual(yield* cards(f.fork))
    }),
  )
})
