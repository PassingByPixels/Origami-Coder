// The four artifact tools, driven through their real execute against a real
// store in a temp directory.
//
// The store is a process singleton (src/artifact/instance.ts) opened lazily on
// the GLOBAL data dir, and `Global.Path.data` is a module-load constant that
// does not honour ORIGAMI_TEST_HOME. So every test primes that singleton with
// its own temp root first and forgets it afterwards; nothing here can reach the
// user's real ~/.local/share/origami.

import { afterEach, beforeEach, describe, expect } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { PermissionV1 } from "@origami/core/v1/permission"
import { FSUtil } from "@origami/core/fs-util"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import type { Tool } from "@/tool/tool"
import { artifactStore, resetArtifactStore } from "@/artifact/instance"
import { onArtifactChange, type ArtifactChange } from "@/artifact/events"
import {
  ArtifactDiffTool,
  ArtifactGetTool,
  ArtifactListTool,
  ArtifactPublishTool,
  MAX_PUBLISH_BYTES,
} from "../../src/tool/artifact"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

// The tools capture nothing at define time beyond the Tool.define wrapper's own
// Truncate + Agent, and resolve the instance inside execute. No session store
// and no question service: the publish ask goes through ctx.ask, which the
// literal context below supplies.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([FSUtil.node, Truncate.node, Agent.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

// A second harness for the registration check: the registry is what decides
// whether the model ever sees these tools, so that claim is made against the
// real ToolRegistry rather than against the four exports.
const registryIt = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [
      Config.node,
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".origami")])),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ]),
)

type Ask = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

/** A literal tool context that RECORDS every permission ask for assertion.
 *  `callID` is the idempotency key the publish tool derives its retry identity
 *  from, so a test that wants a second version passes a different one.
 *
 *  `deny` names a permission this context refuses. The engine's real ctx.ask
 *  (session/prompt.ts) ends in `Effect.orDie`, so a refusal reaches a tool as a
 *  DEFECT, not a typed failure — `Effect.die` here is that same shape. */
function makeCtx(callID = "call_artifact_1", deny?: string) {
  const asks: Ask[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_artifact-test"),
    messageID: MessageID.make("msg_artifact-test"),
    callID,
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.suspend(() => {
        asks.push(request)
        if (request.permission === deny) {
          return Effect.die(new PermissionV1.RejectedError({ reason: `test denies ${request.permission}` }))
        }
        return Effect.void
      }),
  }
  return { ctx, asks }
}

const tools = Effect.gen(function* () {
  return {
    publish: yield* (yield* ArtifactPublishTool).init(),
    list: yield* (yield* ArtifactListTool).init(),
    get: yield* (yield* ArtifactGetTool).init(),
    diff: yield* (yield* ArtifactDiffTool).init(),
  }
})

let root: string

beforeEach(async () => {
  resetArtifactStore()
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "artifact-tool-"))
  // Prime the singleton on the temp root. Every artifactStore() inside a tool
  // resolves to this same store, opened once.
  await artifactStore(root)
})

afterEach(async () => {
  const store = await artifactStore()
  store.close()
  resetArtifactStore()
  await disposeAllInstances()
  // Best effort. On Windows the SQLite WAL/SHM handles of a just-closed
  // database can stay mapped for a moment longer, and an EBUSY while removing
  // a temp directory is not a failure of anything this file asserts — the next
  // test gets a fresh mkdtemp either way.
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
})

const sha256 = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex")

/** Bytes that are NOT valid UTF-8 and contain a NUL, so a decode-then-encode
 *  anywhere in the publish path would change them. */
const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x01])

