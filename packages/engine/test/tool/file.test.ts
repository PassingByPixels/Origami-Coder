import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@origami/core/effect/layer-node"
import { PermissionV1 } from "@origami/core/v1/permission"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { FileTool, movePath, samePath } from "../../src/tool/file"
import { FSUtil } from "@origami/core/fs-util"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type Ask = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

const base = {
  sessionID: SessionID.make("ses_test-file-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

/** Records every permission ask; `deny` makes the named permission reject like the real service. */
function makeCtx(deny?: string) {
  const asks: Ask[] = []
  const ctx: Tool.Context = {
    ...base,
    ask: (req) =>
      Effect.suspend(() => {
        asks.push(req)
        if (deny && req.permission === deny) return Effect.die(new Error(`permission denied: ${req.permission}`))
        return Effect.void
      }),
  }
  return { asks, ctx }
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([FSUtil.node, EventV2Bridge.node, CrossSpawnSpawner.node, Truncate.node, Agent.node]),
  ),
)

const run = Effect.fn("FileToolTest.run")(function* (
  args: Tool.InferParameters<typeof FileTool>,
  ctx: Tool.Context = makeCtx().ctx,
) {
  const info = yield* FileTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const exists = (p: string) =>
  Effect.promise(() =>
    fs
      .stat(p)
      .then(() => true)
      .catch(() => false),
  )

const read = (p: string) => Effect.promise(() => fs.readFile(p, "utf-8"))
const write = (p: string, text: string) => Effect.promise(() => fs.writeFile(p, text, "utf-8"))
const mkdir = (p: string) => Effect.promise(() => fs.mkdir(p, { recursive: true }))

describe("tool.file", () => {
  describe("mkdir", () => {
    it.instance("creates a directory including missing parents", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "a", "b", "c")

        const result = yield* run({ operation: "mkdir", path: target })

        expect(result.output).toContain("Created directory")
        expect(yield* exists(target)).toBe(true)
      }),
    )

    it.instance("is a no-op when the directory already exists", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "already")
        yield* mkdir(target)
        yield* write(path.join(target, "keep.txt"), "keep")

        const result = yield* run({ operation: "mkdir", path: target })

        expect(result.output).toContain("already exists")
        expect(result.metadata.existed).toBe(true)
        // The existing contents must survive an idempotent mkdir.
        expect(yield* read(path.join(target, "keep.txt"))).toBe("keep")
      }),
    )
  })

  describe("copy", () => {
    it.instance("copies a file and leaves the source in place", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "src.txt")
        const dest = path.join(test.directory, "nested", "dest.txt")
        yield* write(src, "payload")

        yield* run({ operation: "copy", path: src, destination: dest })

        expect(yield* read(dest)).toBe("payload")
        expect(yield* read(src)).toBe("payload")
      }),
    )

    it.instance("copies a directory tree recursively", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "tree")
        yield* mkdir(path.join(src, "deep"))
        yield* write(path.join(src, "deep", "leaf.txt"), "leaf")
        const dest = path.join(test.directory, "tree-copy")

        yield* run({ operation: "copy", path: src, destination: dest })

        expect(yield* read(path.join(dest, "deep", "leaf.txt"))).toBe("leaf")
      }),
    )

    it.instance("refuses to overwrite an existing destination unless asked", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "src.txt")
        const dest = path.join(test.directory, "dest.txt")
        yield* write(src, "new")
        yield* write(dest, "original")

        const exit = yield* run({ operation: "copy", path: src, destination: dest }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        // The refusal must be inert: the destination is untouched.
        expect(yield* read(dest)).toBe("original")
      }),
    )

    it.instance("overwrites when overwrite is true", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "src.txt")
        const dest = path.join(test.directory, "dest.txt")
        yield* write(src, "new")
        yield* write(dest, "original")

        yield* run({ operation: "copy", path: src, destination: dest, overwrite: true })

        expect(yield* read(dest)).toBe("new")
      }),
    )

    it.instance("refuses to copy a directory into itself", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "tree")
        yield* mkdir(src)
        yield* write(path.join(src, "leaf.txt"), "leaf")

        const exit = yield* run({
          operation: "copy",
          path: src,
          destination: path.join(src, "inner"),
        }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(yield* exists(path.join(src, "inner"))).toBe(false)
      }),
    )

    it.instance("fails with a real message when the source does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const exit = yield* run({
          operation: "copy",
          path: path.join(test.directory, "ghost.txt"),
          destination: path.join(test.directory, "out.txt"),
        }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("Source path does not exist")
      }),
    )

    it.instance("fails when destination is missing for copy", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "src.txt")
        yield* write(src, "x")

        const exit = yield* run({ operation: "copy", path: src }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain('"destination" parameter is required')
      }),
    )
  })

  describe("move", () => {
    it.instance("moves a file and removes the source", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "src.txt")
        const dest = path.join(test.directory, "moved", "dest.txt")
        yield* write(src, "payload")

        yield* run({ operation: "move", path: src, destination: dest })

        expect(yield* read(dest)).toBe("payload")
        expect(yield* exists(src)).toBe(false)
      }),
    )

    it.instance("falls back to copy+delete when rename reports a cross-device move", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "xdev.txt")
        const dest = path.join(test.directory, "xdev-moved.txt")
        yield* write(src, "across volumes")

        // A second volume is not available here, so the platform call is stubbed to
        // report EXDEV; everything after that is real filesystem work.
        const how = yield* Effect.promise(() =>
          movePath(src, dest, () => {
            const err: NodeJS.ErrnoException = new Error("EXDEV: cross-device link not permitted")
            err.code = "EXDEV"
            return Promise.reject(err)
          }),
        )

        expect(how).toBe("copy+delete")
        expect(yield* read(dest)).toBe("across volumes")
        expect(yield* exists(src)).toBe(false)
      }),
    )

    it.instance("propagates a rename failure that is not cross-device", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "boom.txt")
        yield* write(src, "x")

        const exit = yield* Effect.promise(() =>
          movePath(src, path.join(test.directory, "out.txt"), () => {
            const err: NodeJS.ErrnoException = new Error("EACCES: permission denied")
            err.code = "EACCES"
            return Promise.reject(err)
          }).then(
            () => "resolved",
            (e) => `rejected: ${(e as Error).message}`,
          ),
        )

        expect(exit).toContain("rejected: EACCES")
        expect(yield* exists(src)).toBe(true)
      }),
    )
  })

  describe("delete", () => {
    it.instance("deletes a file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "gone.txt")
        yield* write(target, "x")

        const result = yield* run({ operation: "delete", path: target })

        expect(result.output).toContain("Deleted file")
        expect(yield* exists(target)).toBe(false)
      }),
    )

    it.instance("deletes an empty directory without recursive", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "empty")
        yield* mkdir(target)

        yield* run({ operation: "delete", path: target })

        expect(yield* exists(target)).toBe(false)
      }),
    )

    it.instance("refuses a non-empty directory unless recursive is set", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "full")
        yield* mkdir(target)
        yield* write(path.join(target, "keep.txt"), "keep")

        const exit = yield* run({ operation: "delete", path: target }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("recursive: true")
        expect(yield* read(path.join(target, "keep.txt"))).toBe("keep")
      }),
    )

    it.instance("deletes a non-empty directory when recursive is set", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "full")
        yield* mkdir(path.join(target, "deep"))
        yield* write(path.join(target, "deep", "leaf.txt"), "leaf")

        yield* run({ operation: "delete", path: target, recursive: true })

        expect(yield* exists(target)).toBe(false)
      }),
    )

    it.instance("fails with a real message when the path does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const exit = yield* run({
          operation: "delete",
          path: path.join(test.directory, "never-was.txt"),
        }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("Path does not exist")
      }),
    )

    it.instance("refuses to delete the project directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "keep.txt"), "keep")

        const exit = yield* run({
          operation: "delete",
          path: test.directory,
          recursive: true,
        }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("project directory")
        expect(yield* read(path.join(test.directory, "keep.txt"))).toBe("keep")
      }),
    )

    it.instance("refuses to delete a git repository root", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const repo = path.join(test.directory, "vendored-repo")
        yield* mkdir(path.join(repo, ".git"))
        yield* write(path.join(repo, "README.md"), "hi")

        const exit = yield* run({ operation: "delete", path: repo, recursive: true }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("git repository")
        expect(yield* read(path.join(repo, "README.md"))).toBe("hi")
      }),
    )

    it.instance("refuses to delete a filesystem root", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const root = path.parse(test.directory).root

        const exit = yield* run({ operation: "delete", path: root, recursive: true }).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("Refusing to delete a filesystem root")
      }),
    )

    it.instance("does not delete anything when external_directory permission is refused", () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const victim = path.join(outside, "precious.txt")
        yield* write(victim, "still here")
        const { asks, ctx } = makeCtx("external_directory")

        const exit = yield* run({ operation: "delete", path: victim }, ctx).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        expect(asks.map((a) => a.permission)).toEqual(["external_directory"])
        expect(yield* read(victim)).toBe("still here")
      }),
    )

    it.instance("asks under file_delete with a directory-scoped always pattern", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const target = path.join(test.directory, "sub", "doomed.txt")
        yield* mkdir(path.dirname(target))
        yield* write(target, "x")
        const { asks, ctx } = makeCtx()

        yield* run({ operation: "delete", path: target }, ctx)

        const ask = asks.find((a) => a.permission === "file_delete")
        expect(ask).toBeDefined()
        // Approving "always" here must not hand over deletes machine-wide.
        expect(ask!.always).not.toContain("*")
        expect(ask!.always[0]).toContain("sub")
      }),
    )

    it.instance("asks under a different permission per operation", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const src = path.join(test.directory, "a.txt")
        yield* write(src, "x")
        const { asks, ctx } = makeCtx()

        yield* run({ operation: "mkdir", path: path.join(test.directory, "d") }, ctx)
        yield* run({ operation: "copy", path: src, destination: path.join(test.directory, "b.txt") }, ctx)
        yield* run({ operation: "move", path: src, destination: path.join(test.directory, "c.txt") }, ctx)

        expect(asks.map((a) => a.permission)).toEqual(["file_mkdir", "file_copy", "file_move"])
      }),
    )
  })

  it.instance("handles non-ascii names and spaces", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const src = path.join(test.directory, "café ünïcode 日本.txt")
      const dest = path.join(test.directory, "sub dir", "renamed café 日本.txt")
      yield* write(src, "naïve")

      yield* run({ operation: "move", path: src, destination: dest })

      expect(yield* read(dest)).toBe("naïve")
      expect(yield* exists(src)).toBe(false)
    }),
  )

  describe("windows paths", () => {
    it.instance("treats a case-different path as the same path on Windows only", () =>
      Effect.gen(function* () {
        expect(samePath("C:\\Temp\\A.txt", "C:\\temp\\a.txt")).toBe(process.platform === "win32")
      }),
    )

    if (process.platform === "win32") {
      it.instance("accepts an MSYS-style /c/... path", () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const target = path.join(test.directory, "msys-made")
          const msys = target.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll(
            "\\",
            "/",
          )

          yield* run({ operation: "mkdir", path: msys })

          // The real Windows path must exist - not a literal "\c\..." directory.
          expect(yield* exists(target)).toBe(true)
        }),
      )

      it.instance("performs a case-only rename instead of refusing it", () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const src = path.join(test.directory, "casing.txt")
          const dest = path.join(test.directory, "CASING.txt")
          yield* write(src, "payload")

          yield* run({ operation: "move", path: src, destination: dest })

          const names = yield* Effect.promise(() => fs.readdir(test.directory))
          expect(names).toContain("CASING.txt")
          expect(yield* read(dest)).toBe("payload")
        }),
      )

      it.instance("handles a path longer than MAX_PATH", () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const target = path.join(test.directory, "l".repeat(120), "o".repeat(120), "ng".repeat(30))
          expect(target.length).toBeGreaterThan(260)

          yield* run({ operation: "mkdir", path: target })

          expect(yield* exists(target)).toBe(true)
        }),
      )
    }
  })
})
