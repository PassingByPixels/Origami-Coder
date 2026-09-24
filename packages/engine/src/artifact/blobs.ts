// One file per unique content, named by its sha256. Ten versions of a page
// that changed one line cost one page plus ten small manifests.
//
// The write is temp-then-rename with the retry from `flock/store.ts`, for the
// same reason: on Windows a rename over a path another process is reading
// comes back EPERM/EBUSY for a reason that is gone a millisecond later. The
// temp name carries the pid so two engines never collide, and the mode rides
// on the temp file because that is what the rename preserves.
//
// A blob that already exists is NEVER rewritten. Its name is its hash, so the
// bytes on disk are already the bytes being offered, and skipping the write is
// both the dedupe and the reason a republish of a 3 MB page costs nothing.

import fs from "node:fs"
import path from "node:path"

const RENAME_TRIES = 3

export class BlobStore {
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true })
  }

  pathFor(sha256: string): string {
    return path.join(this.directory, sha256)
  }

  has(sha256: string): boolean {
    return fs.existsSync(this.pathFor(sha256))
  }

  /** Returns true when the bytes were actually written, false when the blob
   *  was already there. The caller uses that to report what a publish cost. */
  write(sha256: string, bytes: Uint8Array): boolean {
    const file = this.pathFor(sha256)
    if (fs.existsSync(file)) return false
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, bytes, { mode: 0o600 })
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, file)
        return true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        // Another publish of the same content won the race. Its bytes are ours
        // by definition, so this is success, not a collision.
        if (code === "EEXIST" && fs.existsSync(file)) {
          fs.rmSync(temp, { force: true })
          return false
        }
        const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES"
        if (!transient || attempt >= RENAME_TRIES - 1) {
          fs.rmSync(temp, { force: true })
          throw error
        }
      }
    }
  }

  read(sha256: string): Uint8Array | undefined {
    try {
      return new Uint8Array(fs.readFileSync(this.pathFor(sha256)))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === "ENOENT" || code === "ENOTDIR") return undefined
      throw error
    }
  }

  size(sha256: string): number | undefined {
    try {
      return fs.statSync(this.pathFor(sha256)).size
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === "ENOENT" || code === "ENOTDIR") return undefined
      throw error
    }
  }

  /** Blob names only — the `.tmp` files of a publish that died mid-write are
   *  not blobs and must never be counted, served or pruned as one. */
  list(): string[] {
    return fs.readdirSync(this.directory).filter((name) => /^[0-9a-f]{64}$/.test(name))
  }

  /** Bytes on disk, measured by stat rather than summed from the manifests, so
   *  `sizeReport` reports what the folder actually costs. */
  totalBytes(): number {
    let total = 0
    for (const name of this.list()) total += this.size(name) ?? 0
    return total
  }

  remove(sha256: string): number {
    const bytes = this.size(sha256)
    if (bytes === undefined) return 0
    fs.rmSync(this.pathFor(sha256), { force: true })
    return bytes
  }
}
