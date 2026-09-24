import { afterEach, describe, expect, test } from "bun:test"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { Provider } from "@/provider/provider"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { fixedFloor, MIN_COMPACTABLE_HISTORY, overflowCheck, preserveRecentBudget, usable } from "@/session/overflow"
import { SessionPromptCapture } from "@/session/prompt-capture"

/**
 * THE TRIGGER, restated: a full window is only HALF the question.
 *
 * Compaction can delete conversation and nothing else. The fixed block — system
 * prompt plus tool schemas — is sent again on every single turn, so when it is
 * most of what remains, a summary removes a few percent and costs a whole
 * generation (the measured median was 8.3%; one run GREW the context 6.6%).
 * These tests pin the second half: how much removable history the trigger now
 * demands before it fires.
 */

const modality = { text: true, audio: false, image: false, video: false, pdf: false }

/** Fully typed rather than asserted: nothing here is worth an `as`. */
function createModel(opts: { context: number; output: number; input?: number }): Provider.Model {
  return {
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    name: "Test",
    limit: { context: opts.context, input: opts.input, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: { ...modality },
      output: { ...modality },
    },
    api: { id: "test", url: "", npm: "@ai-sdk/anthropic" },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

const cfg = {} as ConfigV1.Info
const model = createModel({ context: 200_000, output: 32_000 })

/** `count` split into a floor and the history above it. */
function check(input: { count: number; floor?: number; cfg?: ConfigV1.Info }) {
  return overflowCheck({
    cfg: input.cfg ?? cfg,
    tokens: { input: input.count, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    model,
    floor: input.floor,
  })
}

afterEach(() => {
  SessionPromptCapture.reset()
})

describe("session.overflow — the history gate", () => {
  // usable = 200000 - 32000 = 168000; tail budget = 8000; required = 16000.
  const limit = usable({ cfg, model })
  const required = Math.max(MIN_COMPACTABLE_HISTORY, 2 * preserveRecentBudget({ cfg, model }))

  test("the measured case: a full window that is almost all fixed block does NOT compact", () => {
    // 170k in the window, 160k of it system prompt and tool schemas. The best
    // a summary can do here is delete 10k, and it adds ~700 tokens back.
    const result = check({ count: 170_000, floor: 160_000 })
    expect(result.overflow).toBe(false)
    expect(result.gated).toBe(true)
    expect(result.history).toBe(10_000)
    expect(result.required).toBe(16_000)
  })

  test("the same count with a measured floor of zero still compacts", () => {
    // No capture means no floor, and the gate must not INVENT one: the whole
    // count counts as history, which can only let a compaction through.
    const result = check({ count: 170_000, floor: 0 })
    expect(result.overflow).toBe(true)
    expect(result.gated).toBe(false)
    expect(result.history).toBe(170_000)
  })

  test("history exactly at the requirement fires; one token under it does not", () => {
    expect(check({ count: 170_000, floor: 170_000 - required }).overflow).toBe(true)
    expect(check({ count: 170_000, floor: 170_000 - required + 1 }).overflow).toBe(false)
  })

  test("a big preserved tail raises the bar: 2 x the tail budget, not the flat 8k", () => {
    // A tail of 30k is kept VERBATIM, so a compaction with 50k of history can
    // remove at most 20k — under the 60k the doubled budget demands.
    const wide = { compaction: { preserve_recent_tokens: 30_000 } } as ConfigV1.Info
    const result = check({ count: 170_000, floor: 120_000, cfg: wide })
    expect(preserveRecentBudget({ cfg: wide, model })).toBe(30_000)
    expect(result.required).toBe(60_000)
    expect(result.gated).toBe(true)
  })

  test("an unfull window is not GATED, it is simply not overflowing", () => {
    // The distinction matters because `gated` is what gets logged: a session
    // under the threshold must not log "held back" on every turn.
    const result = check({ count: limit - 1, floor: 0 })
    expect(result.overflow).toBe(false)
    expect(result.gated).toBe(false)
  })

  test("auto-compaction switched off reports neither overflow nor a gate", () => {
    const off = { compaction: { auto: false } } as ConfigV1.Info
    const result = check({ count: 170_000, floor: 160_000, cfg: off })
    expect(result.overflow).toBe(false)
    expect(result.gated).toBe(false)
  })

  test("a floor larger than the count is clamped, never a negative history", () => {
    const result = check({ count: 170_000, floor: 999_999 })
    expect(result.floor).toBe(170_000)
    expect(result.history).toBe(0)
  })
})

describe("session.overflow.fixedFloor — where the floor comes from", () => {
  test("no session, and a session that has sent no turn, both floor at zero", () => {
    expect(fixedFloor(undefined)).toBe(0)
    expect(fixedFloor("ses_never_sent")).toBe(0)
  })

  test("the floor is the captured system blocks plus the captured tool bytes", () => {
    const sessionID = "ses_floor"
    SessionPromptCapture.draft(sessionID, [])
    const captured = SessionPromptCapture.record({
      sessionID,
      capturedAt: new Date().toISOString(),
      model: "test/test-model",
      base: ["b".repeat(400)],
      finalSystem: ["s".repeat(4_000), "t".repeat(2_000)],
      tools: {},
    })
    expect(captured).toBeTruthy()
    // 6000 chars of system prompt = 1500 tokens; no tools, so no tool bytes.
    // The floor reads the FINAL system (post plugin transform), not the base.
    expect(fixedFloor(sessionID)).toBe(1_500)
  })

  test("MEASUREMENT: the trigger table", () => {
    const rows = [
      { count: 100_000, floor: 0 },
      { count: 168_000, floor: 0 },
      { count: 170_000, floor: 160_000 },
      { count: 170_000, floor: 154_000 },
      { count: 170_000, floor: 120_000 },
      { count: 190_000, floor: 160_000 },
    ]
    const lines = rows.map((row) => {
      const result = check(row)
      return `| ${row.count} | ${row.floor} | ${result.history} | ${result.usable} | ${result.required} | ${result.overflow ? "yes" : "no"} |`
    })
    console.log(
      ["| count | floor | history | usable | required | fires? |", "|---|---|---|---|---|---|", ...lines].join("\n"),
    )
    // The table is evidence, not decoration: the first two rows are the old
    // behaviour (no floor known) and must be unchanged by this work.
    expect(check(rows[0]).overflow).toBe(false)
    expect(check(rows[1]).overflow).toBe(true)
  })
})