describe("tool.artifact registration", () => {
  registryIt.instance("all four artifact tools are in the registry, each with its own description", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("artifact_publish")
      expect(ids).toContain("artifact_list")
      expect(ids).toContain("artifact_get")
      expect(ids).toContain("artifact_diff")

      const defs = (yield* registry.all()).filter((tool) => tool.id.startsWith("artifact_"))
      expect(defs.map((def) => def.id).sort()).toEqual([
        "artifact_diff",
        "artifact_get",
        "artifact_list",
        "artifact_publish",
      ])
      // Each description is the tool's OWN .txt file, not a shared blurb: four
      // tools sharing one string would still pass a "non-empty" check while
      // telling the model nothing about which to call.
      const texts = defs.map((def) => def.description)
      for (const text of texts) expect(text.length).toBeGreaterThan(80)
      expect(new Set(texts).size).toBe(4)
      const byId = new Map(defs.map((def) => [def.id, def.description]))
      expect(byId.get("artifact_publish")).toContain("baseVersion")
      expect(byId.get("artifact_get")).toContain("64 KiB")
      expect(byId.get("artifact_diff")).toContain("added, removed or changed")

      // `all()` is the registry's own inventory; `tools()` is the list a model
      // is actually offered, after the per-model and per-flag filtering. These
      // ship ON with no flag, so they must survive that pass too.
      const agents = yield* Agent.Service
      const offered = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const offeredIds = offered.map((tool) => tool.id)
      for (const id of ["artifact_publish", "artifact_list", "artifact_get", "artifact_diff"]) {
        expect(offeredIds).toContain(id)
      }
    }),
  )
})

