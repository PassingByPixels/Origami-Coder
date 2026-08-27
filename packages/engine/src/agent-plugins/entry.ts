export * as AgentPluginEntry from "./entry"

import type { ConfigV1 } from "@origami/core/v1/config/config"

/**
 * `ConfigV1.AgentPluginEntry` reduced to what the loader and the config
 * writer both need: a spec string and its enabled state. Every reader of
 * `cfg.agentPlugins` goes through `normalize`/`normalizeAll` rather than
 * branching on `typeof entry === "string"` itself, so the two shapes the
 * schema allows cannot drift into two different meanings of "enabled".
 */
export interface Normalized {
  readonly spec: string
  readonly enabled: boolean
}

export function normalize(entry: ConfigV1.AgentPluginEntry): Normalized {
  if (typeof entry === "string") return { spec: entry, enabled: true }
  return { spec: entry.spec, enabled: entry.enabled !== false }
}

export function normalizeAll(entries: readonly ConfigV1.AgentPluginEntry[] | undefined): Normalized[] {
  return (entries ?? []).map(normalize)
}

/**
 * The config VALUE to write for one entry, given its desired enabled state —
 * a plain string when enabled (the common case, and what a hand-authored
 * config already looks like), an object only when disabled. Keeps a toggle
 * round-trip a minimal diff instead of upgrading every entry to object form.
 */
export function toConfigValue(spec: string, enabled: boolean): ConfigV1.AgentPluginEntry {
  return enabled ? spec : { spec, enabled: false }
}
