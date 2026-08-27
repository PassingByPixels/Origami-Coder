import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fsp from "fs/promises"
import { Effect } from "effect"
import { FSUtil } from "@origami/core/fs-util"
import { LayerNode } from "@origami/core/effect/layer-node"
import {
  applyCandidate,
  diffStore,
  discardCandidate,
  mirrorStore,
  readCandidate,
  rejectReason,
  summaryHeadline,
  summaryText,
  type TopicChange,
} from "../../src/tool/dream-stage"
import { backupStamp, candidateDir, memoryDir, readStore, type StoreSnapshot } from "../../src/tool/memory-layout"

const fsLayer = LayerNode.compile(FSUtil.node)

const run = <A, E>(effect: Effect.Effect<A, E, FSUtil.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(fsLayer)) as Effect.Effect<A, E, never>)

async function tmpOrigami(files: Record<string, string> = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "origami-dream-"))
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, content, "utf8")
  }
  return dir
}

const exists = (file: string) =>
  fsp
    .stat(file)
    .then(() => true)
    .catch(() => false)

/** Whole-directory byte snapshot: filename -> base64 of the exact file bytes. */
async function bytesOf(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    out[entry.name] = (await fsp.readFile(path.join(dir, entry.name))).toString("base64")
  }
  return out
}

// ---------------------------------------------------------------------------
// A real-shaped foldered store: YAML-frontmatter topic files, a curated index
// with sections, and an inbox holding bullets that still need refiling.
// ---------------------------------------------------------------------------

const GITEA_HOOK = "self-hosted git host on the tailnet"
const BUILD_HOOK = "how the project builds and tests"

const LIVE_FILES = {
  "memory/MEMORY.md": [
    "# Memory Index",
    "",
    "## References",
    `- [reference_gitea](reference_gitea.md) - ${GITEA_HOOK}`,
    "",
    "## Topics",
    `- [build](build.md) - ${BUILD_HOOK}`,
    "- [inbox](inbox.md) - Unfiled bullets rescued from the old flat memory file — refile these into topics.",
    "",
  ].join("\n"),
  "memory/reference_gitea.md": [
    "---",
    "name: reference_gitea",
    `description: ${GITEA_HOOK}`,
    "---",
    "",
    "**Gitea** is the primary git host; GitHub is the public mirror.",
    "",
    "- [2026-06-01] gitea runs on port 3000",
    "- [2026-06-02] the tailnet address is 100.64.0.7",
    "",
  ].join("\n"),
  "memory/build.md": [
    "---",
    "name: build",
    `description: ${BUILD_HOOK}`,
    "---",
    "",
    "- [2026-06-03] bun test is the runner",
    "",
  ].join("\n"),
  "memory/inbox.md": [
    "# inbox",
    "",
    "- [2026-07-02] gitea mirrors are pushed after every meaningful change",
    "- [2026-07-03] prettier runs on the touched files only",
    "",
  ].join("\n"),
}

const snap = (index: string, topics: Record<string, string>): StoreSnapshot => ({
  index,
  topics: new Map(Object.entries(topics)),
})

const LIVE = snap(LIVE_FILES["memory/MEMORY.md"], {
  build: LIVE_FILES["memory/build.md"],
  inbox: LIVE_FILES["memory/inbox.md"],
  reference_gitea: LIVE_FILES["memory/reference_gitea.md"],
})

const NEW_GITEA_HOOK = "self-hosted git host on the tailnet, and the mirror-push rule"
const FORMATTING_HOOK = "formatting and lint conventions"

/**
 * The curation a model is meant to produce: the inbox is emptied by refiling
 * one bullet into an existing topic and one into a NEW topic, a bullet is
 * reworded, and the gitea hook is rewritten because its file grew a new
 * subject. Nothing is deleted.
 */