describe("tool.artifact_publish", () => {
  it.instance("a sourcePath file is published byte for byte", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const source = path.join(instance.directory, "logo.png")
      fs.writeFileSync(source, BINARY)
      const { ctx, asks } = makeCtx()
      const { publish } = yield* tools

      const result = yield* publish.execute(
        { title: "Binary page", files: [{ path: "logo.png", sourcePath: source }] },
        ctx,
      )

      // The ask is what a ruleset can close, so its shape is part of the
      // contract, not an implementation detail.
      expect(asks).toHaveLength(1)
      expect(asks[0].permission).toBe("artifact_publish")
      expect(asks[0].patterns).toEqual(["Binary page"])
      expect(asks[0].always).toEqual(["*"])
      // A source INSIDE the worktree needs no external-directory approval, so
      // this is the only ask — and the prompt names the file on disk whose
      // contents are about to be stored, not just its artifact path.
      expect(asks[0].metadata).toMatchObject({ sources: [source] })

      const store = yield* Effect.promise(() => artifactStore())
      const detail = store.get(result.metadata.artifactId!)!
      const entry = detail.entries.find((item) => item.path === "logo.png")!
      // The claim is "unchanged bytes", so it is checked against the SOURCE
      // file on disk, not against the array this test built.
      expect(entry.sha256).toBe(sha256(new Uint8Array(fs.readFileSync(source))))
      expect(Array.from(store.readBlob(entry.sha256)!)).toEqual(Array.from(BINARY))
      expect(entry.mediaType).toBe("image/png")
    }),
  )

  it.instance("a stale baseVersion comes back as text naming the current version, and throws nothing", () =>
    Effect.gen(function* () {
      const { publish } = yield* tools
      const first = yield* publish.execute(
        { title: "Report", files: [{ path: "index.html", content: "<h1>v1</h1>" }] },
        makeCtx("call_1").ctx,
      )
      const id = first.metadata.artifactId!
      yield* publish.execute(
        { title: "Report", files: [{ path: "index.html", content: "<h1>v2</h1>" }], artifactId: id, baseVersion: 1 },
        makeCtx("call_2").ctx,
      )

      // A third publish that still believes it is on v1 — the "another window
      // got there first" case the whole base rule exists for.
      const stale = yield* publish.execute(
        {
          title: "Report",
          files: [{ path: "index.html", content: "<h1>mine</h1>" }],
          artifactId: id,
          baseVersion: 1,
        },
        makeCtx("call_3").ctx,
      )

      expect(stale.output.toLowerCase()).toContain("conflict")
      expect(stale.output).toContain("version 2")
      expect(stale.metadata.conflict).toBe(true)
      const store = yield* Effect.promise(() => artifactStore())
      // Nothing was written: still two versions, and v2 is the one from call_2.
      expect(store.latestNumber(id)).toBe(2)
      const entry = store.entries(id, 2)[0]
      expect(new TextDecoder().decode(store.readBlob(entry.sha256))).toBe("<h1>v2</h1>")
    }),
  )

  it.instance("replaying the same tool call id mints no second version", () =>
    Effect.gen(function* () {
      const { publish } = yield* tools
      const first = yield* publish.execute(
        { title: "Retry", files: [{ path: "index.html", content: "<p>one</p>" }] },
        makeCtx("call_same").ctx,
      )
      const id = first.metadata.artifactId!

      // The same call arriving twice after a dropped connection: same callID,
      // and here even different bytes, which must NOT produce a v2.
      const replay = yield* publish.execute(
        { title: "Retry", files: [{ path: "index.html", content: "<p>two</p>" }] },
        makeCtx("call_same").ctx,
      )

      expect(replay.metadata.artifactId).toBe(id)
      expect(replay.metadata.version).toBe(1)
      const store = yield* Effect.promise(() => artifactStore())
      expect(store.latestNumber(id)).toBe(1)
      expect(store.list({ all: true })).toHaveLength(1)
    }),
  )

  it.instance("publishing onto an artifact without a baseVersion is refused in text, not written", () =>
    Effect.gen(function* () {
      const { publish } = yield* tools
      const first = yield* publish.execute(
        { title: "Guarded", files: [{ path: "index.html", content: "<p>one</p>" }] },
        makeCtx("call_a").ctx,
      )
      const id = first.metadata.artifactId!
      const { ctx, asks } = makeCtx("call_b")

      const refused = yield* publish.execute(
        { title: "Guarded", files: [{ path: "index.html", content: "<p>two</p>" }], artifactId: id },
        ctx,
      )

      expect(refused.output).toContain("baseVersion")
      expect(refused.output).toContain("Nothing was written")
      // Refused BEFORE the ask: a call that cannot be honoured must not put a
      // permission prompt in front of the user.
      expect(asks).toHaveLength(0)
      const store = yield* Effect.promise(() => artifactStore())
      expect(store.latestNumber(id)).toBe(1)
    }),
  )

  it.instance("an unsafe path rejects the whole publish as text and writes nothing", () =>
    Effect.gen(function* () {
      const { publish } = yield* tools
      const result = yield* publish.execute(
        {
          title: "Traversal",
          files: [
            { path: "index.html", content: "<p>ok</p>" },
            { path: "../escape.txt", content: "no" },
          ],
        },
        makeCtx("call_bad").ctx,
      )

      expect(result.output).toContain("../escape.txt")
      expect(result.output).toContain("Nothing was written")
      const store = yield* Effect.promise(() => artifactStore())
      // The SAFE file of the same publish is gone too — a version missing a
      // file renders as a broken page, so the whole call is refused.
      expect(store.list({ all: true })).toHaveLength(0)
    }),
  )

  it.instance("a sourcePath outside the project is refused when external_directory is denied", () =>
    Effect.gen(function* () {
      // OUTSIDE the instance directory on purpose: this is the case where the
      // engine would otherwise copy an arbitrary file off the user's disk into
      // a stored artifact with only an "artifact_publish" prompt shown.
      const outside = path.join(root, "secrets.txt")
      fs.writeFileSync(outside, "ssh-key")
      const { ctx, asks } = makeCtx("call_ext", "external_directory")
      const { publish } = yield* tools

      const result = yield* publish.execute(
        { title: "Exfil", files: [{ path: "notes.txt", sourcePath: outside }] },
        ctx,
      )

      expect(result.output).toContain(outside)
      expect(result.output).toContain("Nothing was written")
      // The external gate was consulted, and the publish ask never happened:
      // the user is not asked to approve publishing a file the engine may not
      // even read.
      expect(asks.map((ask) => ask.permission)).toEqual(["external_directory"])
      const store = yield* Effect.promise(() => artifactStore())
      expect(store.list({ all: true })).toHaveLength(0)
    }),
  )

  it.instance("a sourcePath outside the project publishes once external_directory is approved", () =>
    Effect.gen(function* () {
      const outside = path.join(root, "chart.png")
      fs.writeFileSync(outside, BINARY)
      const { ctx, asks } = makeCtx("call_ext_ok")
      const { publish } = yield* tools

      const result = yield* publish.execute(
        { title: "Approved", files: [{ path: "chart.png", sourcePath: outside }] },
        ctx,
      )

      expect(asks.map((ask) => ask.permission)).toEqual(["external_directory", "artifact_publish"])
      expect(result.metadata.version).toBe(1)
      const store = yield* Effect.promise(() => artifactStore())
      const entry = store.get(result.metadata.artifactId!)!.entries[0]
      expect(Array.from(store.readBlob(entry.sha256)!)).toEqual(Array.from(BINARY))
    }),
  )

  it.instance("a version over the 32 MiB cap is refused before anything is asked or written", () =>
    Effect.gen(function* () {
      const half = "a".repeat(MAX_PUBLISH_BYTES / 2)
      const { ctx, asks } = makeCtx("call_big")
      const { publish } = yield* tools

      // Two files that are each well under the cap but TOGETHER exceed it: the
      // limit is on the version, not on any one file.
      const result = yield* publish.execute(
        {
          title: "Huge",
          files: [
            { path: "a.txt", content: half },
            { path: "b.txt", content: `${half}x` },
          ],
        },
        ctx,
      )

      expect(result.output).toContain("32.00 MiB")
      expect(result.output).toContain(`${MAX_PUBLISH_BYTES + 1} bytes`)
      expect(result.output).toContain("Nothing was written")
      expect(asks).toHaveLength(0)
      const store = yield* Effect.promise(() => artifactStore())
      expect(store.list({ all: true })).toHaveLength(0)
    }),
  )
})

