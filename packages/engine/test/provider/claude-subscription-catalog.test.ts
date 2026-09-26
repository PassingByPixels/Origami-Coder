// t-xu5o64. Owner UAT of 0.4.178 on a Max plan: the picker showed Opus (1M context),
// Sonnet and Haiku from the engine, but no Fable, although the plan offers it.
//
// THE RAW VALUES. One read-only run of the engine's own picker handshake on the
// owner's PC (2026-09-25, CLI 2.1.282, `initialize` control request: no user
// message, nothing billed) answered, in this order:
//   default               "Default (recommended)"  (Opus 5.5 with 1M context)
//   opus[1m]              "Opus (1M context)"
//   claude-fable-5-1[1m]  "Fable"
//   sonnet                "Sonnet"
//   haiku                 "Haiku"
// with account.subscriptionType "Claude Max". Fable is a FULL model id, not the
// `fable` alias, so the family filter (value minus `[1m]` must be exactly one of
// fable|opus|sonnet|haiku) dropped it. Plain `opus` is not in the picker at all:
// only `opus[1m]` is. The rows below are those values, verbatim.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaudeCli } from "@origami/llm/route"
import { ClaudeSubscription } from "@/provider/claude-subscription"

const OWNER_MAX_PICKER = [
  { value: "default", displayName: "Default (recommended)", description: "Opus 5.5 with 1M context · Best for everyday, complex tasks" },
  { value: "opus[1m]", displayName: "Opus (1M context)", description: "Opus 5.5 with 1M context · Best for everyday, complex tasks" },
  { value: "claude-fable-5-1[1m]", displayName: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks" },
  { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks" },
  { value: "haiku", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
]

afterEach(() => ClaudeSubscription.resetMemo())

describe("catalogFromHandshake (t-xu5o64)", () => {
  test("the owner's Max picker lists Fable under its full model id, once, with a 1M window", () => {
    const rows = ClaudeSubscription.catalogFromHandshake(OWNER_MAX_PICKER, "Claude Max")
    expect(rows.map((r) => r.id)).toEqual(["opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"])
    const fable = rows.find((r) => r.id === "claude-fable-5-1[1m]")!
    // t-y5ecbj: a 1M value says so in its name, as the CLI's own Opus row does.
    expect(fable.name).toBe("Fable (1M context)")
    expect(rows.find((r) => r.id === "opus[1m]")!.name).toBe("Opus (1M context)")
    expect(fable.context).toBe(1_000_000)
    // A Max plan: Fable does not bill usage credits.
    expect(fable.note).toBeUndefined()
  })

  test("`default` and CLI modes are not models", () => {
    const rows = ClaudeSubscription.catalogFromHandshake(
      [...OWNER_MAX_PICKER, { value: "opusplan", displayName: "Opus Plan Mode" }, { value: "claude-3-custom" }],
      "Claude Max",
    )
    expect(rows.map((r) => r.id)).not.toContain("default")
    expect(rows.map((r) => r.id)).not.toContain("opusplan")
    expect(rows.map((r) => r.id)).not.toContain("claude-3-custom")
  })

  test("Fable under its full id on a plan that is not Max is marked as billing usage credits", () => {
    const rows = ClaudeSubscription.catalogFromHandshake(OWNER_MAX_PICKER, "pro")
    expect(rows.find((r) => r.id === "claude-fable-5-1[1m]")?.note).toBe("usage credits")
    expect(rows.find((r) => r.id === "sonnet")?.note).toBeUndefined()
  })

  // t-y5ecbj: owner UAT of 0.4.179 showed rows named `claude-fable-5-1[1m]` and
  // `opus[1m]`. A row with no displayName and no description fell back to the
  // raw CLI value. The name is always readable; the id keeps the raw value.
  test("a row with no displayName is named readably, never by its raw CLI value", () => {
    const rows = ClaudeSubscription.catalogFromHandshake(
      [{ value: "claude-fable-5-1[1m]" }, { value: "opus[1m]" }, { value: "sonnet" }],
      "Claude Max",
    )
    expect(rows.map((r) => [r.id, r.name])).toEqual([
      ["claude-fable-5-1[1m]", "Fable (1M context)"],
      ["opus[1m]", "Opus (1M context)"],
      ["sonnet", "Sonnet"],
    ])
  })

  test("a plan whose picker has no Fable gets no Fable row", () => {
    const rows = ClaudeSubscription.catalogFromHandshake(
      OWNER_MAX_PICKER.filter((m) => !m.value.includes("fable")),
      "pro",
    )
    expect(rows.some((r) => r.id.includes("fable"))).toBe(false)
  })
})

describe("providerInfo through the handshake (fake CLI, t-xu5o64)", () => {
  test("the provider list carries the picker's own rows, Fable included, under the short name", async () => {
    const FIXTURES = path.resolve(import.meta.dir, "../../../llm/test/fixtures/claude-cli")
    const FAKE = [process.execPath, path.join(FIXTURES, "fake-claude.ts")]
    const log = mkdtempSync(path.join(tmpdir(), "fake-claude-catalog-"))
    const scenario = path.join(log, "scenario.json")
    writeFileSync(
      scenario,
      JSON.stringify({ models: OWNER_MAX_PICKER, account: { subscriptionType: "Claude Max" } }),
    )
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => ClaudeCli.envConflicts({ [key]: process.env[key] }).length === 0),
    )
    const info = await ClaudeSubscription.providerInfo({
      command: FAKE,
      env: { ...env, FAKE_SCENARIO: scenario, FAKE_LOG: log },
    })
    expect(Object.keys(info.models)).toEqual(["opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"])
    expect(info.models["claude-fable-5-1[1m]"]!.name).toBe("Fable (1M context)")
    // The picker shows `<provider name>/<model name>` (acp/config-option.ts):
    // "Claude (Sub)/Fable (1M context)". The experimental notice belongs to the connection step.
    expect(info.name).toBe("Claude (Sub)")
  })
})
