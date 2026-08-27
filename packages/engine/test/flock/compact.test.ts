import { describe, expect } from "bun:test"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { FSUtil } from "@origami/core/fs-util"
import { Ripgrep } from "@origami/core/ripgrep"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "@/question"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SystemPrompt } from "@/session/system"
import { Snapshot } from "@/snapshot"
import { Skill } from "@/skill"
import { Todo } from "@/session/todo"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { afterEach } from "bun:test"

afterEach(async () => {
  await disposeAllInstances()
})

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.mock(LSP.Service)({
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  hasClients: () => Effect.succeed(false),
  touchFile: () => Effect.void,
  diagnostics: () => Effect.succeed({}),
})

const mcp = Layer.mock(MCP.Service)({
  status: () => Effect.succeed({}),
  clients: () => Effect.succeed({}),
  instructions: () => Effect.succeed([]),
  tools: () => Effect.succeed({}),
  prompts: () => Effect.succeed({}),
  resources: () => Effect.succeed({}),
  resourceTemplates: () => Effect.succeed({}),
})

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const root = LayerNode.group([
  testLLMServerNode,
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const model = (id: string) => ({
  id,
  name: id,
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100_000, output: 10_000 },
  cost: { input: 0, output: 0 },
  options: {},
})

/**
 * One provider, three models, all served by the mock LLM endpoint. Which model
 * a request carries is therefore the only difference between them — exactly what
 * a routing test needs to read off the wire.
 */
const providerCfg = (url: string): Partial<ConfigV1.Info> => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": model("test-model"),
        "compact-primary": model("compact-primary"),
        "compact-spare": model("compact-spare"),
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

/** Binds the profile's ONE routing decision: which model subagent work runs on. */
const withFlock = (
  base: Partial<ConfigV1.Info>,
  subagents: { use: string; fallback?: string[] },
): Partial<ConfigV1.Info> => ({ ...base, flock: { profile: "p", profiles: { p: { subagents } } } })

/** A profile that is active but binds nothing — the D10 fallthrough case. */
const withEmptyFlock = (base: Partial<ConfigV1.Info>): Partial<ConfigV1.Info> => ({
  ...base,
  flock: { profile: "p", profiles: { p: { description: "binds nothing" } } },
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const writeConfig = Effect.fn("FlockCompactTest.writeConfig")(function* (config: (url: string) => object) {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(directory, "origami.json"),
    JSON.stringify({ ...config(llm.url) }),
  )
  return llm
})

const isTitle = (hit: { body: Record<string, unknown> }) =>
  JSON.stringify(hit.body).includes("Generate a title for this conversation")

/**
 * Drives one real turn on a session with a generated (default) title, which is
 * the only condition under which the engine generates one, and hands back the
 * models every title request actually went out on.
 */
const titleModels = Effect.fn("FlockCompactTest.titleModels")(function* () {
  const llm = yield* TestLLMServer
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
  yield* prompt.prompt({
    sessionID: chat.id,
    agent: "build",
    noReply: true,
    parts: [{ type: "text", text: "hello" }],
  })
  yield* llm.text("world")
  yield* prompt.loop({ sessionID: chat.id })
  const titles = yield* pollWithTimeout(
    Effect.gen(function* () {
      const seen = (yield* llm.hits).filter(isTitle)
      return seen.length ? seen : undefined
    }),
    "no title request was ever made",
    "5 seconds",
  )
  return { chat, models: titles.map((hit) => hit.body["model"]) }
})

describe("flock subagent binding — title generation", () => {
  it.instance("routes the title through the subagent binding when one is bound", () =>
    Effect.gen(function* () {
      yield* writeConfig((url) => withFlock(providerCfg(url), { use: "test/compact-primary" }))
      const { chat, models } = yield* titleModels()
      expect(models).toEqual(["compact-primary"])
      expect((yield* (yield* Session.Service).get(chat.id)).title).toBe("E2E Title")
    }),
  )

  it.instance("walks the subagent chain when the bound endpoint is sick", () =>
    Effect.gen(function* () {
      const llm = yield* writeConfig((url) =>
        withFlock(providerCfg(url), { use: "test/compact-primary", fallback: ["test/compact-spare"] }),
      )
      // A real 403 off a real endpoint, through the real provider stack — the
      // walk decision is made on whatever shape that actually produces.
      yield* llm.pushMatch(isTitle, { type: "http-error", status: 403, body: { error: "forbidden" } })
      const { chat, models } = yield* titleModels()
      expect(models).toEqual(["compact-primary", "compact-spare"])
      expect((yield* (yield* Session.Service).get(chat.id)).title).toBe("E2E Title")
    }),
  )

  it.instance("leaves the title on today's model when the profile binds nothing", () =>
    Effect.gen(function* () {
      yield* writeConfig((url) => withEmptyFlock(providerCfg(url)))
      const { models } = yield* titleModels()
      // Flock is ON, but this profile binds no model: `small_model` resolution
      // stands and the request goes out on the session's own model, as always.
      expect(models).toEqual(["test-model"])
    }),
  )

  it.instance("leaves the title on today's model with Flock off", () =>
    Effect.gen(function* () {
      yield* writeConfig(providerCfg)
      const { models } = yield* titleModels()
      expect(models).toEqual(["test-model"])
    }),
  )

  it.instance("falls back to today's model when no candidate exists (D10)", () =>
    Effect.gen(function* () {
      yield* writeConfig((url) => withFlock(providerCfg(url), { use: "ghost/one", fallback: ["ghost/two"] }))
      const { models } = yield* titleModels()
      expect(models).toEqual(["test-model"])
    }),
  )
})

const user = Effect.fn("FlockCompactTest.user")(function* (sessionID: SessionID, text: string) {
  const sessions = yield* Session.Service
  const msg = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
  return msg
})

/**
 * Runs one real compaction and reports the models it was actually attempted on,
 * read off the assistant messages compaction itself writes.
 */
const compactModels = Effect.fn("FlockCompactTest.compactModels")(function* () {
  const compaction = yield* SessionCompaction.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Pinned" })
  yield* user(chat.id, "first thing")
  const marker = yield* user(chat.id, "compact this")
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: marker.id,
    sessionID: chat.id,
    type: "compaction",
    auto: false,
  })
  const messages = yield* sessions.messages({ sessionID: chat.id })
  const result = yield* compaction.process({ parentID: marker.id, messages, sessionID: chat.id, auto: false })
  const after = yield* sessions.messages({ sessionID: chat.id })
  const attempts = after.filter(
    (item): item is SessionV1.WithParts & { info: SessionV1.Assistant } =>
      item.info.role === "assistant" && item.info.summary === true,
  )
  return {
    result,
    models: attempts.map((item) => item.info.modelID),
    errors: attempts.map((item) => item.info.error?.name),
  }
})

