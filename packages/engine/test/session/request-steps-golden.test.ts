// Every request of a long scripted chat, pinned (t-vs5p1y).
//
// The per-step request build of a big chat is being made cheaper (one
// construction of the native request, no span per message, prompt-capture
// hashing after the send, yields between phases). None of that may move a
// byte the provider receives, nor a value the prompt capture reports.
//
// This drives the REAL prompt loop against the fake provider through one
// script that covers: two tool-aging batches (one at a turn's first step, one
// at a half-window boundary inside a turn), a manual compaction and the turn
// after it, and a change of model in the middle of the chat. It records the
// SHA-256 of every request body, and the prefix and cache facts every
// step-finish part carries. The recording was made on master f9d49f6b70,
// before any of the changes; the script runs on the native runtime and on the
// AI SDK runtime.
//
// Record again (only when a byte change is intended and understood):
//   GOLDEN_RECORD=1 bun test test/session/request-steps-golden.test.ts

import { ConfigV1 } from "@origami/core/v1/config/config"
import { SessionV1 } from "@origami/core/v1/session"
import { expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Session } from "@/session/session"
import { FSUtil } from "@origami/core/fs-util"
import { SessionCompaction } from "@/session/compaction"
import { SessionPrompt } from "@/session/prompt"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { SessionToolAging } from "@/session/tool-aging"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { TestLLMServer, reply } from "../lib/llm-server"
import { compareGolden, compareGoldenValue, goldenIt, normalise } from "../lib/request-golden"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"

// The shell tool describes the shell from $SHELL; unset, so Git Bash and
// PowerShell runs send the same tool block.
delete process.env.SHELL

const GOLDEN_DIR = path.join(import.meta.dir, "fixtures", "request-steps-golden")
const A = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
const B = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model-b") }

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

