import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Drift guard (t-tc1tnk). `Effect.cached`, `Effect.cachedWithTTL`,
 * `Effect.cachedInvalidateWithTTL`, `Cache.make` and `ScopedCache.make` keep
 * whatever exit the first caller produced, INTERRUPTS and defects included.
 * Three field defects came from that: the 0.4.153 catalog memo, the ACP
 * directory refresh under its 20 s timeout, and `InstanceState`.
 *
 * A process-wide memo uses `cachedInvalidateForever` from
 * `@origami/core/effect/cached`. A raw primitive is allowed only where it is
 * listed below with the reason it cannot keep an interrupt. A new raw call, or
 * a new one in a listed file, fails this test: use the helper, or add the site
 * here with its reason.
 */

const PACKAGES = path.resolve(import.meta.dir, "../../..")

const RAW = /\b(?:Effect\.cached(?:WithTTL|InvalidateWithTTL|Function)?|ScopedCache\.make(?:With)?|Cache\.make(?:With)?)\s*[(<]/g

const ALLOWED: Record<string, { count: number; reason: string }> = {
  "engine/src/effect/instance-state.ts": {
    count: 1,
    reason: "ScopedCache.makeWith with a timeToLive that expires an isTransientExit exit at once (asserted below)",
  },
  "engine/src/server/server.ts": {
    count: 3,
    reason:
      "run-once listener teardown; reached only from an unsignalled runPromiseExit root fiber and an uninterruptible scope finalizer, so no caller can interrupt it",
  },
  "engine/src/project/instance-store.ts": {
    count: 1,
    reason: "cachedWithTTL at Duration.zero: shares the in-flight disposeAll only; nothing is kept after it ends",
  },
  "engine/src/account/account.ts": {
    count: 1,
    reason: "Cache with timeToLive Duration.zero: shares an in-flight token refresh only; nothing is kept after it ends",
  },
  "core/src/pty/ticket.ts": {
    count: 1,
    reason: "Cache used only through set/invalidateWhen; its lookup is never run",
  },
  "http-recorder/src/recorder.ts": {
    count: 1,
    reason: "test tooling: one cassette read per replay scope, not engine runtime",
  },
}

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

const scan = () => {
  const found: Record<string, number> = {}
  for (const file of new Glob("*/src/**/*.{ts,tsx}").scanSync({ cwd: PACKAGES })) {
    const rel = file.replaceAll("\\", "/")
    if (rel.includes("/node_modules/")) continue
    const hits = stripComments(readFileSync(path.join(PACKAGES, rel), "utf8")).match(RAW)
    if (hits) found[rel] = hits.length
  }
  return found
}

describe("Effect cache sites", () => {
  test("no raw caching primitive outside the allow-list", () => {
    const found = scan()
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([file, entry]) => [file, entry.count]))
    expect(found).toEqual(expected)
  })

  test("InstanceState's ScopedCache still expires interrupted and defective lookups", () => {
    const source = readFileSync(path.join(PACKAGES, "engine/src/effect/instance-state.ts"), "utf8")
    // `key` since t-tijhw6: the typed-failure backoff is counted per directory.
    expect(source).toMatch(/timeToLive:\s*\(exit(?:,\s*key)?\)\s*=>\s*\(isTransientExit\(exit\)\s*\?\s*Duration\.zero/)
  })
})
