// The manifest is the IDENTITY of a version: a sorted list of (path, size,
// sha256) and one sha256 over it. Two machines that compute the same digest
// hold the same files, with no clock and no negotiation involved.
//
// Path safety lives here, and it runs BEFORE anything is hashed or written.
// A manifest path is later resolved against the blob store by an HTTP route
// (lane 2), so `..`, an absolute path, an encoded separator or a `.git`
// segment are not "unlikely input" — they are the exact shapes that turn a
// static file route into an arbitrary-read of the user's disk. Rejecting the
// whole publish is the only safe answer: a publish that silently dropped one
// bad file would serve a page missing a script and look like a render bug.

import crypto from "node:crypto"
import { ArtifactPathError, mediaTypeFor, type ManifestEntry } from "./types"

/** Anything that would let a path escape the version it belongs to. Checked as
 *  raw text, not after a normalise: `normalize()` is what we are defending
 *  against, not a step we take first. */
export function validatePath(input: string): void {
  if (input.length === 0) throw new ArtifactPathError(input, "empty")
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new ArtifactPathError(input, "control character")
  if (input.includes("\\")) throw new ArtifactPathError(input, "backslash separator")
  if (input.startsWith("/")) throw new ArtifactPathError(input, "absolute path")
  if (/^[a-zA-Z]:/.test(input)) throw new ArtifactPathError(input, "drive-letter path")
  // %2F / %5C and the double-encoded forms. A route that decodes once before
  // splitting would otherwise see a separator this check never split on.
  if (/%(25)*(2f|5c|2e)/i.test(input)) throw new ArtifactPathError(input, "percent-encoded separator or dot")

  const segments = input.split("/")
  for (const segment of segments) {
    if (segment.length === 0) throw new ArtifactPathError(input, "empty segment")
    if (segment === "." || segment === "..") throw new ArtifactPathError(input, "relative segment")
    if (segment === ".git") throw new ArtifactPathError(input, ".git segment")
  }
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

/** Sorted by path, so the order the caller listed files in cannot change the
 *  digest. Duplicate paths are a caller bug, not a last-one-wins merge. */
export function canonical(entries: ManifestEntry[]): ManifestEntry[] {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.path === sorted[i - 1]!.path) throw new ArtifactPathError(sorted[i]!.path, "duplicate path")
  }
  return sorted
}

/** sha256 over the canonical `(path, size, sha256)` list. NUL-separated so no
 *  path containing the separator can forge a different list with the same
 *  bytes — a path cannot contain NUL, `validatePath` saw to that. */
export function digest(entries: ManifestEntry[]): string {
  const body = canonical(entries)
    .map((entry) => `${entry.path}\u0000${entry.size}\u0000${entry.sha256}`)
    .join("\n")
  return crypto.createHash("sha256").update(body, "utf8").digest("hex")
}

/** Validate, hash and sort in one pass. Throws on the first unsafe path, which
 *  is why the caller can run this before touching the disk. */
export function build(files: { path: string; bytes: Uint8Array; mediaType?: string }[]): ManifestEntry[] {
  const entries = files.map((file) => {
    validatePath(file.path)
    return {
      path: file.path,
      size: file.bytes.byteLength,
      sha256: sha256(file.bytes),
      mediaType: file.mediaType ?? mediaTypeFor(file.path),
    }
  })
  return canonical(entries)
}

/** Manifest-level only. Two HTML renders are never merged line by line, so
 *  "changed" is a path whose content hash moved, and nothing finer. */
export function compare(from: ManifestEntry[], to: ManifestEntry[]) {
  const before = new Map(from.map((entry) => [entry.path, entry.sha256]))
  const after = new Map(to.map((entry) => [entry.path, entry.sha256]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [path, hash] of after) {
    const old = before.get(path)
    if (old === undefined) added.push(path)
    else if (old !== hash) changed.push(path)
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path)
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

export * as Manifest from "./manifest"
