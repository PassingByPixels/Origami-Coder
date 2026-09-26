// origami_change (t-hca1vv): the provider-catalog cache is the thing a new chat now
// TRUSTS instead of rebuilding, so these tests are about the two ways trusting it
// could hurt: serving a stale catalog after the user changed something, and leaving a
// credential on disk.
//
// Real paths are safe here because `test/preload.ts` points XDG_DATA_HOME at a temp
// directory before `Global` loads (docs Part 9).
import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Global } from "@origami/core/global"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { ProviderCatalogCache } from "../../src/provider/catalog-cache"
import type { Provider } from "../../src/provider/provider"

const SECRET = "sk-THIS-IS-A-SECRET-0123456789"

function catalog(): Provider.ConfigProvidersResult {
  return {
    providers: [
      {
        id: ProviderV2.ID.make("acme"),
        name: "Acme",
        source: "config",
        env: ["ACME_API_KEY"],
        key: SECRET,
        options: { baseURL: "https://acme.test", apiKey: SECRET },
        models: {
          big: {
            id: ModelV2.ID.make("big"),
            providerID: ProviderV2.ID.make("acme"),
            name: "Big",
            api: { id: "big", url: "", npm: "@ai-sdk/openai" },
            status: "active",
            headers: { Authorization: `Bearer ${SECRET}` },
            options: { apiKey: SECRET },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 1000, output: 100 },
            capabilities: {} as never,
            release_date: "",
          } as unknown as Provider.Model,
        },
      } as unknown as Provider.Info,
    ],
    default: { acme: "big" },
  }
}

const authFile = path.join(Global.Path.data, "auth.json")

function withAuth<T>(contents: string | undefined, body: () => T): T {
  const previous = fs.existsSync(authFile) ? fs.readFileSync(authFile) : undefined
  try {
    if (contents === undefined) fs.rmSync(authFile, { force: true })
    else fs.writeFileSync(authFile, contents)
    return body()
  } finally {
    if (previous === undefined) fs.rmSync(authFile, { force: true })
    else fs.writeFileSync(authFile, previous)
  }
}

