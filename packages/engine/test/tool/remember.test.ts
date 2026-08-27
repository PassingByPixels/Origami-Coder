import { describe, expect, test } from "bun:test"
import {
  appendFact,
  projectMemoryPath,
  globalMemoryPath,
  projectMemoryDir,
  globalMemoryDir,
} from "../../src/tool/remember"
import { indexPath, topicPath } from "../../src/tool/memory-layout"

const bullets = (s: string) => s.match(/^- .*/gm) ?? []

describe("remember.appendFact", () => {
  test("creates a headed file with a dated bullet from empty", () => {
    const out = appendFact("", "we use Effect-TS", "2026-07-06")
    expect(out).toContain("# Origami Memory")
    expect(bullets(out)).toEqual(["- [2026-07-06] we use Effect-TS"])
  })

  test("appends newest-last and preserves prior bullets", () => {
    const first = appendFact("", "build with bun", "2026-07-01")
    const second = appendFact(first, "test with vitest", "2026-07-02")
    expect(bullets(second)).toEqual(["- [2026-07-01] build with bun", "- [2026-07-02] test with vitest"])
    // header is not duplicated on re-write
    expect(second.match(/# Origami Memory/g)?.length).toBe(1)
  })

  test("caps at the most recent N, dropping the oldest", () => {
    const existing =
      "# Origami Memory\n\n" + Array.from({ length: 100 }, (_, i) => `- [2026-01-01] fact${i}`).join("\n") + "\n"
    const out = appendFact(existing, "the newest fact", "2026-07-06", 100)
    const b = bullets(out)
    expect(b.length).toBe(100)
    expect(b).not.toContain("- [2026-01-01] fact0") // oldest evicted
    expect(b).toContain("- [2026-01-01] fact99") // second-oldest survives
    expect(b[b.length - 1]).toBe("- [2026-07-06] the newest fact")
  })

  test("collapses whitespace/newlines in the fact to one line", () => {
    const out = appendFact("", "line one\n\n   spaced\ttabs", "2026-07-06")
    expect(bullets(out)).toEqual(["- [2026-07-06] line one spaced tabs"])
  })

  test("ignores non-bullet prose already in the file (agent-owned store)", () => {
    // A hand-added prose line is not a bullet and is normalised away on append.
    const out = appendFact("# Origami Memory\n\nsome stray note\n\n- [2026-05-01] kept", "new", "2026-07-06")
    expect(bullets(out)).toEqual(["- [2026-05-01] kept", "- [2026-07-06] new"])
  })
})

describe("remember memory paths", () => {
  const slash = (p: string) => p.replace(/\\/g, "/")

  test("LEGACY flat store paths (still read as a fallback, never written)", () => {
    expect(slash(projectMemoryPath("/work/proj"))).toBe("/work/proj/.origami/memory.md")
    expect(slash(globalMemoryPath("/home/me/.origami"))).toBe("/home/me/.origami/memory.md")
  })

  test("the store the tool WRITES is a folder, per scope", () => {
    expect(slash(projectMemoryDir("/work/proj"))).toBe("/work/proj/.origami/memory")
    expect(slash(globalMemoryDir("/home/me/.origami"))).toBe("/home/me/.origami/memory")
  })

  test("a fact lands in <memdir>/<topic>.md and the index sits beside it", () => {
    const memdir = projectMemoryDir("/work/proj")
    expect(slash(topicPath(memdir, "build commands"))).toBe("/work/proj/.origami/memory/build-commands.md")
    expect(slash(indexPath(memdir))).toBe("/work/proj/.origami/memory/MEMORY.md")
  })

  test("the flat store and the folder store are siblings, never the same file", () => {
    expect(slash(projectMemoryDir("/work/proj"))).not.toBe(slash(projectMemoryPath("/work/proj")))
  })
})
