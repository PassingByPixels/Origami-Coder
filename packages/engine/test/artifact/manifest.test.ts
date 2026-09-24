// The digest is the thing two machines compare instead of talking. If it
// depended on the order a caller happened to list files in, two stores holding
// identical bytes would disagree and the sync would copy a version that is
// already there — forever. So the property under test is not "digest returns a
// hash", it is "the same FILES give the same digest and different files never
// do", which is what a caller is entitled to rely on.
import { describe, expect, test } from "bun:test"
import { Manifest } from "@/artifact/manifest"
import { ArtifactPathError, mediaTypeFor } from "@/artifact/types"

const bytes = (text: string) => new TextEncoder().encode(text)

describe("Manifest", () => {
  test("the digest ignores the order files were listed in", () => {
    const forward = Manifest.build([
      { path: "index.html", bytes: bytes("page") },
      { path: "assets/app.css", bytes: bytes("body{}") },
      { path: "z.js", bytes: bytes("0") },
    ])
    const backward = Manifest.build([
      { path: "z.js", bytes: bytes("0") },
      { path: "assets/app.css", bytes: bytes("body{}") },
      { path: "index.html", bytes: bytes("page") },
    ])
    expect(Manifest.digest(forward)).toBe(Manifest.digest(backward))
    expect(forward.map((entry) => entry.path)).toEqual(["assets/app.css", "index.html", "z.js"])
  })

  test("one changed byte changes the digest", () => {
    const before = Manifest.build([{ path: "a.txt", bytes: bytes("hello") }])
    const after = Manifest.build([{ path: "a.txt", bytes: bytes("hellp") }])
    expect(Manifest.digest(after)).not.toBe(Manifest.digest(before))
  })

  test("a path moved between directories changes the digest even though the bytes did not", () => {
    const here = Manifest.build([{ path: "a.txt", bytes: bytes("same") }])
    const there = Manifest.build([{ path: "sub/a.txt", bytes: bytes("same") }])
    expect(Manifest.digest(there)).not.toBe(Manifest.digest(here))
  })

  test("a duplicate path is a rejected manifest, not a last-one-wins merge", () => {
    expect(() =>
      Manifest.build([
        { path: "a.txt", bytes: bytes("one") },
        { path: "a.txt", bytes: bytes("two") },
      ]),
    ).toThrow(ArtifactPathError)
  })

  test("ordinary nested paths are accepted", () => {
    for (const good of ["index.html", "assets/app.css", "a/b/c/d.png", "read.me", "no-extension"]) {
      expect(() => Manifest.validatePath(good)).not.toThrow()
    }
  })

  test("media types come from the short table, and anything else is a download", () => {
    expect(mediaTypeFor("a/b.HTML")).toBe("text/html")
    expect(mediaTypeFor("x.svg")).toBe("image/svg+xml")
    expect(mediaTypeFor("archive.tar.gz")).toBe("application/octet-stream")
    expect(mediaTypeFor("noext")).toBe("application/octet-stream")
  })

  test("compare is manifest-level: added, removed, changed, and nothing for equal bytes", () => {
    const from = Manifest.build([
      { path: "keep.js", bytes: bytes("k") },
      { path: "edit.html", bytes: bytes("one") },
      { path: "drop.css", bytes: bytes("d") },
    ])
    const to = Manifest.build([
      { path: "keep.js", bytes: bytes("k") },
      { path: "edit.html", bytes: bytes("two") },
      { path: "add.png", bytes: bytes("p") },
    ])
    expect(Manifest.compare(from, to)).toEqual({
      added: ["add.png"],
      removed: ["drop.css"],
      changed: ["edit.html"],
    })
    expect(Manifest.compare(from, from)).toEqual({ added: [], removed: [], changed: [] })
  })
})
