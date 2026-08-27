import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import { migrateZenProviderId } from "../../src/origami/zen-provider-migrate"

// Every case works on a scratch directory passed in EXPLICITLY. Nothing here
// resolves `Global.Path.config`, so no run of this suite can reach a real
// user's config no matter how the environment is set up.

let dir: string

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zen-provider-migrate-"))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const file = (name: string) => path.join(dir, name)

function write(name: string, text: string) {
  fs.writeFileSync(file(name), text)
  return file(name)
}

/** Pin mtime a minute into the past, so ANY rewrite moves it. */
function pin(target: string) {
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(target, past, past)
  return fs.statSync(target).mtimeMs
}

const withComments = `{
  // the gateway key, pasted from the Zen dashboard
  "provider": {
    "opencode-zen": {
      /* two billing tiers share this baseURL by design */
      "options": { "apiKey": "sk-zen-123" },
      "models": { "kimi-k2.7-code": {} } // the one we actually use
    }
  }
}
`

describe("migrateZenProviderId", () => {
  test("renames the legacy key and keeps every other byte, comments included", () => {
    const target = write("origami.json", withComments)

    const message = migrateZenProviderId(dir)

    expect(message).toContain('renamed provider "opencode-zen" to "opencode"')
    const after = fs.readFileSync(target, "utf8")
    // The ONLY difference is the key token itself.
    expect(after).toBe(withComments.replace('"opencode-zen"', '"opencode"'))
    // Stated separately, because the line above would also pass if both sides
    // were mangled the same way: the comments must still be there.
    expect(after).toContain("// the gateway key, pasted from the Zen dashboard")
    expect(after).toContain("/* two billing tiers share this baseURL by design */")
    expect(after).toContain("// the one we actually use")
    expect(after).not.toContain("opencode-zen")
    // and the original is recoverable
    expect(fs.readFileSync(target + ".zen-provider.bak", "utf8")).toBe(withComments)
  })

  test("preserves CRLF line endings", () => {
    const crlf = withComments.replace(/\n/g, "\r\n")
    const target = write("origami.json", crlf)

    migrateZenProviderId(dir)

    const after = fs.readFileSync(target, "utf8")
    expect(after).toBe(crlf.replace('"opencode-zen"', '"opencode"'))
    expect(after.split("\r\n").length).toBe(crlf.split("\r\n").length)
    expect(after).not.toContain("\n\n")
  })

  test("is a no-op on the second run", () => {
    const target = write("origami.json", withComments)
    migrateZenProviderId(dir)
    const migrated = fs.readFileSync(target, "utf8")
    const backup = fs.readFileSync(target + ".zen-provider.bak", "utf8")
    const pinned = pin(target)

    expect(migrateZenProviderId(dir)).toBeUndefined()

    expect(fs.statSync(target).mtimeMs).toBe(pinned)
    expect(fs.readFileSync(target, "utf8")).toBe(migrated)
    // the first run's backup is the one that matters; don't clobber it
    expect(fs.readFileSync(target + ".zen-provider.bak", "utf8")).toBe(backup)
  })

  test("writes NOTHING when both ids are present in the same file", () => {
    const both = `{
  "provider": {
    "opencode-zen": { "options": { "apiKey": "sk-old" } },
    "opencode": { "options": { "apiKey": "sk-new" } }
  }
}
`
    const target = write("origami.json", both)
    const pinned = pin(target)

    expect(migrateZenProviderId(dir)).toBeUndefined()

    expect(fs.statSync(target).mtimeMs).toBe(pinned)
    expect(fs.readFileSync(target, "utf8")).toBe(both)
    expect(fs.existsSync(target + ".zen-provider.bak")).toBe(false)
  })

  test("writes NOTHING when a sibling candidate file already defines opencode", () => {
    const legacy = write("origami.json", withComments)
    write("config.json", '{ "provider": { "opencode": { "options": { "apiKey": "sk-new" } } } }')
    const pinned = pin(legacy)

    expect(migrateZenProviderId(dir)).toBeUndefined()

    expect(fs.statSync(legacy).mtimeMs).toBe(pinned)
    expect(fs.readFileSync(legacy, "utf8")).toBe(withComments)
    expect(fs.existsSync(legacy + ".zen-provider.bak")).toBe(false)
  })

  test("writes NOTHING when there is no Zen block at all", () => {
    const other = `{
  "provider": { "openrouter": { "options": { "apiKey": "sk-or" } } }
}
`
    const target = write("origami.json", other)
    const pinned = pin(target)

    expect(migrateZenProviderId(dir)).toBeUndefined()

    expect(fs.statSync(target).mtimeMs).toBe(pinned)
    expect(fs.readFileSync(target, "utf8")).toBe(other)
    expect(fs.existsSync(target + ".zen-provider.bak")).toBe(false)
  })

  test("writes NOTHING to a malformed config, even one holding the legacy id", () => {
    const broken = '{ "provider": { "opencode-zen": { "options": { "apiKey": "sk" } }, }' // truncated
    const target = write("origami.json", broken)
    const pinned = pin(target)

    expect(migrateZenProviderId(dir)).toBeUndefined()

    expect(fs.statSync(target).mtimeMs).toBe(pinned)
    expect(fs.readFileSync(target, "utf8")).toBe(broken)
  })

  test("migrates origami.jsonc too, not just origami.json", () => {
    const target = write("origami.jsonc", withComments)

    expect(migrateZenProviderId(dir)).toContain("origami.jsonc")

    expect(fs.readFileSync(target, "utf8")).toContain('"opencode":')
  })

  test("does nothing, and does not throw, on a directory with no config at all", () => {
    expect(migrateZenProviderId(dir)).toBeUndefined()
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
