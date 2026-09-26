// The real prompt loop against the fake provider, for tests that pin the exact
// request bytes (t-vs5p1y). Same layer and stubs as
// test/session/request-golden.test.ts, which keeps its own copy unchanged.

import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "path"
import { Agent as AgentSvc } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "@/env"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { FSUtil } from "@origami/core/fs-util"
import { SessionCompaction } from "@/session/compaction"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Skill } from "@/skill"
import { SystemPrompt } from "@/session/system"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Ripgrep } from "@origami/core/ripgrep"
import { Format } from "@/format"
import { testEffect } from "./effect"
import { TestLLMServer } from "./llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"

export const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

export const lsp = Layer.succeed(
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

export const mcp = Layer.succeed(
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

export const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

export const root = LayerNode.group([
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

/** A test runner over the real loop. `flags` are merged into the runtime flags. */
export function goldenIt(flags: Partial<RuntimeFlags.Info> = {}) {
  return testEffect(
    LayerNode.compile(root, [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, ...flags })],
    ]),
  )
}

export type Recording = { bytes: number; sha256: string }[]

/** The run-to-run differences of the same code, and nothing else: the
 *  temporary directory, today's date, and the wall-clock marker on a tool
 *  result that ran live in the test. */
export function normalise(raw: string, dir: string, seeded: RegExp) {
  const once = JSON.stringify(dir).slice(1, -1)
  // Raw, forward slashes, JSON-escaped, and escaped twice (a path inside tool
  // arguments, which are a JSON string inside the JSON body).
  const forms = new Set([dir, dir.replaceAll("\\", "/"), once, JSON.stringify(once).slice(1, -1)])
  let out = raw
  for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join("<DIR>")
  out = out.split(new Date().toDateString()).join("<DATE>")
  out = out.replace(/\[took \d+(?:\.\d)? s\]\\n/g, (match, offset: number) =>
    seeded.test(out.slice(offset + match.length, offset + match.length + 40)) ? match : "[took <T> s]\\n",
  )
  return out
}

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

/** Compare `bodies` with the recording `dir/name.json`; GOLDEN_RECORD=1 writes it. */
export function compareGolden(dir: string, name: string, bodies: string[]) {
  const file = path.join(dir, `${name}.json`)
  const current: Recording = bodies.map((body) => ({ bytes: Buffer.byteLength(body, "utf8"), sha256: hash(body) }))
  if (process.env.GOLDEN_RECORD) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(current, null, 2) + "\n")
  }
  const dump = path.join(os.tmpdir(), "origami-request-golden", name)
  const recorded = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Recording) : undefined
  const same = JSON.stringify(recorded) === JSON.stringify(current)
  if (!same || process.env.GOLDEN_DUMP) {
    mkdirSync(dump, { recursive: true })
    bodies.forEach((body, i) => writeFileSync(path.join(dump, `${i}.json`), body))
  }
  expect(current, `request bodies of "${name}" changed; dumped to ${dump}`).toEqual(recorded!)
}

/** Same, for any JSON value (the capture facts), recorded as text. */
export function compareGoldenValue(dir: string, name: string, value: unknown) {
  const file = path.join(dir, `${name}.json`)
  const text = JSON.stringify(value, null, 2) + "\n"
  if (process.env.GOLDEN_RECORD) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, text)
  }
  const recorded = existsSync(file) ? readFileSync(file, "utf8").replaceAll("\r\n", "\n") : undefined
  expect(text, `"${name}" changed`).toBe(recorded!)
}
