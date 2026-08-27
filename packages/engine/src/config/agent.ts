export * as ConfigAgent from "./agent"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@origami/core/util/glob"
import { ConfigAgentV1 } from "@origami/core/v1/config/agent"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"

/** The glob and name prefixes `load` scans, shared so a lookup cannot drift. */
const GLOB = "{agent,agents}/**/*.md"
const PREFIXES = ["agent/", "agents/"]

const scan = (dir: string) => Glob.scan(GLOB, { cwd: dir, absolute: true, dot: true, symlink: true })

/**
 * The file `load` would read the definition NAME from, under one directory, or
 * undefined when that directory holds none. Uses the same glob and the same
 * naming rule as `load`, so a caller that reports this path reports the file
 * the loader actually reads - including a file whose frontmatter `load` had to
 * skip, which is exactly the file a human needs named.
 */
export async function fileFor(dir: string, name: string) {
  for (const item of await scan(dir)) {
    if (configEntryNameFromPath(path.relative(dir, item), PREFIXES) === name) return item
  }
  return undefined
}

export async function load(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await scan(dir)) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), PREFIXES)

    const config = {
      name,
      ...md.data,
      prompt: md.content.trim(),
    }
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
  }
  return result
}

export async function loadMode(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const config = {
      name: configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"]),
      ...md.data,
      prompt: md.content.trim(),
    }
    const parsed = Schema.decodeUnknownExit(ConfigAgentV1.Info)(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = {
        ...parsed.value,
        mode: "primary" as const,
      }
    }
  }
  return result
}