// t-s3pdlq: the base prompt names WHEN to publish; this nudge is the only
// place that tells the model to tell the OWNER where the result landed, and
// it must appear exactly once per result — never duplicated by a second copy
// added elsewhere.
const PILL_NUDGE = "Tell the user this is in the Artifacts pill in the sidebar."
const nudgeCount = (output: string) => output.split(PILL_NUDGE).length - 1

describe("tool.artifact nudge line", () => {
  it.instance("publish, list, get and diff each end with the pill nudge exactly once", () =>
    Effect.gen(function* () {
      const { publish, list, get, diff } = yield* tools
      const first = yield* publish.execute(
        { title: "Nudge", files: [{ path: "index.html", content: "<p>one</p>" }] },
        makeCtx("call_n1").ctx,
      )
      expect(nudgeCount(first.output)).toBe(1)
      const id = first.metadata.artifactId!
      const second = yield* publish.execute(
        { title: "Nudge", files: [{ path: "index.html", content: "<p>two</p>" }], artifactId: id, baseVersion: 1 },
        makeCtx("call_n2").ctx,
      )
      expect(nudgeCount(second.output)).toBe(1)

      const listed = yield* list.execute({}, makeCtx("call_n3").ctx)
      expect(nudgeCount(listed.output)).toBe(1)

      const got = yield* get.execute({ artifactId: id }, makeCtx("call_n4").ctx)
      expect(nudgeCount(got.output)).toBe(1)

      const diffed = yield* diff.execute({ artifactId: id, from: 1, to: 2 }, makeCtx("call_n5").ctx)
      expect(nudgeCount(diffed.output)).toBe(1)
    }),
  )
})

