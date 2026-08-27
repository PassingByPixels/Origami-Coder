import { $ } from "bun"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { GitDiffTool, summarize } from "../../src/tool/git-diff"
import { Git } from "@/git"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test-git-diff-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Git.node, CrossSpawnSpawner.node, Truncate.node, Agent.node])),
)

const run = Effect.fn("GitDiffToolTest.run")(function* (args: Tool.InferParameters<typeof GitDiffTool>) {
  const info = yield* GitDiffTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const git = (dir: string, ...args: string[]) => Effect.promise(() => $`git ${args}`.cwd(dir).quiet().then(() => undefined))
const write = (p: string, text: string) => Effect.promise(() => fs.writeFile(p, text, "utf-8"))
const porcelain = (dir: string) =>
  Effect.promise(() => $`git status --porcelain`.cwd(dir).quiet().text())

describe("tool.git_diff", () => {
  it.instance(
    "reports no changes in a clean repository",
    () =>
      Effect.gen(function* () {
        const result = yield* run({})

        expect(result.output).toContain("Staged: 0 file(s), unstaged: 0 file(s), untracked: 0 file(s)")
        expect(result.output).toContain("No unstaged changes.")
        expect(result.metadata.empty).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "separates staged from unstaged changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "app.ts")
        yield* write(file, "const committed = 1\n")
        yield* git(test.directory, "add", "app.ts")
        yield* git(test.directory, "commit", "-m", "add app")

        yield* write(file, "const committed = 2\n")
        yield* git(test.directory, "add", "app.ts")
        yield* write(file, "const committed = 3\n")

        const staged = yield* run({ staged: true })
        const unstaged = yield* run({})

        // Staged shows 1 -> 2, unstaged shows 2 -> 3. Neither may contain the other's line.
        expect(staged.output).toContain("+const committed = 2")
        expect(staged.output).not.toContain("+const committed = 3")
        expect(unstaged.output).toContain("+const committed = 3")
        expect(unstaged.output).not.toContain("+const committed = 2")
        expect(staged.metadata.counts).toEqual({ staged: 1, unstaged: 1, untracked: 0 })
      }),
    { git: true },
  )

  it.instance(
    "says nothing is staged when nothing is staged",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "loose.txt"), "only in the working tree\n")

        const result = yield* run({ staged: true })

        expect(result.output).toContain("untracked: 1 file(s)")
        expect(result.output).toContain("No staged changes.")
        expect(result.metadata.empty).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "explains that untracked files do not show in an unstaged diff",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "loose.txt"), "brand new\n")

        const result = yield* run({})

        expect(result.output).toContain("Untracked files do not appear in a diff.")
      }),
    { git: true },
  )

  it.instance(
    "summarises per file when stat is set",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "app.ts")
        yield* write(file, "a\n")
        yield* git(test.directory, "add", "app.ts")
        yield* git(test.directory, "commit", "-m", "add app")
        yield* write(file, "a\nb\nc\n")

        const result = yield* run({ stat: true })

        expect(result.output).toContain("app.ts")
        expect(result.output).toContain("2 +")
        // A --stat summary must not carry the patch body.
        expect(result.output).not.toContain("@@")
      }),
    { git: true },
  )

  it.instance(
    "limits the diff to a path",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "one.txt"), "one\n")
        yield* write(path.join(test.directory, "two.txt"), "two\n")
        yield* git(test.directory, "add", ".")
        yield* git(test.directory, "commit", "-m", "two files")
        yield* write(path.join(test.directory, "one.txt"), "one changed\n")
        yield* write(path.join(test.directory, "two.txt"), "two changed\n")

        const result = yield* run({ path: "one.txt" })

        expect(result.output).toContain("one changed")
        expect(result.output).not.toContain("two changed")
      }),
    { git: true },
  )

  it.instance(
    "reports an empty result for a path with no changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "one.txt"), "one\n")
        yield* git(test.directory, "add", ".")
        yield* git(test.directory, "commit", "-m", "one file")

        const result = yield* run({ path: "one.txt" })

        expect(result.output).toContain("No unstaged changes under one.txt.")
      }),
    { git: true },
  )

  it.instance(
    "leaves the repository exactly as it found it",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "app.ts")
        yield* write(file, "a\n")
        yield* git(test.directory, "add", "app.ts")
        yield* write(path.join(test.directory, "loose.txt"), "loose\n")

        const before = yield* porcelain(test.directory)
        yield* run({})
        yield* run({ staged: true })
        yield* run({ stat: true })
        const after = yield* porcelain(test.directory)

        expect(after).toBe(before)
        expect(before).toContain("A  app.ts")
      }),
    { git: true },
  )

  it.instance("fails clearly outside a git repository", () =>
    Effect.gen(function* () {
      const exit = yield* run({}).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("Not a git repository")
    }),
  )

  it.live("counts index and worktree columns independently", () =>
    Effect.gen(function* () {
      expect(
        summarize([{ code: "M " }, { code: " M" }, { code: "MM" }, { code: "??" }, { code: "A " }]),
      ).toEqual({ staged: 3, unstaged: 2, untracked: 1 })
    }),
  )
})
