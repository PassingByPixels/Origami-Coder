// `origami models` lists the OpenCode Zen gateway first, then everything else
// alphabetically. The sort keys on a provider-ID PREFIX, and a wrong prefix is
// invisible: the listing still prints, just in plain alphabetical order. These
// tests assert the observable order for the ids the shipped catalog serves.
import { describe, expect, test } from "bun:test"
import { sortProviderIDs } from "@/cli/cmd/models"

describe("sortProviderIDs", () => {
  test("sorts the OpenCode Zen provider to the top", () => {
    expect(sortProviderIDs(["anthropic", "opencode", "google"])).toEqual(["opencode", "anthropic", "google"])
  })

  test("the one prefix also covers the OpenCode Go provider", () => {
    expect(sortProviderIDs(["anthropic", "opencode-go", "google"])).toEqual(["opencode-go", "anthropic", "google"])
  })

  test("both gateway entries lead, alphabetically among themselves", () => {
    expect(sortProviderIDs(["zai", "opencode-go", "anthropic", "opencode"])).toEqual([
      "opencode",
      "opencode-go",
      "anthropic",
      "zai",
    ])
  })

  test("everything else stays alphabetical", () => {
    expect(sortProviderIDs(["zai", "anthropic", "google"])).toEqual(["anthropic", "google", "zai"])
  })

  test("an empty list is not a special case", () => {
    expect(sortProviderIDs([])).toEqual([])
  })

  test("does not mutate its input", () => {
    const input = ["anthropic", "opencode"]
    sortProviderIDs(input)
    expect(input).toEqual(["anthropic", "opencode"])
  })
})
