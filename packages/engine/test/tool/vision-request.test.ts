// t-kgtr6c round 4 — `vision_request` is a DIRECT ONE-SHOT COMPLETION.
//
// Rounds 1-3 built it as a stripped-down task tool: a child session, driven
// through `ops.prompt`, with the profile resolved against the live agent
// registry. The round-4 session export shows what that cost — `vision-qwen.md`
// sitting on disk while the tool answered "there is no agent by that name any
// more", because the registry is built at engine start and rebuilt only by the
// collab paths.
//
// So these tests pin the SHAPE of the one request the tool now makes, and the
// absence of everything it used to build around it:
//
//  - one completion, not a session. The model is a MockLanguageModelV3 that
//    records every call, and a Session service is provided that dies on any
//    method — a reintroduced `sessions.create` is a red test, not a silent
//    regression.
//  - the system prompt is the profile's own instruction with the describe floor
//    UNDER it, so the guarantee survives whatever the user wrote in the file.
//  - the question and the pixels ride ONE user message.
//  - every failure is a tool RESULT, so the parent turn survives and can answer
//    without the image.
//
// The profile fixture is a real file in the format the Agents pane writes
// (frontmatter + persona body), read through the same `ConfigMarkdown.parse`
// the engine uses, rather than an invented shape.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { MockLanguageModelV3 } from "ai/test"
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type { SessionV1 } from "@origami/core/v1/session"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Agent } from "@/agent/agent"
import { InstanceRef } from "@/effect/instance-ref"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { VisionRequest } from "../../src/tool/vision-request"
import { ProviderTest } from "../fake/provider"

const INSTRUCTION = "You are Qwen. You are the eyes for another agent."

/** A profile file exactly as `serializeAgentDef` writes one. */
const PROFILE_FILE = [
  "---",
  'description: "Vision"',
  "mode: all",
  "hidden: true",
  "vision-profile: true",
  "model: lmstudio/qwen3-vl",
  "vision: true",
  "steps: 25",
  "---",
  "",
  INSTRUCTION,
  "",
].join("\n")

const image = (override: Partial<SessionV1.FilePart> = {}): SessionV1.FilePart => ({
  id: PartID.make("prt_image"),
  sessionID: SessionID.make("ses_vision"),
  messageID: MessageID.make("msg_vision"),
  type: "file",
  mime: "image/png",
  filename: "shot.png",
  url: "data:image/png;base64,iVBORw0KGgo=",
  ...override,
})

// ---------------------------------------------------------------------------
// The request, as a pure value.
// ---------------------------------------------------------------------------

describe("the one request the tool builds", () => {
  const built = VisionRequest.buildRequest({
    question: "what does the error dialog say",
    instruction: INSTRUCTION,
    images: [image(), image({ id: PartID.make("prt_image2"), filename: "second.png", mime: "image/jpeg" })],
  })

  test("the profile's instruction comes first and the describe floor sits under it", () => {
    // Order is the point: the user's file is the persona, the floor is the
    // guarantee that has to survive whatever they wrote in it.
    expect(built.system).toBe(`${INSTRUCTION}\n\n${VisionRequest.DESCRIBE_PERSONA}`)
  })

  test("a profile with no instruction body still carries the floor, with no blank lead", () => {
    const bare = VisionRequest.buildRequest({ question: "q", instruction: "   ", images: [image()] })
    expect(bare.system).toBe(VisionRequest.DESCRIBE_PERSONA)
  })

  test("the question and every image ride ONE user message, question first", () => {
    // Split across two messages, a model with more than one image attached
    // routinely answers about the wrong one.
    expect(built.messages).toHaveLength(1)
    expect(built.messages[0]!.role).toBe("user")
    const content = built.messages[0]!.content as Array<Record<string, unknown>>
    expect(content).toHaveLength(3)
    expect(content[0]).toEqual({ type: "text", text: "what does the error dialog say" })
    expect(content[1]).toEqual({
      type: "file",
      data: "data:image/png;base64,iVBORw0KGgo=",
      mediaType: "image/png",
      filename: "shot.png",
    })
    expect(content[2]!.mediaType).toBe("image/jpeg")
  })

  test("an image with no filename does not invent one", () => {
    const anon = VisionRequest.buildRequest({
      question: "q",
      instruction: "",
      images: [image({ filename: undefined })],
    })
    const part = (anon.messages[0]!.content as Array<Record<string, unknown>>)[1]!
    expect(part).not.toHaveProperty("filename")
  })
})