const providerCfg = (url: string): Partial<ConfigV1.Info> => ({
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

// Fixed clock for the seeded history, so stored tool timings are part of the recording.
let clock = 1_700_000_000_000
const tick = () => (clock += 1000)
let fileIndex = 0

/** A user message and `count` completed reads of distinct files, one assistant message each. */
const seedReads = Effect.fn("stepsGolden.seedReads")(function* (sessionID: SessionID, root: string, count: number) {
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

const say = (sessionID: SessionID, text: string, ref = A) =>
  SessionPrompt.Service.use((prompt) => prompt.prompt({ sessionID, model: ref, parts: [{ type: "text", text }] }))

const AGED = "aged out — read again if needed"
const count = (text: string, needle: string) => text.split(needle).length - 1

/**
 * What the prompt capture measured, from every step-finish part. The digests
 * cover the raw text, which holds the temporary directory, so each distinct
 * digest is replaced by the order it first appeared in ("#0", "#1", ...): the
 * recording keeps which steps share a prefix and which do not. For the same
 * reason the byte offset of a divergence is left out; the message index stays.
 * `idleMs` is wall-clock time.
 */
const stepFacts = Effect.fn("stepsGolden.stepFacts")(function* (sessionID: SessionID) {
  const all = yield* MessageV2.stream(sessionID)
  const classes = new Map<string, string>()
  const cls = (value: string | undefined) => {
    if (value === undefined) return null
    if (!classes.has(value)) classes.set(value, `#${classes.size}`)
    return classes.get(value)!
  }
  return all
    .toReversed()
    .flatMap((msg) => msg.parts)
    .filter((part): part is SessionV1.StepFinishPart => part.type === "step-finish")
    .map((part) => {
      const { idleMs: _idle, divergence, ...cache } = (part.cache ?? {}) as Record<string, any>
      return {
        reason: part.reason,
        prefix: part.prefix
          ? { system: cls(part.prefix.system), tools: cls(part.prefix.tools), history: cls(part.prefix.history) }
          : null,
        cache: part.cache
          ? {
              ...cache,
              ...(divergence
                ? { divergence: { message: divergence.message, role: divergence.role, source: divergence.source } }
                : {}),
            }
          : null,
      }
    })
})

const script = (label: string) =>
  Effect.gen(function* () {
    SessionPromptCapture.reset()
    SessionToolAging.reset()
    clock = 1_700_000_000_000
    fileIndex = 0
    const { directory: dir } = yield* TestInstance
    const llm = yield* TestLLMServer
    yield* llm.reset
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(path.join(dir, "AGENTS.md"), "PROJECT RULE: answer briefly.")
    yield* fs.writeWithDirs(path.join(dir, "origami.json"), JSON.stringify({ ...providerCfg(llm.url) }))
    for (let index = 1; index <= 4; index++)
      yield* fs.writeWithDirs(path.join(dir, `live${index}.ts`), `export const live${index} = ${index}\n`)
    const sessions = yield* Session.Service
    const compaction = yield* SessionCompaction.Service
    const prompt = yield* SessionPrompt.Service
    const chat = yield* sessions.create({
      title: "Steps",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const usage = (input: number) => ({ input, output: 5, cached: 0 })

    // Turn 1: 40 seeded reads. The turn's first step is an aging boundary and
    // commits the first batch (the 22 reads outside the 18-result tail).
    yield* seedReads(chat.id, dir, 40)
    yield* llm.push(reply().tool("read", { filePath: path.join(dir, "live1.ts") }).usage(usage(1000)))
    yield* llm.push(reply().tool("read", { filePath: path.join(dir, "live2.ts") }).usage(usage(1000)))
    yield* llm.text("Turn one done.", { usage: usage(1000) })
    yield* say(chat.id, "Resume one.")

    // Turn 2: 15 more seeded reads leave 17 waiting (below the batch of 18), so
    // the first step commits nothing. Its reply reports a prompt past half the
    // window, so the next step is a boundary too, and the 18th waiting read
    // commits the second batch there.
    yield* seedReads(chat.id, dir, 15)
    yield* llm.push(reply().tool("read", { filePath: path.join(dir, "live3.ts") }).usage(usage(600_000)))
    yield* llm.push(reply().tool("read", { filePath: path.join(dir, "live4.ts") }).usage(usage(1000)))
    yield* llm.text("Turn two done.", { usage: usage(1000) })
    yield* say(chat.id, "Resume two.")

    // A manual compaction, then the turn after it. The reply carries reasoning,
    // which a later model change turns into text.
    yield* llm.text("Summary: the user read many source files.", { usage: usage(1000) })
    yield* compaction.create({ sessionID: chat.id, agent: "build", model: A, auto: false })
    yield* prompt.loop({ sessionID: chat.id })
    yield* llm.reason("Thinking about the summary.", { text: "After the summary.", usage: usage(1000) })
    yield* say(chat.id, "What did we read?")

    // A change of model in the middle of the chat.
    yield* llm.text("Model B here.", { usage: usage(1000) })
    yield* say(chat.id, "Now with the other model.", B)

    const hits = yield* llm.hits
    const bodies = hits
      .filter((hit) => !JSON.stringify(hit.body).includes("Generate a title"))
      .map((hit) => normalise(hit.raw, dir, /^1: export const value/))
    // The script really covers what it claims.
    // Turn 1 (0-2), turn 2 (3-5), the compaction (6), the turn after it (7),
    // the turn on the other model (8).
    expect(bodies.length).toBe(9)
    expect(count(bodies[0]!, AGED)).toBe(22)
    expect(count(bodies[3]!, AGED)).toBe(22)
    expect(count(bodies[4]!, AGED)).toBe(40)
    expect(bodies[7]).toContain("Summary: the user read many source files.")
    expect(bodies[8]).toContain('"model":"test-model-b"')
    expect(bodies[8]).toContain("Thinking about the summary.")
    compareGolden(GOLDEN_DIR, `${label}-bodies`, bodies)
    compareGoldenValue(GOLDEN_DIR, `${label}-step-facts`, yield* stepFacts(chat.id))
  })

goldenIt().instance("native runtime: every request and every capture fact is unchanged", () => script("native"), {
  git: true,
}, 120_000)

goldenIt({ nativeLlmFamilies: "none" }).instance(
  "AI SDK runtime: every request and every capture fact is unchanged",
  () => script("aisdk"),
  { git: true },
  120_000,
)
