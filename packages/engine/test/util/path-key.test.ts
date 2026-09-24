// t-v47qh6. The one "same folder?" rule, on both platforms, with the three
// spellings of one Windows folder that the engine, VS Code and the session
// table really produce (the owner's store and origami.db, read 2026-09-24).
import { describe, expect, test } from "bun:test"
import { pathKey, samePath } from "@/util/path-key"

describe("samePath", () => {
  test("win32: the realpath, fsPath and session-table spellings are one folder", () => {
    const engine = "C:\\Users\\dev\\Desktop\\Workspace"
    expect(samePath(engine, "c:\\Users\\dev\\Desktop\\Workspace", "win32")).toBe(true)
    expect(samePath(engine, "C:/Users/dev/Desktop/Workspace", "win32")).toBe(true)
    expect(samePath(engine, "c:\\users\\dev\\desktop\\workspace\\", "win32")).toBe(true)
  })

  test("win32: a sibling or a parent is a different folder", () => {
    expect(samePath("C:\\Repos\\a", "C:\\Repos\\ab", "win32")).toBe(false)
    expect(samePath("C:\\Repos\\a", "C:\\Repos", "win32")).toBe(false)
  })

  test("win32: a drive root is one key whatever the spelling", () => {
    expect(pathKey("C:/", "win32")).toBe(pathKey("c:\\", "win32"))
    expect(samePath("C:\\", "c:/", "win32")).toBe(true)
  })

  test("posix: case still matters, as the file system says; a trailing separator does not", () => {
    expect(samePath("/Users/dev/Workspace", "/users/dev/workspace", "darwin")).toBe(false)
    expect(samePath("/home/a/Repo/", "/home/a/Repo", "linux")).toBe(true)
  })
})