// ---------------------------------------------------------------------------
// The describe floor (round 3), now asserted where it lives.
// ---------------------------------------------------------------------------

describe("the describe floor asks for a description, in detail", () => {
  const text = VisionRequest.DESCRIBE_PERSONA

  test("it names the specifics that make a description usable to a blind model", () => {
    for (const phrase of ["layout", "verbatim", "colours", "counts", "in relation to"]) {
      expect(text, `the floor never mentions "${phrase}"`).toContain(phrase)
    }
  })

  test("it demands the unreadable parts be named rather than guessed", () => {
    // A confident guess is indistinguishable from a good answer once the
    // picture has been reduced to text — the asking model cannot check it.
    expect(text).toContain("unreadable")
    expect(text).toContain("rather than guessing")
  })

  test("it still forbids tools and follow-up questions — nobody is there to answer", () => {
    expect(text).toContain("Do not use tools")
    expect(text).toContain("single exchange")
  })

  test("none of the review vocabulary appears anywhere in it", () => {
    // The round-2 defect, stated as an absence.
    for (const word of ["review", "critique", "suggest", "improve", "recommend"]) {
      expect(text.toLowerCase(), `the floor uses review language: "${word}"`).not.toContain(word)
    }
  })

  test("and it says plainly what it wants instead", () => {
    expect(text).toContain("do not judge it")
  })
})

// ---------------------------------------------------------------------------
// The tool, end to end, over a recorded model.
// ---------------------------------------------------------------------------

let dir = ""
let profilePath = ""

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-request-"))
  profilePath = path.join(dir, "vision-qwen.md")
  await fs.writeFile(profilePath, PROFILE_FILE, "utf8")
})

afterAll(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

const AGENT: Agent.Info = { name: "build", mode: "all", permission: [], options: {} }

/** An Agent service that answers only the two questions the wrapper and the
 *  tool actually ask. Anything else dies loudly rather than answering an
 *  invented value. */
function agentService(definitionFile: string | undefined) {
  const unused = (name: string) => Effect.die(new Error(`agentService.${name} not configured`))
  return Agent.Service.of({
    get: () => Effect.succeed(AGENT),
    list: () => Effect.succeed([AGENT]),
    rescan: () => unused("rescan") as Effect.Effect<void>,
    definitionFile: () => Effect.succeed(definitionFile),
    defaultInfo: () => unused("defaultInfo") as Effect.Effect<Agent.Info>,
    defaultAgent: () => unused("defaultAgent") as Effect.Effect<string>,
    generate: () => unused("generate") as never,
  })
}

const truncateService = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: (text: string) => Effect.succeed(text),
  output: (text: string) => Effect.succeed({ content: text, truncated: false } as const),
  limits: () => Effect.succeed({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES }),
})

/**
 * A Session service where EVERY method is a defect, plus the record of which
 * ones were reached.
 *
 * This is the round-4 guard with teeth: the tool no longer takes the session
 * store, so a reintroduced `sessions.create` would have to reach for this, and
 * the call both records itself and kills the test.
 */
function sessionSpy() {
  const calls: string[] = []
  const service = new Proxy({} as Session.Interface, {
    get(_target, key) {
      if (typeof key !== "string") return undefined
      return (...args: unknown[]) => {
        calls.push(key)
        void args
        return Effect.die(new Error(`vision_request must not call Session.${key}`))
      }
    },
  })
  return { calls, service }
}

/** Every `ctx.ask` the tool raised, so a test can assert the external-directory
 *  bar went up on the PARENT's context rather than nowhere. */
let asks: { permission: string; patterns: readonly string[]; metadata: Record<string, unknown> }[] = []

const ctx = (callID?: string): Tool.Context => ({
  sessionID: SessionID.make("ses_vision-test"),
  messageID: MessageID.make("msg_vision-test"),
  callID,
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (req) =>
    Effect.sync(() => {
      asks.push({ permission: req.permission, patterns: req.patterns, metadata: req.metadata })
    }),
})

