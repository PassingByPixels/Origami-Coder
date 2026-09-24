import { Effect, Formatter, Logger, type LogLevel } from "effect"
import fsSync from "fs"
import path from "path"
import { Global } from "../global"
import { runID } from "./shared"

function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB per generation
const DEFAULT_MAX_FILES = 5 // the live file plus 4 rotated backups

/**
 * Shift `file.3 -> file.4`, `file.2 -> file.3`, ..., `file -> file.1`, dropping
 * whatever was at `file.<maxFiles - 1>`. A missing source (nothing to shift yet,
 * or another engine already rotated this generation this instant) is not an
 * error -- every engine process appends to the same `origami.log`, so more than
 * one of them can notice the size cap at once.
 *
 * This renames the live file; it never unlinks it. On Windows, Node opens files
 * with FILE_SHARE_DELETE, so a rename succeeds even while another engine still
 * holds the file open -- that engine's handle keeps pointing at the renamed
 * (now `.1`) file and keeps working, it just stops being the file new readers
 * see at `origami.log`. Nothing is ever deleted out from under a live handle.
 */
function rotate(file: string, maxFiles: number) {
  for (let generation = maxFiles - 1; generation >= 1; generation--) {
    const from = generation === 1 ? file : `${file}.${generation - 1}`
    const to = `${file}.${generation}`
    try {
      fsSync.renameSync(from, to)
    } catch {
      // Source does not exist yet, or lost the race with another engine. Either is fine.
    }
  }
}

function openAppend(file: string, mode?: number) {
  return fsSync.openSync(file, "a", mode)
}

/**
 * Rotate `file` if, and only if, `fd` is still the file that lives AT that
 * path right now -- otherwise just reopen it. Closes `fd` unconditionally and
 * returns the fd to write to next (the caller must not use `fd` again).
 *
 * Every engine process appends to the same `origami.log`, so more than one
 * can see an oversize fd at once. Without the identity check, engine A
 * rotates (`file` -> `file.1`, a fresh small file reopened at `file`), and
 * engine B's fd -- opened before the rotation, still pointing at the OLD file
 * now living at `file.1` -- still reports the old, over-cap size on its next
 * check. B would then rename `file` (A's fresh file) to `file.1` too,
 * overwriting the real history A just preserved there with an almost-empty
 * file. N engines racing this moment would each perform a spurious rotation,
 * and the `maxFiles` generations fill with near-empty files while the real
 * history falls off the end.
 *
 * The fix: compare device + inode, not just size, between the fd we hold and
 * whatever is at `file` right now. A fresh post-rotation file can
 * coincidentally be small (checked too), but its identity never matches the
 * fd another engine is still holding. Only the engine whose fd's identity
 * still matches -- and whose file is still over the cap -- performs the
 * rename; everyone else just follows along and reopens what is there.
 */
export function rotateIfOwned(file: string, fd: number, maxBytes: number, maxFiles: number, mode?: number): number {
  let held: fsSync.Stats
  try {
    held = fsSync.fstatSync(fd)
  } catch {
    try {
      fsSync.closeSync(fd)
    } catch {}
    return openAppend(file, mode)
  }
  if (held.size < maxBytes) return fd

  const atPath = fsSync.statSync(file, { throwIfNoEntry: false })
  const owns = atPath !== undefined && atPath.dev === held.dev && atPath.ino === held.ino && atPath.size >= maxBytes
  try {
    fsSync.closeSync(fd)
  } catch {}
  if (owns) rotate(file, maxFiles)
  return openAppend(file, mode)
}

/**
 * A file logger that rotates `file` by size (finding 23: one 187 MB
 * `origami.log`, appended since 2026-06-25, never rotated). Rotation is
 * checked at flush time (every `batchWindow`, default 1s) rather than on a
 * timer, so a quiet server never rotates and a chatty one rotates promptly.
 */
export function rotatingFileLogger(
  file = path.join(Global.Path.log, "origami.log"),
  options: {
    id?: string
    mode?: number
    batchWindow?: number
    maxBytes?: number
    maxFiles?: number
  } = {},
) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES

  // Deferred into the Effect (like the `Logger.toFile` this replaces), not opened
  // at call time: `Logger.layer([fileLogger(...)])` builds this eagerly, before the
  // log directory is guaranteed to exist, so an open failure must become a typed
  // Effect defect, not a synchronous throw at layer construction.
  return Effect.gen(function* () {
    let fd = yield* Effect.sync(() => openAppend(file, options.mode))

    return yield* Logger.batched(formatter(options.id), {
      // Do not set batchWindow to 0; it causes high idle CPU usage.
      window: options.batchWindow ?? 1000,
      flush: (messages) =>
        Effect.sync(() => {
          const text = messages.join("\n") + "\n"
          fd = rotateIfOwned(file, fd, maxBytes, maxFiles, options.mode)
          try {
            fsSync.writeSync(fd, text)
          } catch {
            // Logging must never crash the process it is trying to explain.
          }
        }),
    })
  })
}

export function fileLogger(file = path.join(Global.Path.log, "origami.log"), id: string = runID) {
  return rotatingFileLogger(file, { id })
}

const stderrLogger = Logger.make((options) => process.stderr.write(formatter().log(options) + "\n"))

export function minimumLogLevel() {
  const value = process.env.ORIGAMI_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export function loggers() {
  return process.env.ORIGAMI_PRINT_LOGS === "1" ? [fileLogger(), stderrLogger] : [fileLogger()]
}

export * as Logging from "./logging"
