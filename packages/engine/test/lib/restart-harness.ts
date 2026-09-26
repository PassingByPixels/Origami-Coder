// An engine process restart, in one test process (t-w2qb1x).
//
// Every "process" is a fresh runtime built from the golden layer (the real
// prompt loop, request-golden.ts), with its own instance store. What a real
// restart keeps is shared across them and nothing else: the SQLite database
// (one `Database.Service` value, built once, outside every runtime), the
// working directory, and the fake provider. What a real restart loses is lost:
// the runtime's scope is closed, which drops every layer-scoped store (the
// `tool_search` loaded set, config and skill snapshots, the instance), and
// `EngineProcessMemory.resetForTest()` empties every module-level store.
//
// A second file database is not an option here: `Flag.ORIGAMI_DB` is read once
// at import, so one `:memory:` connection that outlives the runtimes is the
// shared disk.

import { Database } from "@origami/core/database/database"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { SessionV1 } from "@origami/core/v1/session"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { Context, Effect, Exit, Layer } from "effect"
import * as Scope from "effect/Scope"
import * as TestConsole from "effect/testing/TestConsole"
import path from "path"
import { EngineProcessMemory } from "@/engine-process-memory"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { ToolSearch } from "@/tool/tool-search"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { SessionSummary } from "@/session/summary"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { FSUtil } from "@origami/core/fs-util"
import { provideInstanceEffect, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer, reply } from "./llm-server"
import { lsp, mcp as emptyMcp, normalise, root, summary, testLLMServerNode } from "./request-golden"

export const A = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
export const B = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model-b") }

const model = (id: string, name: string) => ({
  id,
  name,
  attachment: true,
  reasoning: true,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  modalities: { input: ["text", "image"] as ("text" | "image")[], output: ["text"] as "text"[] },
  limit: { context: 1_000_000, output: 10000 },
  cost: { input: 0, output: 0 },
  options: {},
})

/** The provider block of request-steps-golden.test.ts. */
export const providerCfg = (url: string): Partial<ConfigV1.Info> => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: { "test-model": model("test-model", "Test Model"), "test-model-b": model("test-model-b", "Test Model B") },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

/** What one segment of a run can use: the working directory, the fake provider,
 *  and a slot for ids that later segments (in another runtime) need. */
export type Ctx = {
  readonly dir: string
  readonly llm: TestLLMServer["Service"]
  readonly ids: Map<string, SessionID>
}

// The segment bodies need the golden runtime's services; the harness provides
// them. Typed loosely on purpose: the requirement set is the whole root.
export type Segment = (ctx: Ctx) => Effect.Effect<void, unknown, any>

export type Run = {
  /** Every request body the fake provider received, title requests left out,
   *  normalised with the golden rules (temporary directory, today's date). */
  readonly bodies: string[]
  /** How many runtimes ("processes") the run built. */
  readonly processes: number
}

/**
 * Run `segments` in order. After segment `i`, if `restartAfter(i)`, the runtime
 * is stopped and every process store emptied; the next segment starts in a new
 * runtime over the same database. `between(i)` runs after segment `i` either
 * way (a clock change, for example).
 */
export function runProcesses(input: {
  readonly flags?: Partial<RuntimeFlags.Info>
  readonly mcp?: Layer.Layer<MCP.Service>
  readonly segments: readonly Segment[]
  readonly restartAfter: (index: number) => boolean
  readonly between?: (index: number) => void
}): Promise<Run> {
  return Effect.gen(function* () {
    EngineProcessMemory.resetForTest()
    const outer = yield* Scope.Scope
    const db = Context.get(yield* Layer.buildWithScope(Database.layerFromPath(":memory:"), outer), Database.Service)
    const llm = Context.get(yield* Layer.buildWithScope(TestLLMServer.layer, outer), TestLLMServer)
    const dir = yield* tmpdirScoped({ git: true })

    const runtime = () =>
      Layer.mergeAll(
        LayerNode.compile(LayerNode.group([root, ToolSearch.node]), [
          [SessionSummary.node, summary],
          [LSP.node, lsp],
          [MCP.node, input.mcp ?? emptyMcp],
          [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, ...input.flags })],
          [Database.node, Layer.succeed(Database.Service, db)],
          [testLLMServerNode, Layer.succeed(TestLLMServer, llm)],
        ]),
        testInstanceStoreLayer,
        TestConsole.layer,
      )

    const ctx: Ctx = { dir, llm, ids: new Map() }
    let processes = 0
    let live: { scope: Scope.Closeable; context: Context.Context<any> } | undefined
    for (const [index, segment] of input.segments.entries()) {
      if (!live) {
        const scope = yield* Scope.make()
        live = { scope, context: yield* Layer.buildWithScope(runtime(), scope) }
        processes++
      }
      yield* segment(ctx).pipe(provideInstanceEffect(dir), Effect.provide(live.context))
      if (input.restartAfter(index)) {
        yield* Scope.close(live.scope, Exit.void)
        live = undefined
        EngineProcessMemory.resetForTest()
      }
      input.between?.(index)
    }
    if (live) yield* Scope.close(live.scope, Exit.void)

    const bodies = (yield* llm.hits)
      .filter((hit) => !JSON.stringify(hit.body).includes("Generate a title"))
      .map((hit) => normalise(hit.raw, dir, /^1: export const value/))
    return { bodies, processes }
  }).pipe(
    Effect.scoped,
    Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)),
    Effect.runPromise,
  ) as Promise<Run>
}

