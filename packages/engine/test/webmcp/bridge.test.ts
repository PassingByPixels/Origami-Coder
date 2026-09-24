import { describe, expect, test } from "bun:test"
import { pillCount, pillMismatch, samePage, shapeDiscovery, type Discovery } from "../../src/webmcp/bridge"

/**
 * Shaping what the page hands back.
 *
 * Everything here is the seam between a real WebMCP page and the engine, and
 * every case below was taken from what a live page actually returned rather
 * than from the spec — including the two that would otherwise look like bugs in
 * the page: `inputSchema` arriving as a JSON STRING, and a descriptor that
 * cannot be serialised at all because it carries a live `window`.
 */

const PAGE = { pageId: "P1", port: 9222, pageUrl: "https://origami.gratis/folio/" }

describe("shapeDiscovery", () => {
  test("parses an inputSchema that arrived as a JSON string", () => {
    // THE CHROME QUIRK. A page's `inputSchema` comes over as a string; a client
    // that passed it straight through would hand the model a quoted blob where
    // a schema belongs.
    const shaped = shapeDiscovery(
      {
        surface: "document.modelContext",
        tools: [
          {
            name: "add_chunk",
            description: "Add a chunk",
            inputSchema: '{"type":"object","properties":{"starter":{"type":"string"}},"required":["starter"]}',
          },
        ],
        version: 0,
      },
      PAGE,
    )
    expect(shaped.tools[0].inputSchema).toEqual({
      type: "object",
      properties: { starter: { type: "string" } },
      required: ["starter"],
    })
  })

  test("keeps a schema that already arrived as an object", () => {
    const shaped = shapeDiscovery(
      { surface: "document.modelContext", tools: [{ name: "a", description: "", inputSchema: { type: "object" } }], version: 0 },
      PAGE,
    )
    expect(shaped.tools[0].inputSchema).toEqual({ type: "object" })
  })

  test("drops an unusable schema without dropping the tool", () => {
    const shaped = shapeDiscovery(
      {
        surface: "document.modelContext",
        tools: [
          { name: "broken", description: "", inputSchema: "{not json" },
          { name: "listy", description: "", inputSchema: "[1,2]" },
          { name: "bare", description: "" },
        ],
        version: 0,
      },
      PAGE,
    )
    // A tool with an unreadable schema is still callable — losing it would cost
    // the model a capability over a documentation problem.
    expect(shaped.tools.map((tool) => tool.name)).toEqual(["broken", "listy", "bare"])
    expect(shaped.tools.every((tool) => tool.inputSchema === undefined)).toBe(true)
  })

  test("reads the pill and its count alongside the registry", () => {
    const shaped = shapeDiscovery(
      {
        surface: "document.modelContext",
        tools: [{ name: "a", description: "" }],
        pill: "WebMCP: connected via document.modelContext — 29 tools",
        version: 3,
      },
      PAGE,
    )
    expect(shaped.pillCount).toBe(29)
    expect(shaped.version).toBe(3)
    expect(shaped.pageId).toBe("P1")
  })

  test("treats an unknown or missing surface as none", () => {
    // "none" is a real answer — the page loaded and published no WebMCP — and
    // has to be distinguishable from a page that could not be read at all.
    expect(shapeDiscovery(undefined, PAGE).surface).toBe("none")
    expect(shapeDiscovery({ surface: "window.somethingElse", tools: [] }, PAGE).surface).toBe("none")
    expect(shapeDiscovery({ surface: "navigator.modelContext", tools: [] }, PAGE).surface).toBe("navigator.modelContext")
  })

  test("carries a getTools() failure through as a reported error", () => {
    const shaped = shapeDiscovery({ surface: "document.modelContext", tools: [], error: "TypeError: nope" }, PAGE)
    expect(shaped.error).toBe("TypeError: nope")
    expect(shaped.tools).toEqual([])
  })

  test("survives a page that returns half a tool", () => {
    const shaped = shapeDiscovery({ surface: "document.modelContext", tools: [{}], version: 0 }, PAGE)
    expect(shaped.tools[0]).toEqual({ name: "", description: "" })
  })
})

describe("pillCount", () => {
  test("reads the number out of the page's own status line", () => {
    expect(pillCount("WebMCP: connected via document.modelContext — 29 tools")).toBe(29)
    expect(pillCount("1 tool")).toBe(1)
  })

  test("is undefined when there is no count to read", () => {
    // No pill at all, or a pill that says something else, must not be read as
    // zero — that would raise a false mismatch on every page without one.
    for (const text of [undefined, "", "WebMCP: connecting…", "no tools available"]) expect(pillCount(text)).toBeUndefined()
  })
})

describe("pillMismatch", () => {
  const withPill = (tools: number, pill: string): Discovery => ({
    surface: "document.modelContext",
    tools: Array.from({ length: tools }, (_, index) => ({ name: `t${index}`, description: "" })),
    pill,
    pillCount: pillCount(pill),
    version: 0,
    ...PAGE,
  })

  test("flags a disagreement between the page's count and ours", () => {
    // THE REGRESSION GUARD for the wrong-world failure: an isolated world
    // reports ZERO tools with no error, while the pill still says 29.
    expect(pillMismatch(withPill(0, "WebMCP: connected — 29 tools"))).toEqual({ pillCount: 29, discovered: 0 })
  })

  test("says nothing when the two agree", () => {
    expect(pillMismatch(withPill(29, "WebMCP: connected — 29 tools"))).toBeUndefined()
  })

  test("says nothing when the page publishes no count to compare against", () => {
    expect(pillMismatch({ surface: "document.modelContext", tools: [], version: 0, ...PAGE })).toBeUndefined()
  })
})

describe("samePage", () => {
  test("a trailing slash is not a different page", () => {
    expect(samePage("https://origami.gratis/folio", "https://origami.gratis/folio/")).toBe(true)
    expect(samePage("https://origami.gratis/folio/", "https://origami.gratis/folio")).toBe(true)
  })

  test("a hash route the page added still belongs to the site", () => {
    // The tab navigates itself once the app boots; the site it was opened for
    // has not changed, so it must still be found.
    expect(samePage("https://origami.gratis/folio", "https://origami.gratis/folio/#/deck/1")).toBe(true)
    expect(samePage("https://origami.gratis/folio", "https://origami.gratis/folio?new=1")).toBe(true)
  })

  test("a different page is not the same page", () => {
    // The prefix trap: `/folio-old` must not match `/folio`, or a launch would
    // attach to, and drive, the wrong tab.
    expect(samePage("https://origami.gratis/folio", "https://origami.gratis/folio-old")).toBe(false)
    expect(samePage("https://origami.gratis/folio", "https://origami.gratis/")).toBe(false)
    expect(samePage("https://origami.gratis/folio", "https://elsewhere.example/folio")).toBe(false)
  })
})
