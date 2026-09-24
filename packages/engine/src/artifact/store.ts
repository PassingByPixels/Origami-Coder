// The local artifact store: one SQLite file plus a sha256 blob directory under
// the global data dir, exactly like `flock.json` is global rather than
// per-project. Lane 1 — no network, no relay, no ACP, no tool.
//
//   <data>/artifacts/artifacts.db       artifact, version, manifest_entry, ...
//   <data>/artifacts/blobs/<sha256>     one file per unique content
//
// WHY A PLAIN CLASS. Everything a caller does here is one short transaction or
// one file read. Wrapping that in Effect would buy retry and tracing that no
// call site wants and would force every consumer — a tool, an HTTP route, a
// test — to carry a runtime to read a blob. The Effect seam belongs at the
// caller, and lane 2 adds it there.
//
// WHY THE DRIVER IS IMPORTED BY A RUNTIME SPECIFIER. `bun:sqlite` and
// `node:sqlite` present the same surface (`exec`, `prepare`, `all/get/run`,
// `close`), but naming either one statically makes it a hard dependency of the
// module: a node host cannot resolve `bun:sqlite`, and bun 1.3 has no
// `node:sqlite` at all. Core solves this with a package `imports` alias
// (`#sqlite`), which is scoped to core and not reachable from this package,
// and core's `Database.layerFromPath` additionally runs the origami.db
// migrations — which would build the whole session schema inside artifacts.db.
// So: one specifier chosen at runtime, one code path after that.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@origami/core/global"
import { samePath } from "@/util/path-key"
import { BlobStore } from "./blobs"
import { Manifest } from "./manifest"
import {
  ArtifactNotFoundError,
  ArtifactPathError,
  type ArtifactDetail,
  type ArtifactListItem,
  type ArtifactRow,
  type DeleteReport,
  type DiffResult,
  type ManifestEntry,
  type PruneReport,
  type PublishFile,
  type PublishInput,
  type PublishResult,
  type PublishedResult,
  type SizeReport,
  type VersionRow,
} from "./types"

export interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

type SqliteModule = {
  Database?: new (filename: string) => SqliteDatabase
  DatabaseSync?: new (filename: string) => SqliteDatabase
}