describe("provider catalog cache", () => {
  test("a written catalog is read back", () => {
    const key = ProviderCatalogCache.key({ directory: "/round/trip", config: { model: "acme/big" } })
    ProviderCatalogCache.write(key, catalog())
    const read = ProviderCatalogCache.read(key)
    expect(read?.providers.map((provider) => provider.id)).toEqual([ProviderV2.ID.make("acme")])
    expect(Object.keys(read!.providers[0]!.models)).toEqual(["big"])
    expect(read?.default).toEqual({ acme: "big" })
  })

  // The defect this guards: the catalog carries live API keys, and writing it
  // verbatim would leave every credential in a world-readable file under the data
  // dir. Greps the BYTES actually written, not the object we passed in.
  test("no credential reaches the file on disk", () => {
    const key = ProviderCatalogCache.key({ directory: "/secrets", config: {} })
    ProviderCatalogCache.write(key, catalog())
    const raw = fs.readFileSync(ProviderCatalogCache.file(key), "utf8")
    expect(raw).not.toContain(SECRET)
    expect(raw).toContain("acme")
    const read = ProviderCatalogCache.read(key)!
    expect((read.providers[0] as { key?: string }).key).toBeUndefined()
    expect(read.providers[0]!.options).toEqual({ baseURL: "https://acme.test" })
    expect(read.providers[0]!.models["big"]!.headers).toEqual({})
  })

  test("withoutSecrets keeps the fields the model picker reads", () => {
    const stripped = ProviderCatalogCache.withoutSecrets(catalog())
    expect(stripped.providers[0]!.name).toBe("Acme")
    expect(stripped.providers[0]!.models["big"]!.limit.context).toBe(1000)
  })

  test("a truncated or foreign file is a MISS, not a throw", () => {
    const key = ProviderCatalogCache.key({ directory: "/corrupt", config: {} })
    ProviderCatalogCache.write(key, catalog())
    const file = ProviderCatalogCache.file(key)
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(0, 40))
    expect(ProviderCatalogCache.read(key)).toBeUndefined()
    fs.writeFileSync(file, JSON.stringify({ format: 999, catalog: catalog() }))
    expect(ProviderCatalogCache.read(key)).toBeUndefined()
    fs.writeFileSync(file, JSON.stringify({ format: 1, catalog: { providers: "not-an-array" } }))
    expect(ProviderCatalogCache.read(key)).toBeUndefined()
  })

  test("a missing file is a miss", () => {
    expect(ProviderCatalogCache.read("0".repeat(64))).toBeUndefined()
  })

  // THE acceptance item: "a config change is picked up on the next chat". The next
  // chat is a new process, so the only thing that can carry the change is the key.
  test("a config change changes the key", () => {
    const before = ProviderCatalogCache.key({ directory: "/d", config: { provider: { a: {} } } })
    const after = ProviderCatalogCache.key({ directory: "/d", config: { provider: { a: {}, b: {} } } })
    expect(after).not.toBe(before)
  })

  test("a different directory changes the key", () => {
    expect(ProviderCatalogCache.key({ directory: "/one", config: {} })).not.toBe(
      ProviderCatalogCache.key({ directory: "/two", config: {} }),
    )
  })

  // Pasting a credential rewrites auth.json. Without this the next chat would serve
  // the catalog from before the provider was connected.
  test("an auth store change changes the key", () => {
    const absent = withAuth(undefined, () => ProviderCatalogCache.key({ directory: "/d", config: {} }))
    const present = withAuth('{"acme":{"type":"api","key":"one"}}', () =>
      ProviderCatalogCache.key({ directory: "/d", config: {} }),
    )
    const longer = withAuth('{"acme":{"type":"api","key":"one"},"other":{"type":"api","key":"two"}}', () =>
      ProviderCatalogCache.key({ directory: "/d", config: {} }),
    )
    expect(present).not.toBe(absent)
    expect(longer).not.toBe(present)
  })

  test("a provider credential in the environment changes the key", () => {
    const name = "CATALOG_CACHE_TEST_API_KEY"
    delete process.env[name]
    const without = ProviderCatalogCache.key({ directory: "/d", config: {} })
    process.env[name] = "one"
    const one = ProviderCatalogCache.key({ directory: "/d", config: {} })
    process.env[name] = "two"
    const two = ProviderCatalogCache.key({ directory: "/d", config: {} })
    delete process.env[name]
    expect(one).not.toBe(without)
    expect(two).not.toBe(one)
  })

  // t-y579wi: the provider build reads two runtime flags (provider.ts). An engine started
  // with the Claude (Sub) setting off lists `offInfo` rows (or none); one started with it on
  // lists the CLI's live catalog. With the same key, a chat started after the setting moved
  // was shown the other engine's rows for up to an hour (store copy: a flag-off engine
  // showed the live catalog while it refused every request as "off for this chat").
  test("the runtime flags the provider build reads change the key", () => {
    for (const name of ["ORIGAMI_EXPERIMENTAL_CLAUDE_SUBSCRIPTION", "ORIGAMI_ENABLE_EXPERIMENTAL_MODELS"]) {
      const saved = process.env[name]
      delete process.env[name]
      const off = ProviderCatalogCache.key({ directory: "/d", config: {} })
      process.env[name] = "true"
      const on = ProviderCatalogCache.key({ directory: "/d", config: {} })
      if (saved === undefined) delete process.env[name]
      else process.env[name] = saved
      expect(on, name).not.toBe(off)
    }
  })

  // t-y579wi: the list above must follow provider.ts. A new flag read there without its
  // env name in the key would serve rows built under the other value.
  test("every runtime flag provider.ts reads is one the key covers", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/provider/provider.ts"), "utf8")
    const read = [...new Set([...source.matchAll(/runtimeFlags\.(\w+)/g)].map((match) => match[1]))].toSorted()
    expect(read).toEqual(Object.keys(ProviderCatalogCache.PROVIDER_FLAGS).toSorted())
  })

  // t-ttmo5w: the key cannot see a provider's REMOTE model list, so age is the bound.
  // An entry older than MAX_AGE_MS is a miss: the next chat builds fresh (and runs
  // live discovery) instead of serving a list from whenever the file was last written.
  test("an entry older than MAX_AGE_MS is a miss; a younger one is a hit", () => {
    const key = ProviderCatalogCache.key({ directory: "/aged", config: {} })
    ProviderCatalogCache.write(key, catalog())
    const file = ProviderCatalogCache.file(key)
    const young = new Date(Date.now() - ProviderCatalogCache.MAX_AGE_MS + 60_000)
    fs.utimesSync(file, young, young)
    expect(ProviderCatalogCache.read(key)).toBeDefined()
    const old = new Date(Date.now() - ProviderCatalogCache.MAX_AGE_MS - 60_000)
    fs.utimesSync(file, old, old)
    expect(ProviderCatalogCache.read(key)).toBeUndefined()
  })

  // t-ttmo5w: the Connections Refresh button ("hard" provider_refresh). Every cached
  // catalog goes, and nothing else in the cache directory does.
  test("clear() removes every cached catalog and leaves other cache files alone", () => {
    const one = ProviderCatalogCache.key({ directory: "/clear/one", config: {} })
    const two = ProviderCatalogCache.key({ directory: "/clear/two", config: {} })
    ProviderCatalogCache.write(one, catalog())
    ProviderCatalogCache.write(two, catalog())
    const neighbour = path.join(ProviderCatalogCache.directory(), "agent-snapshot-clear-test.json")
    fs.writeFileSync(neighbour, "{}")
    ProviderCatalogCache.clear()
    expect(ProviderCatalogCache.read(one)).toBeUndefined()
    expect(ProviderCatalogCache.read(two)).toBeUndefined()
    expect(fs.existsSync(neighbour)).toBe(true)
    fs.rmSync(neighbour, { force: true })
  })

  test("clear() with no cache directory does not throw", () => {
    fs.rmSync(ProviderCatalogCache.directory(), { recursive: true, force: true })
    expect(() => ProviderCatalogCache.clear()).not.toThrow()
  })

  // The regression that made the cache never hit once: ORIGAMI_PID matches the
  // credential-name pattern and is rewritten by the engine in every process, so the
  // key was unique per run and every chat was a miss.
  test("the engine's own per-process env does NOT change the key", () => {
    const first = ProviderCatalogCache.key({ directory: "/d", config: { model: "acme/big" } })
    process.env["ORIGAMI_PID"] = "99999"
    process.env["ORIGAMI_CONSOLE_TOKEN"] = "rotated"
    const second = ProviderCatalogCache.key({ directory: "/d", config: { model: "acme/big" } })
    expect(second).toBe(first)
  })
})
