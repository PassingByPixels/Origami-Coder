import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { Effect, FileSystem } from "effect"

export const writeFileStringScoped = Effect.fn("test.writeFileStringScoped")(function* (file: string, text: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* fs.writeFileString(file, text)
  yield* Effect.addFinalizer(() => fs.remove(file, { force: true }).pipe(Effect.orDie))
  return file
})

/**
 * Windows only creates symlinks for an admin process or with Developer Mode on;
 * otherwise `symlinkSync` fails EPERM. Tests that need a real symlink must skip
 * on that box rather than report a product defect — but a blanket win32 skip
 * would also hide the tests on a machine that CAN make them, so probe the real
 * capability once and cache the answer.
 */
export const canSymlink: boolean = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "origami-symlink-probe-"))
  try {
    mkdirSync(path.join(dir, "target"))
    symlinkSync(path.join(dir, "target"), path.join(dir, "dir-link"), "dir")
    symlinkSync(path.join(dir, "target"), path.join(dir, "plain-link"))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()
