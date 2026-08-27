import { describe, expect, test } from "bun:test"
import { extractSnippet, relTime } from "../../src/tool/session-search"

// A serialized text part as the engine stores it in part.data (compact JSON).
const textPart = (text: string) => JSON.stringify({ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text })

describe("session_search.extractSnippet", () => {
  test("windows a hit in the middle with ellipses on both sides", () => {
    const long = "alpha ".repeat(30) + "the SECRET decision was made here " + "omega ".repeat(30)
    const snip = extractSnippet(textPart(long), "secret decision")
    expect(snip).toBeDefined()
    // Case-insensitive match is found and included verbatim from the source.
    expect(snip!.toLowerCase()).toContain("secret decision")
    // Truncated on both ends -> ellipses.
    expect(snip!.startsWith("…")).toBe(true)
    expect(snip!.endsWith("…")).toBe(true)
    // The window is bounded, not the whole 300+ char text.
    expect(snip!.length).toBeLessThan(200)
  })

  test("no leading ellipsis when the hit is at the very start", () => {
    const snip = extractSnippet(textPart("compaction nearOverflow ratio is 0.9 and matters a lot"), "compaction")
    expect(snip).toBeDefined()
    expect(snip!.startsWith("…")).toBe(false)
    expect(snip!.toLowerCase()).toContain("compaction")
  })

  test("short text returns in full with no ellipses", () => {
    const snip = extractSnippet(textPart("we chose Effect-TS"), "Effect")
    expect(snip).toBe("we chose Effect-TS")
  })

  test("collapses internal whitespace/newlines", () => {
    const snip = extractSnippet(textPart("line one\n\n   spaced\tword decision"), "decision")
    expect(snip).toBeDefined()
    expect(snip).not.toContain("\n")
    expect(snip).not.toContain("\t")
    expect(snip).not.toMatch(/ {2,}/)
  })

  test("returns undefined for a part with no string text (e.g. a tool part)", () => {
    const toolPart = JSON.stringify({ id: "prt", type: "tool", tool: "grep", state: { status: "completed" } })
    expect(extractSnippet(toolPart, "grep")).toBeUndefined()
  })

  test("returns undefined for unparseable data", () => {
    expect(extractSnippet("not json", "x")).toBeUndefined()
  })
})

describe("session_search.relTime", () => {
  const base = 1_000_000_000_000
  test("sub-minute is 'just now'", () => {
    expect(relTime(base - 30_000, base)).toBe("just now")
  })
  test("minute / hour / day / month / year buckets at their boundaries", () => {
    expect(relTime(base - 5 * 60_000, base)).toBe("5m ago")
    expect(relTime(base - 3 * 3_600_000, base)).toBe("3h ago")
    expect(relTime(base - 4 * 86_400_000, base)).toBe("4d ago")
    expect(relTime(base - 60 * 86_400_000, base)).toBe("2mo ago")
    expect(relTime(base - 400 * 86_400_000, base)).toBe("1y ago")
  })
  test("a future timestamp floors to 'just now' rather than going negative", () => {
    expect(relTime(base + 10_000, base)).toBe("just now")
  })
})
