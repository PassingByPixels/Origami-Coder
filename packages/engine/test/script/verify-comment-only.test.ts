// verify-comment-only.test.ts — exercises the gate against real, throwaway
// git repos (created fresh per test in the OS temp dir) so the assertions
// are against actual `git diff` output, not a mocked shape of it.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { spawnSync } from "child_process"

const SCRIPT = path.resolve(import.meta.dir, "../../../../scripts/verify-comment-only.ts")
const createdDirs: string[] = []

function git(dir: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`)
  return res.stdout
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-comment-only-"))
  createdDirs.push(dir)
  git(dir, ["init", "-q", "-b", "master"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Test"])
  git(dir, ["config", "core.autocrlf", "false"])
  return dir
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", message])
}

function runVerify(dir: string, extraArgs: string[] = []): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("bun", [SCRIPT, "--dir", dir, ...extraArgs], { encoding: "utf8" })
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr }
}

afterAll(() => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup only
    }
  }
})

describe("verify-comment-only", () => {
  test("(1) a comment-only rewrite in a .ts and a .svelte file passes with a table", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "a.ts"), '// old comment\nexport function add(a: number, b: number) {\n  return a + b // sum\n}\n')
    writeFileSync(
      path.join(dir, "b.svelte"),
      '<script lang="ts">\n  // old\n  let x = 1\n</script>\n<!-- old markup comment -->\n<div>{x}</div>\n',
    )
    commitAll(dir, "base")
    writeFileSync(
      path.join(dir, "a.ts"),
      '/* new comment block\n   spanning two lines */\nexport function add(a: number, b: number) {\n  return a + b /* changed trailing comment */\n}\n',
    )
    writeFileSync(
      path.join(dir, "b.svelte"),
      '<script lang="ts">\n  /* rewritten entirely */\n  let x = 1\n</script>\n<!-- brand new markup comment -->\n<div>{x}</div>\n',
    )

    const { status, stdout, stderr } = runVerify(dir)

    expect(stderr).toBe("")
    expect(status).toBe(0)
    expect(stdout).toContain("a.ts")
    expect(stdout).toContain("b.svelte")
    expect(stdout).toContain("code: equal")
    expect(stdout).toContain("total: 2 files, code: equal")
  })

  test("(2) changing one identifier fails, naming the file and the line", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "a.ts"), "export function add(a: number, b: number) {\n  return a + b\n}\n")
    commitAll(dir, "base")
    writeFileSync(path.join(dir, "a.ts"), "export function add(a: number, b: number) {\n  return a + c\n}\n")

    const { status, stdout, stderr } = runVerify(dir)
    const out = stdout + stderr

    expect(status).toBe(1)
    expect(out).toContain("a.ts")
    expect(out).toMatch(/base 2:\d+ "b"/)
    expect(out).toMatch(/head 2:\d+ "c"/)
  })

  test("(3) changing one string literal fails", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "a.ts"), 'export const label = "hello"\n')
    commitAll(dir, "base")
    writeFileSync(path.join(dir, "a.ts"), 'export const label = "hallo"\n')

    const { status, stdout, stderr } = runVerify(dir)
    const out = stdout + stderr

    expect(status).toBe(1)
    expect(out).toContain("a.ts")
    expect(out).toContain(JSON.stringify('"hello"'))
    expect(out).toContain(JSON.stringify('"hallo"'))
  })

  test("(4) changing one Svelte attribute fails", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "b.svelte"), '<script lang="ts">\n  let x = 1\n</script>\n<div class="a">{x}</div>\n')
    commitAll(dir, "base")
    writeFileSync(path.join(dir, "b.svelte"), '<script lang="ts">\n  let x = 1\n</script>\n<div class="b">{x}</div>\n')

    const { status, stdout, stderr } = runVerify(dir)
    const out = stdout + stderr

    expect(status).toBe(1)
    expect(out).toContain("b.svelte")
    expect(out).toContain("markup")
  })

  test("(5) an added file fails", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")
    commitAll(dir, "base")
    writeFileSync(path.join(dir, "new.ts"), "export const b = 2\n")
    git(dir, ["add", "-A"]) // stage it so the diff reports status A

    const { status, stdout, stderr } = runVerify(dir)
    const out = stdout + stderr

    expect(status).toBe(1)
    expect(out).toContain("added file")
    expect(out).toContain("new.ts")
  })

  test("(5b) an untracked file (never added) also fails", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")
    commitAll(dir, "base")
    writeFileSync(path.join(dir, "stray.ts"), "export const b = 2\n")

    const { status, stdout, stderr } = runVerify(dir)
    const out = stdout + stderr

    expect(status).toBe(1)
    expect(out).toContain("untracked file")
    expect(out).toContain("stray.ts")
  })

  test("(6) a template literal with ${} and a regex literal survive untouched, only comments change", () => {
    const dir = makeRepo()
    const src =
      'export const name = "world"\n' +
      "export const greeting = `Hello, ${name}! Total: ${1 + 2}`\n" +
      "export const pattern = /a\\/b[0-9]+/gi\n" +
      "export function check(s: string) { return pattern.test(s) }\n"
    writeFileSync(path.join(dir, "a.ts"), `// before\n${src}`)
    commitAll(dir, "base")
    writeFileSync(path.join(dir, "a.ts"), `// after, completely rewritten comment\n${src}`)

    const { status, stdout, stderr } = runVerify(dir)

    expect(stderr).toBe("")
    expect(status).toBe(0)
    expect(stdout).toContain("code: equal")
  })

  test("(7) a CRLF head vs LF base, comment edits only, passes", () => {
    const dir = makeRepo()
    // Committed (base) content is LF, matching what `git show` hands back
    // under this repo's core.autocrlf=true.
    writeFileSync(path.join(dir, "a.ts"), "// old comment\nexport function add(a: number, b: number) {\n  return a + b\n}\n")
    commitAll(dir, "base")
    // Working tree (head) is CRLF, as a real checkout would be, with only
    // the comment rewritten.
    writeFileSync(
      path.join(dir, "a.ts"),
      "// new comment, rewritten entirely\r\nexport function add(a: number, b: number) {\r\n  return a + b\r\n}\r\n",
    )

    const { status, stdout, stderr } = runVerify(dir)

    expect(stderr).toBe("")
    expect(status).toBe(0)
    expect(stdout).toContain("code: equal")
  })

  test("(8) a JSDoc-only edit passes", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "a.ts"), "/**\n * Adds two numbers.\n */\nexport function add(a: number, b: number) {\n  return a + b\n}\n")
    commitAll(dir, "base")
    writeFileSync(
      path.join(dir, "a.ts"),
      "/**\n * Adds two numbers together.\n *\n * @param a first operand\n * @param b second operand\n * @returns the sum\n */\nexport function add(a: number, b: number) {\n  return a + b\n}\n",
    )

    const { status, stdout, stderr } = runVerify(dir)

    expect(stderr).toBe("")
    expect(status).toBe(0)
    expect(stdout).toContain("code: equal")
  })

  test("(9) a JSDoc edit plus one changed identifier, in a CRLF file, still fails at the identifier's line", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "a.ts"), "/**\n * Adds two numbers.\n */\nexport function add(a: number, b: number) {\n  return a + b\n}\n")
    commitAll(dir, "base")
    writeFileSync(
      path.join(dir, "a.ts"),
      "/**\r\n * Adds two numbers together.\r\n */\r\nexport function add(a: number, b: number) {\r\n  return a + c\r\n}\r\n",
    )

    const { status, stdout, stderr } = runVerify(dir)
    const out = stdout + stderr

    expect(status).toBe(1)
    expect(out).toContain("a.ts")
    // Line 5 is `  return a + b` / `  return a + c` — NOT inside the
    // rewritten JSDoc (lines 1-3), which must be silently skipped.
    expect(out).toMatch(/base 5:\d+ "b"/)
    expect(out).toMatch(/head 5:\d+ "c"/)
  })

  test("a renamed file (even with identical content) fails", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "old-name.ts"), "export function add(a: number, b: number) {\n  return a + b\n}\n")
    commitAll(dir, "base")
    git(dir, ["mv", "old-name.ts", "new-name.ts"])

    const { status, stdout, stderr } = runVerify(dir)
    const out = stdout + stderr

    expect(status).toBe(1)
    expect(out).toContain("renamed file")
    expect(out).toContain("old-name.ts")
    expect(out).toContain("new-name.ts")
  })

  test("a deleted file fails", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")
    writeFileSync(path.join(dir, "b.ts"), "export const b = 1\n")
    commitAll(dir, "base")
    rmSync(path.join(dir, "b.ts"))

    const { status, stdout, stderr } = runVerify(dir)
    const out = stdout + stderr

    expect(status).toBe(1)
    expect(out).toContain("deleted file")
    expect(out).toContain("b.ts")
  })

  test("a modified non-source file (e.g. .json) fails", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "config.json"), '{\n  "a": 1\n}\n')
    commitAll(dir, "base")
    writeFileSync(path.join(dir, "config.json"), '{\n  "a": 2\n}\n')

    const { status, stdout, stderr } = runVerify(dir)
    const out = stdout + stderr

    expect(status).toBe(1)
    expect(out).toContain("config.json")
  })

  test("--base selects a different ref than master", () => {
    const dir = makeRepo()
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")
    commitAll(dir, "base")
    git(dir, ["checkout", "-q", "-b", "feature"])
    writeFileSync(path.join(dir, "a.ts"), "// comment only\nexport const a = 1\n")
    commitAll(dir, "feature-commit")
    writeFileSync(path.join(dir, "a.ts"), "// comment only, rewritten\nexport const a = 1\n")

    const { status, stdout } = runVerify(dir, ["--base", "master"])

    expect(status).toBe(0)
    expect(stdout).toContain("code: equal")
  })
})