interface RunOptions {
  definitionFile?: string | undefined
  language?: LanguageModelV3
  images?: readonly SessionV1.FilePart[]
  profile?: string
  /** Args beyond `question`, i.e. the round-5 `paths`. */
  paths?: readonly string[]
  /** Make the provider layer DIE on getLanguage, the way an unconfigured
   *  provider or an unloadable SDK does. */
  languageDies?: boolean
}

/**
 * Build the tool with fakes, execute it once per entry in `callIDs`, and hand
 * back the results plus the session methods the tool reached for.
 *
 * ONE tool instance across the calls on purpose: the retry memo lives on that
 * instance, so re-running the same `callID` is only a real re-drive if it goes
 * through the same built tool.
 */
async function runMany(question: string, callIDs: readonly (string | undefined)[], options: RunOptions = {}) {
  asks = []
  const spy = sessionSpy()
  const model = ProviderTest.model({ id: ModelV2.ID.make("qwen3-vl"), providerID: ProviderV2.ID.make("lmstudio") })
  const language = options.language ?? new MockLanguageModelV3({ doGenerate: async () => generated("ok") })
  const provider = Provider.Service.of({
    ...ProviderTest.registry([model]),
    getLanguage: () =>
      options.languageDies
        ? Effect.die(new Error("lmstudio is not running"))
        : Effect.succeed(language),
  })

  const results = await Effect.runPromise(
    VisionRequest.defs({
      profile: options.profile ?? "vision-qwen",
      images: options.images ?? [image()],
    }).pipe(
      Effect.flatMap((tools) =>
        Effect.forEach(
          callIDs,
          (callID) =>
            tools[0]!.execute({ question, ...(options.paths ? { paths: options.paths } : {}) }, ctx(callID)),
          { concurrency: 1 },
        ),
      ),
      Effect.provideService(Agent.Service, agentService("definitionFile" in options ? options.definitionFile : profilePath)),
      Effect.provideService(Truncate.Service, truncateService),
      Effect.provideService(Provider.Service, provider),
      Effect.provideService(Session.Service, spy.service),
      // The external-directory gate reads the project boundary off InstanceRef.
      // A directory that holds NONE of the fixture files is the point: every
      // path a test passes is external, so the ask always has to fire.
      Effect.provideService(InstanceRef, {
        directory: path.join(os.tmpdir(), "vision-request-not-here"),
        worktree: path.join(os.tmpdir(), "vision-request-not-here"),
        project: {} as never,
      }),
    ),
  )
  return { results, sessionCalls: spy.calls }
}

async function run(question: string, options: RunOptions = {}) {
  const { results, sessionCalls } = await runMany(question, [undefined], options)
  return { result: results[0]!, sessionCalls }
}

function generated(text: string) {
  return {
    content: text ? [{ type: "text" as const, text }] : [],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }
}

/** The system text of a recorded call, whatever role encoding it took. */
function systemOf(call: LanguageModelV3CallOptions): string {
  return call.prompt
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n")
}

describe("one completion, and nothing else", () => {
  test("it sends exactly ONE request, and returns the model's words as the tool output", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("A red error dialog reading E_FAIL.") })
    const { result, sessionCalls } = await run("what does the dialog say", { language: model })

    expect(model.doGenerateCalls).toHaveLength(1)
    expect(result.output).toBe("A red error dialog reading E_FAIL.")
    expect(result.metadata.refused).toBeUndefined()
    expect(result.metadata.model).toBe("lmstudio/qwen3-vl")
    // No `attachments` — that field is the only route pixels have back into the
    // parent's context.
    expect(result.attachments).toBeUndefined()
    expect(sessionCalls).toEqual([])
  })

  test("the request carries the profile's instruction over the describe floor", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("ok") })
    await run("what does the dialog say", { language: model })

    const system = systemOf(model.doGenerateCalls[0]!)
    expect(system).toContain(INSTRUCTION)
    expect(system).toContain("do not judge it")
    expect(system.indexOf(INSTRUCTION)).toBeLessThan(system.indexOf("do not judge it"))
  })

  test("the question and the pixels arrive together in one user message", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("ok") })
    await run("what does the dialog say", { language: model })

    const users = model.doGenerateCalls[0]!.prompt.filter((message) => message.role === "user")
    expect(users).toHaveLength(1)
    const content = users[0]!.content as Array<{ type: string; mediaType?: string; text?: string }>
    expect(content.map((part) => part.type)).toEqual(["text", "file"])
    expect(content[0]!.text).toBe("what does the dialog say")
    expect(content[1]!.mediaType).toBe("image/png")
  })

  test("no session is created — the session store is never touched at all", async () => {
    const { sessionCalls } = await run("what does the dialog say")
    expect(sessionCalls).toEqual([])
  })

  test("a re-driven tool call is answered from the memo, not paid for twice", async () => {
    // A provider retry can re-drive a finished stream and re-execute a call
    // that already ran. Without the memo the user uploads the image again to
    // be told the same thing.
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("a red dialog") })
    const { results } = await runMany("what does the dialog say", ["call-1", "call-1"], { language: model })

    expect(model.doGenerateCalls).toHaveLength(1)
    expect(results.map((r) => r.output)).toEqual(["a red dialog", "a red dialog"])
  })
})

