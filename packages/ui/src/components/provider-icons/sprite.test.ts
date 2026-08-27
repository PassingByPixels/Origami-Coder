// ProviderIcon resolves an icon by PROVIDER ID: `iconNames.includes(id) ? id :
// "synthetic"`, then renders `<use href="sprite.svg#<id>">`. So an icon only
// reaches the screen when the provider id is in `iconNames` AND a `<symbol>`
// with that exact id is in the sprite. A mismatch is silent — the user just
// gets the generic fallback glyph — which is why this is asserted, not eyeballed.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { iconNames, type IconName } from "./types"

const sprite = readFileSync(path.join(import.meta.dir, "sprite.svg"), "utf8")
const symbolIDs = new Set([...sprite.matchAll(/<symbol[^>]*\sid="([^"]+)"/g)].map((m) => m[1]!))

describe("provider icon sprite", () => {
  test("the sprite is not empty", () => {
    expect(symbolIDs.size).toBeGreaterThan(50)
  })

  // The ids the shipped models.dev catalog serves for the OpenCode Zen gateway.
  // Named explicitly because these two are the ones a rename broke.
  test.each(["opencode", "opencode-go"])("provider id %s resolves to its own icon", (id) => {
    expect(iconNames).toContain(id)
    expect(symbolIDs).toContain(id)
  })

  // PRE-EXISTING DEFECT, not a waiver: `llmgateway` is listed as an icon name
  // but no `<symbol id="llmgateway">` is in the sprite, so that provider renders
  // the generic fallback. Fixing it needs the missing artwork. Listing it here
  // keeps the check strict for every OTHER name — a new mismatch still fails.
  const KNOWN_MISSING_SYMBOLS: IconName[] = ["llmgateway"]

  test("every listed icon name has a matching symbol in the sprite", () => {
    const missing = iconNames.filter((name) => !symbolIDs.has(name))
    expect(missing).toEqual(KNOWN_MISSING_SYMBOLS)
  })

  test("the fallback icon that ProviderIcon falls back to exists", () => {
    expect(symbolIDs).toContain("synthetic")
  })
})