const isCompaction = (hit: { body: Record<string, unknown> }) => !isTitle(hit)

describe("flock subagent binding — compaction", () => {
  it.instance("routes compaction through the subagent binding when one is bound", () =>
    Effect.gen(function* () {
      const llm = yield* writeConfig((url) => withFlock(providerCfg(url), { use: "test/compact-primary" }))
      yield* llm.textMatch(isCompaction, "a summary")
      const run = yield* compactModels()
      expect(run.models).toEqual([ModelV2.ID.make("compact-primary")])
      expect(run.errors).toEqual([undefined])
    }),
  )

  it.instance("walks the subagent chain when the bound endpoint is sick", () =>
    Effect.gen(function* () {
      const llm = yield* writeConfig((url) =>
        withFlock(providerCfg(url), { use: "test/compact-primary", fallback: ["test/compact-spare"] }),
      )
      yield* llm.pushMatch(isCompaction, { type: "http-error", status: 403, body: { error: "forbidden" } })
      yield* llm.textMatch(isCompaction, "a summary")
      const run = yield* compactModels()
      // The failed attempt keeps its own message and its own error — an honest
      // trail — and the spare finishes the job.
      expect(run.models).toEqual([ModelV2.ID.make("compact-primary"), ModelV2.ID.make("compact-spare")])
      expect(run.errors).toEqual(["APIError", undefined])
    }),
  )

  it.instance("does not walk a failure the next binding would repeat", () =>
    Effect.gen(function* () {
      const llm = yield* writeConfig((url) =>
        withFlock(providerCfg(url), { use: "test/compact-primary", fallback: ["test/compact-spare"] }),
      )
      yield* llm.pushMatch(isCompaction, { type: "http-error", status: 400, body: { error: "bad request" } })
      const run = yield* compactModels()
      expect(run.models).toEqual([ModelV2.ID.make("compact-primary")])
      expect(run.result).toBe("stop")
    }),
  )

  it.instance("compacts on today's model when the profile binds nothing", () =>
    Effect.gen(function* () {
      const llm = yield* writeConfig((url) => withEmptyFlock(providerCfg(url)))
      yield* llm.textMatch(isCompaction, "a summary")
      const run = yield* compactModels()
      expect(run.models).toEqual([ref.modelID])
    }),
  )

  it.instance("compacts on today's model when no candidate exists (D10)", () =>
    Effect.gen(function* () {
      const llm = yield* writeConfig((url) => withFlock(providerCfg(url), { use: "ghost/one" }))
      yield* llm.textMatch(isCompaction, "a summary")
      const run = yield* compactModels()
      expect(run.models).toEqual([ref.modelID])
    }),
  )
})
