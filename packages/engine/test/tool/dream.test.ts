import { describe, expect } from "bun:test"
import path from "path"
import fsp from "fs/promises"
import { Effect, Fiber, Layer } from "effect"
import { Database } from "@origami/core/database/database"
import { FSUtil } from "@origami/core/fs-util"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { SessionProjector } from "@origami/core/session/projector"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Question } from "../../src/question"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { Truncate } from "@/tool/truncate"
import { DreamTool } from "../../src/tool/dream"
import { candidateDir, memoryDir } from "../../src/tool/memory-layout"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// DreamTool captures FSUtil / Session / Question at define time and resolves the
// instance inside execute, so the stack it needs is: the session store (Database
// + projector), the question service, and the Tool.define wrapper's own
// Truncate + Agent.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      Database.node,
      EventV2Bridge.node,
      Question.node,
      FSUtil.node,
      Truncate.node,
      Agent.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_dream-test"),
  messageID: MessageID.make("msg_dream-test"),
  callID: "dream-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const dream = Effect.gen(function* () {
  const info = yield* DreamTool
  return yield* info.init()
})

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

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, content, "utf8")
  }
}

const GITEA_HOOK = "self-hosted git host on the tailnet"

/** A real-shaped foldered store: frontmatter topic files + an unfiled inbox. */
const FOLDERED = {
  ".origami/memory/MEMORY.md": [
    "# Memory Index",
    "",
    "## References",
    `- [reference_gitea](reference_gitea.md) - ${GITEA_HOOK}`,
    "",
    "## Topics",
    "- [inbox](inbox.md) - Unfiled bullets rescued from the old flat memory file — refile these into topics.",
    "",
  ].join("\n"),
  ".origami/memory/reference_gitea.md": [
    "---",
    "name: reference_gitea",
    `description: ${GITEA_HOOK}`,
    "---",
    "",
    "- [2026-06-01] gitea runs on port 3000",
    "",
  ].join("\n"),
  ".origami/memory/inbox.md": [
    "# inbox",
    "",
    "- [2026-07-02] gitea mirrors are pushed after every meaningful change",
    "",
  ].join("\n"),
}

/** The curation a model would perform inside the staged candidate directory. */
async function curateCandidate(dir: string) {
  const cdir = candidateDir(path.join(dir, ".origami"))
  await fsp.writeFile(
    path.join(cdir, "reference_gitea.md"),
    [
      "---",
      "name: reference_gitea",
      "description: self-hosted git host, and the mirror-push rule",
      "---",
      "",
      "- [2026-06-01] gitea runs on port 3000",
      "- [2026-07-02] gitea mirrors are pushed after every meaningful change",
      "",
    ].join("\n"),
    "utf8",
  )
  await fsp.writeFile(
    path.join(cdir, "MEMORY.md"),
    [
      "# Memory Index",
      "",
      "## References",
      "- [reference_gitea](reference_gitea.md) - self-hosted git host, and the mirror-push rule",
      "",
    ].join("\n"),
    "utf8",
  )
  await fsp.rm(path.join(cdir, "inbox.md"))
}

/** Answer the pending dream question with one label. */
const answer = (label: string) =>
  Effect.gen(function* () {
    const question = yield* Question.Service
    const item = yield* pollWithTimeout(
      question.list().pipe(Effect.map((items) => items[0])),
      `dream never asked a question (expected to answer "${label}")`,
    )
    expect(item.questions[0].options.map((option) => option.label)).toEqual(["Approve", "Revise", "Disapprove"])
    yield* question.reply({ requestID: item.id, answers: [[label]] })
    return item
  })