// t-s49986: the model is told what a page can and cannot do in the sandbox.
// Every item is a thing a model would otherwise try and have fail silently in
// the owner's browser, so each one is asserted by name.
describe("tool.artifact_publish capability sheet", () => {
  it.instance("the description names what runs, what does not, the size cap and immutability", () =>
    Effect.gen(function* () {
      const { publish } = yield* tools
      const text = publish.description
      const sheet = text.split("WHAT A PAGE CAN DO.")[1] ?? ""
      expect(sheet, "the capability sheet is missing").not.toBe("")
      const works = sheet.split("It does not work:")[0]!
      const fails = sheet.split("It does not work:")[1] ?? ""
      expect(fails, "the sheet has no does-not-work list").not.toBe("")

      // The header it describes is the one serve.ts actually sends.
      expect(sheet).toContain("sandbox allow-scripts")
      // Runs.
      expect(works).toContain("Inline <script> and <style>")
      expect(works).toContain("own relative files")
      expect(works).toContain("Script, stylesheet and font links to a public CDN")
      expect(works).toContain("Images from the artifact's own files")
      // Does not run.
      expect(fails).toContain("fetch or XMLHttpRequest to the engine or to any same-origin URL")
      expect(fails).toContain("localStorage, sessionStorage, IndexedDB and cookies")
      expect(fails).toContain("Form submission")
      expect(fails).toContain("window.open or navigation to the engine")
      expect(fails).toContain("local disk path")
      // Markdown is named, and named as a LIMIT: nothing renders it.
      expect(fails).toContain("a .md entry is served as text/markdown and shows as plain text")
      // The cap and immutability.
      expect(text).toContain("at most 32 MiB")
      expect(sheet).toContain("A version is immutable")
      // The cap it states is the cap the tool enforces.
      expect(MAX_PUBLISH_BYTES).toBe(32 * 1024 * 1024)
    }),
  )
})

// t-s49986: the result carries a STABLE link the chat renders as a card.
describe("tool.artifact link", () => {
  it.instance("publish and get each carry origami://artifact/<id>?v=<n> for the version they name", () =>
    Effect.gen(function* () {
      const { publish, get } = yield* tools
      const first = yield* publish.execute(
        { title: "Q3 [draft] report", files: [{ path: "index.html", content: "<p>one</p>" }] },
        makeCtx("call_k1").ctx,
      )
      const id = first.metadata.artifactId!
      expect(id).toMatch(/^art_[0-9a-f]+$/)
      // The label is the title with brackets swapped, so the Markdown link
      // does not end early; the link itself is exact.
      expect(first.output).toContain(`Link: [Q3 (draft) report](origami://artifact/${id}?v=1)`)

      const second = yield* publish.execute(
        { title: "Q3 report", files: [{ path: "index.html", content: "<p>two</p>" }], artifactId: id, baseVersion: 1 },
        makeCtx("call_k2").ctx,
      )
      expect(second.output).toContain(`(origami://artifact/${id}?v=2)`)
      expect(second.output).not.toContain(`?v=1)`)

      // get names the version it READ, not the latest.
      const old = yield* get.execute({ artifactId: id, version: 1 }, makeCtx("call_k3").ctx)
      expect(old.output).toContain(`(origami://artifact/${id}?v=1)`)
      const latest = yield* get.execute({ artifactId: id }, makeCtx("call_k4").ctx)
      expect(latest.output).toContain(`Link: [Q3 report](origami://artifact/${id}?v=2)`)
    }),
  )

  it.instance("a publish tells the host which session made it", () =>
    Effect.gen(function* () {
      const { publish } = yield* tools
      const heard: ArtifactChange[] = []
      const off = onArtifactChange((change) => heard.push(change))
      try {
        yield* publish.execute(
          { title: "Heard", files: [{ path: "index.html", content: "<p>x</p>" }] },
          makeCtx("call_k5").ctx,
        )
      } finally {
        off()
      }
      expect(heard).toHaveLength(1)
      expect(heard[0]).toMatchObject({ version: 1, kind: "published", sessionID: "ses_artifact-test" })
    }),
  )
})