const CURATED = snap(
  [
    "# Memory Index",
    "",
    "## References",
    `- [reference_gitea](reference_gitea.md) - ${NEW_GITEA_HOOK}`,
    "",
    "## Topics",
    `- [build](build.md) - ${BUILD_HOOK}`,
    `- [formatting](formatting.md) - ${FORMATTING_HOOK}`,
    "",
  ].join("\n"),
  {
    build: [
      "---",
      "name: build",
      `description: ${BUILD_HOOK}`,
      "---",
      "",
      "- [2026-06-03] bun test is the test runner for this repo",
      "",
    ].join("\n"),
    formatting: [
      "---",
      "name: formatting",
      `description: ${FORMATTING_HOOK}`,
      "---",
      "",
      "- [2026-07-03] prettier runs on the touched files only",
      "",
    ].join("\n"),
    reference_gitea: [
      "---",
      "name: reference_gitea",
      `description: ${NEW_GITEA_HOOK}`,
      "---",
      "",
      "**Gitea** is the primary git host; GitHub is the public mirror.",
      "",
      "- [2026-06-01] gitea runs on port 3000",
      "- [2026-06-02] the tailnet address is 100.64.0.7",
      "- [2026-07-02] gitea mirrors are pushed after every meaningful change",
      "",
    ].join("\n"),
  },
)

const topicOf = (topics: readonly TopicChange[], name: string) => topics.find((topic) => topic.topic === name)!

