// The FULL-STACK collab harness, extracted from flock-integration.test.ts so a
// second end-to-end test does not have to copy a 200-line layer graph.
//
// What it stubs and what it does not: the model is the in-process fake HTTP
// server (no paid model is ever contacted), and LSP / MCP / summarisation are
// stubbed because they are irrelevant to a room and expensive to stand up.
// EVERYTHING ELSE IS REAL - a real Agent registry reading real definition files,
// a real Session store, a real SessionPrompt, a real collab runner. That is the
// point: the seams these tests exercise (permission composition, model
// resolution, tool injection) only exist where those services meet.

import { ConfigV1 } from "@origami/core/v1/config/config"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { Effect, Layer } from "effect"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { CollabRunner } from "@/collab/runner"
import { CollabStore } from "@/collab/store"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { FSUtil } from "@origami/core/fs-util"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { MessageV2 } from "@/session/message-v2"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "@/question"
import { Ripgrep } from "@origami/core/ripgrep"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { SystemPrompt } from "@/session/system"
import { Todo } from "@/session/todo"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(LSP.Service, {
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
} as unknown as LSP.Interface)

const mcp = Layer.succeed(MCP.Service, {
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
} as unknown as MCP.Interface)

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const root = LayerNode.group([
  CollabRunner.node,
  CollabStore.node,
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
  testLLMServerNode,
])

/** The `it` every full-stack collab test runs on. */
export const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

/**
 * A provider whose only model points at the in-process fake server.
 *
 * `sees` is the CATALOG's claim about the model, which is a different thing
 * from an agent def's `vision:` - the provider transform swaps a file part for
 * an error line when the catalog says the model takes no image input.
 */
export const providerConfig = (url: string, sees = false): Partial<ConfigV1.Info> => ({
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
          attachment: sees,
          ...(sees ? { modalities: { input: ["text" as const, "image" as const] } } : {}),
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

/** Matches a request that carries one agent's own envelope. */
export const wroteFor = (slug: string) => (hit: { body: Record<string, unknown> }) =>
  JSON.stringify(hit.body).includes(`You are @${slug} `)

/** A collab agent def in the form the extension's seed installer writes. */
export const def = (description: string, persona: string, extra: readonly string[] = []) =>
  [
    "---",
    `description: "${description}"`,
    "mode: all",
    "hidden: true",
    "collab: true",
    "model: test/test-model",
    "steps: 8",
    ...extra,
    "permission:",
    '  "*": deny',
    "  read: allow",
    "---",
    "",
    persona,
    "",
  ].join("\n")
