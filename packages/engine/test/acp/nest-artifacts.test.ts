// Artifacts in the nest (t-sj39jx), over the ACP dispatch. The bugs worth
// catching: a nest_artifact_* call that runs (or creates its table) while the
// host says Nests is off, and a pulled body that is served some other way than
// the existing sandboxed loopback route.
import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RequestError } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { ACPNestArtifacts } from "@/acp/nest-artifacts"
import { onArtifactChange, type ArtifactChange } from "@/artifact/events"
import { artifactStore, resetArtifactStore } from "@/artifact/instance"
import { ArtifactStore } from "@/artifact/store"
import { NestSync } from "@/artifact/nest-sync"
import { SANDBOX, NO_SNIFF, serve } from "@/artifact/serve"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-nest-acp-"))
const peerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-nest-peer-"))
resetArtifactStore()
const store = await artifactStore(root)
const peer = await ArtifactStore.open(peerRoot)

afterAll(async () => {
  for (const s of [store, peer]) {
    try {
      s.close()
    } catch {}
  }
  resetArtifactStore()
  Bun.gc(true)
  for (const dir of [root, peerRoot]) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        Bun.gc(true)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
}, 60_000)

const DESK = "deskAAAAAAA"
const PEER = "deskBBBBBBB"
const PAGE = "<!doctype html><script>document.title='x'</script><h1>from the peer</h1>"

const call = (name: string, params: Record<string, unknown>) =>
  Effect.runPromise(ACPNestArtifacts.dispatch(name, params)! as Effect.Effect<Record<string, unknown>, unknown>)
const hasTable = () =>
  !!store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nest_artifact_row'`).get()

const valid: Record<string, Record<string, unknown>> = {
  nest_artifact_index: { deskName: "5090" },
  nest_artifact_apply: { desk: PEER, rows: [] },
  nest_artifact_export: { artifactId: "art_000000000000000000000000", version: 1 },
  nest_artifact_import: { chunk: { kind: "blob" } },
}

test("Nests off: every method is refused with nests-off before the store is touched, and the table is never created", () => {
  for (const name of ACPNestArtifacts.METHODS) {
    for (const enabled of [false, undefined, "true", 1]) {
      let error: unknown
      try {
        ACPNestArtifacts.dispatch(name, { ...valid[name], deviceId: DESK, ...(enabled === undefined ? {} : { enabled }) })
      } catch (e) {
        error = e
      }
      expect(error, `${name} enabled=${String(enabled)}`).toBeInstanceOf(RequestError)
      expect((error as RequestError).data).toEqual({ service: "nests", reason: "nests-off" })
    }
  }
  expect(hasTable()).toBe(false)
  // Not one of ours: the dispatch answers undefined and the next handler runs.
  expect(ACPNestArtifacts.dispatch("nest_index", { enabled: true, deviceId: DESK })).toBeUndefined()
})

test("Nests on: a peer's version is pulled through the four methods and served by the sandboxed loopback route", async () => {
  const published = peer.publish({
    title: "Peer page",
    files: [{ path: "index.html", bytes: new TextEncoder().encode(PAGE) }],
    baseVersion: "absent",
    idempotencyKey: "peer-1",
  })
  if (published.kind !== "published") throw new Error("fixture")
  const on = { enabled: true, deviceId: DESK }
  const peerRows = NestSync.index({ store: peer, deviceId: PEER, deskName: "Surface" }).rows
  expect(await call("nest_artifact_apply", { ...on, desk: PEER, rows: peerRows, replace: true })).toMatchObject({ inserted: 1 })
  expect(hasTable()).toBe(true)
  expect((await call("nest_artifact_index", { ...on, deskName: "5090" }))["others"]).toEqual([
    expect.objectContaining({ id: published.artifactId, version: 1, desk: PEER, deskName: "Surface" }),
  ])

  const changes: ArtifactChange[] = []
  const off = onArtifactChange((c) => changes.push(c))
  const manifest = NestSync.exportManifest({ store: peer, deviceId: PEER, artifactId: published.artifactId, version: 1 })
  const first = await call("nest_artifact_import", { ...on, chunk: manifest })
  expect(first).toMatchObject({ result: "missing" })
  const [blob] = first["missing"] as { sha256: string; size: number }[]
  const piece = NestSync.exportBlob({ store: peer, artifactId: published.artifactId, version: 1, sha256: blob!.sha256, offset: 0, maxBytes: 24_000 })
  expect(await call("nest_artifact_import", { ...on, chunk: piece })).toMatchObject({ done: true })
  expect(await call("nest_artifact_import", { ...on, chunk: manifest, deskName: "Surface" })).toEqual({
    result: "added",
    artifactId: published.artifactId,
    version: 1,
  })
  off()
  expect(changes).toEqual([{ artifactId: published.artifactId, version: 1, kind: "imported" }])

  const token = store.get(published.artifactId, 1)!.version.contentToken
  const served = await serve({ pathname: `/artifact/${token}/index.html`, host: "127.0.0.1:4096", remoteAddress: "127.0.0.1" })
  expect(served.status).toBe(200)
  expect(new TextDecoder().decode(served.body)).toBe(PAGE)
  expect(served.headers["content-security-policy"]).toBe(SANDBOX)
  expect(served.headers["x-content-type-options"]).toBe(NO_SNIFF)

  // The export side answers from this store too: the manifest, and nothing for an unknown artifact.
  expect(await call("nest_artifact_export", { ...on, artifactId: published.artifactId, version: 1 })).toMatchObject({
    kind: "manifest",
    owner: PEER,
    digest: published.digest,
  })
  expect(await call("nest_artifact_export", { ...on, artifactId: "art_000000000000000000000000", version: 1 })).toMatchObject({
    refused: "not-found",
  })
})

test("a malformed call is refused as invalid params, not run", () => {
  const on = { enabled: true, deviceId: DESK }
  expect(() => ACPNestArtifacts.dispatch("nest_artifact_export", { ...on, artifactId: "x", version: 0 })).toThrow(RequestError)
  expect(() => ACPNestArtifacts.dispatch("nest_artifact_import", { ...on, chunk: { kind: "other" } })).toThrow(RequestError)
  expect(() => ACPNestArtifacts.dispatch("nest_artifact_apply", { ...on, rows: [] })).toThrow(RequestError)
  expect(() => ACPNestArtifacts.dispatch("nest_artifact_index", { enabled: true })).toThrow(RequestError)
})
