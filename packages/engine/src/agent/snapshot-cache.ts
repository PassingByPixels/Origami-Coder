// origami_change (t-qdc718): the agent registry, cached ACROSS engine processes.
//
// Every new chat is its own engine process, and every one of them rebuilt the agent
// registry from scratch inside `session/new` - the `acp.directory.mode.defaultAgent.load`
// leg, measured at ~930 ms warm on this box and provider-count independent, which is
// what `session/new` waits on once the provider catalog is cached.
//
// Almost none of that cost is the agent definitions. Measured with temporary marks
// inside `Agent.state`: config.get 0 ms, getDeclaredAgents 0 ms, the registry build
// 1 ms, skill.dirs 65 ms, and 812 ms in ONE line - the `PluginV2.wait("core/config-reference")`
// the state does to turn configured references into permission allow-globs. That wait
// boots the whole plugin runtime for the location. It is paid again on the first
// prompt, so paying it inside `session/new` buys nothing but a slower first paint.
//
// So the registry is hashed into a key and the RESULT is written next to the provider
// catalog cache. A second process with the same inputs reads the answer instead of
// rebuilding it. Same two rules as `provider/catalog-cache.ts`:
//
//  1. A HIT AND A MISS RETURN THE SAME VALUE. The registry holds no credentials - it
//     is names, prompts, permission rulesets and model ids, all plain JSON - so there
//     is no secret strip here. What there IS is a JSON round trip, and both paths take
//     it: the live answer already crosses an HTTP boundary as JSON before any caller
//     sees it, and `toSnapshot` applies the same projection to the value written. An
//     equality test (`test/agent/snapshot-cache.test.ts`) asserts the two are deep-equal.
//  2. A BAD CACHE IS A MISS, NEVER A CRASH. Truncated file, wrong shape, unreadable
//     directory - every one of them falls through to the normal build.
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Global } from "@origami/core/global"
import { InstallationVersion } from "@origami/core/installation/version"
import type { Info } from "./agent"

const FORMAT = 1

export function directory() {
  return path.join(Global.Path.data, "cache")
}

export function file(key: string) {
  return path.join(directory(), `agent-snapshot-${key}.json`)
}

function sha(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex")
}

/**
 * The cache key. Every input the registry build reads that can change between two
 * engine processes is in here:
 *
 *  - the engine version, so an upgrade never serves the old build's shape;
 *  - the directory, because project config is merged per directory;
 *  - the MERGED config. This is stronger than the agent definition files' mtimes:
 *    `Config.get` already merges every `agent/**.md` and `mode/*.md` file's PARSED
 *    CONTENT into `cfg.agent` (config/config.ts, `ConfigAgent.load`/`loadMode`), so a
 *    definition edited, added or deleted changes this hash by its content, not by a
 *    timestamp a touch could move without a real change;
 *  - the SKILL DIRECTORIES. The registry reads skills only as permission allow-globs
 *    (`path.join(dir, "*")`), so the set of directories is exactly what it depends on -
 *    a skill file edited inside a directory already covered cannot change the answer.
 *    Cheap to compute: `Skill.dirs` is a filesystem scan (~65 ms) and does not touch
 *    the plugin runtime this cache exists to skip.
 *
 * REFERENCES are covered through the config: the reference directories the registry
 * whitelists are `core/config-reference`'s output, and that plugin derives every one of
 * them from `cfg.references` (a local path, or a deterministic cache path for a git
 * repository).
 *
 * Known gap, deliberately not covered and the same one `provider/catalog-cache.ts`
 * carries: a PLUGIN can rewrite `cfg.agent` or contribute a reference of its own after
 * this hash is taken. Plugins are declared in the config, so adding or removing one does
 * invalidate; editing a plugin's source in place does not. The delayed refresh at the
 * call site is what closes it for the NEXT chat.
 */
export function key(input: { directory: string; config: unknown; skillDirs: readonly string[] }) {
  return sha(
    [
      `format=${FORMAT}`,
      `version=${InstallationVersion}`,
      `directory=${input.directory}`,
      `config=${JSON.stringify(input.config ?? null)}`,
      `skills=${[...input.skillDirs].toSorted().join("\n")}`,
    ].join("\n"),
  )
}

/** The JSON projection every caller of `/agent` already receives. Applied to the live
 *  answer as well as the cached one - see rule 1 at the top of this file. */
export function toSnapshot(agents: readonly Info[]): Info[] {
  return JSON.parse(JSON.stringify(agents)) as Info[]
}

function looksLikeSnapshot(value: unknown): value is Info[] {
  if (!Array.isArray(value)) return false
  return value.every((item) => {
    if (!item || typeof item !== "object") return false
    const candidate = item as { name?: unknown; mode?: unknown; permission?: unknown; options?: unknown }
    return (
      typeof candidate.name === "string" &&
      typeof candidate.mode === "string" &&
      Array.isArray(candidate.permission) &&
      !!candidate.options &&
      typeof candidate.options === "object"
    )
  })
}

/** The cached registry for this key, or undefined. Never throws. */
export function read(cacheKey: string): Info[] | undefined {
  try {
    const raw = fs.readFileSync(file(cacheKey), "utf8")
    const parsed = JSON.parse(raw) as { format?: number; agents?: unknown }
    if (parsed?.format !== FORMAT) return undefined
    if (!looksLikeSnapshot(parsed.agents)) return undefined
    return parsed.agents
  } catch {
    return undefined
  }
}

/** Write the registry for this key. Never throws: a cache that cannot be written is a
 *  slow start, not a failed one. Written to a sibling temp file and renamed, so a
 *  second engine process never reads a half-written file. */
export function write(cacheKey: string, agents: readonly Info[]) {
  try {
    fs.mkdirSync(directory(), { recursive: true })
    const target = file(cacheKey)
    const temp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ format: FORMAT, agents: toSnapshot(agents) }))
    fs.renameSync(temp, target)
  } catch {
    // intentionally ignored
  }
}

export * as AgentSnapshotCache from "./snapshot-cache"