describe("dream-stage.diffStore", () => {
  test("an untouched copy of the store proposes nothing", () => {
    const diff = diffStore(LIVE, LIVE)
    expect(diff.changed).toBe(false)
    expect(diff.dropped).toEqual([])
    expect(diff.topics.every((topic) => topic.status === "unchanged")).toBe(true)
  })

  test("refiling the inbox reports MOVES, never drops — the fact just lives elsewhere now", () => {
    const diff = diffStore(LIVE, CURATED)

    // Both inbox bullets left; neither is lost.
    const inbox = topicOf(diff.topics, "inbox")
    expect(inbox.status).toBe("removed")
    expect(inbox.movedOut).toBe(2)
    expect(inbox.dropped).toEqual([])

    // One landed in an existing topic, one in a topic that did not exist.
    expect(topicOf(diff.topics, "reference_gitea").movedIn).toBe(1)
    const formatting = topicOf(diff.topics, "formatting")
    expect(formatting.status).toBe("new")
    expect(formatting.movedIn).toBe(1)
    // A refiled bullet is NOT also counted as invented content.
    expect(formatting.added).toBe(0)

    expect(diff.dropped).toEqual([])
    expect(diff.changed).toBe(true)
  })

  test("a rewritten bullet is reworded, not dropped-and-added", () => {
    const build = topicOf(diffStore(LIVE, CURATED).topics, "build")
    expect(build.reworded).toBe(1)
    expect(build.added).toBe(0)
    expect(build.dropped).toEqual([])
  })

  test("a hook the candidate rewrites is surfaced in full; an untouched hook is not", () => {
    const diff = diffStore(LIVE, CURATED)
    expect(topicOf(diff.topics, "reference_gitea").hook).toBe(NEW_GITEA_HOOK)
    expect(topicOf(diff.topics, "formatting").hook).toBe(FORMATTING_HOOK)
    // build's hook is byte-identical in both indexes — nothing to show.
    expect(topicOf(diff.topics, "build").hook).toBeUndefined()
  })

  test("a genuinely deleted fact is reported verbatim, per topic and store-wide", () => {
    const pruned = snap(LIVE.index, {
      ...Object.fromEntries(LIVE.topics),
      reference_gitea: LIVE_FILES["memory/reference_gitea.md"].replace(
        "- [2026-06-02] the tailnet address is 100.64.0.7\n",
        "",
      ),
    })
    const diff = diffStore(LIVE, pruned)

    expect(diff.dropped).toEqual([
      { topic: "reference_gitea", bullet: "- [2026-06-02] the tailnet address is 100.64.0.7" },
    ])
    expect(topicOf(diff.topics, "reference_gitea").dropped).toEqual([
      "- [2026-06-02] the tailnet address is 100.64.0.7",
    ])
    expect(diff.changed).toBe(true)
  })

  test("an orphaned topic file — dropped from the index but left on disk — is reported", () => {
    // The facts survive on disk but the model only ever loads the index, so a
    // topic missing from it is unreachable. Silence here would be a data loss
    // the summary never mentions.
    const orphaned = snap(LIVE.index.replace(`- [build](build.md) - ${BUILD_HOOK}\n`, ""), {
      ...Object.fromEntries(LIVE.topics),
    })
    const build = topicOf(diffStore(LIVE, orphaned).topics, "build")
    expect(build.unlisted).toBe(true)
    expect(build.status).toBe("changed")
    expect(summaryText(diffStore(LIVE, orphaned))).toContain("NOT LISTED IN THE INDEX")
  })

  test("prose and frontmatter edits are reported even when no bullet moves", () => {
    const edited = snap(LIVE.index, {
      ...Object.fromEntries(LIVE.topics),
      reference_gitea: LIVE_FILES["memory/reference_gitea.md"].replace(
        "**Gitea** is the primary git host; GitHub is the public mirror.",
        "**Gitea** is the primary git host.",
      ),
    })
    const diff = diffStore(LIVE, edited)
    expect(topicOf(diff.topics, "reference_gitea").proseChanged).toBe(true)
    expect(diff.dropped).toEqual([])
    expect(diff.changed).toBe(true)
  })

  test("merging a duplicate is NOT a drop — the fact still exists in the surviving copy", () => {
    // Deduplication is the whole point of a dream pass. Reporting the folded
    // copy as a DROPPED fact would cry wolf on the one signal that has to mean
    // "this fact is about to be lost".
    const before = snap("# Memory Index\n\n## Topics\n- [general](general.md) - misc\n", {
      general: [
        "# general",
        "",
        "- [2026-01-01] gitea runs on port 3000",
        "- [2026-02-02] Gitea runs on port 3000",
        "",
      ].join("\n"),
    })
    const after = snap("# Memory Index\n\n## Topics\n- [general](general.md) - misc\n", {
      general: "# general\n\n- [2026-01-01] gitea runs on port 3000\n",
    })

    const diff = diffStore(before, after)
    expect(diff.dropped).toEqual([])
    expect(topicOf(diff.topics, "general").merged).toBe(1)
    expect(topicOf(diff.topics, "general").status).toBe("changed")
    expect(summaryText(diff)).toContain("1 duplicate(s) merged")
    expect(summaryText(diff)).toContain("No facts are dropped")
  })

  test("two unrelated facts are not paired as a reword — an unmatched fact stays a drop", () => {
    const before = snap("# Memory Index\n", { general: "# general\n\n- [2026-01-01] the pi runs kodi on port 8080\n" })
    const after = snap("# Memory Index\n", { general: "# general\n\n- [2026-01-02] crossfit sessions are at 12:30\n" })
    const diff = diffStore(before, after)
    expect(diff.dropped).toHaveLength(1)
    expect(topicOf(diff.topics, "general").added).toBe(1)
    expect(topicOf(diff.topics, "general").reworded).toBe(0)
  })

  test("an empty store gaining its first topic is all additions", () => {
    const diff = diffStore(
      snap("", {}),
      snap("# Memory Index\n\n## Topics\n- [build](build.md) - runs\n", {
        build: "# build\n\n- [2026-08-05] bun is the runner\n",
      }),
    )
    expect(topicOf(diff.topics, "build").status).toBe("new")
    expect(topicOf(diff.topics, "build").added).toBe(1)
    expect(diff.dropped).toEqual([])
  })
})