async function openDatabase(file: string): Promise<SqliteDatabase> {
  const onBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
  const specifier = onBun ? "bun" + ":sqlite" : "node" + ":sqlite"
  // LOUD, and naming BOTH specifiers. A host where neither resolves (an old
  // node without `node:sqlite`, a bundle that rewrote the specifier away)
  // otherwise fails as "Cannot find module" from inside a dynamic import, which
  // reads like a broken build rather than "this runtime cannot hold the store".
  let module: SqliteModule
  try {
    module = (await import(/* @vite-ignore */ specifier)) as SqliteModule
  } catch (error) {
    throw new Error(`${noDriver(specifier)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const Driver = module.Database ?? module.DatabaseSync
  if (!Driver) throw new Error(`${noDriver(specifier)}: it exported neither Database nor DatabaseSync`)
  return new Driver(file)
}

function noDriver(specifier: string): string {
  const runtime = typeof (globalThis as { Bun?: { version?: string } }).Bun !== "undefined"
    ? `bun ${(globalThis as { Bun?: { version?: string } }).Bun?.version ?? "?"}`
    : `node ${typeof process !== "undefined" ? process.version : "?"}`
  return `artifact store: no sqlite driver: tried bun:sqlite / node:sqlite under ${runtime}, loaded ${specifier}`
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifact (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  session_id         TEXT,
  project_path       TEXT,
  owner_device       TEXT,
  parent_artifact_id TEXT,
  parent_version     INTEGER,
  created            INTEGER NOT NULL,
  updated            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS version (
  artifact_id     TEXT NOT NULL,
  number          INTEGER NOT NULL,
  manifest_digest TEXT NOT NULL,
  content_token   TEXT NOT NULL UNIQUE,
  entry_path      TEXT,
  created         INTEGER NOT NULL,
  device          TEXT,
  PRIMARY KEY (artifact_id, number)
);
CREATE TABLE IF NOT EXISTS manifest_entry (
  artifact_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  path        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version, path)
);
-- The retry half of the conflict rule: a publish resent after a dropped
-- connection must return the FIRST result, not mint a second version.
CREATE TABLE IF NOT EXISTS idempotency (
  key         TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  created     INTEGER NOT NULL
);
-- Written by lane 3 (device-group transfer). Created here so the store opens
-- with its full schema and lane 3 adds rows, not tables.
CREATE TABLE IF NOT EXISTS transfer (
  artifact_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  peer_device TEXT NOT NULL,
  state       TEXT NOT NULL,
  updated     INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, version, peer_device)
);
CREATE INDEX IF NOT EXISTS manifest_entry_sha ON manifest_entry (sha256);
CREATE INDEX IF NOT EXISTS version_created ON version (created);
`

const nullable = (value: string | number | undefined | null) => (value === undefined ? null : value)
const optional = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value)

interface ArtifactSqlRow {
  id: string
  title: string
  session_id: string | null
  project_path: string | null
  owner_device: string | null
  parent_artifact_id: string | null
  parent_version: number | null
  created: number
  updated: number
}

interface VersionSqlRow {
  artifact_id: string
  number: number
  manifest_digest: string
  content_token: string
  entry_path: string | null
  created: number
  device: string | null
}

function toArtifact(row: ArtifactSqlRow): ArtifactRow {
  return {
    id: row.id,
    title: row.title,
    sessionID: optional(row.session_id),
    projectPath: optional(row.project_path),
    ownerDevice: optional(row.owner_device),
    parentArtifactId: optional(row.parent_artifact_id),
    parentVersion: row.parent_version === null ? undefined : Number(row.parent_version),
    created: Number(row.created),
    updated: Number(row.updated),
  }
}

function toVersion(row: VersionSqlRow): VersionRow {
  return {
    artifactId: row.artifact_id,
    number: Number(row.number),
    digest: row.manifest_digest,
    contentToken: row.content_token,
    entryPath: optional(row.entry_path),
    created: Number(row.created),
    device: optional(row.device),
  }
}

export class ArtifactStore {
  private constructor(
    readonly directory: string,
    /** Read by nest-sync.ts (lane 4), which keeps its own tables in this file. */
    readonly db: SqliteDatabase,
    readonly blobs: BlobStore,
    private readonly now: () => number,
  ) {}

  /** `root` defaults to the global store and is an explicit argument only so a
   *  test (and a future per-device fixture) can point at a temp dir, the same
   *  way `FlockStore` threads `directory`. Opening twice is a no-op: every
   *  statement in the schema is `IF NOT EXISTS`. */
  static async open(root?: string, options?: { now?: () => number }): Promise<ArtifactStore> {
    const directory = root ?? path.join(Global.Path.data, "artifacts")
    fs.mkdirSync(directory, { recursive: true })
    const db = await openDatabase(path.join(directory, "artifacts.db"))
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec(SCHEMA)
    return new ArtifactStore(directory, db, new BlobStore(path.join(directory, "blobs")), options?.now ?? Date.now)
  }

  close(): void {
    this.db.close()
  }

  // ---------------------------------------------------------------- publish

  publish(input: PublishInput): PublishResult {
    if (!input.artifactId && input.baseVersion !== "absent") {
      throw new ArtifactNotFoundError("publish without an artifactId must carry baseVersion 'absent'")
    }

    // Read, validate and hash BEFORE anything is written. An unsafe path throws
    // here, which is what makes "rejected with nothing written" true. Pure CPU,
    // so it stays outside the transaction.
    const bodies = readBodies(input.files)
    const entries = Manifest.build(bodies)
    const entryPath = resolveEntry(input.entryPath, entries)

    // THE CHECK AND THE WRITE ARE ONE TRANSACTION. Two engines on this machine
    // share this file — the multi-window case the flock exists for — and a base
    // check made outside the lock lets both read "current is v3" and both try to
    // write v4. The loser would then die on a primary-key violation instead of
    // getting the Conflict the owner is supposed to see.
    return this.transact(() => {
      // A retry of a publish that already landed must not mint a second version
      // and must not care whether the base has moved since. It already won.
      const replay = this.replay(input.idempotencyKey)
      if (replay) return replay

      const artifact = input.artifactId ? this.artifact(input.artifactId) : undefined
      if (input.artifactId && !artifact) throw new ArtifactNotFoundError(`no artifact ${input.artifactId}`)

      const current = artifact ? this.latestNumber(artifact.id) : 0
      const expected = input.baseVersion === "absent" ? 0 : input.baseVersion
      if (current !== expected) {
        return {
          kind: "conflict",
          artifactId: artifact!.id,
          currentVersion: current,
          // No version to name yet: the caller quoted a base this artifact has
          // never reached. Empty is "nothing to compare against", not a digest.
          currentDigest: current === 0 ? "" : this.version(artifact!.id, current)!.digest,
        }
      }

      return this.write({
        artifactId: artifact?.id ?? mintId(),
        isNew: !artifact,
        title: input.title,
        sessionID: input.sessionID,
        projectPath: input.projectPath,
        device: input.device,
        number: current + 1,
        entries,
        entryPath,
        payload: new Map(bodies.map((file) => [file.path, file.bytes])),
        idempotencyKey: input.idempotencyKey,
      })
    })
  }

  /** One BEGIN IMMEDIATE. Public for nest-sync.ts, whose import check and write must be one transaction too. */
  transact<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = body()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  /** "Keep mine as a sibling": a NEW artifact id that records the artifact and
   *  version it came from. Both copies survive; nothing is merged. */
  forkAsSibling(artifactId: string, baseVersion: number, files: PublishFile[], title?: string): PublishedResult {
    const parent = this.artifact(artifactId)
    if (!parent) throw new ArtifactNotFoundError(`no artifact ${artifactId}`)
    if (!this.version(artifactId, baseVersion)) {
      throw new ArtifactNotFoundError(`no version ${baseVersion} of ${artifactId}`)
    }
    const bodies = readBodies(files)
    const entries = Manifest.build(bodies)
    return this.transact(() =>
      this.write({
        artifactId: mintId(),
        isNew: true,
        title: title ?? `${parent.title} (sibling)`,
        sessionID: parent.sessionID,
        projectPath: parent.projectPath,
        device: parent.ownerDevice,
        number: 1,
        entries,
        entryPath: resolveEntry(undefined, entries),
        payload: new Map(bodies.map((file) => [file.path, file.bytes])),
        parent: { artifactId, version: baseVersion },
      }),
    )
  }

  /** Copy-forward, not a rewind: version n's manifest becomes the newest
   *  version, so the digest matches n and the history keeps every step. The
   *  blobs are already on disk under their hashes, so this costs one row set. */
  restore(artifactId: string, n: number): PublishedResult {
    const artifact = this.artifact(artifactId)
    if (!artifact) throw new ArtifactNotFoundError(`no artifact ${artifactId}`)
    const source = this.version(artifactId, n)
    if (!source) throw new ArtifactNotFoundError(`no version ${n} of ${artifactId}`)
    return this.transact(() =>
      this.write({
        artifactId,
        isNew: false,
        title: artifact.title,
        sessionID: artifact.sessionID,
        projectPath: artifact.projectPath,
        device: artifact.ownerDevice,
        number: this.latestNumber(artifactId) + 1,
        entries: this.entries(artifactId, n),
        entryPath: source.entryPath,
        payload: new Map(),
      }),
    )
  }

  /** Title only. No new version: a rename is not content, so it costs one row
   *  update and one `updated` bump, not a manifest and a digest. */
  rename(artifactId: string, title: string): ArtifactRow {
    const artifact = this.artifact(artifactId)
    if (!artifact) throw new ArtifactNotFoundError(`no artifact ${artifactId}`)
    const now = this.now()
    this.db.prepare(`UPDATE artifact SET title = ?, updated = ? WHERE id = ?`).run(title, now, artifactId)
    return { ...artifact, title, updated: now }
  }

  /** Every version's rows go, then every blob that version pointed at — UNLESS
   *  another artifact's manifest still names that sha256. Two artifacts that
   *  happen to publish the same `app.css` share one blob; deleting one must
   *  never take the file the other one still serves. */
  delete(artifactId: string): DeleteReport {
    const artifact = this.artifact(artifactId)
    if (!artifact) throw new ArtifactNotFoundError(`no artifact ${artifactId}`)
    return this.transact(() => {
      const shas = this.db
        .prepare(`SELECT DISTINCT sha256 FROM manifest_entry WHERE artifact_id = ?`)
        .all(artifactId) as { sha256: string }[]
      const versionCount = this.db
        .prepare(`SELECT COUNT(*) AS n FROM version WHERE artifact_id = ?`)
        .get(artifactId) as { n: number }

      this.db.prepare(`DELETE FROM manifest_entry WHERE artifact_id = ?`).run(artifactId)
      this.db.prepare(`DELETE FROM version WHERE artifact_id = ?`).run(artifactId)
      this.db.prepare(`DELETE FROM idempotency WHERE artifact_id = ?`).run(artifactId)
      this.db.prepare(`DELETE FROM transfer WHERE artifact_id = ?`).run(artifactId)
      this.db.prepare(`DELETE FROM artifact WHERE id = ?`).run(artifactId)

      const stillReferenced = this.db.prepare(`SELECT 1 FROM manifest_entry WHERE sha256 = ? LIMIT 1`)
      let removedBlobs = 0
      let removedBytes = 0
      for (const { sha256 } of shas) {
        if (stillReferenced.get(sha256)) continue
        removedBytes += this.blobs.remove(sha256)
        removedBlobs++
      }
      return { removedVersions: Number(versionCount.n), removedBlobs, removedBytes }
    })
  }

  /** Rows and bodies, inside the caller's transaction. */
  private write(args: {
    artifactId: string
    isNew: boolean
    title: string
    sessionID?: string
    projectPath?: string
    device?: string
    number: number
    entries: ManifestEntry[]
    entryPath?: string
    payload: Map<string, Uint8Array>
    idempotencyKey?: string
    parent?: { artifactId: string; version: number }
  }): PublishedResult {
    const now = this.now()
    const digest = Manifest.digest(args.entries)
    const token = mintToken()

    // Bodies first: a blob on disk that no row points at is inert and the next
    // prune sweeps it. A row that points at a blob which is not there is a
    // broken page.
    for (const entry of args.entries) {
      const bytes = args.payload.get(entry.path)
      if (bytes) this.blobs.write(entry.sha256, bytes)
    }

    if (args.isNew) {
      this.db
        .prepare(
          `INSERT INTO artifact (id, title, session_id, project_path, owner_device, parent_artifact_id, parent_version, created, updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.artifactId,
          args.title,
          nullable(args.sessionID),
          nullable(args.projectPath),
          nullable(args.device),
          nullable(args.parent?.artifactId),
          nullable(args.parent?.version),
          now,
          now,
        )
    } else {
      // The machine that made the newest version owns the artifact. There is
      // no take-over button; passing the base check IS the handover.
      this.db
        .prepare(`UPDATE artifact SET title = ?, owner_device = ?, updated = ? WHERE id = ?`)
        .run(args.title, nullable(args.device), now, args.artifactId)
    }

    this.db
      .prepare(
        `INSERT INTO version (artifact_id, number, manifest_digest, content_token, entry_path, created, device)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(args.artifactId, args.number, digest, token, nullable(args.entryPath), now, nullable(args.device))

    const insertEntry = this.db.prepare(
      `INSERT INTO manifest_entry (artifact_id, version, path, size, sha256, media_type) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const entry of args.entries) {
      insertEntry.run(args.artifactId, args.number, entry.path, entry.size, entry.sha256, entry.mediaType)
    }

    if (args.idempotencyKey) {
      this.db
        .prepare(`INSERT INTO idempotency (key, artifact_id, version, created) VALUES (?, ?, ?, ?)`)
        .run(args.idempotencyKey, args.artifactId, args.number, now)
    }
    return { kind: "published", artifactId: args.artifactId, version: args.number, digest, contentToken: token }
  }

  private replay(key: string): PublishedResult | undefined {
    const row = this.db.prepare(`SELECT artifact_id, version FROM idempotency WHERE key = ?`).get(key) as
      | { artifact_id: string; version: number }
      | undefined
      | null
    if (!row) return undefined
    const version = this.version(row.artifact_id, Number(row.version))
    if (!version) return undefined
    return {
      kind: "published",
      artifactId: version.artifactId,
      version: version.number,
      digest: version.digest,
      contentToken: version.contentToken,
    }
  }

  // ------------------------------------------------------------------ reads

  artifact(id: string): ArtifactRow | undefined {
    const row = this.db.prepare(`SELECT * FROM artifact WHERE id = ?`).get(id) as ArtifactSqlRow | undefined | null
    return row ? toArtifact(row) : undefined
  }

  version(artifactId: string, number: number): VersionRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM version WHERE artifact_id = ? AND number = ?`)
      .get(artifactId, number) as VersionSqlRow | undefined | null
    return row ? toVersion(row) : undefined
  }

  latestNumber(artifactId: string): number {
    const row = this.db.prepare(`SELECT MAX(number) AS n FROM version WHERE artifact_id = ?`).get(artifactId) as
      | { n: number | null }
      | undefined
      | null
    return row?.n ? Number(row.n) : 0
  }

  entries(artifactId: string, version: number): ManifestEntry[] {
    const rows = this.db
      .prepare(`SELECT path, size, sha256, media_type FROM manifest_entry WHERE artifact_id = ? AND version = ?`)
      .all(artifactId, version) as { path: string; size: number; sha256: string; media_type: string }[]
    return Manifest.canonical(
      rows.map((row) => ({
        path: row.path,
        size: Number(row.size),
        sha256: row.sha256,
        mediaType: row.media_type,
      })),
    )
  }

  /** `projectPath` narrows to one repo ("from chat X in repo Y"); `all: true`
   *  says "ignore that filter", so a caller holding a project can still ask for
   *  the whole store without building a second call. Siblings always list.
   *  The project match is `samePath` (t-v47qh6): on Windows `C:\X`, `c:\x` and
   *  `C:/X` are one folder. It runs here, not in SQL, so the one rule decides and
   *  stored rows keep their spelling. */
  list(options: { all?: boolean; projectPath?: string } = {}): ArtifactListItem[] {
    const project = options.all ? undefined : options.projectPath
    const rows = (
      this.db
        .prepare(
          `SELECT a.*, v.number AS latest_number, v.manifest_digest AS latest_digest
           FROM artifact a
           JOIN version v
             ON v.artifact_id = a.id
            AND v.number = (SELECT MAX(number) FROM version WHERE artifact_id = a.id)
          ORDER BY a.updated DESC, a.id ASC`,
        )
        .all() as (ArtifactSqlRow & {
        latest_number: number
        latest_digest: string
      })[]
    ).filter((row) => project === undefined || (row.project_path !== null && samePath(row.project_path, project)))
    return rows.map((row) => ({
      ...toArtifact(row),
      latestVersion: Number(row.latest_number),
      latestDigest: row.latest_digest,
    }))
  }

  get(artifactId: string, version?: number): ArtifactDetail | undefined {
    const artifact = this.artifact(artifactId)
    if (!artifact) return undefined
    const number = version ?? this.latestNumber(artifactId)
    const row = this.version(artifactId, number)
    if (!row) return undefined
    return { artifact, version: row, entries: this.entries(artifactId, number) }
  }

  readBlob(sha256: string): Uint8Array | undefined {
    return this.blobs.read(sha256)
  }

  /** The seam lane 2's loopback route sits on: a random per-version token plus
   *  a manifest path in, one blob path out. The path is re-validated here so a
   *  traversal can never reach `path.join`, whatever the route decoded. */
  resolveToken(contentToken: string, filePath: string): { entry: ManifestEntry; blobPath: string } | undefined {
    try {
      Manifest.validatePath(filePath)
    } catch (error) {
      if (error instanceof ArtifactPathError) return undefined
      throw error
    }
    const row = this.db.prepare(`SELECT * FROM version WHERE content_token = ?`).get(contentToken) as
      | VersionSqlRow
      | undefined
      | null
    if (!row) return undefined
    const entry = this.entries(row.artifact_id, Number(row.number)).find((item) => item.path === filePath)
    if (!entry) return undefined
    return { entry, blobPath: this.blobs.pathFor(entry.sha256) }
  }

  diff(artifactId: string, v1: number, v2: number): DiffResult {
    if (!this.version(artifactId, v1)) throw new ArtifactNotFoundError(`no version ${v1} of ${artifactId}`)
    if (!this.version(artifactId, v2)) throw new ArtifactNotFoundError(`no version ${v2} of ${artifactId}`)
    return Manifest.compare(this.entries(artifactId, v1), this.entries(artifactId, v2))
  }

  // --------------------------------------------------------------- retention

  sizeReport(): SizeReport {
    const artifacts = this.db.prepare(`SELECT COUNT(*) AS n FROM artifact`).get() as { n: number }
    const versions = this.db.prepare(`SELECT COUNT(*) AS n FROM version`).get() as { n: number }
    return { artifacts: Number(artifacts.n), versions: Number(versions.n), blobBytes: this.blobs.totalBytes() }
  }

  /** Drops BODIES, never rows. After a prune the history still lists every
   *  version and every path; what is gone is the content of old versions you
   *  have not looked at. The latest version of every artifact is always kept,
   *  so nothing in the sidebar can turn into a broken page. `dryRun` counts
   *  what would go and removes nothing (the Nests Storage card, t-vb87lt). */
  pruneByWindow(days: number, options: { dryRun?: boolean } = {}): PruneReport {
    const cutoff = this.now() - days * 86_400_000
    const keep = new Set<string>()
    const recent = this.db
      .prepare(
        `SELECT DISTINCT m.sha256 AS sha FROM manifest_entry m
           JOIN version v ON v.artifact_id = m.artifact_id AND v.number = m.version
          WHERE v.created >= ?`,
      )
      .all(cutoff) as { sha: string }[]
    for (const row of recent) keep.add(row.sha)

    const latest = this.db
      .prepare(
        `SELECT DISTINCT m.sha256 AS sha FROM manifest_entry m
          WHERE m.version = (SELECT MAX(number) FROM version WHERE artifact_id = m.artifact_id)`,
      )
      .all() as { sha: string }[]
    for (const row of latest) keep.add(row.sha)

    let removedBlobs = 0
    let removedBytes = 0
    for (const sha of this.blobs.list()) {
      if (keep.has(sha)) continue
      removedBytes += options.dryRun ? (this.blobs.size(sha) ?? 0) : this.blobs.remove(sha)
      removedBlobs++
    }
    return { removedBlobs, removedBytes }
  }
}

function readBodies(files: PublishFile[]): { path: string; bytes: Uint8Array; mediaType?: string }[] {
  return files.map((file) => {
    if (file.bytes) return { path: file.path, bytes: file.bytes, mediaType: file.mediaType }
    if (file.sourcePath) {
      return { path: file.path, bytes: new Uint8Array(fs.readFileSync(file.sourcePath)), mediaType: file.mediaType }
    }
    throw new ArtifactPathError(file.path, "neither bytes nor sourcePath")
  })
}

/** The file the viewer opens. It must be IN the manifest: an entry pointing at
 *  a path the version does not contain renders a blank pane and reads like the
 *  page failed, not like the publish was wrong. */
function resolveEntry(requested: string | undefined, entries: ManifestEntry[]): string | undefined {
  if (requested !== undefined) {
    if (!entries.some((entry) => entry.path === requested)) {
      throw new ArtifactPathError(requested, "entryPath is not in the manifest")
    }
    return requested
  }
  return entries.find((entry) => entry.path === "index.html")?.path ?? entries[0]?.path
}

export const mintId = () => `art_${crypto.randomBytes(12).toString("hex")}`
/** 24 base64url characters. Random per VERSION, so a token handed to the
 *  integrated browser stops resolving the moment a new version lands. */
export const mintToken = () => crypto.randomBytes(18).toString("base64url")
