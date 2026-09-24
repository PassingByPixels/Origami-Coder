// Artifacts in the nest (lane 4, t-sj39jx): the engine half. The host
// (packages/vscode/src/dashboard/nestArtifacts.ts) carries these shapes
// between desks; this file reads and writes the local store.
//
//   index        this desk's rows (one per artifact, its latest version) and
//                the rows the other desks sent (nest_artifact_row)
//   applyIndex   store one desk's rows; idempotent by (desk, id, version)
//   exportManifest / exportBlob   what a peer asks for: the version's
//                manifest, then each blob it lacks in base64 pieces
//   importBlob   append one piece to incoming/<sha>.part; the blob moves into
//                the store only after its sha256 matches
//   importManifest   write the version once every blob is here
//
// THE LANE 1 RULE HOLDS ON IMPORT. A version never overwrites a local one: an
// incoming version N whose digest differs from the local version N becomes a
// NEW artifact (a sibling) that records its parent. Everything from a peer is
// untrusted: ids, paths, sizes, hashes and media types are checked here.

import fs from "node:fs"
import path from "node:path"
import { Manifest } from "./manifest"
import { mintId, mintToken, type ArtifactStore } from "./store"
import type { ManifestEntry } from "./types"

/** Same cap as tool/artifact.ts MAX_PUBLISH_BYTES: one version, all files. */
export const MAX_VERSION_BYTES = 32 * 1024 * 1024
/** Rows one desk sends, newest first. */
export const MAX_INDEX_ROWS = 500
export const DEFAULT_PIECE_BYTES = 24_000
const MAX_PIECE_BYTES = 256 * 1024

/** The index row, as the host mirrors it (nestArtifacts.ts NEST_ARTIFACT_ROW_FIELDS). */
export const ROW_FIELDS = ["id", "title", "version", "digest", "desk", "deskName", "owner", "updated", "size"] as const
export interface IndexRow {
  id: string
  title: string
  version: number
  digest: string
  /** The desk that HOLDS this copy. */
  desk: string
  deskName: string
  /** The desk that made the latest version. */
  owner: string
  updated: number
  size: number
}

export interface ApplyResult {
  inserted: number
  updated: number
  unchanged: number
  stale: number
  rejected: number
  removed: number
}

export interface ManifestChunk {
  kind: "manifest"
  artifactId: string
  version: number
  title: string
  owner: string
  digest: string
  entryPath?: string
  created: number
  entries: ManifestEntry[]
}
export interface BlobChunk {
  kind: "blob"
  artifactId: string
  version: number
  sha256: string
  offset: number
  size: number
  data: string
  done: boolean
}
export type Refused = { refused: "not-found"; artifactId: string; version: number }

export type BlobImport = { sha256: string; have: number; done: boolean; refused?: "gap" | "bad-chunk" | "hash" }
export type ManifestImport =
  | { result: "missing"; artifactId: string; version: number; missing: { sha256: string; size: number; have: number }[] }
  | { result: "added" | "unchanged"; artifactId: string; version: number }
  | { result: "sibling"; artifactId: string; version: number; sibling: string }
  | { refused: "bad-chunk" | "too-big"; artifactId: string; version: number }

const ID = /^art_[0-9a-f]{24}$/
const SHA = /^[0-9a-f]{64}$/
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/
/** A header value the route sends as Content-Type: no CR, LF or other control characters. */
const MEDIA = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}(; ?charset=[a-z0-9_-]{1,32})?$/i

const TABLE = `
CREATE TABLE IF NOT EXISTS nest_artifact_row (
  desk      TEXT NOT NULL,
  id        TEXT NOT NULL,
  title     TEXT NOT NULL,
  version   INTEGER NOT NULL,
  digest    TEXT NOT NULL,
  desk_name TEXT NOT NULL,
  owner     TEXT NOT NULL,
  updated   INTEGER NOT NULL,
  size      INTEGER NOT NULL,
  PRIMARY KEY (desk, id)
);`

const prepared = new WeakSet<ArtifactStore>()
/** Created by the first gated call, so a desk with Nests off never gets the table. */
function ready(store: ArtifactStore): ArtifactStore {
  if (!prepared.has(store)) {
    store.db.exec(TABLE)
    prepared.add(store)
  }
  return store
}

const isInt = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min
const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined

function sizeOf(store: ArtifactStore, id: string, version: number): number {
  return store.entries(id, version).reduce((n, e) => n + e.size, 0)
}

