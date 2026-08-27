// Prompt capture — the transparency store behind the `prompt_capture` ext
// method. The bugs worth catching are the dishonest ones: reporting an
// assembly the model never received (a plugin can reshape the prompt after it
// is built), letting a title-generation or compaction call masquerade as the
// user's turn, or a labeled list that no longer matches the array the request
// layer actually joined.

import { beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { jsonSchema } from "ai"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { LLMRequestPrep } from "@/session/llm/request"

beforeEach(() => SessionPromptCapture.reset())

const staged = (label: SessionPromptCapture.PartLabel, text: string) => SessionPromptCapture.part(label, text)

describe("the labeled parts ARE the prompt", () => {
  test("the text the model gets is exactly the labeled list, in order", () => {
    const parts = SessionPromptCapture.parts({
      env: ["env-a", "env-b"],
      instructions: ["AGENTS.md body"],
      mcp: "mcp blurb",
      skills: "skills blurb",
      flock: "flock blurb",
      structuredOutput: "structured",
    })

    // This is the array prompt.ts hands to the model; nothing is assembled twice.
    expect(parts.map((entry) => entry.text)).toEqual([
      "env-a",
      "env-b",
      "AGENTS.md body",
      "mcp blurb",
      "skills blurb",
      "flock blurb",
      "structured",
    ])
    expect(parts.map((entry) => entry.label)).toEqual([
      "env",
      "env",
      "instructions",
      "mcp",
      "skills",
      "flock",
      "structured-output",
    ])
  })

  test("an absent source contributes no row at all, rather than an empty one", () => {
    const parts = SessionPromptCapture.parts({ env: [], instructions: [] })

    expect(parts).toEqual([])
  })

  test("sizes come from the text itself and the token figure is the rounded-up chars/4", () => {
    const [entry] = SessionPromptCapture.parts({ env: ["12345"], instructions: [] })

    expect(entry!.chars).toBe(5)
    expect(entry!.tokensApprox).toBe(2)
  })
})

describe("record — only a real turn is captured", () => {
  test("nothing is stored for a session that staged no draft", () => {
    const written = SessionPromptCapture.record({
      sessionID: "ses_compaction",
      capturedAt: "2026-08-03T00:00:00.000Z",
      model: "anthropic/claude",
      base: ["base"],
      finalSystem: ["base"],
      tools: {},
    })

    expect(written).toBeUndefined()
    expect(SessionPromptCapture.get("ses_compaction")).toBeNull()
  })

  test("a draft is spent once, so the next model call cannot claim the same turn", () => {
    SessionPromptCapture.draft("ses_a", [staged("env", "env text")])
    const first = SessionPromptCapture.record({
      sessionID: "ses_a",
      capturedAt: "2026-08-03T00:00:00.000Z",
      model: "anthropic/claude",
      base: ["base"],
      finalSystem: ["joined"],
      tools: {},
    })
    const second = SessionPromptCapture.record({
      sessionID: "ses_a",
      capturedAt: "2026-08-03T00:00:01.000Z",
      model: "anthropic/claude",
      base: ["other base"],
      finalSystem: ["something else entirely"],
      tools: {},
    })

    expect(first).toBeDefined()
    expect(second).toBeUndefined()
    // The stored capture is still the first one — untouched by the second call.
    expect(SessionPromptCapture.get("ses_a")!.finalSystem[0]!.text).toBe("joined")
  })

  test("the base prompt leads and the message's own system text trails the assembled middle", () => {
    SessionPromptCapture.draft("ses_b", [staged("env", "env text"), staged("instructions", "rules")])
    SessionPromptCapture.record({
      sessionID: "ses_b",
      capturedAt: "2026-08-03T00:00:00.000Z",
      model: "anthropic/claude",
      base: ["the built-in prompt"],
      userSystem: "one-off system",
      finalSystem: ["joined"],
      tools: {},
    })

    expect(SessionPromptCapture.get("ses_b")!.labeledParts.map((entry) => entry.label)).toEqual([
      "base-or-agent-prompt",
      "env",
      "instructions",
      "user-system",
    ])
  })

  test("an absent user system text adds no row", () => {
    SessionPromptCapture.draft("ses_c", [staged("env", "env text")])
    SessionPromptCapture.record({
      sessionID: "ses_c",
      capturedAt: "2026-08-03T00:00:00.000Z",
      model: "anthropic/claude",
      base: ["base"],
      finalSystem: ["joined"],
      tools: {},
    })

    expect(SessionPromptCapture.get("ses_c")!.labeledParts.some((entry) => entry.label === "user-system")).toBe(false)
  })

  test("a later turn REPLACES the session's capture rather than accumulating", () => {
    for (const text of ["turn one", "turn two"]) {
      SessionPromptCapture.draft("ses_d", [staged("env", text)])
      SessionPromptCapture.record({
        sessionID: "ses_d",
        capturedAt: "2026-08-03T00:00:00.000Z",
        model: "anthropic/claude",
        base: [],
        finalSystem: [text],
        tools: {},
      })
    }

    const capture = SessionPromptCapture.get("ses_d")!
    expect(capture.labeledParts).toHaveLength(1)
    expect(capture.finalSystem[0]!.text).toBe("turn two")
  })

  test("the estimator is named on the wire, so a reader cannot mistake it for a tokenisation", () => {
    SessionPromptCapture.draft("ses_e", [staged("env", "x")])
    SessionPromptCapture.record({
      sessionID: "ses_e",
      capturedAt: "2026-08-03T00:00:00.000Z",
      model: "openai/gpt-5.2",
      base: [],
      finalSystem: ["abcdefgh"],
      tools: {},
    })

    const capture = SessionPromptCapture.get("ses_e")!
    expect(capture.tokensApproxMethod).toBe("chars/4")
    expect(capture.finalSystem[0]!.chars).toBe(8)
    expect(capture.finalSystem[0]!.tokensApprox).toBe(2)
    expect(capture.model).toBe("openai/gpt-5.2")
  })

  test("the store is bounded, dropping the oldest session rather than growing forever", () => {
    for (let i = 0; i <= SessionPromptCapture.LIMIT; i++) {
      SessionPromptCapture.draft(`ses_${i}`, [staged("env", "x")])
      SessionPromptCapture.record({
        sessionID: `ses_${i}`,
        capturedAt: "2026-08-03T00:00:00.000Z",
        model: "anthropic/claude",
        base: [],
        finalSystem: ["x"],
        tools: {},
      })
    }

    expect(SessionPromptCapture.get("ses_0")).toBeNull()
    expect(SessionPromptCapture.get(`ses_${SessionPromptCapture.LIMIT}`)).not.toBeNull()
  })

  test("an abandoned draft is bounded too, so an aborted turn cannot leak its prompt text", () => {
    // A turn aborted before the request layer runs never spends its draft, so
    // the staging map needs the same bound the capture map has.
    for (let i = 0; i <= SessionPromptCapture.LIMIT; i++) {
      SessionPromptCapture.draft(`ses_abandoned_${i}`, [staged("env", "x")])
    }

    const recorded = (sessionID: string) =>
      SessionPromptCapture.record({
        sessionID,
        capturedAt: "2026-08-03T00:00:00.000Z",
        model: "anthropic/claude",
        base: [],
        finalSystem: ["x"],
        tools: {},
      })

    // The oldest draft was evicted, so that session has nothing to record...
    expect(recorded("ses_abandoned_0")).toBeUndefined()
    // ...while the newest is still staged and records normally.
    expect(recorded(`ses_abandoned_${SessionPromptCapture.LIMIT}`)).toBeDefined()
  })
})

describe("the tool inventory", () => {
  test("reports each tool's description size and the bytes of the schema the provider receives", () => {
    const schema = { type: "object" as const, properties: { q: { type: "string" as const } } }
    const entries = SessionPromptCapture.toolEntries({
      grep: { description: "Search files", inputSchema: jsonSchema(schema) },
    } as never)

    expect(entries).toHaveLength(1)
    expect(entries[0]!.name).toBe("grep")
    expect(entries[0]!.description).toBe("Search files")
    expect(entries[0]!.descriptionChars).toBe("Search files".length)
    expect(entries[0]!.schemaBytes).toBe(Buffer.byteLength(JSON.stringify(schema), "utf8"))
  })

  test("a description-less tool reports zero chars, not a fabricated description", () => {
    const entries = SessionPromptCapture.toolEntries({
      mystery: { inputSchema: jsonSchema({ type: "object" }) },
    } as never)

    expect(entries[0]!.description).toBe("")
    expect(entries[0]!.descriptionChars).toBe(0)
  })

  test("a schema that cannot be read without waiting reports 0 = not measured, never a guess", () => {
    const entries = SessionPromptCapture.toolEntries({
      deferred: { description: "d", inputSchema: jsonSchema(Promise.resolve({ type: "object" as const })) },
    } as never)

    expect(entries[0]!.schemaBytes).toBe(0)
  })

  test("the repair-only `invalid` tool is NOT listed — the model is never offered it", () => {
    const tools = {
      grep: { description: "Search", inputSchema: jsonSchema({ type: "object" }) },
      invalid: { description: "Do not use", inputSchema: jsonSchema({ type: "object" }) },
    } as never

    // session/llm.ts hands the model exactly `offeredToolNames`, so the two
    // cannot disagree about what was on offer.
    expect(SessionPromptCapture.offeredToolNames(tools)).toEqual(["grep"])
    expect(SessionPromptCapture.toolEntries(tools).map((entry) => entry.name)).toEqual(["grep"])
  })
})

// The end-to-end proof: the capture is taken from the REAL prepared request,
// after the plugin hook that can reshape it. Mirrors the prepare() harness in
// test/provider/transform.test.ts.
const model = {
  id: "claude-opus-4-6",
  providerID: "anthropic",
  api: { id: "claude-opus-4-6", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
  name: "Claude",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
} as never

const prepare = (over: Record<string, unknown>) =>
  Effect.runPromise(
    LLMRequestPrep.prepare({
      user: {
        id: "msg_user",
        sessionID: "ses_prepared",
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      } as never,
      sessionID: "ses_prepared",
      model,
      agent: { name: "build", mode: "primary", prompt: "AGENT PROMPT", options: {}, permission: [] } as never,
      system: ["env text", "AGENTS.md body"],
      messages: [{ role: "user", content: "Hello" }],
      tools: { grep: { description: "Search", inputSchema: jsonSchema({ type: "object", properties: {} }) } },
      provider: { id: "anthropic", options: {} } as never,
      auth: undefined,
      plugin: {
        trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
        list: () => Effect.succeed([]),
        init: () => Effect.void,
      } as never,
      flags: { outputTokenMax: 32_000, client: "test" } as never,
      isWorkflow: false,
      ...over,
    } as never),
  )

describe("capture-on-send, taken from the prepared request", () => {
  test("stores what the model was sent — the joined system and the resolved tools", async () => {
    SessionPromptCapture.draft("ses_prepared", [staged("env", "env text"), staged("instructions", "AGENTS.md body")])
    const prepared = await prepare({})

    const capture = SessionPromptCapture.get("ses_prepared")!
    expect(capture.finalSystem.map((entry) => entry.text)).toEqual(prepared.system)
    expect(capture.tools.map((entry) => entry.name)).toEqual(Object.keys(prepared.tools))
    // The agent's own prompt replaced the built-in one, and is labelled as such.
    expect(capture.labeledParts[0]).toMatchObject({ label: "base-or-agent-prompt", text: "AGENT PROMPT" })
    expect(capture.model).toBe("anthropic/claude-opus-4-6")
  })

  test("reports what a plugin RESHAPED it into, not what the engine assembled", async () => {
    SessionPromptCapture.draft("ses_prepared", [staged("env", "env text")])
    await prepare({
      plugin: {
        trigger: (name: string, _input: unknown, output: unknown) => {
          if (name === "experimental.chat.system.transform") {
            ;(output as { system: string[] }).system.push("INJECTED BY A PLUGIN")
          }
          return Effect.succeed(output)
        },
        list: () => Effect.succeed([]),
        init: () => Effect.void,
      },
    })

    const capture = SessionPromptCapture.get("ses_prepared")!
    // Re-deriving the prompt to answer the query would MISS this entirely.
    expect(capture.finalSystem.map((entry) => entry.text).join("\n")).toContain("INJECTED BY A PLUGIN")
  })

  test("a small-model call (title generation) never claims the session's turn", async () => {
    SessionPromptCapture.draft("ses_prepared", [staged("env", "env text")])
    await prepare({ small: true, system: [], tools: {} })

    // The draft is still waiting for the real turn, and nothing was stored.
    expect(SessionPromptCapture.get("ses_prepared")).toBeNull()
  })

  test("a model call with no staged draft (compaction) records nothing", async () => {
    await prepare({ system: [], tools: {} })

    expect(SessionPromptCapture.get("ses_prepared")).toBeNull()
  })
})

// THE STEP DIGEST — the arithmetic every cache verdict rests on. A prefix cache
// is an exact match from byte 0, so the only question that matters between two
// steps is "did this one rewrite anything the last one already sent", and these
// tests pin the two answers apart: an APPEND (healthy, the cache carries) and a
// HEAD REWRITE (the sub-agent defect, the cache is thrown away).
describe("recordStep — where two consecutive steps first differ", () => {
  const msg = (role: "user" | "assistant", text: string) => ({ role, content: text }) as never

  test("an append leaves the whole previous array as a prefix, and says so", () => {
    const first = SessionPromptCapture.recordStep({
      sessionID: "ses_step",
      capturedAt: "2026-08-25T00:00:00.000Z",
      messages: [msg("user", "hello")],
    })
    const second = SessionPromptCapture.recordStep({
      sessionID: "ses_step",
      capturedAt: "2026-08-25T00:00:01.000Z",
      messages: [msg("user", "hello"), msg("assistant", "hi")],
    })

    expect(first[0]!.prefixPreserved).toBeNull()
    expect(first[0]!.divergenceOffset).toBeNull()
    const step = second[second.length - 1]!
    expect(step.step).toBe(2)
    expect(step.prefixPreserved).toBe(true)
    // The first difference is where the NEW message starts — i.e. everything
    // the previous step sent is still byte-identical.
    expect(step.divergenceMessage).toBe(1)
    expect(step.divergenceOffset).toBe(first[0]!.bytes)
  })

  test("a rewritten head is reported at byte 0 of the message it happened in", () => {
    SessionPromptCapture.recordStep({
      sessionID: "ses_head",
      capturedAt: "2026-08-25T00:00:00.000Z",
      messages: [msg("user", "task"), msg("assistant", "a")],
    })
    const steps = SessionPromptCapture.recordStep({
      sessionID: "ses_head",
      capturedAt: "2026-08-25T00:00:01.000Z",
      messages: [msg("user", "task and memory"), msg("assistant", "a")],
    })

    const step = steps[steps.length - 1]!
    expect(step.prefixPreserved).toBe(false)
    expect(step.divergenceMessage).toBe(0)
    // Exact, not just "somewhere in message 0": the two serialisations share
    // `{"role":"user","content":"task` and part company at the next character.
    expect(step.divergenceOffset).toBe(Buffer.byteLength('{"role":"user","content":"task', "utf8"))
    expect(step.sample!.previous).toContain('"task"')
    expect(step.sample!.current).toContain('"task and memory"')
  })

  test("a binary part is measured, not expanded — an image must not become a byte-per-key object", () => {
    // `JSON.stringify` renders a Uint8Array as {"0":137,"1":80,...} — one key
    // per byte. A single screenshot would turn a digest into megabytes of
    // string on EVERY step, which is a memory fault, not a slow test. The
    // replacer has to catch it, and only a real typed array proves it does.
    const image = new Uint8Array(64_000)
    const steps = SessionPromptCapture.recordStep({
      sessionID: "ses_bin",
      capturedAt: "2026-08-25T00:00:00.000Z",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "file", data: image, mediaType: "image/png" },
          ],
        } as never,
      ],
    })

    // Bytes of the whole message, not of the picture: well under the 64k the
    // array alone would have cost even at one character per byte.
    expect(steps[0]!.bytes).toBeLessThan(200)
    expect(steps[0]!.messages[0]!.bytes).toBe(steps[0]!.bytes)
  })

  test("only the last two steps are kept, so a long turn cannot grow the store", () => {
    for (const text of ["one", "two", "three", "four"])
      SessionPromptCapture.recordStep({
        sessionID: "ses_roll",
        capturedAt: "2026-08-25T00:00:00.000Z",
        messages: [msg("user", text)],
      })
    const steps = SessionPromptCapture.recordStep({
      sessionID: "ses_roll",
      capturedAt: "2026-08-25T00:00:00.000Z",
      messages: [msg("user", "five")],
    })

    expect(steps).toHaveLength(SessionPromptCapture.STEP_HISTORY)
    expect(steps.map((s) => s.step)).toEqual([4, 5])
  })
})
