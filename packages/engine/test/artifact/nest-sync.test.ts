// Artifacts in the nest (t-sj39jx), proved on two REAL stores in two temp
// dirs: desk A publishes, desk B holds the index row and pulls the body. The
// bugs worth catching: an index row applied twice or out of order, a binary
// body that does not arrive byte for byte, a piece at the wrong offset that is
// appended anyway, a peer's manifest that names a traversal path or lies about
// its digest, and an incoming version that overwrites a local one.
import { afterAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ArtifactStore } from "@/artifact/store"
import { NestSync } from "@/artifact/nest-sync"

const dirs: string[] = []
const stores: ArtifactStore[] = []
const open = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-nest-"))
  dirs.push(root)
  const store = await ArtifactStore.open(root)
  stores.push(store)
  return store
}

afterAll(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {}
  }
  Bun.gc(true)
  for (const directory of dirs.splice(0)) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        fs.rmSync(directory, { recursive: true, force: true })
        break
      } catch {
        Bun.gc(true)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
}, 60_000)

const A = "deskAAAAAAA"
const B = "deskBBBBBBB"
const bytes = (text: string) => new TextEncoder().encode(text)
/** 70 KB of every byte value: three pieces at 24 KB, and NUL, 0xFF and invalid UTF-8 on the way. */
const BINARY = new Uint8Array(crypto.randomBytes(70_000))

function publish(store: ArtifactStore, page: string, base: number | "absent" = "absent", artifactId?: string) {
  const r = store.publish({
    ...(artifactId ? { artifactId } : {}),
    title: "Relief report",
    files: [
      { path: "index.html", bytes: bytes(page) },
      { path: "img/logo.bin", bytes: BINARY },
    ],
    baseVersion: base,
    idempotencyKey: crypto.randomUUID(),
  })
  if (r.kind !== "published") throw new Error(`fixture publish refused: ${JSON.stringify(r)}`)
  return r
}

/** The receiver-driven pull the host runs, with the wire replaced by a direct call. */
function pull(from: ArtifactStore, to: ArtifactStore, artifactId: string, version: number, deskName = "Surface") {
  const manifest = NestSync.exportManifest({ store: from, deviceId: A, artifactId, version })
  if ("refused" in manifest) throw new Error("not found")
  const chunk = manifest as unknown as Record<string, unknown>
  let r = NestSync.importManifest({ store: to, chunk, deskName })
  const pieces: string[] = []
  if ("result" in r && r.result === "missing") {
    for (const blob of r.missing) {
      let have = blob.have
      while (have < blob.size) {
        const piece = NestSync.exportBlob({ store: from, artifactId, version, sha256: blob.sha256, offset: have, maxBytes: 24_000 })
        if ("refused" in piece) throw new Error("blob not found")
        pieces.push(`${blob.sha256.slice(0, 6)}@${piece.offset}`)
        const got = NestSync.importBlob({ store: to, chunk: piece as unknown as Record<string, unknown> })
        if (got.refused) throw new Error(got.refused)
        have = got.have
      }
    }
    r = NestSync.importManifest({ store: to, chunk, deskName })
  }
  return { result: r, pieces }
}

