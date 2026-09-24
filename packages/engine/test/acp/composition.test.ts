// The context composition the gauge draws. The whole point of this object is
// that a reader can add the parts up and land on the number the gauge shows, so
// that is what these assert — on a capture written by the REAL prompt-capture
// path (draft + record), not a hand-built object, because a capture the engine
// never wrote proves nothing about what the engine sends.

import { beforeEach, describe, expect, test } from "bun:test"
import { jsonSchema } from "ai"
import { ACPComposition } from "@/acp/composition"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { UsageService } from "@/acp/usage"

beforeEach(() => SessionPromptCapture.reset())

const SESSION = "ses_ctx"

/** One real prompt assembly: staged parts, a joined system, two offered tools. */
function recordAssembly(): SessionPromptCapture.Capture {
  SessionPromptCapture.draft(
    SESSION,
    SessionPromptCapture.parts({
      env: ["<env>cwd: /repo</env>"],
      instructions: ["# AGENTS.md\nBe terse.\n".repeat(20)],
      skills: "skill: wrap",
    }),
  )
  const capture = SessionPromptCapture.record({
    sessionID: SESSION,
    capturedAt: "2026-09-21T00:00:00.000Z",
    model: "anthropic/claude",
    base: ["You are Origami.".repeat(10)],
    finalSystem: ["You are Origami.".repeat(10), "<env>cwd: /repo</env>", "# AGENTS.md\nBe terse.\n".repeat(20)],
    tools: {
      grep: { description: "Search files", inputSchema: jsonSchema({ type: "object" as const }) },
      read: { description: "Read a file", inputSchema: jsonSchema({ type: "object" as const }) },
    } as never,
  })
  return capture!
}

describe("contextComposition", () => {
  test("the parts sum to the used total, on a capture the real assembly wrote", () => {
    recordAssembly()
    const used = 40_000

    const composition = ACPComposition.contextComposition({ capture: SessionPromptCapture.get(SESSION), used })!

    expect(composition.systemPrompt + composition.tools + composition.conversation).toBe(used)
    // Not a placeholder split: the fixed block is measured off the capture.
    expect(composition.systemPrompt).toBeGreaterThan(0)
    expect(composition.tools).toBeGreaterThan(0)
    expect(composition.conversation).toBeGreaterThan(0)
  })

  test("the fixed parts are the capture's own figures, not a re-derivation", () => {
    const capture = recordAssembly()
    const systemPrompt = capture.finalSystem.reduce((sum, item) => sum + item.tokensApprox, 0)
    const toolChars = capture.tools.reduce((sum, item) => sum + item.descriptionChars + item.schemaBytes, 0)

    const composition = ACPComposition.contextComposition({ capture, used: 40_000 })!

    expect(composition.systemPrompt).toBe(systemPrompt)
    expect(composition.tools).toBe(SessionPromptCapture.estimateTokens(toolChars))
  })

  test("a used total SMALLER than the estimated fixed block still sums to used, with no negative part", () => {
    const capture = recordAssembly()
    const used = 12

    const composition = ACPComposition.contextComposition({ capture, used })!

    expect(composition.systemPrompt + composition.tools + composition.conversation).toBe(used)
    expect(composition.conversation).toBe(0)
    expect(composition.systemPrompt).toBeGreaterThanOrEqual(0)
    expect(composition.tools).toBeGreaterThanOrEqual(0)
  })

  test("no capture, or no measured total, reports nothing rather than a guess", () => {
    expect(ACPComposition.contextComposition({ capture: null, used: 1000 })).toBeUndefined()
    expect(ACPComposition.contextComposition({ capture: recordAssembly(), used: 0 })).toBeUndefined()
  })

  test("it names itself an estimate, so a client cannot present it as provider-reported", () => {
    const composition = ACPComposition.contextComposition({ capture: recordAssembly(), used: 40_000 })!

    expect(composition.estimated).toBe(true)
    expect(composition.method).toContain("chars/4")
  })
})

describe("the usage_update frame", () => {
  test("carries the composition on _meta, beside the subagent rollup", () => {
    const composition = ACPComposition.contextComposition({ capture: recordAssembly(), used: 40_000 })!

    const update = UsageService.buildUsageUpdate({ used: 40_000, size: 128_000, cost: 1, composition })

    expect((update as { _meta?: { composition?: unknown } })._meta?.composition).toEqual(composition)
  })

  test("a frame with no composition carries no composition key at all", () => {
    const update = UsageService.buildUsageUpdate({ used: 40_000, size: 128_000, cost: 1 })

    expect((update as { _meta?: { composition?: unknown } })._meta?.composition).toBeUndefined()
  })
})
