// THE ARTIFACT ACP SURFACE, END TO END.
//
// The claim `artifact_open` makes is not "a url was built": it is "this url
// opens the page in the integrated browser". So this file starts a REAL
// listener (the `httpapi-listen.test.ts` shape), asks `ACPArtifacts.open` for
// the url, and fetches it over the socket with no headers at all. That is the
// browser's exact position, and it is the one thing a shape assertion could
// never prove. (`artifact/serve.test.ts` holds the other half: the same route
// answering on a server that HAS a password.)
//
// The other four methods are asserted against a real store for the same reason
// `artifact/store.test.ts` uses one: the rows the pane renders are rows SQLite
// returned, and a mock would restate the mapping rather than check it.
import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { LayerNode } from "@origami/core/effect/layer-node"
import type { OrigamiClient } from "@origami/sdk/v2"
import { Effect, ManagedRuntime } from "effect"
import { ACPArtifacts } from "@/acp/artifacts"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"
import { emitArtifactChange, onArtifactChange } from "@/artifact/events"
import { artifactStore, resetArtifactStore } from "@/artifact/instance"
import { Server } from "@/server/server"

const bytes = (text: string) => new TextEncoder().encode(text)
const V1 = "<!doctype html><h1>v1</h1>"
const V2 = "<!doctype html><h1>v2</h1>"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-acp-"))
resetArtifactStore()
const store = await artifactStore(root)

const first = store.publish({
  title: "Release notes",
  files: [
    { path: "index.html", bytes: bytes(V1) },
    { path: "old.css", bytes: bytes("a{}") },
  ],
  baseVersion: "absent",
  idempotencyKey: "acp-1",
  sessionID: "ses_one",
  projectPath: "C:/Repos/Origami Coder",
  device: "5090",
})
if (first.kind !== "published") throw new Error("fixture publish did not publish")
const ID = first.artifactId

const second = store.publish({
  artifactId: ID,
  title: "Release notes",
  files: [
    { path: "index.html", bytes: bytes(V2) },
    { path: "new.js", bytes: bytes("console.log(1)") },
  ],
  baseVersion: 1,
  idempotencyKey: "acp-2",
  device: "5090",
})
if (second.kind !== "published") throw new Error("fixture republish did not publish")

const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })

afterAll(async () => {
  await listener.stop(true).catch(() => {})
  resetArtifactStore()
  try {
    store.close()
  } catch {}
  Bun.gc(true)
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EBUSY" && code !== "EPERM") throw error
      Bun.gc(true)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
})

test("artifact_open returns the loopback url of the version's entry file, and that url really serves it", async () => {
  const latest = await ACPArtifacts.open({ artifactId: ID })
  expect(latest.url).toBe(`http://127.0.0.1:${listener.port}/artifact/${second.contentToken}/index.html`)

  // THE WHOLE POINT: no headers, no credentials — what the integrated browser
  // sends when it opens a tab.
  const response = await fetch(latest.url)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(V2)
  expect(response.headers.get("content-type")).toBe("text/html")
  expect(response.headers.get("cache-control")).toContain("immutable")
})

test("artifact_open answers a localPath on this machine's disk, for Show in Explorer", async () => {
  const latest = await ACPArtifacts.open({ artifactId: ID })
  expect(latest.localPath).toBeDefined()
  expect(fs.existsSync(latest.localPath!)).toBe(true)
  expect(fs.readFileSync(latest.localPath!, "utf8")).toBe(V2)
})

test("artifact_open with an explicit version opens THAT version, on its own token", async () => {
  const old = await ACPArtifacts.open({ artifactId: ID, version: 1 })
  expect(old.url).toBe(`http://127.0.0.1:${listener.port}/artifact/${first.contentToken}/index.html`)
  expect(await (await fetch(old.url)).text()).toBe(V1)
})

