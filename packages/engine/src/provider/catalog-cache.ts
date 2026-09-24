// origami_change (t-hca1vv): the provider catalog, cached ACROSS engine processes.
//
// Every new chat is its own engine process, and every one of them rebuilt the
// provider catalog from scratch inside `session/new` - measured at ~1.2-1.7 s for a
// config with 8-9 providers, which is 97-99% of the `acp.directory.snapshot` leg the
// ACP shell waits on before it can answer with `configOptions`.
//
// Nothing about that build is per-process: it is a pure function of the engine
// version, the merged config, the auth store and the environment. So it is hashed
// into a key and the RESULT is written next to the other engine state. A second
// process with the same inputs reads the answer instead of recomputing it.
//
// Two rules this file exists to keep:
//
//  1. NO SECRETS ON DISK. The catalog carries each provider's `key` and can carry
//     `apiKey`/`Authorization` inside `options`/`headers`. `withoutSecrets` strips
//     them, and the handler applies it to the LIVE answer too, so a cache hit and a
//     cache miss return the same shape - an inconsistency here would be a bug that
//     only appears on the second run. Verified in-tree: the ACP snapshot reads only
//     `id`, `name` and `models` off these rows.
//  2. A BAD CACHE IS A MISS, NEVER A CRASH. Truncated file, wrong shape, unreadable
//     directory - every one of them falls through to the normal build.
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Global } from "@origami/core/global"
import { InstallationVersion } from "@origami/core/installation/version"
import type { Provider } from "./provider"

const FORMAT = 1

/** origami_change (t-ttmo5w): the one input the key cannot see is a provider's REMOTE
 *  model list (live discovery). A hit already re-validates the file 5 s later, but only
 *  if that process lives that long, and a file nobody re-validated could be served for
 *  days. So an entry older than this is a miss: no new chat starts from a catalog older
 *  than an hour. Not shorter, because a miss costs `session/new` the full build again
 *  (~1.2-1.7 s), and the first chat after a break is the common case. */
export const MAX_AGE_MS = 60 * 60 * 1000

/** Env names that can change what the provider layer builds. Matched on the NAME, so
 *  a provider nobody anticipated still invalidates when its credential appears. Values
 *  are hashed, never recorded. */
const ENV_PATTERN = /(API_?KEY|_TOKEN|_KEY|BASE_?URL|_HOST|^ORIGAMI_CONFIG)/i

/** Names the ENGINE ITSELF writes into its own environment at boot. They match
 *  ENV_PATTERN by shape but change every process, so leaving them in made the key
 *  unique per run and the cache never hit once - the exact failure this denylist was
 *  added to fix. */
const ENV_DENY = /^(ORIGAMI_PID|ORIGAMI_CONSOLE_TOKEN)$/

/** Option/header names whose VALUE is a credential. */
const SECRET_PATTERN = /(key|token|secret|password|authorization|cookie)/i

export function directory() {
  return path.join(Global.Path.data, "cache")
}

export function file(key: string) {
  return path.join(directory(), `provider-catalog-${key}.json`)
}

function sha(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex")
}

function authStamp() {
  try {
    const stat = fs.statSync(path.join(Global.Path.data, "auth.json"))
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return "absent"
  }
}

function envStamp() {
  const parts: string[] = []
  for (const name of Object.keys(process.env).toSorted()) {
    if (!ENV_PATTERN.test(name) || ENV_DENY.test(name)) continue
    parts.push(`${name}=${sha(process.env[name] ?? "")}`)
  }
  return parts.join("\n")
}

/**
 * The cache key. Every input the catalog build reads that can change between two
 * engine processes is in here:
 *
 *  - the engine version, so an upgrade never serves the old build's shape;
 *  - the directory, because project config is merged per directory;
 *  - the MERGED config, which is what a "config change" means to the user;
 *  - the auth store's mtime+size, so pasting a credential is picked up;
 *  - the credential-shaped environment.
 *
 * Known gap, deliberately not covered: a PLUGIN's `config()` hook can rewrite
 * `cfg.provider` after this hash is taken. Plugins are declared in the config, so
 * adding or removing one does invalidate; editing a plugin's source in place does
 * not. `provider_refresh` remains the escape hatch for that.
 */
export function key(input: { directory: string; config: unknown }) {
  return sha(
    [
      `format=${FORMAT}`,
      `version=${InstallationVersion}`,
      `directory=${input.directory}`,
      `config=${JSON.stringify(input.config ?? null)}`,
      `auth=${authStamp()}`,
      `env=${envStamp()}`,
    ].join("\n"),
  )
}

function stripRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([name]) => !SECRET_PATTERN.test(name)),
  )
}

/** Drop everything credential-shaped. Applied to the live answer as well as the
 *  cached one - see rule 1 at the top of this file. */
export function withoutSecrets(result: Provider.ConfigProvidersResult): Provider.ConfigProvidersResult {
  return {
    ...result,
    providers: result.providers.map((provider) => {
      const { key: _secret, ...rest } = provider as Provider.Info & { key?: string }
      return {
        ...rest,
        options: stripRecord(rest.options),
        models: Object.fromEntries(
          Object.entries(rest.models ?? {}).map(([id, model]) => [
            id,
            { ...model, options: stripRecord(model.options), headers: stripRecord(model.headers) },
          ]),
        ),
      } as Provider.Info
    }),
  }
}

function looksLikeCatalog(value: unknown): value is Provider.ConfigProvidersResult {
  if (!value || typeof value !== "object") return false
  const candidate = value as { providers?: unknown; default?: unknown }
  return Array.isArray(candidate.providers) && !!candidate.default && typeof candidate.default === "object"
}

/** The cached catalog for this key, or undefined. Never throws. */
export function read(cacheKey: string): Provider.ConfigProvidersResult | undefined {
  try {
    if (Date.now() - fs.statSync(file(cacheKey)).mtimeMs > MAX_AGE_MS) return undefined
    const raw = fs.readFileSync(file(cacheKey), "utf8")
    const parsed = JSON.parse(raw) as { format?: number; catalog?: unknown }
    if (parsed?.format !== FORMAT) return undefined
    if (!looksLikeCatalog(parsed.catalog)) return undefined
    return parsed.catalog
  } catch {
    return undefined
  }
}

/** Write the catalog for this key, secrets stripped. Never throws: a cache that
 *  cannot be written is a slow start, not a failed one. Written to a sibling temp
 *  file and renamed, so a second engine process never reads a half-written file. */
export function write(cacheKey: string, catalog: Provider.ConfigProvidersResult) {
  try {
    fs.mkdirSync(directory(), { recursive: true })
    const target = file(cacheKey)
    const temp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ format: FORMAT, catalog: withoutSecrets(catalog) }))
    fs.renameSync(temp, target)
  } catch {
    // intentionally ignored
  }
}

/** origami_change (t-ttmo5w): drop every cached catalog, for every key. The
 *  Connections Refresh button's "hard" `provider_refresh` calls this, so the next chat
 *  builds fresh. Only `provider-catalog-*` files: the directory is shared with the
 *  agent snapshot cache. Never throws. */
export function clear() {
  try {
    for (const name of fs.readdirSync(directory())) {
      if (name.startsWith("provider-catalog-")) fs.rmSync(path.join(directory(), name), { force: true })
    }
  } catch {
    // intentionally ignored: no directory means nothing is cached
  }
}

export * as ProviderCatalogCache from "./catalog-cache"