export function index(input: { store: ArtifactStore; deviceId: string; deskName: string }) {
  const store = ready(input.store)
  const rows: IndexRow[] = store
    .list({ all: true })
    .slice(0, MAX_INDEX_ROWS)
    .map((a) => ({
      id: a.id,
      title: a.title,
      version: a.latestVersion,
      digest: a.latestDigest,
      desk: input.deviceId,
      deskName: input.deskName,
      owner: a.ownerDevice && DEVICE.test(a.ownerDevice) ? a.ownerDevice : input.deviceId,
      updated: a.updated,
      size: sizeOf(store, a.id, a.latestVersion),
    }))
  const others = (
    store.db.prepare(`SELECT * FROM nest_artifact_row WHERE desk != ? ORDER BY updated DESC`).all(input.deviceId) as {
      desk: string
      id: string
      title: string
      version: number
      digest: string
      desk_name: string
      owner: string
      updated: number
      size: number
    }[]
  ).map((r) => ({
    id: r.id,
    title: r.title,
    version: Number(r.version),
    digest: r.digest,
    desk: r.desk,
    deskName: r.desk_name,
    owner: r.owner,
    updated: Number(r.updated),
    size: Number(r.size),
  }))
  return { rows, others }
}

/** One row off the wire, or undefined. `desk` is the link's peer id, never the row's word for it. */
function readRow(raw: unknown, desk: string): IndexRow | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const id = str(r["id"], 64)
  const digest = str(r["digest"], 64)
  const owner = str(r["owner"], 64)
  if (!id || !ID.test(id) || !digest || !SHA.test(digest) || !owner || !DEVICE.test(owner)) return undefined
  if (r["desk"] !== desk || !isInt(r["version"], 1) || !isInt(r["size"], 0)) return undefined
  const updated = typeof r["updated"] === "number" && Number.isFinite(r["updated"]) ? Math.floor(r["updated"]) : 0
  return {
    id,
    title: (typeof r["title"] === "string" ? r["title"] : "").slice(0, 200) || id,
    version: r["version"],
    digest,
    desk,
    deskName: (typeof r["deskName"] === "string" ? r["deskName"] : "").slice(0, 100),
    owner,
    updated,
    size: r["size"],
  }
}

export function applyIndex(input: {
  store: ArtifactStore
  deviceId: string
  desk: string
  rows: readonly unknown[]
  replace: boolean
}): ApplyResult {
  const store = ready(input.store)
  const out: ApplyResult = { inserted: 0, updated: 0, unchanged: 0, stale: 0, rejected: 0, removed: 0 }
  if (input.desk === input.deviceId) return { ...out, rejected: input.rows.length }
  const find = store.db.prepare(`SELECT version, digest, title, updated FROM nest_artifact_row WHERE desk = ? AND id = ?`)
  const put = store.db.prepare(
    `INSERT OR REPLACE INTO nest_artifact_row (desk, id, title, version, digest, desk_name, owner, updated, size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const seen = new Set<string>()
  return store.transact(() => {
    for (const raw of input.rows) {
      const row = readRow(raw, input.desk)
      if (!row || seen.has(row.id)) {
        out.rejected++
        continue
      }
      seen.add(row.id)
      const held = find.get(input.desk, row.id) as
        | { version: number; digest: string; title: string; updated: number }
        | null
        | undefined
      if (held && Number(held.version) > row.version) {
        out.stale++
        continue
      }
      if (
        held &&
        Number(held.version) === row.version &&
        held.digest === row.digest &&
        held.title === row.title &&
        Number(held.updated) === row.updated
      ) {
        out.unchanged++
        continue
      }
      put.run(input.desk, row.id, row.title, row.version, row.digest, row.deskName, row.owner, row.updated, row.size)
      if (held) out.updated++
      else out.inserted++
    }
    if (input.replace) {
      const gone = (
        store.db.prepare(`SELECT id FROM nest_artifact_row WHERE desk = ?`).all(input.desk) as { id: string }[]
      ).filter((r) => !seen.has(r.id))
      const drop = store.db.prepare(`DELETE FROM nest_artifact_row WHERE desk = ? AND id = ?`)
      for (const r of gone) drop.run(input.desk, r.id)
      out.removed = gone.length
    }
    return out
  })
}

export function exportManifest(input: {
  store: ArtifactStore
  deviceId: string
  artifactId: string
  version: number
}): ManifestChunk | Refused {
  const detail = input.store.get(input.artifactId, input.version)
  if (!detail) return { refused: "not-found", artifactId: input.artifactId, version: input.version }
  const owner = detail.artifact.ownerDevice
  return {
    kind: "manifest",
    artifactId: detail.artifact.id,
    version: detail.version.number,
    title: detail.artifact.title,
    owner: owner && DEVICE.test(owner) ? owner : input.deviceId,
    digest: detail.version.digest,
    ...(detail.version.entryPath ? { entryPath: detail.version.entryPath } : {}),
    created: detail.version.created,
    entries: detail.entries,
  }
}

/** One piece of one blob of that version. Only a blob the version's manifest names is served. */
export function exportBlob(input: {
  store: ArtifactStore
  artifactId: string
  version: number
  sha256: string
  offset: number
  maxBytes: number
}): BlobChunk | Refused {
  const refused: Refused = { refused: "not-found", artifactId: input.artifactId, version: input.version }
  const entry = input.store.entries(input.artifactId, input.version).find((e) => e.sha256 === input.sha256)
  const size = entry ? input.store.blobs.size(entry.sha256) : undefined
  if (!entry || size === undefined || input.offset > size) return refused
  const length = Math.min(Math.max(1, Math.floor(input.maxBytes)), MAX_PIECE_BYTES, size - input.offset)
  const bytes = Buffer.alloc(Math.max(0, length))
  const fd = fs.openSync(input.store.blobs.pathFor(entry.sha256), "r")
  try {
    fs.readSync(fd, bytes, 0, bytes.length, input.offset)
  } finally {
    fs.closeSync(fd)
  }
  return {
    kind: "blob",
    artifactId: input.artifactId,
    version: input.version,
    sha256: entry.sha256,
    offset: input.offset,
    size,
    data: bytes.toString("base64"),
    done: input.offset + bytes.length >= size,
  }
}

function incoming(store: ArtifactStore, sha: string): string {
  const dir = path.join(store.directory, "incoming")
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${sha}.part`)
}

function partSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** Append one piece. Resumable: `have` is what is on disk, so a broken pull asks from there. */
export function importBlob(input: { store: ArtifactStore; chunk: Record<string, unknown> }): BlobImport {
  const c = input.chunk
  const sha = typeof c["sha256"] === "string" && SHA.test(c["sha256"]) ? c["sha256"] : ""
  if (!sha || !isInt(c["size"], 0) || c["size"] > MAX_VERSION_BYTES || !isInt(c["offset"], 0) || typeof c["data"] !== "string")
    return { sha256: sha, have: 0, done: false, refused: "bad-chunk" }
  const size = c["size"]
  if (input.store.blobs.has(sha)) return { sha256: sha, have: size, done: true }
  const file = incoming(input.store, sha)
  const have = partSize(file)
  if (c["offset"] !== have) return { sha256: sha, have, done: false, refused: "gap" }
  const bytes = Buffer.from(c["data"], "base64")
  if (have + bytes.length > size) {
    fs.rmSync(file, { force: true })
    return { sha256: sha, have: 0, done: false, refused: "bad-chunk" }
  }
  fs.appendFileSync(file, bytes, { mode: 0o600 })
  if (have + bytes.length < size) return { sha256: sha, have: have + bytes.length, done: false }
  const body = new Uint8Array(fs.readFileSync(file))
  fs.rmSync(file, { force: true })
  if (Manifest.sha256(body) !== sha) return { sha256: sha, have: 0, done: false, refused: "hash" }
  input.store.blobs.write(sha, body)
  return { sha256: sha, have: size, done: true }
}

/** The manifest off the wire, checked the way a local publish is: paths, sizes, hashes, the digest itself. */
function readManifest(c: Record<string, unknown>): ManifestChunk | undefined {
  const artifactId = str(c["artifactId"], 64)
  const owner = str(c["owner"], 64)
  const digest = str(c["digest"], 64)
  if (!artifactId || !ID.test(artifactId) || !owner || !DEVICE.test(owner) || !digest || !SHA.test(digest)) return
  if (!isInt(c["version"], 1) || !Array.isArray(c["entries"]) || c["entries"].length === 0) return
  const entries: ManifestEntry[] = []
  for (const raw of c["entries"] as unknown[]) {
    const e = (raw ?? {}) as Record<string, unknown>
    const p = typeof e["path"] === "string" ? e["path"] : ""
    const sha = typeof e["sha256"] === "string" ? e["sha256"] : ""
    const media = typeof e["mediaType"] === "string" ? e["mediaType"] : ""
    if (!SHA.test(sha) || !isInt(e["size"], 0) || !MEDIA.test(media)) return
    try {
      Manifest.validatePath(p)
    } catch {
      return
    }
    entries.push({ path: p, size: e["size"], sha256: sha, mediaType: media })
  }
  let sorted: ManifestEntry[]
  try {
    sorted = Manifest.canonical(entries)
  } catch {
    return
  }
  if (Manifest.digest(sorted) !== digest) return
  const entryPath = typeof c["entryPath"] === "string" ? c["entryPath"] : undefined
  if (entryPath !== undefined && !sorted.some((e) => e.path === entryPath)) return
  return {
    kind: "manifest",
    artifactId,
    version: c["version"],
    title: (typeof c["title"] === "string" ? c["title"] : "").slice(0, 200) || artifactId,
    owner,
    digest,
    ...(entryPath ? { entryPath } : {}),
    created: typeof c["created"] === "number" && Number.isFinite(c["created"]) ? Math.floor(c["created"]) : Date.now(),
    entries: sorted,
  }
}

