// The outbound request bytes, pinned (t-u54x6w).
//
// A provider's prompt cache matches the request body from byte 0, so a change
// that moves one byte of an already-sent prefix costs the owner a cache miss
// on every later step. The per-turn performance work in t-u54x6w (paged reads,
// a media validation cache, a cheaper prompt capture, a compaction without a
// full clone) must therefore leave every request byte-identical.
//
// This file drives the REAL prompt loop against the fake provider and compares
// the exact body the provider receives with a recording made on the code
// before that work (lane head dff7520381). Fixtures: several turns, a tool
// loop, screenshots (a user attachment and a tool attachment, one of each over
// 64 KiB), a compaction and the turn after it, and a revert and the turn after
// it.
//
// Only three things are normalised, and only because they differ between two
// runs of the SAME code: the temporary directory, today's date, and the
// wall-clock marker on a tool result that ran live in the test.
//
// Record again (only when a byte change is intended and understood):
//   GOLDEN_RECORD=1 bun test test/session/request-golden.test.ts

import { ConfigV1 } from "@origami/core/v1/config/config"
import { SessionV1 } from "@origami/core/v1/session"
import { Database } from "@origami/core/database/database"
import { LayerNode } from "@origami/core/effect/layer-node"
import { SessionProjector } from "@origami/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import zlib from "node:zlib"
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
import { SessionPromptCapture } from "@/session/prompt-capture"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Skill } from "@/skill"
import { SystemPrompt } from "@/session/system"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Ripgrep } from "@origami/core/ripgrep"
import { Format } from "@/format"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