describe("dream tool — foldered store", () => {
  it.instance(
    "gather stages a candidate mirroring the live store and tells the model to refile the inbox",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* Effect.promise(() => writeFiles(directory, FOLDERED))
        const tool = yield* dream

        const result = yield* tool.execute({ action: "gather" }, ctx)

        // The store under test is the one inside this tmp instance — if the
        // layout probe missed, the flat path would have run against a different
        // directory and every later assertion would be meaningless.
        expect(result.metadata.layout).toBe("foldered")
        expect(result.metadata.storePath).toBe(memoryDir(path.join(directory, ".origami")))

        const memdir = memoryDir(path.join(directory, ".origami"))
        const cdir = candidateDir(path.join(directory, ".origami"))
        expect(result.metadata.candidateDir).toBe(cdir)
        // A directory is staged, so no candidatePath — nothing may key a
        // file-vs-file diff off it.
        expect(result.metadata.candidatePath).toBeUndefined()

        // The candidate is a byte-exact mirror: curation starts from the store,
        // never from a blank page.
        expect(yield* Effect.promise(() => bytesOf(cdir))).toEqual(yield* Effect.promise(() => bytesOf(memdir)))

        // The instructions name the actual work, and the store is echoed back.
        expect(result.output).toContain("REFILE inbox.md")
        expect(result.output).toContain("EVERY EXISTING FACT MUST REMAIN FINDABLE")
        expect(result.output).toContain("- [2026-07-02] gitea mirrors are pushed after every meaningful change")
        expect(result.output).toContain(GITEA_HOOK)
      }),
    { git: true },
  )

  it.instance(
    "review summarises the staged diff, and Approve backs the store up before replacing it",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* Effect.promise(() => writeFiles(directory, FOLDERED))
        const origami = path.join(directory, ".origami")
        const memdir = memoryDir(origami)
        const tool = yield* dream

        yield* tool.execute({ action: "gather" }, ctx)
        const before = yield* Effect.promise(() => bytesOf(memdir))
        yield* Effect.promise(() => curateCandidate(directory))

        const fiber = yield* tool.execute({ action: "review" }, ctx).pipe(Effect.forkScoped)
        const asked = yield* answer("Approve")
        const result = yield* Fiber.join(fiber)

        // The user was shown the per-topic change summary, not a bare count.
        const prompt = asked.questions[0].question
        expect(prompt).toContain("1 refiled")
        expect(prompt).toContain("inbox (TOPIC REMOVED): 1 moved out")
        expect(prompt).toContain("hook: self-hosted git host, and the mirror-push rule")
        expect(prompt).toContain("No facts are dropped")

        // The backup holds the store EXACTLY as it was before the approve.
        const backup = result.metadata.backupDir as string
        expect(backup.startsWith(path.join(origami, "memory.bak-"))).toBe(true)
        expect(yield* Effect.promise(() => bytesOf(backup))).toEqual(before)

        // The live store is now the curated version, and the draft is gone.
        const gitea = yield* Effect.promise(() => fsp.readFile(path.join(memdir, "reference_gitea.md"), "utf8"))
        expect(gitea).toContain("- [2026-07-02] gitea mirrors are pushed after every meaningful change")
        expect(yield* Effect.promise(() => exists(path.join(memdir, "inbox.md")))).toBe(false)
        expect(yield* Effect.promise(() => exists(candidateDir(origami)))).toBe(false)
        expect(result.title).toBe("dream: adopted")
      }),
    { git: true },
  )

  it.instance(
    "Disapprove leaves the store byte-identical and deletes the draft",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* Effect.promise(() => writeFiles(directory, FOLDERED))
        const origami = path.join(directory, ".origami")
        const memdir = memoryDir(origami)
        const tool = yield* dream

        yield* tool.execute({ action: "gather" }, ctx)
        const before = yield* Effect.promise(() => bytesOf(memdir))
        yield* Effect.promise(() => curateCandidate(directory))

        const fiber = yield* tool.execute({ action: "review" }, ctx).pipe(Effect.forkScoped)
        yield* answer("Disapprove")
        const result = yield* Fiber.join(fiber)

        expect(result.title).toBe("dream: discarded")
        expect(yield* Effect.promise(() => bytesOf(memdir))).toEqual(before)
        expect(yield* Effect.promise(() => exists(candidateDir(origami)))).toBe(false)
        // Nothing was backed up either — a backup implies the store changed.
        const entries = yield* Effect.promise(() => fsp.readdir(origami))
        expect(entries.filter((name) => name.startsWith("memory.bak-"))).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "Revise keeps both the store and the draft so the steer can be applied to it",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* Effect.promise(() => writeFiles(directory, FOLDERED))
        const origami = path.join(directory, ".origami")
        const memdir = memoryDir(origami)
        const tool = yield* dream

        yield* tool.execute({ action: "gather" }, ctx)
        const before = yield* Effect.promise(() => bytesOf(memdir))
        yield* Effect.promise(() => curateCandidate(directory))

        const fiber = yield* tool.execute({ action: "review" }, ctx).pipe(Effect.forkScoped)
        yield* answer("Revise")
        const result = yield* Fiber.join(fiber)

        expect(result.title).toBe("dream: revise")
        expect(yield* Effect.promise(() => bytesOf(memdir))).toEqual(before)
        // The draft survives — a foldered candidate is many edits' work.
        expect(yield* Effect.promise(() => exists(path.join(candidateDir(origami), "reference_gitea.md")))).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "a gather with nothing to curate stages nothing and says so",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        // An index, but no topic files, and no sessions in this fresh instance.
        yield* Effect.promise(() => writeFiles(directory, { ".origami/memory/MEMORY.md": "# Memory Index\n" }))
        const tool = yield* dream

        const result = yield* tool.execute({ action: "gather" }, ctx)

        expect(result.title).toBe("dream: nothing to curate")
        expect(result.output).toContain("nothing to curate")
        expect(result.output).toContain("NOTHING was staged")
        expect(yield* Effect.promise(() => exists(candidateDir(path.join(directory, ".origami"))))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "review with no staged candidate refuses rather than diffing against nothing",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* Effect.promise(() => writeFiles(directory, FOLDERED))
        const tool = yield* dream

        const result = yield* tool.execute({ action: "review" }, ctx)

        expect(result.title).toBe("dream: no candidate")
        expect(result.output).toContain('action:"gather"')
      }),
    { git: true },
  )

  it.instance(
    "a candidate identical to the store asks nothing and discards the draft",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* Effect.promise(() => writeFiles(directory, FOLDERED))
        const origami = path.join(directory, ".origami")
        const tool = yield* dream

        yield* tool.execute({ action: "gather" }, ctx)
        // No curation at all — the mirror is left exactly as staged.
        const result = yield* tool.execute({ action: "review" }, ctx)

        expect(result.title).toBe("dream: no changes")
        expect(yield* Effect.promise(() => exists(candidateDir(origami)))).toBe(false)
      }),
    { git: true },
  )
})

