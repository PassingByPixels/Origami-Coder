import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fsp from "fs/promises"
import { Effect } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { LayerNode } from "@origami/core/effect/layer-node"
import {
  appendTopicFact,
  bulletKey,
  firstHook,
  indexEntry,
  indexFooter,
  indexPath,
  indexedTopics,
  INBOX_HOOK,
  INDEX_HEADER,
  INDEX_SECTION,
  isIndexPath,
  memoryDir,
  migrateMemory,
  MIGRATED_FLAT_FILE,
  oneLineHook,
  pruneIndexEntries,
  topicPath,
  topicSlug,
  upsertIndexEntry,
} from "../../src/tool/memory-layout"
import { globalMemoryDir, globalMemoryPath, projectMemoryDir, projectMemoryPath } from "../../src/tool/remember"

const fsLayer = LayerNode.compile(FSUtil.node)

const run = <A, E>(effect: Effect.Effect<A, E, FSUtil.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(fsLayer)) as Effect.Effect<A, E, never>)

async function tmpOrigami(files: Record<string, string> = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "origami-memory-"))
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, content, "utf8")
  }
  return dir
}

const read = (file: string) => fsp.readFile(file, "utf8")
const exists = (file: string) =>
  fsp
    .stat(file)
    .then(() => true)
    .catch(() => false)

describe("memory layout paths", () => {
  test("index lives at <origami>/memory/MEMORY.md", () => {
    expect(indexPath(memoryDir("/home/me/.origami")).replace(/\\/g, "/")).toBe("/home/me/.origami/memory/MEMORY.md")
  })

  test("a topic file is <memdir>/<slug>.md", () => {
    expect(topicPath("/m", "Build Commands").replace(/\\/g, "/")).toBe("/m/build-commands.md")
  })

  test("slugs keep underscores so existing reference_/feedback_ files stay addressable", () => {
    expect(topicSlug("reference_gitea")).toBe("reference_gitea")
    expect(topicSlug("Spark vLLM!! notes")).toBe("spark-vllm-notes")
    expect(topicSlug("   ")).toBe("general")
    expect(topicSlug(undefined)).toBe("general")
  })

  test("only <...>/memory/MEMORY.md counts as the index", () => {
    expect(isIndexPath("/home/me/.origami/memory/MEMORY.md")).toBe(true)
    // An unrelated MEMORY.md in a repo must never be treated as the store.
    expect(isIndexPath("/repo/docs/MEMORY.md")).toBe(false)
    expect(isIndexPath("/home/me/.origami/memory/reference_gitea.md")).toBe(false)
  })

  test("the served footer names the read tool and the directory", () => {
    const footer = indexFooter("/home/me/.origami/memory")
    expect(footer).toContain("Read the topic file with the read tool for detail before acting on a hook.")
    expect(footer).toContain("/home/me/.origami/memory")
  })
})

