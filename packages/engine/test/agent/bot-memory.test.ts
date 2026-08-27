import { describe, expect, test } from "bun:test"
import path from "path"
import { AgentBotMemory } from "../../src/agent/bot-memory"

/**
 * PER-BOT MEMORY: where it lives, and the fence around it.
 *
 * The incident class this exists to close: a memory writer that takes a
 * caller-supplied name and joins it onto a root will write anywhere the process
 * can reach the moment that name contains `..` or a drive letter. Every write
 * below goes through ONE resolver, and the resolver is what these tests attack.
 *
 * Pure paths only — no test here touches a real user directory.
 */

const slash = (p: string) => p.replace(/\\/g, "/")

describe("AgentBotMemory — where a bot's store lives", () => {
  test("the config directory is derived from the DEFINITION file, so it is keyed to the def", () => {
    expect(slash(AgentBotMemory.configDirOfDef("/cfg/origami/agent/crane.md", "crane") ?? "")).toBe("/cfg/origami")
  })

  test("a nested definition still resolves to the config directory above `agent/`", () => {
    expect(slash(AgentBotMemory.configDirOfDef("/cfg/origami/agents/team/crane.md", "team/crane") ?? "")).toBe(
      "/cfg/origami",
    )
  })

  test("a file outside an agent directory has no bot root at all", () => {
    expect(AgentBotMemory.configDirOfDef("/cfg/origami/notagent/crane.md", "crane")).toBeUndefined()
  })

  test("a name that does not match the file is refused rather than guessed", () => {
    expect(AgentBotMemory.configDirOfDef("/cfg/origami/agent/crane.md", "heron")).toBeUndefined()
  })

  test("the store is a SIBLING of agent/, never inside it — the def glob must not see it", () => {
    const dir = slash(AgentBotMemory.memoryDir("/cfg/origami", "crane"))
    expect(dir).toBe("/cfg/origami/bot/crane/memory")
    expect(dir).not.toContain("/agent/")
  })

  test("a nested slug is flattened to one filesystem-safe segment", () => {
    expect(AgentBotMemory.slug("team/crane")).toBe("team-crane")
    expect(AgentBotMemory.slug("Odd Name!")).toBe("odd-name")
  })
})

describe("AgentBotMemory.resolveInRoot — the fence", () => {
  const root = path.resolve("/cfg/origami/bot/crane/memory")

  test("an ordinary topic file resolves inside the root", () => {
    expect(slash(AgentBotMemory.resolveInRoot(root, "general.md")).endsWith("/bot/crane/memory/general.md")).toBe(true)
  })

  test("REFUSES a parent-directory escape", () => {
    expect(() => AgentBotMemory.resolveInRoot(root, "../escape.md")).toThrow(AgentBotMemory.OutsideRootError)
  })

  test("REFUSES an escape hidden mid-path", () => {
    expect(() => AgentBotMemory.resolveInRoot(root, "a/../../../escape.md")).toThrow(AgentBotMemory.OutsideRootError)
  })

  test("REFUSES an absolute path, which would ignore the root entirely", () => {
    const absolute = process.platform === "win32" ? "C:/Windows/evil.md" : "/etc/evil.md"
    expect(() => AgentBotMemory.resolveInRoot(root, absolute)).toThrow(AgentBotMemory.OutsideRootError)
  })

  test("REFUSES a sibling directory that merely shares the root's prefix", () => {
    // `<root>-evil` starts with `<root>` as a STRING but is not inside it.
    expect(() => AgentBotMemory.resolveInRoot(root, "../memory-evil/x.md")).toThrow(AgentBotMemory.OutsideRootError)
  })

  test("the root itself is not a writable target", () => {
    expect(() => AgentBotMemory.resolveInRoot(root, "")).toThrow(AgentBotMemory.OutsideRootError)
  })
})

describe("AgentBotMemory.topicFile — every write name goes through the fence", () => {
  const root = path.resolve("/cfg/origami/bot/crane/memory")

  test("a traversal topic cannot leave the root", () => {
    const target = AgentBotMemory.topicFile(root, "../../../etc/passwd")
    expect(slash(target).startsWith(slash(root))).toBe(true)
  })

  test("a topic that slugs away to nothing lands on the default topic", () => {
    expect(path.basename(AgentBotMemory.topicFile(root, "///"))).toBe("general.md")
  })
})

describe("AgentBotMemory.block — the read seam is bounded", () => {
  const bullet = (date: string, text: string) => ({ topic: "general", line: `- [${date}] ${text}` })

  test("newest first, so a cap drops the OLDEST fact", () => {
    const out = AgentBotMemory.block("/m", [bullet("2026-01-01", "old"), bullet("2026-08-01", "new")], {
      maxEntries: 1,
      maxBytes: 10_000,
    })
    expect(out).toContain("new")
    expect(out).not.toContain("old")
  })

  test("a byte cap truncates the block rather than sending it whole", () => {
    const many = Array.from({ length: 200 }, (_, i) => bullet("2026-08-01", `fact number ${i} with padding`))
    const out = AgentBotMemory.block("/m", many, { maxEntries: 500, maxBytes: 400 }) ?? ""
    expect(out.length).toBeLessThanOrEqual(600)
    expect(out).toContain("fact number 0")
  })

  test("no facts means NO block — an empty store costs zero tokens", () => {
    expect(AgentBotMemory.block("/m", [], { maxEntries: 10, maxBytes: 100 })).toBeUndefined()
  })

  test("the block names the directory so the bot can read further on its own", () => {
    const out = AgentBotMemory.block("/m", [bullet("2026-08-01", "kept")], { maxEntries: 10, maxBytes: 1000 }) ?? ""
    expect(out).toContain("/m")
  })
})
