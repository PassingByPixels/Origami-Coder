export * as AgentPluginConfigWrite from "./config-write"

import path from "path"
import { modify, applyEdits, parse as parseJsonc } from "jsonc-parser"
import { Global } from "@origami/core/global"
import type { ConfigV1 } from "@origami/core/v1/config/config"
import { Filesystem } from "@/util/filesystem"
import { AgentPluginEntry } from "./entry"

/**
 * Direct file-level read/write of the `agentPlugins` config array, for the
 * Plugins management pane's two write actions (enable/disable toggle, add
 * from folder). Deliberately NOT through `Config.Service`: that merges every
 * config file into one in-memory value with no record of which physical file
 * an entry came from, and a write has to land on THAT file or it either
 * duplicates the entry (toggle) or silently no-ops (a merged read the write
 * side never persists).
 *
 * Comment-preserving via jsonc-parser, same tool and same shape as
 * `cli/cmd/agent-plugin.ts`'s own `add` command.
 */

const CONFIG_KEY = "agentPlugins"

function projectCandidates(directory: string): string[] {
  return [
    path.join(directory, "origami.json"),
    path.join(directory, "origami.jsonc"),
    path.join(directory, ".origami", "origami.json"),
    path.join(directory, ".origami", "origami.jsonc"),
  ]
}

function globalCandidates(): string[] {
  return [path.join(Global.Path.config, "origami.json"), path.join(Global.Path.config, "origami.jsonc")]
}

/** Every place an `agentPlugins` entry could physically live, PROJECT first
 *  (closest to where a user is working) then GLOBAL. */
function allCandidates(directory: string): string[] {
  return [...projectCandidates(directory), ...globalCandidates()]
}

async function readEntries(file: string): Promise<{ text: string; entries: ConfigV1.AgentPluginEntry[] }> {
  if (!(await Filesystem.exists(file))) return { text: "{}", entries: [] }
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
  return { text, entries: Array.isArray(raw) ? (raw as ConfigV1.AgentPluginEntry[]) : [] }
}

async function writeEntries(file: string, text: string, entries: ConfigV1.AgentPluginEntry[]): Promise<void> {
  const edits = modify(text, [CONFIG_KEY], entries, { formattingOptions: { tabSize: 2, insertSpaces: true } })
  await Filesystem.write(file, applyEdits(text, edits))
}

export interface Located {
  readonly path: string
  readonly text: string
  readonly entries: ConfigV1.AgentPluginEntry[]
  readonly index: number
}

/**
 * Find which config file already names `spec`, searching PROJECT candidates
 * then GLOBAL ones. A toggle has to land on the file the entry already lives
 * in — searching (rather than always writing project) is what stops a plugin
 * added to the GLOBAL config from growing a second, shadowing project entry
 * the first time it is disabled.
 */
export async function locate(directory: string, spec: string): Promise<Located | undefined> {
  for (const file of allCandidates(directory)) {
    const { text, entries } = await readEntries(file)
    const index = entries.findIndex((e) => AgentPluginEntry.normalize(e).spec === spec)
    if (index !== -1) return { path: file, text, entries, index }
  }
  return undefined
}

async function resolveProjectTarget(directory: string): Promise<string> {
  for (const file of projectCandidates(directory)) {
    if (await Filesystem.exists(file)) return file
  }
  return projectCandidates(directory)[0]!
}

export interface SetEnabledResult {
  readonly path: string
}

/** Flip one entry's enabled state in place, in whichever file it lives in. */
export async function setEnabled(directory: string, spec: string, enabled: boolean): Promise<SetEnabledResult> {
  const located = await locate(directory, spec)
  if (!located) {
    throw new Error(`"${spec}" is not in ${CONFIG_KEY} in any project or global origami.json`)
  }
  const next = [...located.entries]
  next[located.index] = AgentPluginEntry.toConfigValue(spec, enabled)
  await writeEntries(located.path, located.text, next)
  return { path: located.path }
}

export interface AddResult {
  readonly path: string
}

/**
 * Append a NEW spec to the project config, creating `origami.json` there if
 * none of the project candidates exist yet — the same default
 * `agent-plugin add` has always used. Refuses a spec already configured
 * ANYWHERE rather than adding a second entry for the same plugin. Callers
 * validate the plugin (manifest parses, resolves) BEFORE calling this; this
 * function only ever writes config.
 */
export async function addPlugin(directory: string, spec: string): Promise<AddResult> {
  const existing = await locate(directory, spec)
  if (existing) throw new Error(`"${spec}" is already configured (${existing.path})`)
  const target = await resolveProjectTarget(directory)
  const { text, entries } = await readEntries(target)
  await writeEntries(target, text, [...entries, spec])
  return { path: target }
}