describe("the index", () => {
  test("rows are stored per desk and idempotent by (desk, id, version); older is stale, a row naming another desk is rejected", async () => {
    const a = await open()
    const b = await open()
    const v1 = publish(a, "<h1>one</h1>")
    const { rows } = NestSync.index({ store: a, deviceId: A, deskName: "Surface" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: v1.artifactId, version: 1, digest: v1.digest, desk: A, owner: A, deskName: "Surface" })
    expect(rows[0]!.size).toBe(bytes("<h1>one</h1>").length + BINARY.length)

    expect(NestSync.applyIndex({ store: b, deviceId: B, desk: A, rows, replace: true })).toMatchObject({ inserted: 1 })
    expect(NestSync.applyIndex({ store: b, deviceId: B, desk: A, rows, replace: true })).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 })
    const v2 = publish(a, "<h1>two</h1>", 1, v1.artifactId)
    const newer = NestSync.index({ store: a, deviceId: A, deskName: "Surface" }).rows
    expect(NestSync.applyIndex({ store: b, deviceId: B, desk: A, rows: newer, replace: true })).toMatchObject({ updated: 1 })
    // The v1 row arriving late (a reordered send) does not roll the stored row back.
    expect(NestSync.applyIndex({ store: b, deviceId: B, desk: A, rows, replace: true })).toMatchObject({ stale: 1, updated: 0 })
    expect(NestSync.index({ store: b, deviceId: B, deskName: "5090" }).others).toEqual([
      expect.objectContaining({ id: v1.artifactId, version: 2, digest: v2.digest, desk: A }),
    ])
    // A row that claims another desk, a bad id, and this desk's own rows are all refused.
    const forged = [{ ...newer[0], desk: "deskCCCCCCC" }, { ...newer[0], id: "../../etc" }]
    expect(NestSync.applyIndex({ store: b, deviceId: B, desk: A, rows: forged, replace: false })).toMatchObject({ rejected: 2 })
    expect(NestSync.applyIndex({ store: b, deviceId: B, desk: B, rows: newer, replace: false })).toMatchObject({ rejected: 1 })
    // replace: a desk that no longer lists the artifact drops its row.
    expect(NestSync.applyIndex({ store: b, deviceId: B, desk: A, rows: [], replace: true })).toMatchObject({ removed: 1 })
    expect(NestSync.index({ store: b, deviceId: B, deskName: "5090" }).others).toEqual([])
  })
})

describe("the pull", () => {
  test("a binary body crosses in base64 pieces and lands byte for byte under the same id, with a new local token", async () => {
    const a = await open()
    const b = await open()
    const v1 = publish(a, "<h1>one</h1>")
    const { result, pieces } = pull(a, b, v1.artifactId, 1)
    expect(result).toEqual({ result: "added", artifactId: v1.artifactId, version: 1 })
    expect(pieces.filter((p) => p.startsWith(crypto.createHash("sha256").update(BINARY).digest("hex").slice(0, 6)))).toHaveLength(3)
    const got = b.get(v1.artifactId, 1)!
    expect(got.version.digest).toBe(v1.digest)
    expect(got.artifact.ownerDevice).toBe(A)
    expect(got.version.contentToken).not.toBe(v1.contentToken)
    const served = b.resolveToken(got.version.contentToken, "img/logo.bin")!
    expect(new Uint8Array(fs.readFileSync(served.blobPath))).toEqual(BINARY)
    // The same pull again writes nothing and asks for no piece.
    expect(pull(a, b, v1.artifactId, 1)).toEqual({ result: { result: "unchanged", artifactId: v1.artifactId, version: 1 }, pieces: [] })
    expect(fs.readdirSync(path.join(b.directory, "incoming"))).toEqual([])
  })

  test("v2 that changed one file sends only that file", async () => {
    const a = await open()
    const b = await open()
    const v1 = publish(a, "<h1>one</h1>")
    pull(a, b, v1.artifactId, 1)
    publish(a, "<h1>two</h1>", 1, v1.artifactId)
    const { result, pieces } = pull(a, b, v1.artifactId, 2)
    expect(result).toEqual({ result: "added", artifactId: v1.artifactId, version: 2 })
    expect(pieces).toHaveLength(1)
    expect(b.latestNumber(v1.artifactId)).toBe(2)
  })

  test("a piece at the wrong offset is a gap and is not appended; a body that fails its hash is dropped, not stored", async () => {
    const a = await open()
    const b = await open()
    const v1 = publish(a, "<h1>one</h1>")
    const sha = crypto.createHash("sha256").update(BINARY).digest("hex")
    const first = NestSync.exportBlob({ store: a, artifactId: v1.artifactId, version: 1, sha256: sha, offset: 0, maxBytes: 24_000 }) as NestSync.BlobChunk
    const second = NestSync.exportBlob({ store: a, artifactId: v1.artifactId, version: 1, sha256: sha, offset: 24_000, maxBytes: 24_000 }) as NestSync.BlobChunk
    expect(NestSync.importBlob({ store: b, chunk: { ...second } })).toEqual({ sha256: sha, have: 0, done: false, refused: "gap" })
    expect(NestSync.importBlob({ store: b, chunk: { ...first } })).toEqual({ sha256: sha, have: 24_000, done: false })
    // Resume: the same piece again is a gap that names where the store stands.
    expect(NestSync.importBlob({ store: b, chunk: { ...first } })).toMatchObject({ refused: "gap", have: 24_000 })
    // The rest, with one byte flipped: the hash check refuses it and nothing reaches blobs/.
    const rest = NestSync.exportBlob({ store: a, artifactId: v1.artifactId, version: 1, sha256: sha, offset: 24_000, maxBytes: 100_000 }) as NestSync.BlobChunk
    const flipped = Buffer.from(rest.data, "base64")
    flipped[0] = flipped[0]! ^ 0xff
    expect(NestSync.importBlob({ store: b, chunk: { ...rest, data: flipped.toString("base64") } })).toMatchObject({ refused: "hash", have: 0 })
    expect(b.blobs.has(sha)).toBe(false)
    expect(fs.readdirSync(path.join(b.directory, "incoming"))).toEqual([])
  })

  test("a blob the version does not name is not served", async () => {
    const a = await open()
    const one = publish(a, "<h1>one</h1>")
    const other = a.publish({ title: "Other", files: [{ path: "secret.txt", bytes: bytes("not yours") }], baseVersion: "absent", idempotencyKey: "o" })
    if (other.kind !== "published") throw new Error("fixture")
    const secret = a.get(other.artifactId)!.entries[0]!.sha256
    expect(NestSync.exportBlob({ store: a, artifactId: one.artifactId, version: 1, sha256: secret, offset: 0, maxBytes: 100 })).toEqual({
      refused: "not-found",
      artifactId: one.artifactId,
      version: 1,
    })
  })

  test("a peer manifest with a traversal path, a false digest or a header-breaking media type is refused before anything is written", async () => {
    const a = await open()
    const b = await open()
    const v1 = publish(a, "<h1>one</h1>")
    const m = NestSync.exportManifest({ store: a, deviceId: A, artifactId: v1.artifactId, version: 1 }) as NestSync.ManifestChunk
    const bad = (entries: unknown[], digest = m.digest) =>
      NestSync.importManifest({ store: b, chunk: { ...m, entries, digest } as unknown as Record<string, unknown> })
    expect(bad([{ ...m.entries[0], path: "../../escape.html" }])).toMatchObject({ refused: "bad-chunk" })
    expect(bad(m.entries, "0".repeat(64))).toMatchObject({ refused: "bad-chunk" })
    expect(bad([{ ...m.entries[0], mediaType: "text/html\r\nSet-Cookie: x=1" }, m.entries[1]])).toMatchObject({ refused: "bad-chunk" })
    expect(b.list({ all: true })).toEqual([])
  })
})

