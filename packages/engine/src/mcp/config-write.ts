export * as McpConfigWrite from "./config-write"

import path from "path"
import { modify, applyEdits, parse as parseJsonc } from "jsonc-parser"
import { Global } from "@origami/core/global"
import type { ConfigMCPV1 } from "@origami/core/v1/config/mcp"
import { Filesystem } from "@/util/filesystem"

/**
 * Direct file-level read/write of the `mcp` config record, shared by the CLI
 * (`cli/cmd/mcp.ts`) and the MCP management pane's ACP writes
 * (`acp/mcp.ts`).
 *
 * Deliberately NOT through `Config.Service`, for the reason
 * `agent-plugins/config-write.ts` states: that merges every config file into
 * one in-memory value with no record of which physical file an entry came
 * from, and a write has to land on THAT file or it either duplicates the
 * entry or silently no-ops. Comment-preserving via jsonc-parser.
 *
 * `resolveConfigPath` and `addServer` were the CLI's own private
 * `resolveConfigPath`/`addMcpToConfig`, moved here verbatim so both callers
 * share one implementation instead of two that can drift.
 */

const CONFIG_KEY = "mcp"

/** A `mcp` record value: a full server, or the bare disable marker that turns
 *  OFF a server a plugin provided (core config.ts allows `{ enabled }` with
 *  no `type`). */
export type Entry = ConfigMCPV1.Info | { enabled: boolean }

export async function resolveConfigPath(baseDir: string, global = false): Promise<string> {
  // Check for existing config files (prefer .jsonc over .json, check .origami/ subdirectory too)
  const candidates = [path.join(baseDir, "origami.json"), path.join(baseDir, "origami.jsonc")]

  if (!global) {
    candidates.push(path.join(baseDir, ".origami", "origami.json"), path.join(baseDir, ".origami", "origami.jsonc"))
  }

  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) {
      return candidate
    }
  }

  // Default to origami.json if none exist
  return candidates[0]!
}

/** Every place an `mcp` entry could physically live, PROJECT first (closest to
 *  where a user is working) then GLOBAL — same order and same rationale as
 *  `AgentPluginConfigWrite.allCandidates`. */
function allCandidates(directory: string): string[] {
  return [
    path.join(directory, "origami.json"),
    path.join(directory, "origami.jsonc"),
    path.join(directory, ".origami", "origami.json"),
    path.join(directory, ".origami", "origami.jsonc"),
    path.join(Global.Path.config, "origami.json"),
    path.join(Global.Path.config, "origami.jsonc"),
  ]
}

async function readFile(file: string): Promise<{ text: string; servers: Record<string, Entry> }> {
  if (!(await Filesystem.exists(file))) return { text: "{}", servers: {} }
  const text = await Filesystem.readText(file)
  let parsed: unknown
  try {
    parsed = parseJsonc(text)
  } catch {
    throw new Error(`${file} is not valid JSON — fix or remove it first`)
  }
  const raw =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)[CONFIG_KEY]
      : undefined
  const servers = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, Entry>) : {}
  return { text, servers }
}

async function writeKey(file: string, text: string, name: string, value: unknown): Promise<void> {
  const edits = modify(text, [CONFIG_KEY, name], value, { formattingOptions: { tabSize: 2, insertSpaces: true } })
  await Filesystem.write(file, applyEdits(text, edits))
}

/** Write one server under `mcp.<name>` in an explicitly chosen file. The CLI's
 *  own `addMcpToConfig`, unchanged. */
export async function addServer(configPath: string, name: string, mcpConfig: ConfigMCPV1.Info): Promise<string> {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }
  const edits = modify(text, [CONFIG_KEY, name], mcpConfig, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  await Filesystem.write(configPath, applyEdits(text, edits))
  return configPath
}

export interface Located {
  readonly path: string
  readonly text: string
  readonly entry: Entry
}

/** Which config file already names `name` under `mcp`, PROJECT before GLOBAL.
 *  A write has to land on that file, not on whichever one a default picks. */
export async function locate(directory: string, name: string): Promise<Located | undefined> {
  for (const file of allCandidates(directory)) {
    const { text, servers } = await readFile(file)
    const entry = servers[name]
    if (entry !== undefined) return { path: file, text, entry }
  }
  return undefined
}

/** True for the entries the engine actually connects — a bare `{ enabled }`
 *  marker has no `type` and is skipped by `mcp/index.ts`'s `isMcpConfigured`. */
export function isConfigured(entry: Entry | undefined): entry is ConfigMCPV1.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

export interface WrittenTo {
  readonly path: string
}

/**
 * Turn one server on or off.
 *
 * Two genuinely different cases, because of the merge rule in
 * `mcp/index.ts`: `{ ...pluginServers, ...cfg.mcp }`, and an entry with no
 * `type` is then SKIPPED entirely.
 *
 *  - The name is in a config file already → set `enabled` on it in place.
 *  - The name is NOT in any config file (a plugin brought it) → disabling
 *    writes the bare `{ enabled: false }` marker into the project config.
 *    ENABLING such a name must DELETE that marker rather than write
 *    `{ enabled: true }`: a bare entry shadows the plugin's real definition
 *    and, having no `type`, would make the server vanish instead of start.
 */
export async function setEnabled(directory: string, name: string, enabled: boolean): Promise<WrittenTo> {
  const located = await locate(directory, name)
  if (located && isConfigured(located.entry)) {
    await writeKey(located.path, located.text, name, { ...located.entry, enabled })
    return { path: located.path }
  }
  if (located) {
    // A bare marker. Turning it back on means removing the shadow.
    if (enabled) {
      await writeKey(located.path, located.text, name, undefined)
      return { path: located.path }
    }
    await writeKey(located.path, located.text, name, { enabled: false })
    return { path: located.path }
  }
  if (enabled) {
    // Reachable: a plugin can declare its OWN server `enabled: false`. Turning
    // that on is the plugin's to do — a config entry here would have to COPY
    // the whole definition, and the copy would then shadow the plugin's own.
    throw new Error(
      `"${name}" is not in mcp in any project or global origami.json — nothing to enable. ` +
        `A server a plugin declares as disabled has to be enabled in that plugin.`,
    )
  }
  const target = await resolveConfigPath(directory)
  const { text } = await readFile(target)
  await writeKey(target, text, name, { enabled: false })
  return { path: target }
}

/** Delete one `mcp.<name>` entry from the file it lives in. Refuses a name no
 *  config file holds — a plugin-provided server is not this file's to delete. */
export async function remove(directory: string, name: string): Promise<WrittenTo> {
  const located = await locate(directory, name)
  if (!located) throw new Error(`"${name}" is not in mcp in any project or global origami.json`)
  await writeKey(located.path, located.text, name, undefined)
  return { path: located.path }
}
