import { LayerNode } from "@origami/core/effect/layer-node"
import { httpClient } from "@origami/core/effect/app-node-platform"
import { serviceUse } from "@origami/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@origami/core/global"
import fsNode from "fs/promises"
import { Flag } from "@origami/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { existsSync, readFileSync, renameSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import { migrateZenProviderId } from "@/origami/zen-provider-migrate" // origami_change
import type { ConsoleState } from "@origami/core/v1/config/console-state"
import { FSUtil } from "@origami/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@origami/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@origami/core/v1/config/config"
import { RemoteAuthError } from "@origami/core/v1/config/error"
import { ConfigPermissionV1 } from "@origami/core/v1/config/permission"
import { ConfigPluginV1 } from "@origami/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { Npm } from "@origami/core/npm"
import { withTransientReadRetry } from "@/util/effect-http-client"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

type State = {
  config: Info
  /** The `agent` blocks config files declared - see {@link Interface.getDeclaredAgents}. */
  declaredAgent: NonNullable<Info["agent"]>
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  /** Read an agent's temperature / top_p FRESH from the global config file,
   *  bypassing the spawn-memoized cache, so a settings change applies on the
   *  next request with no engine respawn. Missing/invalid → empty. */
  readonly getLiveAgentSampling: (
    agentName: string,
  ) => Effect.Effect<{ temperature?: number; topP?: number; frequencyPenalty?: number }>
  /**
   * Re-scan the agent DEFINITION FILES - the `agent/` and `agents/` markdown
   * trees, plus the `mode/` equivalents - under every config directory,
   * bypassing the spawn-memoized instance cache. A definition written while the
   * engine runs is therefore readable now. Same targeted-live-read role as
   * `getLiveAgentSampling` above.
   *
   * Deliberately NOT `invalidateInstance()`: that also re-runs `ensureGitignore`
   * and the background dependency install for every directory, which is far too
   * much work for a list call. Markdown definitions only - the `agent` blocks
   * inside origami.json are not re-read.
   */
  readonly getLiveAgents: () => Effect.Effect<NonNullable<Info["agent"]>>
  /**
   * The `agent` blocks CONFIG FILES declared, without the ones the scan of the
   * definition files contributes. The other half of `getLiveAgents`, and only
   * useful beside it: `get().agent` is the union of the two and cannot say
   * which source an entry came from.
   *
   * Read once, at load, so this is the boot-time picture. It exists so a rescan
   * can rebuild the registry as "what the config declares, plus what is on disk
   * NOW" and therefore drop a definition file that has been deleted without
   * dropping a config-declared agent with it - see `Agent.rescan`.
   */
  readonly getDeclaredAgents: () => Effect.Effect<NonNullable<Info["agent"]>>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  /**
   * Drop the MERGED per-instance config as well as the global file cache, so the
   * next `get()` re-reads every layer from disk.
   *
   * `invalidate()` alone busts only the global-file cache; the view `get()`
   * answers from is an `InstanceState` entry that survives it — which is why the
   * HTTP `config.refresh` route has to dispose the whole instance on top
   * (`httpapi/handlers/config.ts`). That disposal is bound to an HTTP request
   * (`markInstanceForDisposal` hangs the teardown off the pre-response handler),
   * so an in-process caller with no request — an ACP ext method — cannot use it.
   * This is the same job at instance granularity: everything else keeps running.
   */
  readonly invalidateInstance: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  /**
   * Join the background npm install started for each config directory at load.
   * Callers that are about to IMPORT from one of those directories wait here
   * first — `ToolRegistry` before it imports `.origami/tool/*.ts`, and
   * `Plugin` before it loads external plugins.
   *
   * It installs whatever `<dir>/package.json` declares and NOTHING ELSE. It
   * used to also `add` `@origami/plugin` so a user tool file could
   * `import { tool }` from it; that package is workspace-internal and
   * unpublished in this fork, so the registry answered 404 and the reify
   * FAILED — which meant the directory's real dependencies were not installed
   * either. Removing the add is what makes this call able to succeed at all.
   * A tool file that wants `@origami/plugin` still works by the manual
   * convention (a `node_modules/@origami/plugin` the user puts there), which
   * `test/tool/registry.test.ts` covers.
   *
   * Resolves immediately when nothing was scheduled — every fiber in the list
   * has already been forked, so an empty list is an empty join.
   */
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@origami/Config") {}

export const use = serviceUse(Service)

/**
 * The global config file a WRITE should target: the first of the three
 * candidates that exists, else the one `loadGlobal` would seed. Exported so a
 * writer outside this module (the Flock ext methods) edits the same file the
 * loader prefers — the candidate order mirrors `loadGlobal`'s merge order, so
 * the file picked here is also the one whose value wins.
 *
 * When NOTHING exists yet the answer is `origami.json`, NOT `origami.jsonc`.
 * The `.jsonc` candidate outranks `.json` in the merge, so seeding an empty
 * `.jsonc` on a virgin machine put a permanently-empty file at the TOP of the
 * merge order — where it shadowed, forever and silently, every write the VS
 * Code extension makes (it targets `origami.json` and has no candidate search).
 * Both halves succeeded at what they thought they were doing and the user's
 * connections simply never took effect. Connections review 2026-08-15,
 * finding 1; `migrateEmptySeedJsonc` below folds away the ones already on disk.
 */
export function globalConfigFile() {
  const candidates = ["origami.jsonc", "origami.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return path.join(Global.Path.config, "origami.json")
}

/** True when `text` is the empty seed — `{}` and nothing else but whitespace.
 *  Parsed, not string-compared, so `{ }` and `{\n}` count too. Comments do NOT:
 *  a commented file is something the user wrote in, and this must never move a
 *  file that holds anything of theirs. */
function isEmptySeed(text: string): boolean {
  if (/\/\/|\/\*/.test(text)) return false
  try {
    const parsed = JSON.parse(text)
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0
  } catch {
    return false
  }
}

/**
 * Fold away an EMPTY `origami.jsonc` seed left by an older build, so the
 * populated `origami.json` beside it stops being shadowed (finding 1).
 *
 * Deliberately conservative, in three ways. It only ever fires when the
 * `.jsonc` parses to exactly `{}` — a file with ANY content, or any comment, is
 * the user's and is left alone. It only fires when `origami.json` actually has
 * something in it, so a genuinely fresh install is untouched. And it RENAMES,
 * never deletes: `origami.jsonc.empty-seed-<date>` stays on disk, because a
 * loader silently removing a file from the user's config directory is not a
 * trade worth making even for a two-byte one.
 */
function migrateEmptySeedJsonc(): string | undefined {
  const jsonc = path.join(Global.Path.config, "origami.jsonc")
  const json = path.join(Global.Path.config, "origami.json")
  if (!existsSync(jsonc) || !existsSync(json)) return undefined
  try {
    if (!isEmptySeed(readFileSync(jsonc, "utf8"))) return undefined
    // Nothing being shadowed yet: a blank or equally-empty origami.json is a
    // fresh install, not a user whose settings are being outranked.
    const jsonText = readFileSync(json, "utf8")
    if (!jsonText.trim() || isEmptySeed(jsonText)) return undefined
    const aside = `${jsonc}.empty-seed-${new Date().toISOString().slice(0, 10)}`
    if (existsSync(aside)) return undefined // already migrated today; don't clobber the kept copy
    renameSync(jsonc, aside)
    return `renamed the empty ${jsonc} to ${aside}: it was shadowing ${json}`
  } catch {
    // Best effort. A config directory we cannot write is not a reason to fail
    // the load — the merge below still reads whatever is actually there.
    return undefined
  }
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed), source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      // This fork hosts no config JSON Schema, so it never writes a `$schema` key into the
      // user's config file. A `$schema` the user sets themselves is still read and kept.
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed an empty default global config so the user has a file to edit, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.ORIGAMI_CONFIG && !Flag.ORIGAMI_CONFIG_DIR && !Flag.ORIGAMI_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs.writeWithDirs(file, JSON.stringify({}, null, 2)).pipe(Effect.catch(() => Effect.void))
        }
        // Older builds seeded origami.jsonc here. Fold an empty one aside before
        // the merge below, or it keeps outranking the file the extension writes.
        const migrated = migrateEmptySeedJsonc()
        if (migrated) yield* Effect.logInfo("config migration", { message: migrated })
        // origami_change-start: the sidebar used to write its OpenCode Zen block
        // under `opencode-zen`, which no Zen feature gate matches. Fold those over
        // to the catalog's `opencode` before the merge below reads them.
        const zen = migrateZenProviderId(Global.Path.config)
        if (zen) yield* Effect.logInfo("config migration", { message: zen })
        // origami_change-end
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "origami.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "origami.jsonc"), env))

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const getLiveAgentSampling = Effect.fn("Config.getLiveAgentSampling")(function* (agentName: string) {
      const out: { temperature?: number; topP?: number; frequencyPenalty?: number } = {}
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
      // Read EVERY candidate global config file and merge (later wins). Don't
      // trust globalConfigFile()'s first-existing pick: an empty origami.jsonc
      // would otherwise shadow the populated origami.json the shell writes to.
      //
      // ORDER MATTERS AND MUST MATCH `loadGlobal` ABOVE. Later wins in both, so
      // the list has to read config.json -> origami.json -> origami.jsonc. It
      // used to be the exact reverse, which made legacy config.json outrank
      // origami.jsonc HERE while origami.jsonc outranked it EVERYWHERE else: a
      // user who set temperature in the .jsonc got the new value in the cached
      // config and the stale one on the wire (connections review finding 23).
      // The parse is ConfigParse.jsonc for the same reason the loader's is —
      // JSON.parse could not read the very candidate this list once put first.
      for (const name of ["config.json", "origami.json", "origami.jsonc"]) {
        const file = path.join(Global.Path.config, name)
        const raw = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
        if (!raw) continue
        try {
          const a = (
            ConfigParse.jsonc(raw, file) as {
              agent?: Record<string, { temperature?: unknown; top_p?: unknown; frequency_penalty?: unknown }>
            }
          ).agent?.[agentName]
          const t = num(a?.temperature)
          const p = num(a?.top_p)
          const f = num(a?.frequency_penalty)
          if (t !== undefined) out.temperature = t
          if (p !== undefined) out.topP = p
          if (f !== undefined) out.frequencyPenalty = f
        } catch {
          // genuinely malformed → skip, try the next candidate
        }
      }
      return out
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        /**
         * The `agent` blocks CONFIG FILES declared, kept apart from the ones the
         * definition-file scan below contributes to `result.agent`.
         *
         * Provenance, not a second copy: `result.agent` is the union of the two
         * and cannot say which source an entry came from, so a rescan reading
         * only the definition files could never drop a deleted one without
         * risking a config-declared agent along with it. See `Agent.rescan`.
         *
         * Every non-markdown contributor records here - `merge` covers the
         * remote, global, project and per-directory JSON sources; the two sites
         * that write `result` without going through it do so themselves.
         *
         * NOT named `declare`: that is a TypeScript modifier keyword, and a
         * call to it in statement position does not parse.
         */
        let declaredAgent: NonNullable<Info["agent"]> = {}
        const recordDeclared = (next: Info["agent"]) => {
          if (!next) return
          declaredAgent = mergeDeep(declaredAgent, next) as NonNullable<Info["agent"]>
        }

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "ORIGAMI_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          recordDeclared(next.agent)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/origami`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.ORIGAMI_CONFIG) {
          yield* merge(Flag.ORIGAMI_CONFIG, yield* loadFile(Flag.ORIGAMI_CONFIG, authEnv))
          yield* Effect.logDebug("loaded custom config", { path: Flag.ORIGAMI_CONFIG })
        }

        if (!Flag.ORIGAMI_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("origami", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file, authEnv), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.ORIGAMI_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from ORIGAMI_CONFIG_DIR", { path: Flag.ORIGAMI_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".origami") || dir === Flag.ORIGAMI_CONFIG_DIR) {
            for (const file of ["origami.json", "origami.jsonc"]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          // NO `add:` — see the note on `waitForDependencies`. This used to add
          // `@origami/plugin`, which is unpublished in this fork, so the reify
          // 404'd and took the DIRECTORY'S OWN dependencies down with it.
          // Without it the same call still installs whatever `<dir>/package.json`
          // declares, which is the part that was never working.
          const dep = yield* npmSvc
            .install(dir)
            .pipe(
              Effect.exit,
              Effect.tap((exit) =>
                Exit.isFailure(exit)
                  ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                  : Effect.void,
              ),
              Effect.asVoid,
              Effect.forkDetach,
            )
          deps.push(dep)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.origami/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        if (process.env.ORIGAMI_CONFIG_CONTENT) {
          const source = "ORIGAMI_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.ORIGAMI_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from ORIGAMI_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["ORIGAMI_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("ORIGAMI_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) =>
              Effect.logDebug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["origami.json", "origami.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          const preferences = yield* loadConfig(managed.text, {
            dir: path.dirname(managed.source),
            source: managed.source,
          })
          result = mergeConfigConcatArrays(result, preferences)
          recordDeclared(preferences.agent)
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          const expanded = {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          }
          result.agent = mergeDeep(result.agent ?? {}, expanded)
          // A `mode` block is config too, whichever file wrote it - so the agent
          // it expands into must outlive a definition-file rescan like any other.
          recordDeclared(expanded)
        }

        if (Flag.ORIGAMI_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.ORIGAMI_PERMISSION))
          } catch (err) {
            yield* Effect.logWarning("ORIGAMI_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.ORIGAMI_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.ORIGAMI_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          declaredAgent,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getLiveAgents = Effect.fn("Config.getLiveAgents")(function* () {
      let result: NonNullable<Info["agent"]> = {}
      for (const dir of yield* directories()) {
        // `ConfigParse.schema` THROWS on a malformed definition, and that
        // rejects the whole directory's load - not just the bad file. Skip the
        // directory instead of failing the scan: the readable definitions in
        // the other directories still list, and the caller keeps whatever the
        // last good load already gave it.
        const loaded = yield* Effect.promise(async () => {
          try {
            return [await ConfigAgent.load(dir), await ConfigAgent.loadMode(dir)]
          } catch {
            return []
          }
        })
        for (const entry of loaded) result = mergeDeep(result, entry) as NonNullable<Info["agent"]>
      }
      return result
    })

    const getDeclaredAgents = Effect.fn("Config.getDeclaredAgents")(function* () {
      return yield* InstanceState.use(state, (s) => s.declaredAgent)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      yield* fs
        .writeFileString(file, JSON.stringify(mergeDeep(writable(existing), writable(config)), null, 2))
        .pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const invalidateInstance = Effect.fn("Config.invalidateInstance")(function* () {
      yield* invalidateGlobal
      yield* InstanceState.invalidate(state)
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      // ONE branch for .json and .jsonc alike: patch the TEXT, then decode the
      // result to answer with. The `.json` branch used to decode-then-rewrite
      // instead — and `Schema.Struct` strips undeclared keys at every nested
      // level (parse.ts's topLevelExtraKeys check only re-guards the top), so a
      // round trip silently dropped any nested field this engine build does not
      // declare. One `PUT /config` from an older engine against a newer
      // extension's config was enough; the setting reverted with no explanation
      // (connections review finding 33). Patching text cannot drop what it does
      // not touch, and it preserves comments in the `.json` file too — which the
      // engine has always accepted, since it parses every candidate as JSONC.
      //
      // The returned `info` is still the fully decoded config (the HTTP
      // configUpdate handler answers with it), just decoded AFTER the patch
      // rather than merged before it.
      const updated = patchJsonc(before, patch)
      const next = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(updated, file), file)
      const changed = updated !== before
      if (changed) {
        yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
        yield* invalidate()
      }
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      getLiveAgentSampling,
      getLiveAgents,
      getDeclaredAgents,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      invalidateInstance,
      directories,
      waitForDependencies,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Account.node, Env.node, Npm.node, httpClient],
})

export * as Config from "./config"