describe("memory index entries", () => {
  test("lists the topics an index links to", () => {
    const index = `${INDEX_HEADER}\n\n## References\n- [reference_gitea](reference_gitea.md) - git host\n- [pi5](pi5.md) - the pi\n`
    expect(indexedTopics(index)).toEqual(["reference_gitea", "pi5"])
  })

  test("inserts a missing entry under a Topics section", () => {
    const next = upsertIndexEntry(INDEX_HEADER, "build", "bun test is the runner")
    expect(next).toContain(INDEX_SECTION)
    expect(indexedTopics(next)).toEqual(["build"])
    expect(next).toContain(indexEntry("build", "bun test is the runner"))
  })

  test("leaves an existing entry byte-identical — a curated hook is never clobbered", () => {
    const index = `${INDEX_HEADER}\n\n## References\n- [gitea](gitea.md) - the whole story of our git host\n`
    expect(upsertIndexEntry(index, "gitea", "some unrelated newest fact")).toBe(index)
  })

  test("a second insert joins the existing Topics section rather than starting another", () => {
    const one = upsertIndexEntry(INDEX_HEADER, "alpha", "first")
    const two = upsertIndexEntry(one, "beta", "second")
    expect(two.match(/## Topics/g)).toHaveLength(1)
    expect(indexedTopics(two)).toEqual(["alpha", "beta"])
  })

  test("inserts before the next section header, not at the end of the file", () => {
    const index = `${INDEX_HEADER}\n\n${INDEX_SECTION}\n- [alpha](alpha.md) - a\n\n## References\n- [gitea](gitea.md) - g\n`
    const next = upsertIndexEntry(index, "beta", "b")
    const lines = next.split("\n")
    expect(lines.indexOf("- [beta](beta.md) - b")).toBeLessThan(lines.indexOf("## References"))
  })

  test("prune drops entries whose topic file is gone and keeps the rest", () => {
    const index = `${INDEX_HEADER}\n\n## Topics\n- [alive](alive.md) - here\n- [dead](dead.md) - gone\n`
    const next = pruneIndexEntries(index, ["alive"])
    expect(indexedTopics(next)).toEqual(["alive"])
    expect(next).toContain(INDEX_HEADER)
  })

  test("hooks are one line and elided when long", () => {
    expect(oneLineHook("a\n  b\tc")).toBe("a b c")
    expect(oneLineHook("x".repeat(200)).length).toBe(160)
  })
})

describe("memory topic files", () => {
  test("creates a headed file from empty", () => {
    expect(appendTopicFact("", "build", "bun is the runner", "2026-08-05")).toBe(
      "# build\n\n- [2026-08-05] bun is the runner\n",
    )
  })

  test("appends without touching frontmatter or prose — the reason it is not normalizeStore", () => {
    const existing = "---\nname: reference_gitea\ndescription: git host\n---\n\n**Gitea**: creds live in the vault.\n"
    const next = appendTopicFact(existing, "reference_gitea", "port is 3000", "2026-08-05")
    expect(next).toContain("description: git host")
    expect(next).toContain("**Gitea**: creds live in the vault.")
    expect(next.trimEnd().endsWith("- [2026-08-05] port is 3000")).toBe(true)
  })

  test("keeps every bullet — topic files are uncapped because they load on demand", () => {
    let text = ""
    for (let i = 0; i < 150; i++) text = appendTopicFact(text, "big", `fact${i}`, "2026-08-05")
    expect(text.match(/^- .*/gm)).toHaveLength(150)
    expect(text).toContain("- [2026-08-05] fact0")
  })

  test("bulletKey ignores the date stamp and case so duplicates are detectable", () => {
    expect(bulletKey("- [2026-01-01] Bun Is The   Runner")).toBe(bulletKey("- [2026-08-05] bun is the runner"))
  })

  test("firstHook prefers frontmatter description, else the first real line", () => {
    expect(firstHook("---\nname: x\ndescription: the git host\n---\n\n# Heading\nbody\n")).toBe("the git host")
    expect(firstHook("# Heading\n\n- [2026-08-05] the first fact\n")).toBe("the first fact")
    expect(firstHook("")).toBe("")
  })
})

describe("dream's layout guard targets the same directory the reader loads", () => {
  // dream derives the memory dir from the FLAT store path it was written for
  // (dirname(storePath) + memoryDir). If that derivation is off by a level the
  // guard silently misses and dream overwrites a foldered store — the exact
  // corruption the guard exists to prevent. Both scopes are pinned here.
  const guarded = (flatStore: string) => memoryDir(path.dirname(flatStore))

  test("project scope", () => {
    expect(guarded(projectMemoryPath("/work/proj"))).toBe(projectMemoryDir("/work/proj"))
  })

  test("global scope", () => {
    expect(guarded(globalMemoryPath("/home/me/.origami"))).toBe(globalMemoryDir("/home/me/.origami"))
  })
})

describe("migrateMemory", () => {
  test("rescues uncovered flat bullets, keeps topic files, rebuilds the index, archives the flat file", async () => {
    const dir = await tmpOrigami({
      "memory.md": [
        "# Origami Memory",
        "",
        "- [2026-07-01] gitea runs on port 3000",
        "- [2026-07-02] a fact no topic file has",
        "- [2026-07-03] another orphan",
        "",
      ].join("\n"),
      "memory/reference_gitea.md": [
        "---",
        "name: reference_gitea",
        "description: self-hosted git host",
        "---",
        "",
        "- [2026-06-01] Gitea runs on port 3000",
        "",
      ].join("\n"),
      "memory/MEMORY.md": `${INDEX_HEADER}\n\n## References\n- [reference_gitea](reference_gitea.md) - self-hosted git host\n- [vanished](vanished.md) - file was deleted\n`,
    })

    const result = await run(migrateMemory(dir))

    // 1. the already-split topic file survives untouched
    const topic = await read(path.join(dir, "memory", "reference_gitea.md"))
    expect(topic).toContain("- [2026-06-01] Gitea runs on port 3000")
    expect(topic).not.toContain("2026-07-02")

    // 2. only the bullets no topic file covered are rescued, dated, into inbox
    expect(result.rescued).toBe(2)
    expect(result.skipped).toBe(1)
    const inbox = await read(path.join(dir, "memory", "inbox.md"))
    expect(inbox).toContain("- [2026-07-02] a fact no topic file has")
    expect(inbox).toContain("- [2026-07-03] another orphan")
    expect(inbox).not.toContain("gitea runs on port 3000")

    // 3. index lists every topic file, keeps the curated hook, drops the stale entry
    const index = await read(indexPath(memoryDir(dir)))
    expect(indexedTopics(index).sort()).toEqual(["inbox", "reference_gitea"])
    expect(index).toContain("- [reference_gitea](reference_gitea.md) - self-hosted git host")
    expect(index).not.toContain("vanished")

    // 4. the flat file is renamed, never deleted
    expect(await exists(path.join(dir, "memory.md"))).toBe(false)
    expect(result.flatArchived).toBe(path.join(dir, MIGRATED_FLAT_FILE))
    expect(await read(path.join(dir, MIGRATED_FLAT_FILE))).toContain("- [2026-07-02] a fact no topic file has")
  })

  test("builds the layout from a bare flat file with no prior split", async () => {
    const dir = await tmpOrigami({ "memory.md": "# Origami Memory\n\n- [2026-07-01] only fact\n" })

    const result = await run(migrateMemory(dir))

    expect(result.topics).toEqual(["inbox"])
    expect(await read(path.join(dir, "memory", "inbox.md"))).toContain("- [2026-07-01] only fact")
    // The inbox hook describes the BUCKET, not whichever fact landed first.
    expect(await read(indexPath(memoryDir(dir)))).toContain(`- [inbox](inbox.md) - ${INBOX_HOOK}`)
  })

  test("is idempotent — a second run rescues nothing and leaves the index listing the same topics", async () => {
    const dir = await tmpOrigami({ "memory.md": "# Origami Memory\n\n- [2026-07-01] only fact\n" })

    await run(migrateMemory(dir))
    const first = await read(indexPath(memoryDir(dir)))
    const second = await run(migrateMemory(dir))

    expect(second.rescued).toBe(0)
    expect(second.flatArchived).toBeUndefined()
    expect(await read(indexPath(memoryDir(dir)))).toBe(first)
    // the archive from run one is still there and still untouched
    expect(await read(path.join(dir, MIGRATED_FLAT_FILE))).toContain("- [2026-07-01] only fact")
  })

  test("an origami dir with no memory at all yields an empty index, not a crash", async () => {
    const dir = await tmpOrigami()

    const result = await run(migrateMemory(dir))

    expect(result.topics).toEqual([])
    expect(result.rescued).toBe(0)
    expect(result.flatArchived).toBeUndefined()
    expect(await read(indexPath(memoryDir(dir)))).toContain(INDEX_HEADER)
  })
})