// ---------------------------------------------------------------------------
// The request-steps-golden script, cut at its turn boundaries.
// ---------------------------------------------------------------------------

let clock = 1_700_000_000_000
const tick = () => (clock += 1000)
let fileIndex = 0

/** A user message and `count` completed reads of distinct files, one assistant
 *  message each. The same seed as request-steps-golden.test.ts. */
export const seedReads = Effect.fn("restartHarness.seedReads")(function* (
  sessionID: SessionID,
  root: string,
  count: number,
) {
  const session = yield* Session.Service
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: A,
    time: { created: tick() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID,
    type: "text",
    text: "Read the source files one by one and report.",
  })
  for (let n = 0; n < count; n++) {
    const index = ++fileIndex
    const msg: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: A.modelID,
      providerID: A.providerID,
      parentID: user.id,
      time: { created: tick(), completed: tick() },
      finish: "tool-calls",
    }
    yield* session.updateMessage(msg)
    const start = tick()
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "tool",
      callID: `seed_read_${index}`,
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: `src/file${index}.ts` },
        output: Array.from({ length: 40 }, (_, line) => `${line + 1}: export const value${index}_${line} = ${line}`).join(
          "\n",
        ),
        title: `src/file${index}.ts`,
        metadata: {},
        time: { start, end: start + 1250 },
      },
    })
  }
})

export const say = (sessionID: SessionID, text: string, ref = A) =>
  SessionPrompt.Service.use((prompt) => prompt.prompt({ sessionID, model: ref, parts: [{ type: "text", text }] }))

export const usage = (input: number) => ({ input, output: 5, cached: 0 })

/** Writes the project files and creates the chat. Part of the first segment. */
export const setup = (ctx: Ctx, key: string) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(path.join(ctx.dir, "AGENTS.md"), "PROJECT RULE: answer briefly.")
    yield* fs.writeWithDirs(path.join(ctx.dir, "origami.json"), JSON.stringify({ ...providerCfg(ctx.llm.url) }))
    for (let index = 1; index <= 4; index++)
      yield* fs.writeWithDirs(path.join(ctx.dir, `live${index}.ts`), `export const live${index} = ${index}\n`)
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Steps",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    ctx.ids.set(key, chat.id)
  })

/** The five turns of request-steps-golden.test.ts, one segment each: turn 1,
 *  turn 2, the manual compaction, the turn after it, the turn on model B. */
export function stepsScript(): Segment[] {
  clock = 1_700_000_000_000
  fileIndex = 0
  const chat = (ctx: Ctx) => ctx.ids.get("chat")!
  return [
    (ctx) =>
      Effect.gen(function* () {
        yield* setup(ctx, "chat")
        yield* seedReads(chat(ctx), ctx.dir, 40)
        yield* ctx.llm.push(reply().tool("read", { filePath: path.join(ctx.dir, "live1.ts") }).usage(usage(1000)))
        yield* ctx.llm.push(reply().tool("read", { filePath: path.join(ctx.dir, "live2.ts") }).usage(usage(1000)))
        yield* ctx.llm.text("Turn one done.", { usage: usage(1000) })
        yield* say(chat(ctx), "Resume one.")
      }),
    (ctx) =>
      Effect.gen(function* () {
        yield* seedReads(chat(ctx), ctx.dir, 15)
        yield* ctx.llm.push(reply().tool("read", { filePath: path.join(ctx.dir, "live3.ts") }).usage(usage(600_000)))
        yield* ctx.llm.push(reply().tool("read", { filePath: path.join(ctx.dir, "live4.ts") }).usage(usage(1000)))
        yield* ctx.llm.text("Turn two done.", { usage: usage(1000) })
        yield* say(chat(ctx), "Resume two.")
      }),
    (ctx) =>
      Effect.gen(function* () {
        yield* ctx.llm.text("Summary: the user read many source files.", { usage: usage(1000) })
        const compaction = yield* SessionCompaction.Service
        yield* compaction.create({ sessionID: chat(ctx), agent: "build", model: A, auto: false })
        yield* SessionPrompt.Service.use((prompt) => prompt.loop({ sessionID: chat(ctx) }))
      }),
    (ctx) =>
      Effect.gen(function* () {
        yield* ctx.llm.reason("Thinking about the summary.", { text: "After the summary.", usage: usage(1000) })
        yield* say(chat(ctx), "What did we read?")
      }),
    (ctx) =>
      Effect.gen(function* () {
        yield* ctx.llm.text("Model B here.", { usage: usage(1000) })
        yield* say(chat(ctx), "Now with the other model.", B)
      }),
  ]
}

export const AGED = "aged out — read again if needed"
export const count = (text: string, needle: string) => text.split(needle).length - 1
