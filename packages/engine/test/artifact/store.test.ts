// THE CONFLICT RULE, PROVED ON A REAL STORE. Every test here opens a real
// SQLite file and a real blob directory in a temp dir — no fake driver, no
// in-memory shim — because the two claims that matter ("nothing was written"
// and "the unchanged blobs are shared") are claims about the disk. A mock that
// counted calls would restate the implementation and catch none of the bugs
// this is here to catch: a conflict that hashed and wrote the bodies before it
// refused, a republish that stored a second copy of an unchanged file, a prune
// that took the blob the sidebar's newest version needs.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ArtifactStore } from "@/artifact/store"
import { ArtifactNotFoundError, ArtifactPathError } from "@/artifact/types"

const dirs: string[] = []
const stores: ArtifactStore[] = []

const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-store-"))
  dirs.push(directory)
  return directory
}

const open = async (root: string, now?: () => number) => {
  const store = await ArtifactStore.open(root, now ? { now } : undefined)
  stores.push(store)
  return store
}

// Windows keeps the SQLite WAL handle alive until the driver's finalizer runs,
// so a straight rmSync here fails EBUSY through no fault of the code under
// test. Same GC-and-retry shape as `test/preload.ts` uses for the same reason.
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
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "EBUSY" && code !== "EPERM") throw error
        if (attempt === 19) break
        Bun.gc(true)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
})

const bytes = (text: string) => new TextEncoder().encode(text)
const blobNames = (root: string) =>
  fs.readdirSync(path.join(root, "blobs")).filter((name) => /^[0-9a-f]{64}$/.test(name))

const DAY = 86_400_000

