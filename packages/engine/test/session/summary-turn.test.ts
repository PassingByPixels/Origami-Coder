/**
 * t-tc1mhl: summary.diffs is written ONCE per turn, not at every step.
 *
 * Before: prompt.ts forked a summarize at step 1 and processor.ts forked one
 * at every step-finish, each rebuilding the turn's diff and journalling the
 * whole user message again (a 72.9 MB row was journalled 52 times on the
 * owner's store). Now `loop` summarizes when the turn ends, and an unchanged
 * diff is not written again.
 *
 * Also: a session that already stores whole-file diffs (written before this
 * change) still opens, still returns its diffs unchanged, and runs a new turn
 * with its history sent to the model.
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import path from "path"
import { like } from "drizzle-orm"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"
import { Snapshot } from "@/snapshot"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { EventTable } from "@origami/core/event/sql"
import { SessionProjector } from "@origami/core/session/projector"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
const it = testEffect(
  LayerNode.compile(root, [
    [MCP.node, mcp],
    [LSP.node, lsp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const providerCfg = (url: string) => ({
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

/** Journal rows (durable `message.updated` events) that carry a summary.diffs
 *  for this user message. */
const diffWrites = Effect.fn("Test.diffWrites")(function* (messageID: MessageID) {
  const { db } = yield* Database.Service
  const rows = yield* db.select().from(EventTable).where(like(EventTable.type, "message.updated%")).all().pipe(Effect.orDie)
  return rows.filter((row) => {
    const info = (row.data as { info?: SessionV1.Info }).info
    return info?.id === messageID && info.role === "user" && info.summary?.diffs !== undefined
  }).length
})

const firstUser = (sessionID: SessionID) =>
  MessageV2.filterCompactedEffect(sessionID).pipe(
    Effect.map((msgs) => msgs.find((m) => m.info.role === "user")!.info.id),
  )

/** summarize is forked at turn end: poll the stored diff. */
const settledDiff = Effect.fn("Test.settledDiff")(function* (sessionID: SessionID, messageID: MessageID) {
  const summary = yield* SessionSummary.Service
  let diff: Snapshot.FileDiff[] = []
  for (let i = 0; i < 50 && diff.length === 0; i++) {
    diff = yield* summary.diff({ sessionID, messageID })
    if (diff.length === 0) yield* Effect.sleep("100 millis")
  }
  // Any late write from a stray per-step fork would land in this window.
  yield* Effect.sleep("1 second")
  return diff
})

it.live("a multi-step turn writes summary.diffs once, and an unchanged diff is not written again", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const session = yield* sessions.create({
        title: "summary once per turn",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Three steps: two bash tool calls, then a text reply.
      yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("make two files"), "bash", {
        explanation: "first file",
        command: `echo one > ${path.join(dir, "one.txt")}`,
      })
      yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("first file"), "bash", {
        explanation: "second file",
        command: `echo two > ${path.join(dir, "two.txt")}`,
      })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("second file"), "done")

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "make two files" }],
      })
      yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(3)

      const userID = yield* firstUser(session.id)
      const diff = yield* settledDiff(session.id, userID)
      expect(diff.map((d) => d.file).sort()).toEqual(["one.txt", "two.txt"])
      // (Content is not asserted: `echo >` under Windows PowerShell 5.1 writes
      // UTF-16, which git reads as binary. The patch format has its own test,
      // test/snapshot/diff-format.test.ts.)
      expect(diff.map((d) => d.status)).toEqual(["added", "added"])
      expect(yield* diffWrites(userID)).toBe(1)

      // Same trees, same diff: no second journal row.
      yield* summary.summarize({ sessionID: session.id, messageID: userID })
      expect(yield* diffWrites(userID)).toBe(1)
    }),
    { git: true, config: providerCfg },
  ),
  60_000,
)

it.live("a session that stores old whole-file diffs still opens, keeps them, and runs a new turn", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const session = yield* sessions.create({
        title: "old diffs",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // The pre-t-tc1mhl shape: a whole-file patch (context = the whole file).
      const body = Array.from({ length: 3000 }, (_, i) => ` line ${i}`).join("\n")
      const oldDiffs = [
        {
          file: "big.ts",
          patch: `Index: big.ts\n===================================================================\n--- big.ts\t\n+++ big.ts\t\n@@ -1,3001 +1,3001 @@\n${body}\n-old\n+new\n`,
          additions: 1,
          deletions: 1,
          status: "modified" as const,
        },
        { file: "gone.ts", additions: 0, deletions: 4, status: "deleted" as const },
      ]
      const oldUser = MessageID.ascending()
      yield* sessions.updateMessage({
        id: oldUser,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        summary: { diffs: oldDiffs },
      } satisfies SessionV1.User)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: oldUser,
        type: "text",
        text: "an old question",
      })
      const oldAssistant = MessageID.ascending()
      yield* sessions.updateMessage({
        id: oldAssistant,
        sessionID: session.id,
        role: "assistant",
        time: { created: Date.now(), completed: Date.now() },
        parentID: oldUser,
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      } satisfies SessionV1.Assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: oldAssistant,
        type: "text",
        text: "an old answer",
      })

      // Opens: the load and the per-turn diff API both return the old diffs as stored.
      const loaded = yield* MessageV2.filterCompactedEffect(session.id)
      expect(loaded.map((m) => m.info.id)).toEqual([oldUser, oldAssistant])
      expect((loaded[0]!.info as SessionV1.User).summary?.diffs).toEqual(oldDiffs)
      expect(yield* summary.diff({ sessionID: session.id, messageID: oldUser })).toEqual(oldDiffs)

      // Replays: a new turn sends the old history to the model.
      yield* llm.textMatch(
        (hit) => JSON.stringify(hit.body).includes("an old answer") && JSON.stringify(hit.body).includes("a new question"),
        "a new answer",
      )
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "a new question" }],
      })
      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.misses).toEqual([])

      // The new turn's summarize touches only the new turn.
      yield* Effect.sleep("1 second")
      expect(yield* summary.diff({ sessionID: session.id, messageID: oldUser })).toEqual(oldDiffs)
      expect(yield* diffWrites(oldUser)).toBe(1)
    }),
    { git: true, config: providerCfg },
  ),
  60_000,
)
