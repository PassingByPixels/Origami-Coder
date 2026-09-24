// The shapes the artifact store speaks in. No Effect, no SQL, no fs here — a
// caller that only wants to know what a publish returns reads this one file.

/** One file inside a version, as the caller hands it in. Exactly one of
 *  `bytes` or `sourcePath` is used; `bytes` wins if both are present. */
export interface PublishFile {
  /** Store-relative path, `/`-separated. See `Manifest.validatePath` for the rules. */
  path: string
  bytes?: Uint8Array
  sourcePath?: string
  /** Overrides the extension guess. */
  mediaType?: string
}

/** One file inside a version, after it has been hashed and recorded. */
export interface ManifestEntry {
  path: string
  size: number
  sha256: string
  mediaType: string
}

export interface PublishInput {
  /** Absent = mint a new artifact. Present = publish onto that artifact. */
  artifactId?: string
  title: string
  files: PublishFile[]
  /** The file the viewer opens first. Must be one of `files`. Defaults to
   *  `index.html` when present, else the first path in canonical order. */
  entryPath?: string
  /** The version this publish was made from. `'absent'` means "I opened
   *  nothing" and only succeeds on an artifact that has no version yet. */
  baseVersion: number | "absent"
  /** Replaying the same key returns the first result and writes nothing. */
  idempotencyKey: string
  sessionID?: string
  projectPath?: string
  device?: string
}

export interface PublishedResult {
  kind: "published"
  artifactId: string
  version: number
  digest: string
  contentToken: string
}

/** Nothing was written. The caller opened `baseVersion`, but the store has
 *  moved on: another device (or another window) published first. */
export interface ConflictResult {
  kind: "conflict"
  artifactId: string
  currentVersion: number
  currentDigest: string
}

export type PublishResult = PublishedResult | ConflictResult

export interface ArtifactRow {
  id: string
  title: string
  sessionID?: string
  projectPath?: string
  ownerDevice?: string
  parentArtifactId?: string
  parentVersion?: number
  created: number
  updated: number
}

export interface VersionRow {
  artifactId: string
  number: number
  digest: string
  contentToken: string
  entryPath?: string
  created: number
  device?: string
}

export interface ArtifactListItem extends ArtifactRow {
  latestVersion: number
  latestDigest: string
}

export interface ArtifactDetail {
  artifact: ArtifactRow
  version: VersionRow
  entries: ManifestEntry[]
}

export interface DiffResult {
  added: string[]
  removed: string[]
  changed: string[]
}

export interface SizeReport {
  artifacts: number
  versions: number
  blobBytes: number
}

export interface PruneReport {
  removedBlobs: number
  removedBytes: number
}

/** What a delete costs to report back: every version's rows are gone, and only
 *  the blobs no OTHER artifact still points at come off disk. */
export interface DeleteReport {
  removedVersions: number
  removedBlobs: number
  removedBytes: number
}

/** A manifest path that a viewer must never be asked to resolve. Thrown before
 *  a single byte is written, so a rejected publish leaves the store untouched. */
export class ArtifactPathError extends Error {
  constructor(
    readonly badPath: string,
    reason: string,
  ) {
    super(`unsafe artifact path ${JSON.stringify(badPath)}: ${reason}`)
    this.name = "ArtifactPathError"
  }
}

/** The caller asked for an artifact, version or token that is not there. */
export class ArtifactNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArtifactNotFoundError"
  }
}

const MEDIA_TYPES: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  webp: "image/webp",
}

/** Deliberately a SHORT table, not `mime-types`. These are the extensions an
 *  agent-written page actually contains; everything else is served as an opaque
 *  download rather than guessed at. */
export function mediaTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".")
  if (dot < 0) return "application/octet-stream"
  const ext = filePath.slice(dot + 1).toLowerCase()
  return MEDIA_TYPES[ext] ?? "application/octet-stream"
}