describe("every failure is an honest tool result, not a dead turn", () => {
  test("a profile whose file is gone names the slug and tells the model to answer without it", async () => {
    const { result } = await run("describe this", { definitionFile: undefined })
    expect(result.metadata.refused).toBe(true)
    expect(result.output).toContain("@vision-qwen")
    expect(result.output).toContain("answer without the image")
  })

  test("a profile with no pinned model refuses rather than falling back to the blind chat model", async () => {
    const bare = path.join(dir, "no-model.md")
    await fs.writeFile(bare, ["---", 'description: "Vision"', "mode: all", "---", "", "look", ""].join("\n"), "utf8")
    const { result } = await run("describe this", { definitionFile: bare, profile: "no-model" })
    expect(result.metadata.refused).toBe(true)
    expect(result.output).toContain("no model pinned")
  })

  test("frontmatter the parser cannot make sense of reads as NO model, not as a guess", async () => {
    // Checked against the real parser, not assumed: `ConfigMarkdown.parse`
    // falls back to `sanitize` and returns `data: {}` for this file rather than
    // throwing (probed this session). So the honest outcome is the no-model
    // refusal — never a half-read `model:` value sent to the provider.
    const broken = path.join(dir, "broken.md")
    await fs.writeFile(broken, ["---", "model: [unclosed", "  - :", "---", "", "look", ""].join("\n"), "utf8")
    const { result } = await run("describe this", { definitionFile: broken, profile: "broken" })
    expect(result.metadata.refused).toBe(true)
    expect(result.output).toContain("no model pinned")
  })

  test("a profile file deleted between the scan and the read names the file rather than dying", async () => {
    // `definitionFile` scans the directory and hands back a path; the read
    // happens after. A file removed in between makes that read REJECT, and an
    // uncaught rejection would kill the parent turn.
    const vanished = path.join(dir, "vanished.md")
    const { result } = await run("describe this", { definitionFile: vanished, profile: "vanished" })
    expect(result.metadata.refused).toBe(true)
    expect(result.output).toContain("could not be read")
    expect(result.output).toContain("vanished.md")
  })

  test("a turn with no image and no paths says so instead of sending an empty request", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("ok") })
    const { result } = await run("describe this", { images: [], language: model })
    expect(result.metadata.refused).toBe(true)
    expect(result.output).toContain("no `paths` were given")
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  test("a provider failure comes back as a refusal carrying the reason", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("connection refused")
      },
    })
    const { result } = await run("describe this", { language: model })
    expect(result.metadata.refused).toBe(true)
    expect(result.output).toContain("connection refused")
    expect(result.output).toContain("Answer without it")
  })

  test("a provider that is not configured at all refuses instead of killing the turn", async () => {
    // The everyday case: LM Studio is not running, or the model was renamed in
    // the server. `getLanguage` DEFECTS there rather than failing typed, so a
    // plain `Effect.catch` would let it through and the parent turn would die.
    const { result } = await run("describe this", { languageDies: true })
    expect(result.metadata.refused).toBe(true)
    expect(result.output).toContain("lmstudio/qwen3-vl")
    expect(result.output).toContain("answer without the image")
  })

  test("an empty answer is reported as empty, not passed off as a description", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("") })
    const { result } = await run("describe this", { language: model })
    expect(result.metadata.refused).toBe(true)
    expect(result.output).toContain("returned nothing")
  })
})

// ---------------------------------------------------------------------------
// Round 5 — `paths`: the turn that carries no attachment at all.
// ---------------------------------------------------------------------------