describe("tool.artifact_list", () => {
  it.instance("lists this project's artifacts with id, latest version and title", () =>
    Effect.gen(function* () {
      const { publish, list } = yield* tools
      const first = yield* publish.execute(
        { title: "Quarterly", files: [{ path: "index.html", content: "<p>a</p>" }] },
        makeCtx("call_l1").ctx,
      )
      const id = first.metadata.artifactId!
      yield* publish.execute(
        { title: "Quarterly", files: [{ path: "index.html", content: "<p>b</p>" }], artifactId: id, baseVersion: 1 },
        makeCtx("call_l2").ctx,
      )

      const result = yield* list.execute({}, makeCtx("call_l3").ctx)
      expect(result.output).toContain(id)
      expect(result.output).toContain("v2")
      expect(result.output).toContain("Quarterly")
      expect(result.metadata.files).toBe(1)
    }),
  )
})

describe("tool.artifact_get", () => {
  it.instance("returns text content inline and reports a binary entry by size and media type only", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const source = path.join(instance.directory, "logo.png")
      fs.writeFileSync(source, BINARY)
      const { publish, get } = yield* tools
      const published = yield* publish.execute(
        {
          title: "Mixed",
          files: [
            { path: "index.html", content: "<h1>hello artifact</h1>" },
            { path: "logo.png", sourcePath: source },
          ],
        },
        makeCtx("call_g1").ctx,
      )
      const id = published.metadata.artifactId!

      const result = yield* get.execute({ artifactId: id }, makeCtx("call_g2").ctx)

      expect(result.output).toContain("<h1>hello artifact</h1>")
      expect(result.output).toContain(`logo.png (${BINARY.byteLength} bytes, image/png)`)
      expect(result.output).toContain("not shown")
      // The binary bytes are never decoded into the model's context.
      expect(result.output).not.toContain("\u0000")
      expect(result.output).not.toContain("�")
      expect(result.metadata.version).toBe(1)
    }),
  )

  it.instance("an unknown artifact is a text refusal, not a throw", () =>
    Effect.gen(function* () {
      const { get } = yield* tools
      const result = yield* get.execute({ artifactId: "art_nope" }, makeCtx("call_g3").ctx)
      expect(result.output).toContain("art_nope")
      expect(result.output).toContain("artifact_list")
    }),
  )
})

describe("tool.artifact_diff", () => {
  it.instance("names the added, removed and changed paths between two versions", () =>
    Effect.gen(function* () {
      const { publish, diff } = yield* tools
      const first = yield* publish.execute(
        {
          title: "Site",
          files: [
            { path: "index.html", content: "<p>one</p>" },
            { path: "old.css", content: "a{}" },
            { path: "stable.txt", content: "same" },
          ],
        },
        makeCtx("call_d1").ctx,
      )
      const id = first.metadata.artifactId!
      yield* publish.execute(
        {
          title: "Site",
          files: [
            { path: "index.html", content: "<p>two</p>" },
            { path: "new.css", content: "b{}" },
            { path: "stable.txt", content: "same" },
          ],
          artifactId: id,
          baseVersion: 1,
        },
        makeCtx("call_d2").ctx,
      )

      const result = yield* diff.execute({ artifactId: id, from: 1, to: 2 }, makeCtx("call_d3").ctx)

      expect(result.output).toContain("Added:\n- new.css")
      expect(result.output).toContain("Removed:\n- old.css")
      expect(result.output).toContain("Changed:\n- index.html")
      // A file with identical bytes in both versions is in none of the lists.
      expect(result.output).not.toContain("stable.txt")
      expect(result.metadata.files).toBe(3)
    }),
  )

  it.instance("a version the artifact does not have is a text refusal naming the latest", () =>
    Effect.gen(function* () {
      const { publish, diff } = yield* tools
      const first = yield* publish.execute(
        { title: "Small", files: [{ path: "index.html", content: "<p>one</p>" }] },
        makeCtx("call_d4").ctx,
      )
      const id = first.metadata.artifactId!

      const result = yield* diff.execute({ artifactId: id, from: 1, to: 7 }, makeCtx("call_d5").ctx)
      expect(result.output).toContain("no version 7")
      expect(result.output).toContain("its latest is 1")
    }),
  )
})