describe("ArtifactStore", () => {
  test("creates its schema on first open and opening twice keeps the rows", async () => {
    const root = tmp()
    const first = await open(root)
    const published = first.publish({
      title: "Dashboard",
      files: [{ path: "index.html", bytes: bytes("<h1>hi</h1>") }],
      baseVersion: "absent",
      idempotencyKey: "k1",
      projectPath: "C:/repo",
    })
    expect(published.kind).toBe("published")
    first.close()

    expect(fs.existsSync(path.join(root, "artifacts.db"))).toBe(true)

    const second = await open(root)
    expect(second.list()).toHaveLength(1)
    expect(second.list()[0]!.title).toBe("Dashboard")
    // Second open re-ran every CREATE; the version is still v1, not a fresh store.
    expect(second.list()[0]!.latestVersion).toBe(1)
  })

  test("republishing one changed file of three keeps four blobs, not six", async () => {
    const root = tmp()
    const store = await open(root)
    const v1 = store.publish({
      title: "Page",
      files: [
        { path: "index.html", bytes: bytes("<p>one</p>") },
        { path: "app.css", bytes: bytes("body{}") },
        { path: "app.js", bytes: bytes("console.log(1)") },
      ],
      baseVersion: "absent",
      idempotencyKey: "p1",
    })
    expect(v1.kind).toBe("published")
    expect(blobNames(root)).toHaveLength(3)

    const v2 = store.publish({
      artifactId: (v1 as { artifactId: string }).artifactId,
      title: "Page",
      files: [
        { path: "index.html", bytes: bytes("<p>two</p>") },
        { path: "app.css", bytes: bytes("body{}") },
        { path: "app.js", bytes: bytes("console.log(1)") },
      ],
      baseVersion: 1,
      idempotencyKey: "p2",
    })
    expect(v2).toMatchObject({ kind: "published", version: 2 })
    // One new body, two shared. Six would mean every republish stores the world.
    expect(blobNames(root)).toHaveLength(4)
    expect(store.sizeReport().versions).toBe(2)
    // Both versions still resolve their unchanged files.
    expect(store.get((v1 as { artifactId: string }).artifactId, 1)!.entries).toHaveLength(3)
  })

  test("a stale baseVersion is refused and writes nothing", async () => {
    const root = tmp()
    const store = await open(root)
    const v1 = store.publish({
      title: "Plan",
      files: [{ path: "plan.md", bytes: bytes("# v1") }],
      baseVersion: "absent",
      idempotencyKey: "c1",
    })
    const id = (v1 as { artifactId: string }).artifactId
    const v2 = store.publish({
      artifactId: id,
      title: "Plan",
      files: [{ path: "plan.md", bytes: bytes("# v2 from the MacBook") }],
      baseVersion: 1,
      idempotencyKey: "c2",
    })
    expect(v2).toMatchObject({ kind: "published", version: 2 })

    const before = { ...store.sizeReport(), blobs: blobNames(root).length }

    // This machine still had v1 open when the other one published v2.
    const refused = store.publish({
      artifactId: id,
      title: "Plan",
      files: [{ path: "plan.md", bytes: bytes("# my own v2") }],
      baseVersion: 1,
      idempotencyKey: "c3",
    })
    expect(refused.kind).toBe("conflict")
    expect(refused).toMatchObject({
      kind: "conflict",
      artifactId: id,
      currentVersion: 2,
      currentDigest: (v2 as { digest: string }).digest,
    })

    // Nothing written: not a row, not a blob. The body of "# my own v2" was
    // never even hashed onto the disk.
    expect({ ...store.sizeReport(), blobs: blobNames(root).length }).toEqual(before)
    expect(store.latestNumber(id)).toBe(2)
  })

  test("the same idempotencyKey replays the first result and makes no second version", async () => {
    const root = tmp()
    const store = await open(root)
    const first = store.publish({
      title: "Report",
      files: [{ path: "report.md", bytes: bytes("done") }],
      baseVersion: "absent",
      idempotencyKey: "retry-me",
    })
    const again = store.publish({
      title: "Report",
      files: [{ path: "report.md", bytes: bytes("done") }],
      baseVersion: "absent",
      idempotencyKey: "retry-me",
    })
    expect(again).toEqual(first)
    expect(store.sizeReport().versions).toBe(1)
    expect(store.sizeReport().artifacts).toBe(1)
  })

  test("forkAsSibling records the parent artifact and version, and both list", async () => {
    const root = tmp()
    const store = await open(root)
    const v1 = store.publish({
      title: "Dashboard",
      files: [{ path: "index.html", bytes: bytes("<b>theirs</b>") }],
      baseVersion: "absent",
      idempotencyKey: "f1",
      projectPath: "C:/repo",
    })
    const id = (v1 as { artifactId: string }).artifactId

    const sibling = store.forkAsSibling(id, 1, [{ path: "index.html", bytes: bytes("<b>mine</b>") }])
    expect(sibling.kind).toBe("published")
    expect(sibling.artifactId).not.toBe(id)
    expect(sibling.version).toBe(1)

    const forked = store.artifact(sibling.artifactId)!
    expect(forked.parentArtifactId).toBe(id)
    expect(forked.parentVersion).toBe(1)
    expect(forked.title).toBe("Dashboard (sibling)")
    // The point of the rule: both copies survive and both are visible.
    expect(
      store
        .list()
        .map((item) => item.id)
        .sort(),
    ).toEqual([id, sibling.artifactId].sort())
  })

  test("restore(n) creates a new version with version n's digest", async () => {
    const root = tmp()
    const store = await open(root)
    const v1 = store.publish({
      title: "Page",
      files: [{ path: "index.html", bytes: bytes("first") }],
      baseVersion: "absent",
      idempotencyKey: "r1",
    })
    const id = (v1 as { artifactId: string }).artifactId
    store.publish({
      artifactId: id,
      title: "Page",
      files: [{ path: "index.html", bytes: bytes("second") }],
      baseVersion: 1,
      idempotencyKey: "r2",
    })

    const restored = store.restore(id, 1)
    expect(restored.version).toBe(3)
    expect(restored.digest).toBe((v1 as { digest: string }).digest)
    // A copy-forward, not a rewind: v2 is still there and the body still reads.
    expect(store.latestNumber(id)).toBe(3)
    const entry = store.get(id, 3)!.entries[0]!
    expect(new TextDecoder().decode(store.readBlob(entry.sha256)!)).toBe("first")
    // A restore mints its own token, so a stale link cannot follow the rewind.
    expect(restored.contentToken).not.toBe(store.version(id, 1)!.contentToken)
  })

  test("diff reports added, removed and changed paths", async () => {
    const root = tmp()
    const store = await open(root)
    const v1 = store.publish({
      title: "Page",
      files: [
        { path: "index.html", bytes: bytes("one") },
        { path: "old.css", bytes: bytes("gone") },
        { path: "same.js", bytes: bytes("stable") },
      ],
      baseVersion: "absent",
      idempotencyKey: "d1",
    })
    const id = (v1 as { artifactId: string }).artifactId
    store.publish({
      artifactId: id,
      title: "Page",
      files: [
        { path: "index.html", bytes: bytes("two") },
        { path: "new.css", bytes: bytes("fresh") },
        { path: "same.js", bytes: bytes("stable") },
      ],
      baseVersion: 1,
      idempotencyKey: "d2",
    })
    expect(store.diff(id, 1, 2)).toEqual({
      added: ["new.css"],
      removed: ["old.css"],
      changed: ["index.html"],
    })
  })

  test("an unsafe manifest path is rejected at publish time with nothing written", async () => {
    const root = tmp()
    const store = await open(root)
    store.publish({
      title: "Page",
      files: [{ path: "index.html", bytes: bytes("safe") }],
      baseVersion: "absent",
      idempotencyKey: "s1",
    })
    const before = { ...store.sizeReport(), blobs: blobNames(root).length }

    const unsafe = [
      "../escape.html",
      "a/../../escape.html",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "a%2Fb.html",
      "a%252Fb.html",
      ".git/config",
      "nested/.git/HEAD",
      "a//b.html",
      "/",
      "",
      "back\\slash.html",
    ]
    for (const bad of unsafe) {
      expect(() =>
        store.publish({
          title: "Attack",
          files: [
            { path: "index.html", bytes: bytes("decoy") },
            { path: bad, bytes: bytes("payload") },
          ],
          baseVersion: "absent",
          idempotencyKey: `unsafe-${bad}`,
        }),
      ).toThrow(ArtifactPathError)
    }

    // Not one artifact, version or blob from twelve attempts — including the
    // innocent-looking decoy that shared each rejected manifest.
    expect({ ...store.sizeReport(), blobs: blobNames(root).length }).toEqual(before)
  })

  test("resolveToken serves a manifest path and refuses a traversal", async () => {
    const root = tmp()
    const store = await open(root)
    const v1 = store.publish({
      title: "Page",
      files: [
        { path: "index.html", bytes: bytes("<p>hi</p>") },
        { path: "assets/app.css", bytes: bytes("body{}") },
      ],
      baseVersion: "absent",
      idempotencyKey: "t1",
    })
    const token = (v1 as { contentToken: string }).contentToken
    expect(token.length).toBeGreaterThanOrEqual(22)

    const hit = store.resolveToken(token, "assets/app.css")!
    expect(hit.entry.mediaType).toBe("text/css")
    expect(fs.readFileSync(hit.blobPath, "utf8")).toBe("body{}")

    expect(store.resolveToken(token, "../../artifacts.db")).toBeUndefined()
    expect(store.resolveToken(token, "missing.html")).toBeUndefined()
    expect(store.resolveToken("not-a-token", "index.html")).toBeUndefined()
  })

  test("sizeReport matches the bytes on disk and pruneByWindow spares every latest version", async () => {
    const root = tmp()
    let clock = Date.UTC(2026, 0, 1)
    const store = await open(root, () => clock)

    // Day 0: two artifacts. `shared.css` is the same content in both, so it is
    // one blob, and that is what makes "keep the latest version" a real test.
    const a1 = store.publish({
      title: "A",
      files: [
        { path: "index.html", bytes: bytes("A-one") },
        { path: "shared.css", bytes: bytes("body{}") },
      ],
      baseVersion: "absent",
      idempotencyKey: "z1",
    })
    const aid = (a1 as { artifactId: string }).artifactId
    store.publish({
      title: "B",
      files: [
        { path: "index.html", bytes: bytes("B-only") },
        { path: "shared.css", bytes: bytes("body{}") },
      ],
      baseVersion: "absent",
      idempotencyKey: "z2",
    })

    // Unique contents: "A-one"(5) + "body{}"(6) + "B-only"(6) = 3 blobs, 17 bytes.
    expect(blobNames(root)).toHaveLength(3)
    expect(store.sizeReport()).toEqual({ artifacts: 2, versions: 2, blobBytes: 17 })

    // Day 40: A gets a new version; B is untouched and stays outside the window.
    clock += 40 * DAY
    store.publish({
      artifactId: aid,
      title: "A",
      files: [
        { path: "index.html", bytes: bytes("A-two") },
        { path: "shared.css", bytes: bytes("body{}") },
      ],
      baseVersion: 1,
      idempotencyKey: "z3",
    })
    const stale = store.get(aid, 1)!.entries.find((entry) => entry.path === "index.html")!.sha256

    const pruned = store.pruneByWindow(30)
    expect(pruned).toEqual({ removedBlobs: 1, removedBytes: 5 })

    // Gone: the body of A v1's page — old, and no latest version needs it.
    expect(store.readBlob(stale)).toBeUndefined()
    // Kept: rows, not just blobs. The history still lists v1 and its paths.
    expect(store.get(aid, 1)!.entries.map((entry) => entry.path)).toEqual(["index.html", "shared.css"])
    // Kept: every artifact's latest version reads end to end, including B's,
    // whose only version is 40 days outside the window.
    for (const item of store.list()) {
      for (const entry of store.get(item.id, item.latestVersion)!.entries) {
        expect(store.readBlob(entry.sha256)).toBeDefined()
      }
    }
    // 4 blobs (22 bytes) before the prune, 3 after: "body{}" + "B-only" + "A-two".
    expect(store.sizeReport()).toEqual({ artifacts: 2, versions: 3, blobBytes: 17 })
  })

  test("takes a file from disk, keeps binary bytes exact, and lists by project", async () => {
    const root = tmp()
    const source = tmp()
    // A real PNG header: bytes an agent hands over as a file path, not a string.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f])
    fs.writeFileSync(path.join(source, "logo.png"), png)
    fs.writeFileSync(path.join(source, "data.bin"), Buffer.from([0, 1, 2, 3]))

    const mine = await open(root)
    const a = mine.publish({
      title: "With assets",
      files: [
        { path: "index.html", bytes: bytes("<img src=logo.png>") },
        { path: "logo.png", sourcePath: path.join(source, "logo.png") },
        { path: "data.bin", sourcePath: path.join(source, "data.bin"), mediaType: "application/x-custom" },
      ],
      baseVersion: "absent",
      idempotencyKey: "src-1",
      projectPath: "C:/repo-one",
    })
    const detail = mine.get((a as { artifactId: string }).artifactId)!
    const logo = detail.entries.find((entry) => entry.path === "logo.png")!
    expect(logo.mediaType).toBe("image/png")
    expect(logo.size).toBe(png.byteLength)
    // Byte-for-byte, not "a string that looks the same": a Latin-1 round trip
    // through a text decoder would corrupt 0x89 and 0xff and still read fine.
    expect(Array.from(mine.readBlob(logo.sha256)!)).toEqual(Array.from(png))
    // An explicit mediaType beats the extension table.
    expect(detail.entries.find((entry) => entry.path === "data.bin")!.mediaType).toBe("application/x-custom")

    mine.publish({
      title: "Other repo",
      files: [{ path: "index.html", bytes: bytes("elsewhere") }],
      baseVersion: "absent",
      idempotencyKey: "src-2",
      projectPath: "C:/repo-two",
    })
    expect(mine.list({ projectPath: "C:/repo-one" }).map((item) => item.title)).toEqual(["With assets"])
    expect(mine.list({ all: true, projectPath: "C:/repo-one" })).toHaveLength(2)
    expect(mine.list()).toHaveLength(2)
  })

  // t-v47qh6. The owner's store holds `C:\Users\dev\Desktop\Workspace` (the engine's
  // realpath spelling) while VS Code's fsPath says `c:\Users\...`, and the session
  // table says `C:/Users/...`. On Windows those are one folder, so they are one project.
  test.skipIf(process.platform !== "win32")("on Windows a project matches whatever drive case, letter case and separators the query uses", async () => {
    const store = await open(tmp())
    store.publish({
      title: "Workspace summary",
      files: [{ path: "index.html", bytes: bytes("<h1>workspace</h1>") }],
      baseVersion: "absent",
      idempotencyKey: "case-1",
      projectPath: "C:\\Users\\dev\\Desktop\\Workspace",
    })
    for (const query of ["c:\\Users\\dev\\Desktop\\Workspace", "C:/Users/dev/Desktop/Workspace", "c:\\users\\dev\\desktop\\workspace\\"]) {
      expect(store.list({ projectPath: query }).map((item) => item.title)).toEqual(["Workspace summary"])
    }
    // Still one project, not a prefix match: a sibling folder is a different project.
    expect(store.list({ projectPath: "c:\\Users\\dev\\Desktop\\Workspace2" })).toHaveLength(0)
    // The stored spelling is the user's data and is not rewritten.
    expect(store.list()[0]!.projectPath).toBe("C:\\Users\\dev\\Desktop\\Workspace")
  })

  test("rename changes the title and bumps updated, without a new version", async () => {
    const root = tmp()
    const store = await open(root)
    const v1 = store.publish({
      title: "Draft",
      files: [{ path: "index.html", bytes: bytes("<p>hi</p>") }],
      baseVersion: "absent",
      idempotencyKey: "rn1",
    })
    const id = (v1 as { artifactId: string }).artifactId
    const before = store.artifact(id)!

    const renamed = store.rename(id, "Final report")
    expect(renamed.title).toBe("Final report")
    expect(renamed.updated).toBeGreaterThanOrEqual(before.updated)
    expect(store.artifact(id)!.title).toBe("Final report")
    // No content changed: still one version, same digest.
    expect(store.latestNumber(id)).toBe(1)
    expect(store.version(id, 1)!.digest).toBe((v1 as { digest: string }).digest)

    expect(() => store.rename("art_nope", "x")).toThrow(ArtifactNotFoundError)
  })

  test("delete removes every row and every blob only this artifact used", async () => {
    const root = tmp()
    const store = await open(root)
    const a1 = store.publish({
      title: "A",
      files: [
        { path: "index.html", bytes: bytes("A-only") },
        { path: "shared.css", bytes: bytes("body{}") },
      ],
      baseVersion: "absent",
      idempotencyKey: "del-a1",
    })
    const aid = (a1 as { artifactId: string }).artifactId
    store.publish({
      artifactId: aid,
      title: "A",
      files: [
        { path: "index.html", bytes: bytes("A-two") },
        { path: "shared.css", bytes: bytes("body{}") },
      ],
      baseVersion: 1,
      idempotencyKey: "del-a2",
    })
    const b1 = store.publish({
      title: "B",
      files: [{ path: "shared.css", bytes: bytes("body{}") }],
      baseVersion: "absent",
      idempotencyKey: "del-b1",
    })
    const bid = (b1 as { artifactId: string }).artifactId

    // 3 unique blobs: A-only, A-two, shared.css (shared between A and B).
    expect(blobNames(root)).toHaveLength(3)

    const report = store.delete(aid)
    expect(report.removedVersions).toBe(2)
    // A-only and A-two go; shared.css survives because B still names it.
    expect(report.removedBlobs).toBe(2)

    expect(store.artifact(aid)).toBeUndefined()
    expect(store.list().map((item) => item.id)).toEqual([bid])
    expect(blobNames(root)).toHaveLength(1)
    expect(store.get(bid)!.entries[0]!.path).toBe("shared.css")
    expect(store.readBlob(store.get(bid)!.entries[0]!.sha256)).toBeDefined()

    expect(() => store.delete("art_nope")).toThrow(ArtifactNotFoundError)
  })
})