test("artifact_open names the artifact or the version it could not find", async () => {
  await expect(ACPArtifacts.open({ artifactId: "art_nope" })).rejects.toThrow("no artifact art_nope")
  await expect(ACPArtifacts.open({ artifactId: ID, version: 99 })).rejects.toThrow(`no version 99 of ${ID}`)
})

test("artifact_list carries the row the sidebar renders", async () => {
  const result = await ACPArtifacts.list()
  const row = result.artifacts.find((item) => item.id === ID)
  expect(row).toEqual({
    id: ID,
    title: "Release notes",
    latest: 2,
    updated: expect.any(Number),
    ownerDevice: "5090",
    // Bodies are local until the sync lane exists, so nothing can be elsewhere
    // yet, and nothing can have arrived unopened or in conflict either.
    here: true,
    unopened: false,
    sessionID: "ses_one",
    project: "C:/Repos/Origami Coder",
  })
  expect(row && "conflict" in row).toBe(false)
  // The pane marks its own rows with this, without a second call.
  expect(result.homeDevice).toBe(ACPArtifacts.THIS_MACHINE)
})

test("a row with no recorded device says this machine rather than nothing", async () => {
  const local = store.publish({
    title: "Made here",
    files: [{ path: "index.html", bytes: bytes("<p>here</p>") }],
    baseVersion: "absent",
    idempotencyKey: "acp-local",
  })
  if (local.kind !== "published") throw new Error("fixture publish did not publish")
  const row = (await ACPArtifacts.list()).artifacts.find((item) => item.id === local.artifactId)
  expect(row?.ownerDevice).toBe(ACPArtifacts.THIS_MACHINE)
  expect(row?.project).toBeUndefined()
})

test("artifact_list filters to a project, and `all` overrides that filter", async () => {
  const mine = await ACPArtifacts.list({ projectPath: "C:/Repos/Origami Coder" })
  expect(mine.artifacts.map((item) => item.id)).toEqual([ID])
  const everything = await ACPArtifacts.list({ all: true, projectPath: "C:/Repos/Origami Coder" })
  expect(everything.artifacts.length).toBeGreaterThan(1)
})

test("artifact_versions lists every version newest first, with its digest and device", async () => {
  const result = await ACPArtifacts.versions({ artifactId: ID })
  expect(result.versions.map((version) => version.number)).toEqual([2, 1])
  expect(result.versions[0]).toEqual({
    number: 2,
    digest: second.digest,
    created: expect.any(Number),
    device: "5090",
  })
  await expect(ACPArtifacts.versions({ artifactId: "art_nope" })).rejects.toThrow("no artifact art_nope")
})

test("artifact_diff answers in file paths, both ways round", async () => {
  expect(await ACPArtifacts.diff({ artifactId: ID, from: 1, to: 2 })).toEqual({
    added: ["new.js"],
    removed: ["old.css"],
    changed: ["index.html"],
  })
  expect(await ACPArtifacts.diff({ artifactId: ID, from: 2, to: 1 })).toEqual({
    added: ["old.css"],
    removed: ["new.js"],
    changed: ["index.html"],
  })
})

test("artifact_restore copies an old version FORWARD and announces it", async () => {
  const heard: unknown[] = []
  const off = onArtifactChange((change) => heard.push(change))
  try {
    const result = await ACPArtifacts.restore({ artifactId: ID, version: 1 })
    // Forward, not a rewind: the history keeps every step.
    expect(result.version).toBe(3)
    expect((await ACPArtifacts.versions({ artifactId: ID })).versions.map((v) => v.number)).toEqual([3, 2, 1])
    expect(heard).toEqual([{ artifactId: ID, version: 3, kind: "restored" }])
    // And the restored page is v1's bytes, reachable on the NEW version's token.
    const opened = await ACPArtifacts.open({ artifactId: ID })
    expect(await (await fetch(opened.url)).text()).toBe(V1)
  } finally {
    off()
  }
})