describe("dream tool — legacy flat store", () => {
  it.instance(
    "gather -> write candidate -> review -> Approve still adopts the single file",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const store = path.join(directory, ".origami", "memory.md")
        const candidate = path.join(directory, ".origami", "memory.candidate.md")
        yield* Effect.promise(() =>
          writeFiles(directory, {
            ".origami/memory.md": "# Origami Memory\n\n- [2026-06-01] gitea runs on port 3000\n",
          }),
        )
        const tool = yield* dream

        const gathered = yield* tool.execute({ action: "gather" }, ctx)
        expect(gathered.metadata.layout).toBe("flat")
        expect(gathered.metadata.storePath).toBe(store)
        expect(gathered.output).toContain("- [2026-06-01] gitea runs on port 3000")
        expect(gathered.output).toContain("memory.candidate.md")
        // No directory is staged for a flat store.
        expect(yield* Effect.promise(() => exists(candidateDir(path.join(directory, ".origami"))))).toBe(false)

        yield* Effect.promise(() =>
          fsp.writeFile(
            candidate,
            "# Origami Memory\n\n- [2026-06-01] gitea runs on port 3000\n- [2026-08-05] prettier runs on touched files\n",
            "utf8",
          ),
        )

        const fiber = yield* tool.execute({ action: "review" }, ctx).pipe(Effect.forkScoped)
        const asked = yield* answer("Approve")
        const result = yield* Fiber.join(fiber)

        expect(asked.questions[0].question).toContain("1 -> 2 bullets")
        expect(result.title).toBe("dream: adopted")
        const adopted = yield* Effect.promise(() => fsp.readFile(store, "utf8"))
        expect(adopted).toContain("- [2026-08-05] prettier runs on touched files")
        // The flat backup is the single sibling file, not a directory.
        const backedUp = yield* Effect.promise(() =>
          fsp.readFile(path.join(directory, ".origami", "memory.bak.md"), "utf8"),
        )
        expect(backedUp).toBe("# Origami Memory\n\n- [2026-06-01] gitea runs on port 3000\n")
        expect(yield* Effect.promise(() => exists(candidate))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "a flat candidate that normalises to zero bullets is still refused",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* Effect.promise(() =>
          writeFiles(directory, {
            ".origami/memory.md": "# Origami Memory\n\n- [2026-06-01] gitea runs on port 3000\n",
            ".origami/memory.candidate.md": "# Origami Memory\n\n* not a top level bullet\n",
          }),
        )
        const tool = yield* dream

        const result = yield* tool.execute({ action: "review" }, ctx)

        expect(result.title).toBe("dream: candidate rejected")
        const store = yield* Effect.promise(() => fsp.readFile(path.join(directory, ".origami", "memory.md"), "utf8"))
        expect(store).toBe("# Origami Memory\n\n- [2026-06-01] gitea runs on port 3000\n")
      }),
    { git: true },
  )
})