describe("the lane 1 rule on a pulled artifact", () => {
  test("republished here on a stale base, then their v2 arrives: theirs becomes a sibling, ours stays v2, and a retry mints no second sibling", async () => {
    const a = await open()
    const b = await open()
    const v1 = publish(a, "<h1>one</h1>")
    pull(a, b, v1.artifactId, 1)
    const theirs = publish(a, "<h1>two from A</h1>", 1, v1.artifactId)
    // B edits the pulled v1 before it has seen A's v2.
    const ours = publish(b, "<h1>two from B</h1>", 1, v1.artifactId)
    expect(ours.version).toBe(2)
    // B's own store refuses a SECOND publish on the stale base: nothing written.
    expect(b.publish({ artifactId: v1.artifactId, title: "x", files: [{ path: "index.html", bytes: bytes("x") }], baseVersion: 1, idempotencyKey: "stale" }))
      .toMatchObject({ kind: "conflict", currentVersion: 2 })
    const { result } = pull(a, b, v1.artifactId, 2, "Surface")
    expect(result).toMatchObject({ result: "sibling", artifactId: v1.artifactId, version: 2 })
    const sibling = (result as { sibling: string }).sibling
    expect(b.get(v1.artifactId, 2)!.version.digest).toBe(ours.digest)
    expect(b.get(sibling, 1)!.version.digest).toBe(theirs.digest)
    expect(b.artifact(sibling)).toMatchObject({ title: "Relief report (Surface)", parentArtifactId: v1.artifactId, parentVersion: 1, ownerDevice: A })
    expect(pull(a, b, v1.artifactId, 2).result).toEqual(result)
    expect(b.list({ all: true })).toHaveLength(2)
  })
})