// The shell tool describes the shell it will run, chosen from $SHELL (and
// remembered on first use). Unset, as the recording was made, so a run from
// Git Bash sends the same tool block as a run from PowerShell.
delete process.env.SHELL

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
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

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const root = LayerNode.group([
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

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

/** A model that takes images, so screenshots are sent and not replaced. */
const providerCfg = (url: string): Partial<ConfigV1.Info> => ({
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
          attachment: true,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 1_000_000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** A real PNG of deterministic noise (noise does not compress, so `side`
 *  sets the size), as a data URL: a stand-in screenshot the image
 *  normaliser can decode. */
function screenshot(side: number, seed: number) {
  const rows: Buffer[] = []
  let x = seed
  for (let y = 0; y < side; y++) {
    const row = Buffer.alloc(1 + side * 3)
    for (let i = 1; i < row.length; i++) {
      // xorshift32: noise deflate cannot shrink
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      row[i] = x & 0xff
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString("base64")}`
}

const SMALL = screenshot(12, 1)
const BIG = screenshot(170, 2)
const BIG_TOOL = screenshot(150, 3)

// Fixed clock for the seeded history, so stored tool timings are the same on
// every run and the elapsed marker they produce is part of the recording.
let clock = 1_700_000_000_000
const tick = () => (clock += 1000)

const seedUser = Effect.fn("golden.seedUser")(function* (
  sessionID: SessionID,
  text: string,
  files: { url: string; filename: string }[] = [],
) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: tick() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
  for (const file of files)
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "file",
      mime: "image/png",
      filename: file.filename,
      url: file.url,
    })
  return msg
})

const seedAssistant = Effect.fn("golden.seedAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
  body: { text: string; tool?: { callID: string; output: string; attachment?: string } },
) {
  const session = yield* Session.Service
  const created = tick()
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created, completed: tick() },
    finish: body.tool ? "tool-calls" : "stop",
  }
  yield* session.updateMessage(msg)
  yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "step-start" })
  yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text: body.text })
  if (body.tool) {
    const start = tick()
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "tool",
      callID: body.tool.callID,
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "shot.png" },
        output: body.tool.output,
        title: "shot.png",
        metadata: {},
        time: { start, end: start + 1250 },
        ...(body.tool.attachment
          ? {
              attachments: [
                {
                  id: PartID.ascending(),
                  sessionID,
                  messageID: msg.id,
                  type: "file" as const,
                  mime: "image/png",
                  filename: "shot.png",
                  url: body.tool.attachment,
                },
              ],
            }
          : {}),
      },
    })
  }
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "step-finish",
    reason: msg.finish!,
    tokens: msg.tokens,
    cost: 0,
  })
  return msg
})

/** A history with every shape the request builder handles: prose, a tool
 *  result with and without a screenshot, and user screenshots small and big. */
const seedHistory = Effect.fn("golden.seedHistory")(function* (sessionID: SessionID, root: string) {
  const u1 = yield* seedUser(sessionID, "Look at this screen and the logo.", [
    { url: SMALL, filename: "logo.png" },
    { url: BIG, filename: "screen.png" },
  ])
  const a1 = yield* seedAssistant(sessionID, u1.id, root, {
    text: "Reading the capture.",
    tool: { callID: "seed_read_1", output: "Image read successfully", attachment: BIG_TOOL },
  })
  yield* seedAssistant(sessionID, u1.id, root, { text: "The screen shows a login form." })
  void a1
  const u2 = yield* seedUser(sessionID, "Anything odd in the file list? Ünïcödé ✓ and a lone \ud800 surrogate.")
  yield* seedAssistant(sessionID, u2.id, root, {
    text: "Checking.",
    tool: { callID: "seed_read_2", output: "a.txt\nb.txt\n" },
  })
  yield* seedAssistant(sessionID, u2.id, root, { text: "Two files, nothing odd." })
})

type Recording = { bytes: number; sha256: string }[]

const GOLDEN_DIR = path.join(import.meta.dir, "fixtures", "request-golden")

/** The three run-to-run differences of the same code, and nothing else. */
function normalise(raw: string, dir: string) {
  const forms = new Set([dir, dir.replaceAll("\\", "/"), JSON.stringify(dir).slice(1, -1)])
  let out = raw
  for (const form of [...forms].sort((a, b) => b.length - a.length)) out = out.split(form).join("<DIR>")
  const today = new Date()
  out = out.split(today.toDateString()).join("<DATE>")
  // Live tool results only: the seeded history uses a fixed clock.
  out = out.replace(/\[took \d+(?:\.\d)? s\]\\n(?!Image read successfully|a\.txt)/g, "[took <T> s]\\n")
  return out
}

function compare(name: string, bodies: string[]) {
  const file = path.join(GOLDEN_DIR, `${name}.json`)
  const current: Recording = bodies.map((body) => ({
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body, "utf8").digest("hex"),
  }))
  if (process.env.GOLDEN_RECORD) {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(file, JSON.stringify(current, null, 2) + "\n")
  }
  // On a mismatch the bodies are written out so the two runs can be diffed.
  const dump = path.join(os.tmpdir(), "origami-request-golden", name)
  const recorded = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Recording) : undefined
  const same = JSON.stringify(recorded) === JSON.stringify(current)
  if (!same || process.env.GOLDEN_DUMP) {
    mkdirSync(dump, { recursive: true })
    bodies.forEach((body, i) => writeFileSync(path.join(dump, `${i}.json`), body))
  }
  expect(current, `request bodies of "${name}" changed; dumped to ${dump}`).toEqual(recorded!)
}

const nonTitle = (hits: { body: Record<string, unknown>; raw: string }[]) =>
  hits.filter((hit) => !JSON.stringify(hit.body).includes("Generate a title")).map((hit) => hit.raw)

const setup = Effect.fn("golden.setup")(function* () {
  SessionPromptCapture.reset()
  clock = 1_700_000_000_000
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* llm.reset
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(path.join(dir, "AGENTS.md"), "PROJECT RULE: answer briefly.")
  yield* fs.writeWithDirs(path.join(dir, "origami.json"), JSON.stringify({ ...providerCfg(llm.url) }))
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({
    title: "Pinned",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  yield* seedHistory(chat.id, dir)
  return { dir, llm, chat }
})

const say = (sessionID: SessionID, text: string, files: { url: string; filename: string }[] = []) =>
  SessionPrompt.Service.use((prompt) =>
    prompt.prompt({
      sessionID,
      parts: [
        { type: "text", text },
        ...files.map((file) => ({ type: "file" as const, mime: "image/png", filename: file.filename, url: file.url })),
      ],
    }),
  )

it.instance(
  "multi-turn with a tool loop and screenshots: the request bytes are unchanged",
  () =>
    Effect.gen(function* () {
      const { dir, llm, chat } = yield* setup()
      // Turn 1: a new screenshot, then a tool loop of two steps.
      yield* llm.tool("todowrite", { todos: [{ content: "inspect the form", status: "in_progress", priority: "high" }] })
      yield* llm.text("The form has two fields.")
      yield* say(chat.id, "And this one?", [{ url: screenshot(160, 4), filename: "second.png" }])
      // Turn 2: plain text.
      yield* llm.text("Done.")
      yield* say(chat.id, "Thanks, anything else?")
      const bodies = nonTitle(yield* llm.hits).map((raw) => normalise(raw, dir))
      expect(bodies.length).toBe(3)
      // The fixture really carries both kinds of screenshot and the tool loop.
      expect(bodies[0]).toContain(BIG.slice(22, 200))
      expect(bodies[0]).toContain(BIG_TOOL.slice(22, 200))
      expect(bodies[1]).toContain('"role":"tool"')
      compare("multi-turn-tools-screenshots", bodies)
    }),
  { git: true },
  60_000,
)

it.instance(
  "a compaction and the turn after it: the request bytes are unchanged",
  () =>
    Effect.gen(function* () {
      const { dir, llm, chat } = yield* setup()
      const compaction = yield* SessionCompaction.Service
      const prompt = yield* SessionPrompt.Service
      yield* llm.text("First reply.")
      yield* say(chat.id, "One more question before we compact.")
      // The /compact path: the marker message, then the loop runs it.
      yield* llm.text("Summary: the user inspected a login form and a file list.")
      yield* compaction.create({ sessionID: chat.id, agent: "build", model: ref, auto: false })
      yield* prompt.loop({ sessionID: chat.id })
      yield* llm.text("After the summary.")
      yield* say(chat.id, "What did we decide?")
      const bodies = nonTitle(yield* llm.hits).map((raw) => normalise(raw, dir))
      expect(bodies.length).toBe(3)
      // The compaction's own request, then the turn that reads its summary.
      expect(bodies[1]).toContain("anchored summary")
      expect(bodies[2]).toContain("Summary: the user inspected a login form")
      compare("compaction", bodies)
    }),
  { git: true },
  60_000,
)

it.instance(
  "a revert and the turn after it: the request bytes are unchanged",
  () =>
    Effect.gen(function* () {
      const { dir, llm, chat } = yield* setup()
      const revert = yield* SessionRevert.Service
      yield* llm.text("Reply A.")
      yield* say(chat.id, "Question A.")
      yield* llm.text("Reply B.")
      const b = yield* say(chat.id, "Question B, to be reverted.")
      yield* revert.revert({ sessionID: chat.id, messageID: (b.info as SessionV1.Assistant).parentID })
      yield* llm.text("Reply C.")
      yield* say(chat.id, "Question C, after the revert.")
      const bodies = nonTitle(yield* llm.hits).map((raw) => normalise(raw, dir))
      expect(bodies.length).toBe(3)
      expect(bodies[2]).not.toContain("to be reverted")
      compare("revert", bodies)
    }),
  { git: true },
  60_000,
)

// t-v4r3lw: a resumed turn must reuse the prefix the previous turn sent. The
// live trace (child ses_f2d31869bffe36xBN6c9R0S7oo) lost it at every resume
// once the child passed K tool results: tool-result aging stubbed the one or
// two results that had just left the tail, in the middle of the array.

/** `count` completed reads of distinct files, one assistant message each. */
const seedReads = Effect.fn("golden.seedReads")(function* (sessionID: SessionID, root: string, count: number) {
  const session = yield* Session.Service
  const user = yield* seedUser(sessionID, "Read the source files one by one and report.")
  for (let index = 1; index <= count; index++) {
    const created = tick()
    const msg = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID: user.id,
      time: { created, completed: tick() },
      finish: "tool-calls",
    })
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

/** Index of the first message two request bodies do not share. */
function firstDifferentMessage(before: { messages: unknown[] }, after: { messages: unknown[] }) {
  const shared = Math.min(before.messages.length, after.messages.length)
  for (let index = 0; index < shared; index++)
    if (JSON.stringify(before.messages[index]) !== JSON.stringify(after.messages[index])) return index
  return shared
}

it.instance(
  "a child past the aging window, resumed twice: each resume reuses the prefix already sent",
  () =>
    Effect.gen(function* () {
      const { dir, llm, chat } = yield* setup()
      const sessions = yield* Session.Service
      const fs = yield* FSUtil.Service
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Reader",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* seedReads(child.id, dir, 25)
      for (let index = 1; index <= 4; index++)
        yield* fs.writeWithDirs(path.join(dir, `live${index}.ts`), `export const live${index} = ${index}\n`)
      // Each resume runs two more reads, so the tool count keeps growing past K.
      for (const [turn, reads] of [
        ["one", [1, 2]],
        ["two", [3, 4]],
      ] as const) {
        for (const index of reads) yield* llm.tool("read", { filePath: path.join(dir, `live${index}.ts`) })
        yield* llm.text(`Turn ${turn} done.`)
        yield* say(child.id, `Resume ${turn}.`)
      }
      yield* llm.text("Turn three done.")
      yield* say(child.id, "Resume three.")
      const bodies = nonTitle(yield* llm.hits).map((raw) => JSON.parse(raw) as { messages: unknown[]; tools: unknown })
      // Three steps per resume with reads, then one: the resume boundaries are
      // request 2 -> 3 and request 5 -> 6.
      expect(bodies.length).toBe(7)
      for (const [last, first] of [
        [2, 3],
        [5, 6],
      ]) {
        expect(JSON.stringify(bodies[first].tools)).toBe(JSON.stringify(bodies[last].tools))
        // Every message the last request of a turn sent is sent again, unchanged,
        // at the front of the next turn's first request.
        expect(firstDifferentMessage(bodies[last], bodies[first])).toBe(bodies[last].messages.length)
      }
    }),
  { git: true },
  60_000,
)
