// origami_change (t-xsufpe): the plan exit nudge and the review-as-plan turn,
// on the REAL loop, with native plan mode on as in the acp engine. Owner UAT
// 0.4.178: the model wrote the plan as chat text and the review never started.
// Own file: a second RuntimeFlags variant inside prompt.test.ts made its
// cancel/shell timing tests time out. Harness copied from prompt.test.ts.
import { ConfigV1 } from "@origami/core/v1/config/config"
import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import path from "path"
import { readFileSync } from "node:fs"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPlanExitNudge } from "@/session/plan-exit-nudge"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@origami/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Ripgrep } from "@origami/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

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

function makeMcp(instructions: MCP.ServerInstructions[] = []) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(instructions),
      tools: () => Effect.succeed({}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

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

const processorCreateStarted: Array<() => void> = []
const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
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

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "origami.json"),
    JSON.stringify({ ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// ---------------------------------------------------------------------------
// origami_change-start (t-xsufpe): the plan exit nudge, on the REAL loop, with
// native plan mode on as in the acp engine. Owner UAT 0.4.178: the model wrote
// the plan as chat text and the plan review never started.
// ---------------------------------------------------------------------------

const planIt = testEffect(
  LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, experimentalPlanMode: true, client: "acp" })],
  ]),
)

const planNudgeParts = (msgs: SessionV1.WithParts[]) =>
  msgs
    .flatMap((msg) => msg.parts)
    .filter(
      (part): part is SessionV1.TextPart =>
        part.type === "text" && part.metadata?.[SessionPlanExitNudge.METADATA_KEY] !== undefined,
    )

const planChat = Effect.fn("test.planChat")(function* () {
  const sessions = yield* Session.Service
  return yield* sessions.create({ title: "Plan", permission: [{ permission: "*", pattern: "*", action: "allow" }] })
})

const planTurn = (prompt: SessionPrompt.Interface, sessionID: SessionID, agent = "plan") =>
  prompt.prompt({ sessionID, agent, model: ref, parts: [{ type: "text", text: "give me a plan for a road trip" }] })

planIt.instance("a plan turn that ends in text gets ONE nudge, then plan_exit opens the review", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const question = yield* Question.Service
    const chat = yield* planChat()

    yield* llm.text("Day 1: Amsterdam to Cologne. Day 2: Cologne to Munich.")
    yield* llm.tool("plan_exit", {})
    yield* llm.text("Staying in plan mode.")

    const fiber = yield* planTurn(prompt, chat.id).pipe(Effect.forkChild)
    const asked = yield* pollWithTimeout(
      question.list().pipe(Effect.map((all) => all.find((req) => req.questions[0]?.header === "Build Agent"))),
      "plan_exit review question",
      "20 seconds",
    )
    yield* question.reply({ requestID: asked.id, answers: [["No"]] })
    yield* Fiber.join(fiber).pipe(Effect.ignore)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const nudges = planNudgeParts(msgs)
    expect(nudges).toHaveLength(1)
    expect(nudges[0]?.synthetic).toBe(true)
    expect(nudges[0]?.text).toContain("call plan_exit")

    // The nudge is a new turn at the end: the request before it is the exact
    // head of the nudged request.
    type Body = { messages: unknown[]; tools?: unknown }
    const hits = yield* llm.hits
    const before = hits[0]!.body as Body
    const after = hits[1]!.body as Body
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools))
    expect(JSON.stringify(after.tools)).toContain("plan_exit")
    expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages))
  }),
  40_000,
)

planIt.instance("a plan turn that stops in text again after the nudge is not nudged a second time", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const chat = yield* planChat()

    yield* llm.text("Plan: drive.")
    yield* llm.text("Plan: drive, again.")
    yield* llm.text("never asked for")
    yield* planTurn(prompt, chat.id)

    expect(yield* llm.calls).toBe(2)
    expect(planNudgeParts(yield* MessageV2.filterCompactedEffect(chat.id))).toHaveLength(SessionPlanExitNudge.LIMIT)
  }),
  30_000,
)

// The shell's "Review as plan" action (packages/vscode reviewAsPlan.ts) sends
// the answer back with "write it to the plan file, then call plan_exit". A model
// that follows the tool contract gets the plan file and the review from it.
planIt.instance("the review-as-plan turn writes the plan file and opens the plan_exit review", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const question = yield* Question.Service
    const chat = yield* planChat()
    const plan = Session.plan(chat, yield* InstanceState.context)
    const PLAN_TEXT = "Day 1: Amsterdam to Cologne."

    yield* llm.tool("write", { filePath: plan, content: PLAN_TEXT })
    yield* llm.tool("plan_exit", {})
    yield* llm.text("Staying in plan mode.")

    const fiber = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "plan",
        model: ref,
        parts: [{ type: "text", text: `Turn your previous answer into the plan document ... <plan>
${PLAN_TEXT}
</plan>` }],
      })
      .pipe(Effect.forkChild)
    const asked = yield* pollWithTimeout(
      question.list().pipe(Effect.map((all) => all.find((req) => req.questions[0]?.header === "Build Agent"))),
      "plan_exit review question",
      "20 seconds",
    )
    expect(readFileSync(plan, "utf8")).toBe(PLAN_TEXT)
    expect(asked.questions[0]?.options.map((option) => option.label)).toEqual(["Yes", "No", "Revise"])
    yield* question.reply({ requestID: asked.id, answers: [["No"]] })
    yield* Fiber.join(fiber).pipe(Effect.ignore)
    // The turn called plan_exit, so the nudge stays out of it.
    expect(planNudgeParts(yield* MessageV2.filterCompactedEffect(chat.id))).toHaveLength(0)
  }),
  40_000,
)

planIt.instance("a build turn that ends in text is not nudged", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const chat = yield* planChat()

    yield* llm.text("Done.")
    yield* planTurn(prompt, chat.id, "build")

    expect(yield* llm.calls).toBe(1)
    expect(planNudgeParts(yield* MessageV2.filterCompactedEffect(chat.id))).toHaveLength(0)
  }),
  30_000,
)
// origami_change-end