// A real 1x1 PNG, so `FSUtil.mimeType` and the base64 encoding are exercised on
// bytes rather than on an invented string.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

describe("paths: the tool can go and fetch the picture", () => {
  let shot = ""
  let notAnImage = ""

  beforeAll(async () => {
    shot = path.join(dir, "shot.png")
    notAnImage = path.join(dir, "notes.txt")
    await fs.writeFile(shot, PNG_BYTES)
    await fs.writeFile(notAnImage, "plain text", "utf8")
  })

  test("a path is loaded off disk and sent as the picture", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("A red dialog.") })
    const { result } = await run("what does it say", { images: [], paths: [shot], language: model })

    expect(result.metadata.refused).toBeUndefined()
    expect(result.metadata.images).toBe(1)
    const users = model.doGenerateCalls[0]!.prompt.filter((message) => message.role === "user")
    const content = users[0]!.content as Array<{ type: string; mediaType?: string; data?: unknown }>
    expect(content.map((part) => part.type)).toEqual(["text", "file"])
    expect(content[1]!.mediaType).toBe("image/png")
    // The bytes actually reached the request, not a path string.
    expect(String(content[1]!.data)).toContain(PNG_BYTES.toString("base64"))
  })

  // The load happens on the PARENT's ctx, which is the whole reason the tool
  // reads the file itself instead of handing the path to a profile that has no
  // session for a permission bar to appear in.
  test("reading an external path raises the external_directory ask on the parent's context", async () => {
    await run("what does it say", { images: [], paths: [shot] })
    expect(asks.map((ask) => ask.permission)).toEqual(["external_directory"])
    expect(asks[0]!.metadata.filepath).toBeDefined()
  })

  // The fixed-target invariant: a path chooses WHICH picture, never which model.
  test("a path does not redirect the request — the chat's own profile still answers", async () => {
    const { result } = await run("what does it say", { images: [], paths: [shot] })
    expect(result.metadata.profile).toBe("vision-qwen")
    expect(result.metadata.model).toBe("lmstudio/qwen3-vl")
  })

  test("an ATTACHED image wins over paths, so the model cannot look away from it", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("ok") })
    const { result } = await run("what does it say", { paths: [shot], language: model })
    expect(result.metadata.images).toBe(1)
    // No file was read, so no external-directory bar was raised for one.
    expect(asks).toEqual([])
    const users = model.doGenerateCalls[0]!.prompt.filter((message) => message.role === "user")
    const content = users[0]!.content as Array<{ type: string; data?: unknown }>
    // The ATTACHED pixels, not the file's: the fixture attachment's payload is
    // this three-byte stub, and the on-disk PNG's is a different string.
    expect(String(content[1]!.data)).toContain("iVBORw0KGgo=")
    expect(String(content[1]!.data)).not.toContain(PNG_BYTES.toString("base64"))
  })

  test("a relative path is refused with the reason, not resolved against a guess", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("ok") })
    const { result } = await run("what does it say", { images: [], paths: ["shot.png"], language: model })
    expect(result.metadata.refused).toBe(true)
    expect(result.output).toContain("absolute path")
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  test("a file that is not an image is refused by mime, before any bytes are sent", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("ok") })
    const { result } = await run("what does it say", { images: [], paths: [notAnImage], language: model })
    expect(result.metadata.refused).toBe(true)
    expect(result.output).toContain("not an image")
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  test("a path that does not exist is a refusal naming it, not a dead turn", async () => {
    const missing = path.join(dir, "gone.png")
    const { result } = await run("what does it say", { images: [], paths: [missing] })
    expect(result.metadata.refused).toBe(true)
    expect(result.output).toContain("gone.png")
    expect(result.output).toContain("could not be read")
  })

  test("several paths all ride ONE request, in order", async () => {
    const second = path.join(dir, "second.png")
    await fs.writeFile(second, PNG_BYTES)
    const model = new MockLanguageModelV3({ doGenerate: async () => generated("ok") })
    const { result } = await run("compare them", { images: [], paths: [shot, second], language: model })
    expect(result.metadata.images).toBe(2)
    expect(asks).toHaveLength(2)
    const users = model.doGenerateCalls[0]!.prompt.filter((message) => message.role === "user")
    expect(users).toHaveLength(1)
    expect((users[0]!.content as unknown[]).length).toBe(3)
  })
})
