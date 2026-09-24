// t-sj2qkr: `StorageNests.isTurnless` (packages/engine/src/storage/nests.ts)
// mirrors `isTurnless` in packages/vscode/src/dashboard/historyRows.ts — the
// desk's own History/Labyrinth rule for hiding a blank "New session - <ISO>"
// row. Two copies exist only because the engine and extension are separate
// packages with no shared dependency between them (packages/vscode has no
// @origami/core-style link to packages/engine). Per the drift-guard rule
// (agent guide Part 5): every mirror needs a test that reads BOTH files and
// asserts they still agree. This imports both real functions — proven to
// catch drift by deliberately breaking one copy and watching this go red,
// then restoring it (see HANDOFF note in the lane report).

import { describe, expect, test } from "bun:test"
import { isTurnless as engineIsTurnless } from "../../src/storage/nests"
import { isTurnless as extensionIsTurnless } from "../../../vscode/src/dashboard/historyRows"

const TITLES = [
  "",
  "   ",
  "New session - 2026-09-22T22:36:36.232Z",
  "new session - lowercase",
  "New sessions plural is not the placeholder",
  "Greeting and quick check-in",
  "Motherbase question declined handling",
  "flock: Motherbase@b0RRgWQA-A-abJJCWeH6I9",
  "Repo mapping to .origami/map/map.json",
]

describe("nests.isTurnless mirrors historyRows.isTurnless", () => {
  test("both copies agree on every fixture title", () => {
    for (const title of TITLES) {
      expect(engineIsTurnless(title)).toBe(extensionIsTurnless(title))
    }
  })

  test("both copies agree on the Mac evidence titles (t-sj2qkr)", () => {
    const macTitles = [
      "New session - 2026-09-22T22:36:36.232Z",
      "Greeting and quick check-in",
      "New session - 2026-09-22T17:47:40.137Z",
      "Motherbase question declined handling",
      "New session - 2026-09-05T20:03:56.379Z",
      "flock: Motherbase@b0RRgWQA-A-abJJCWeH6I9",
      "Flock message to motherbase",
      "New session - 2026-09-05T10:55:54.086Z",
      "New session - 2026-09-04T19:38:58.870Z",
      "New session - 2026-09-04T19:05:31.992Z",
      "New session - 2026-09-04T19:05:22.284Z",
      "New session - 2026-09-04T19:04:48.049Z",
      "New session - 2026-09-04T19:04:37.824Z",
      "Repo mapping to .origami/map/map.json",
      "Available tools inquiry",
    ]
    for (const title of macTitles) {
      expect(engineIsTurnless(title)).toBe(extensionIsTurnless(title))
    }
    // Exactly the rows without a real turn, matching the evidence pasted into
    // the ticket: 4 zero-message + 3 one-message-no-reply + 2 more untouched
    // "New session" rows = 9 of 15 Mac rows are turnless.
    expect(macTitles.filter(engineIsTurnless)).toHaveLength(9)
  })
})
