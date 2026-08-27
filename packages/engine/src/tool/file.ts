import { Effect, Schema } from "effect"
import * as NFS from "fs/promises"
import os from "os"
import * as path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./file.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Protected } from "@origami/core/filesystem/protected"
import { Watcher } from "@origami/core/filesystem/watcher"
import { FSUtil } from "@origami/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"

export const Parameters = Schema.Struct({
  operation: Schema.Literals(["copy", "move", "delete", "mkdir"]).annotate({
    description: "The filesystem operation to perform",
  }),
  path: Schema.String.annotate({
    description: "The absolute path to act on. For copy and move this is the source.",
  }),
  destination: Schema.optional(Schema.String).annotate({
    description: "The absolute destination path. Required for copy and move, ignored otherwise.",
  }),
  recursive: Schema.optional(Schema.Boolean).annotate({
    description:
      "delete only: also remove a directory that is not empty, along with everything inside it. Defaults to false.",
  }),
  overwrite: Schema.optional(Schema.Boolean).annotate({
    description: "copy and move only: replace the destination if it already exists. Defaults to false.",
  }),
})

type Params = {
  operation: "copy" | "move" | "delete" | "mkdir"
  path: string
  destination?: string
  recursive?: boolean
  overwrite?: boolean
}

type Metadata = {
  operation: Params["operation"]
  filepath: string
  destination?: string
  directory?: boolean
  entries?: number
  existed?: boolean
  how?: "rename" | "copy+delete"
}