describe("dream-stage.summaryText", () => {
  test("the counts it prints are the counts in the diff", () => {
    const diff = diffStore(LIVE, CURATED)
    const summary = summaryText(diff)

    expect(summary).toContain("inbox (TOPIC REMOVED): 2 moved out")
    expect(summary).toContain("formatting (NEW TOPIC)")
    expect(summary).toContain("1 moved in")
    expect(summary).toContain("1 reworded")
    expect(summary).toContain(`    hook: ${NEW_GITEA_HOOK}`)
    // Nothing was lost, and it says so rather than staying silent.
    expect(summary).toContain("No facts are dropped")
  })

  test("every dropped fact is listed verbatim under an explicit heading", () => {
    const pruned = snap(LIVE.index, {
      ...Object.fromEntries(LIVE.topics),
      build: "---\nname: build\ndescription: how the project builds and tests\n---\n",
    })
    const summary = summaryText(diffStore(LIVE, pruned))
    expect(summary).toContain("DROPPED — these facts survive nowhere in the candidate (1):")
    expect(summary).toContain("[build] - [2026-06-03] bun test is the runner")
  })

  test("the headline totals match the per-topic detail", () => {
    expect(summaryHeadline(diffStore(LIVE, CURATED))).toBe(
      "0 added, 2 refiled, 1 reworded, 0 dropped, 1 new topic(s), 1 removed topic(s)",
    )
  })
})

describe("dream-stage.rejectReason", () => {
  test("refuses a candidate with no topic files while the store has some", () => {
    expect(rejectReason(LIVE, snap("# Memory Index\n", {}))).toContain("no topic files")
  })

  test("refuses a candidate with no index — the adopted store would be unreadable", () => {
    expect(rejectReason(LIVE, snap("", Object.fromEntries(LIVE.topics)))).toContain("MEMORY.md")
  })

  test("passes a healthy candidate", () => {
    expect(rejectReason(LIVE, CURATED)).toBeUndefined()
  })

  test("a first-ever store (nothing live) is not blocked by the guard", () => {
    expect(rejectReason(snap("", {}), snap("", {}))).toBeUndefined()
  })
})