test("artifact_rename changes the title and announces a renamed change", async () => {
  const { sent, subscription: bridge } = subscription()
  bridge.start()
  try {
    const result = await ACPArtifacts.rename({ artifactId: ID, title: "Renamed notes" })
    expect(result).toEqual({ title: "Renamed notes" })
    expect((await ACPArtifacts.list()).artifacts.find((item) => item.id === ID)?.title).toBe("Renamed notes")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sent).toEqual([{ method: "origami/artifactsChanged", params: { artifactId: ID, kind: "renamed" } }])
  } finally {
    bridge.stop()
  }
  await expect(ACPArtifacts.rename({ artifactId: "art_nope", title: "x" })).rejects.toThrow("no artifact art_nope")
})

test("artifact_delete removes the artifact, shares surviving blobs, and announces a deleted change", async () => {
  const doomed = store.publish({
    title: "Throwaway",
    files: [{ path: "index.html", bytes: bytes("<p>bye</p>") }],
    baseVersion: "absent",
    idempotencyKey: "acp-doomed",
  })
  if (doomed.kind !== "published") throw new Error("fixture publish did not publish")

  const { sent, subscription: bridge } = subscription()
  bridge.start()
  try {
    const result = await ACPArtifacts.remove({ artifactId: doomed.artifactId })
    expect(result).toEqual({ removedVersions: 1, removedBlobs: 1 })
    expect((await ACPArtifacts.list()).artifacts.some((item) => item.id === doomed.artifactId)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sent).toEqual([
      { method: "origami/artifactsChanged", params: { artifactId: doomed.artifactId, kind: "deleted" } },
    ])
  } finally {
    bridge.stop()
  }
  await expect(ACPArtifacts.remove({ artifactId: "art_nope" })).rejects.toThrow("no artifact art_nope")
})

// ------------------------------------------------ origami/artifactsChanged

/** The event bridge with nothing behind it but a recording connection: the
 *  claim under test is only that a store change becomes one ext notification. */
function subscription() {
  const sent: { method: string; params: unknown }[] = []
  const sdk = {
    global: { event: () => Promise.resolve({ stream: (async function* () {})() }) },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: () => Promise.resolve(),
    extNotification: (method: string, params: unknown) => {
      sent.push({ method, params })
      return Promise.resolve()
    },
  } as unknown as AgentSideConnection
  const session = ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
  return { sent, subscription: new ACPEvent.Subscription({ sdk, connection, session }) }
}

test("a store change is pushed to the extension as origami/artifactsChanged, and stops when the bridge stops", async () => {
  const { sent, subscription: bridge } = subscription()
  bridge.start()
  try {
    emitArtifactChange({ artifactId: ID, version: 4, kind: "published" })
    // The forward is fired and not awaited by the emitter, so let it settle.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sent).toEqual([
      { method: "origami/artifactsChanged", params: { artifactId: ID, version: 4, kind: "published" } },
    ])
  } finally {
    bridge.stop()
  }
  emitArtifactChange({ artifactId: ID, version: 5, kind: "published" })
  await new Promise((resolve) => setTimeout(resolve, 10))
  // A stopped bridge must not keep a dead connection alive by writing to it.
  expect(sent).toHaveLength(1)
})

test("a change made by a tool call carries its session, so only that chat auto-opens it (t-s49986)", async () => {
  const { sent, subscription: bridge } = subscription()
  bridge.start()
  try {
    emitArtifactChange({ artifactId: ID, version: 1, kind: "published", sessionID: "ses_one" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sent).toEqual([
      {
        method: "origami/artifactsChanged",
        params: { artifactId: ID, version: 1, kind: "published", sessionID: "ses_one" },
      },
    ])
  } finally {
    bridge.stop()
  }
})

test("the notification name is the one the extension listens for", () => {
  expect(ACPArtifacts.ARTIFACTS_CHANGED_METHOD).toBe("origami/artifactsChanged")
})