/** Windows compares paths case-insensitively; POSIX does not. */
export function samePath(a: string, b: string) {
  if (process.platform !== "win32") return a === b
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Resolve a model-supplied path to something the OS will accept. `windowsPath`
 * repairs the MSYS/cygwin forms (`/c/Users/...`, `/mnt/c/...`) that leak in when
 * the model has been writing git-bash commands.
 */
function resolvePath(raw: string, cwd: string) {
  const fixed = process.platform === "win32" ? FSUtil.windowsPath(raw) : raw
  return path.isAbsolute(fixed) ? path.resolve(fixed) : path.resolve(cwd, fixed)
}

/**
 * Rename, falling back to copy-then-delete when the two paths live on different
 * volumes (libuv surfaces `ERROR_NOT_SAME_DEVICE` as EXDEV on Windows too). The
 * `rename` parameter exists so the cross-device branch is reachable in a test
 * without a second volume.
 */
export async function movePath(src: string, dest: string, rename: typeof NFS.rename = NFS.rename) {
  try {
    await rename(src, dest)
    return "rename" as const
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err
    await NFS.cp(src, dest, { recursive: true, force: true })
    await NFS.rm(src, { recursive: true, force: true })
    return "copy+delete" as const
  }
}

export const FileTool = Tool.define<typeof Parameters, Metadata, FSUtil.Service | EventV2Bridge.Service>(
  "file",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service

    /** Paths that must never be handed to a recursive delete, whatever the permission says. */
    const assertDeletable = Effect.fn("FileTool.assertDeletable")(function* (
      target: string,
      instance: { directory: string; worktree: string },
    ) {
      if (samePath(target, path.parse(target).root))
        throw new Error(`Refusing to delete a filesystem root: ${target}`)
      if (samePath(target, os.homedir())) throw new Error(`Refusing to delete the home directory: ${target}`)
      for (const item of Protected.paths()) {
        if (samePath(target, item)) throw new Error(`Refusing to delete a protected system directory: ${target}`)
      }
      // `contains` is true when equal, so this covers "is the project" and "is above the project".
      if (FSUtil.contains(target, instance.directory) || FSUtil.contains(target, instance.worktree))
        throw new Error(
          `Refusing to delete ${target} because it is the project directory or contains it. Delete the specific files you mean instead.`,
        )
      if (yield* fs.existsSafe(path.join(target, ".git")))
        throw new Error(
          `Refusing to delete ${target} because it is the root of a git repository. Delete the specific files you mean instead.`,
        )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const target = resolvePath(params.path, instance.directory)
          const needsDestination = params.operation === "copy" || params.operation === "move"

          if (needsDestination && !params.destination)
            throw new Error(`The "destination" parameter is required for the ${params.operation} operation.`)

          const destination = needsDestination ? resolvePath(params.destination!, instance.directory) : undefined
          const rel = (item: string) => path.relative(instance.worktree, item)

          yield* assertExternalDirectoryEffect(ctx, target, {
            kind: params.operation === "mkdir" ? "directory" : "file",
          })
          if (destination) yield* assertExternalDirectoryEffect(ctx, destination)

          if (params.operation === "mkdir") {
            const existed = yield* fs.isDir(target)
            yield* ctx.ask({
              permission: "file_mkdir",
              patterns: [rel(target)],
              always: ["*"],
              metadata: { operation: params.operation, filepath: target },
            })
            if (!existed) {
              yield* Effect.promise(() => NFS.mkdir(target, { recursive: true }))
              yield* events.publish(Watcher.Event.Updated, { file: target, event: "add" })
            }
            return {
              title: rel(target),
              metadata: { operation: params.operation, filepath: target, existed },
              output: existed ? `Directory already exists: ${target}` : `Created directory: ${target}`,
            }
          }

          if (params.operation === "delete") {
            const isDir = yield* fs.isDir(target)
            if (!isDir && !(yield* fs.existsSafe(target))) throw new Error(`Path does not exist: ${target}`)
            yield* assertDeletable(target, instance)

            const entries = isDir ? yield* fs.readDirectoryEntries(target) : []
            if (isDir && entries.length > 0 && !params.recursive)
              throw new Error(
                `Directory is not empty (${entries.length} entries): ${target}. Pass recursive: true to delete it and everything inside it.`,
              )

            yield* ctx.ask({
              permission: "file_delete",
              patterns: [rel(target)],
              // Narrower than write's "*": approving "always" here permits deletes in
              // this directory and below, not everywhere on the machine.
              always: [path.join(rel(path.dirname(target)), "*")],
              metadata: {
                operation: params.operation,
                filepath: target,
                directory: isDir,
                entries: entries.length,
                recursive: params.recursive === true,
              },
            })

            // `fs.rm` needs `recursive` for ANY directory, empty or not. The guard
            // above is what stops a non-empty directory going without `recursive: true`.
            yield* Effect.promise(() => NFS.rm(target, { recursive: isDir, force: false }))
            yield* events.publish(Watcher.Event.Updated, { file: target, event: "unlink" })
            return {
              title: rel(target),
              metadata: { operation: params.operation, filepath: target, directory: isDir, entries: entries.length },
              output: isDir
                ? `Deleted directory ${target} (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`
                : `Deleted file: ${target}`,
            }
          }

          // copy | move
          const dest = destination!
          if (!(yield* fs.existsSafe(target))) throw new Error(`Source path does not exist: ${target}`)
          if (target === dest) throw new Error(`Source and destination are the same path: ${target}`)
          const sourceIsDir = yield* fs.isDir(target)
          if (sourceIsDir && FSUtil.contains(target, dest))
            throw new Error(`Cannot ${params.operation} ${target} into itself: ${dest}`)

          // A case-only rename on Windows ("a.txt" -> "A.txt") targets the same
          // file, so the exists check below must not treat it as a collision.
          const caseOnlyRename = samePath(target, dest)
          const destExists = !caseOnlyRename && (yield* fs.existsSafe(dest))
          if (destExists && !params.overwrite)
            throw new Error(`Destination already exists: ${dest}. Pass overwrite: true to replace it.`)

          yield* ctx.ask({
            permission: params.operation === "copy" ? "file_copy" : "file_move",
            patterns: params.operation === "copy" ? [rel(dest)] : [rel(target), rel(dest)],
            always: ["*"],
            metadata: {
              operation: params.operation,
              filepath: target,
              destination: dest,
              directory: sourceIsDir,
              overwrite: destExists,
            },
          })

          yield* Effect.promise(() => NFS.mkdir(path.dirname(dest), { recursive: true }))

          if (params.operation === "copy") {
            yield* Effect.promise(() => NFS.cp(target, dest, { recursive: sourceIsDir, force: true }))
            yield* events.publish(Watcher.Event.Updated, { file: dest, event: destExists ? "change" : "add" })
            return {
              title: rel(dest),
              metadata: { operation: params.operation, filepath: target, destination: dest, directory: sourceIsDir },
              output: `Copied ${target} to ${dest}`,
            }
          }

          if (destExists) yield* Effect.promise(() => NFS.rm(dest, { recursive: true, force: true }))
          const how = yield* Effect.promise(() => movePath(target, dest))
          yield* events.publish(Watcher.Event.Updated, { file: target, event: "unlink" })
          yield* events.publish(Watcher.Event.Updated, { file: dest, event: destExists ? "change" : "add" })
          return {
            title: rel(dest),
            metadata: { operation: params.operation, filepath: target, destination: dest, directory: sourceIsDir, how },
            output: `Moved ${target} to ${dest}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