describe("dream-stage.backupStamp", () => {
  test("has no characters Windows forbids in a filename", () => {
    const stamp = backupStamp(new Date("2026-08-05T14:30:12.345Z"))
    expect(stamp).toBe("20260805-143012")
    expect(stamp).not.toMatch(/[:*?"<>|\\/]/)
  })
})

describe("dream-stage.mirrorStore", () => {
  test("seeds the candidate with a byte-exact copy of the live store", async () => {
    const dir = await tmpOrigami(LIVE_FILES)

    const result = await run(mirrorStore(dir))

    expect(result.candidate).toBe(candidateDir(dir))
    expect(result.files).toBe(3)
    expect(await bytesOf(candidateDir(dir))).toEqual(await bytesOf(memoryDir(dir)))
  })

  test("a mirror straight back through readStore is a no-change diff", async () => {
    const dir = await tmpOrigami(LIVE_FILES)
    await run(mirrorStore(dir))

    const diff = await run(
      Effect.gen(function* () {
        return diffStore(yield* readStore(memoryDir(dir)), yield* readCandidate(dir))
      }),
    )

    expect(diff.changed).toBe(false)
    expect(diff.dropped).toEqual([])
  })

  test("clears a stale candidate from an abandoned pass before seeding", async () => {
    const dir = await tmpOrigami({ ...LIVE_FILES, "memory.candidate/leftover.md": "# leftover\n\n- [2026-01-01] x\n" })

    await run(mirrorStore(dir))

    expect(await exists(path.join(candidateDir(dir), "leftover.md"))).toBe(false)
    expect(await exists(path.join(candidateDir(dir), "build.md"))).toBe(true)
  })
})

describe("dream-stage.applyCandidate", () => {
  /** Stage a mirror, then apply the CURATED shape on top of it. */
  async function stageCurated(dir: string) {
    await run(mirrorStore(dir))
    const cdir = candidateDir(dir)
    await fsp.writeFile(path.join(cdir, "MEMORY.md"), CURATED.index, "utf8")
    for (const [name, text] of CURATED.topics) await fsp.writeFile(path.join(cdir, `${name}.md`), text, "utf8")
    await fsp.rm(path.join(cdir, "inbox.md"))
  }

  test("backs the live store up byte-for-byte BEFORE replacing it, then clears the candidate", async () => {
    const dir = await tmpOrigami(LIVE_FILES)
    const before = await bytesOf(memoryDir(dir))
    await stageCurated(dir)

    const result = await run(applyCandidate(dir, new Date("2026-08-05T14:30:12.000Z")))

    // 1. the backup is the store as it was, byte for byte
    expect(result.backup).toBe(path.join(dir, "memory.bak-20260805-143012"))
    expect(await bytesOf(result.backup)).toEqual(before)

    // 2. the live store is now the candidate
    const live = await fsp.readFile(path.join(memoryDir(dir), "reference_gitea.md"), "utf8")
    expect(live).toContain("- [2026-07-02] gitea mirrors are pushed after every meaningful change")
    expect(await fsp.readFile(path.join(memoryDir(dir), "formatting.md"), "utf8")).toContain("prettier runs")
    expect(await fsp.readFile(path.join(memoryDir(dir), "MEMORY.md"), "utf8")).toContain(NEW_GITEA_HOOK)

    // 3. a topic the candidate dropped is gone from the live store, not left behind
    expect(await exists(path.join(memoryDir(dir), "inbox.md"))).toBe(false)
    expect(result.removed).toBe(1)
    expect(result.written).toBe(4)

    // 4. the candidate has served its purpose
    expect(await exists(candidateDir(dir))).toBe(false)
  })

  test("a second approve in the same second gets a DISTINCT backup — the first is never overwritten", async () => {
    const dir = await tmpOrigami(LIVE_FILES)
    const when = new Date("2026-08-05T14:30:12.000Z")
    const original = await bytesOf(memoryDir(dir))

    await stageCurated(dir)
    const first = await run(applyCandidate(dir, when))

    // Second pass: curate again from the now-adopted store.
    await run(mirrorStore(dir))
    await fsp.writeFile(path.join(candidateDir(dir), "build.md"), "# build\n\n- [2026-08-05] second pass\n", "utf8")
    const second = await run(applyCandidate(dir, when))

    expect(second.backup).not.toBe(first.backup)
    expect(second.backup).toBe(path.join(dir, "memory.bak-20260805-143012-2"))
    // The first backup still holds the ORIGINAL store, untouched by pass two.
    expect(await bytesOf(first.backup)).toEqual(original)
    expect(await fsp.readFile(path.join(second.backup, "build.md"), "utf8")).toContain("bun test is the test runner")
  })

  test("applies without a candidate index only when the caller allowed it — an empty candidate empties nothing", async () => {
    // rejectReason is the gate; applyCandidate itself is deliberately dumb.
    // This pins that the gate, not luck, is what protects the store.
    const dir = await tmpOrigami(LIVE_FILES)
    const live = await run(readStore(memoryDir(dir)))
    await run(mirrorStore(dir))
    for (const name of ["MEMORY.md", "build.md", "inbox.md", "reference_gitea.md"])
      await fsp.rm(path.join(candidateDir(dir), name))

    expect(rejectReason(live, await run(readCandidate(dir)))).toContain("no topic files")
  })
})

describe("dream-stage.discardCandidate", () => {
  test("deletes the draft and leaves the live store byte-identical", async () => {
    const dir = await tmpOrigami(LIVE_FILES)
    const before = await bytesOf(memoryDir(dir))
    await run(mirrorStore(dir))
    await fsp.writeFile(path.join(candidateDir(dir), "build.md"), "# build\n\n- [2026-08-05] wrecked\n", "utf8")

    await run(discardCandidate(dir))

    expect(await exists(candidateDir(dir))).toBe(false)
    expect(await bytesOf(memoryDir(dir))).toEqual(before)
  })

  test("discarding when nothing is staged is a no-op, not an error", async () => {
    const dir = await tmpOrigami(LIVE_FILES)
    const before = await bytesOf(memoryDir(dir))
    await run(discardCandidate(dir))
    expect(await bytesOf(memoryDir(dir))).toEqual(before)
  })
})