/**
 * Write the version once every blob is here. Idempotent: the same (id, version,
 * digest) a second time answers what the first did. `deskName` names the
 * source desk in a sibling's title.
 */
export function importManifest(input: {
  store: ArtifactStore
  chunk: Record<string, unknown>
  deskName?: string
}): ManifestImport {
  const store = input.store
  const m = readManifest(input.chunk)
  const artifactId = String(input.chunk["artifactId"] ?? "")
  const version = typeof input.chunk["version"] === "number" ? input.chunk["version"] : 0
  if (!m) return { refused: "bad-chunk", artifactId, version }
  if (m.entries.reduce((n, e) => n + e.size, 0) > MAX_VERSION_BYTES) return { refused: "too-big", artifactId, version }
  const missing = [...new Map(m.entries.map((e) => [e.sha256, e.size])).entries()]
    .filter(([sha]) => !store.blobs.has(sha))
    .map(([sha, size]) => ({ sha256: sha, size, have: partSize(path.join(store.directory, "incoming", `${sha}.part`)) }))
  if (missing.length) return { result: "missing", artifactId: m.artifactId, version: m.version, missing }
  const key = `nest:${m.artifactId}:${m.version}:${m.digest}`
  return store.transact(() => {
    const done = store.db.prepare(`SELECT artifact_id, version FROM idempotency WHERE key = ?`).get(key) as
      | { artifact_id: string; version: number }
      | null
      | undefined
    if (done) {
      return done.artifact_id === m.artifactId
        ? { result: "unchanged" as const, artifactId: m.artifactId, version: m.version }
        : { result: "sibling" as const, artifactId: m.artifactId, version: m.version, sibling: done.artifact_id }
    }
    const local = store.artifact(m.artifactId)
    const held = local ? store.version(m.artifactId, m.version) : undefined
    if (held && held.digest === m.digest) {
      remember(store, key, m.artifactId, m.version)
      return { result: "unchanged" as const, artifactId: m.artifactId, version: m.version }
    }
    if (held) {
      // Divergence: this desk has its own version N. Theirs becomes a sibling; ours stays.
      const sibling = mintId()
      const parent = m.version > 1 ? m.version - 1 : undefined
      insertArtifact(store, sibling, `${m.title} (${input.deskName || m.owner})`, m.owner, {
        artifactId: m.artifactId,
        version: parent,
      })
      insertVersion(store, sibling, 1, m)
      remember(store, key, sibling, 1)
      return { result: "sibling" as const, artifactId: m.artifactId, version: m.version, sibling }
    }
    if (!local) insertArtifact(store, m.artifactId, m.title, m.owner)
    else if (m.version > store.latestNumber(m.artifactId))
      store.db
        .prepare(`UPDATE artifact SET title = ?, owner_device = ?, updated = ? WHERE id = ?`)
        .run(m.title, m.owner, Date.now(), m.artifactId)
    insertVersion(store, m.artifactId, m.version, m)
    remember(store, key, m.artifactId, m.version)
    return { result: "added" as const, artifactId: m.artifactId, version: m.version }
  })
}

function remember(store: ArtifactStore, key: string, artifactId: string, version: number): void {
  store.db
    .prepare(`INSERT OR IGNORE INTO idempotency (key, artifact_id, version, created) VALUES (?, ?, ?, ?)`)
    .run(key, artifactId, version, Date.now())
}

function insertArtifact(
  store: ArtifactStore,
  id: string,
  title: string,
  owner: string,
  parent?: { artifactId: string; version?: number },
): void {
  const now = Date.now()
  store.db
    .prepare(
      `INSERT INTO artifact (id, title, session_id, project_path, owner_device, parent_artifact_id, parent_version, created, updated)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(id, title, owner, parent?.artifactId ?? null, parent?.version ?? null, now, now)
}

/** A new random content token: a token is this machine's address for the version, never the peer's. */
function insertVersion(store: ArtifactStore, id: string, number: number, m: ManifestChunk): void {
  store.db
    .prepare(
      `INSERT INTO version (artifact_id, number, manifest_digest, content_token, entry_path, created, device)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, number, m.digest, mintToken(), m.entryPath ?? m.entries[0]?.path ?? null, m.created, m.owner)
  const entry = store.db.prepare(
    `INSERT INTO manifest_entry (artifact_id, version, path, size, sha256, media_type) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const e of m.entries) entry.run(id, number, e.path, e.size, e.sha256, e.mediaType)
}

export * as NestSync from "./nest-sync"
