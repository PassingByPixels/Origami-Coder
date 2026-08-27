import path from "path"
import { Effect } from "effect"
import * as prompts from "@clack/prompts"
import { modify, applyEdits } from "jsonc-parser"
import { Global } from "@origami/core/global"
import { FSUtil } from "@origami/core/fs-util"
import type { ConfigV1 } from "@origami/core/v1/config/config"
import { Config } from "@/config/config"
import { AgentPlugins } from "@/agent-plugins"
import { AgentPluginEntry } from "@/agent-plugins/entry"
import { AgentPluginLoader } from "@/agent-plugins/loader"
import { Filesystem } from "@/util/filesystem"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"

/**
 * Minimal CLI for agent-plugins.org plugins: enough to install one and see what
 * it brought in. The management screen the ticket sizes as L is deliberately not
 * here - it is a separate, greenfield piece of UI work.
 */

const CONFIG_KEY = "agentPlugins"

async function configPath(global: boolean, directory: string) {
  const base = global ? Global.Path.config : directory
  const candidates = [path.join(base, "origami.json"), path.join(base, "origami.jsonc")]
  if (!global) {
    candidates.push(path.join(base, ".origami", "origami.json"), path.join(base, ".origami", "origami.jsonc"))
  }
  for (const candidate of candidates) if (await Filesystem.exists(candidate)) return candidate
  return candidates[0]!
}

/** Append a spec to `agentPlugins`, preserving comments in a .jsonc config. */
async function append(target: string, spec: string, existing: readonly ConfigV1.AgentPluginEntry[]) {
  let text = "{}"
  if (await Filesystem.exists(target)) text = await Filesystem.readText(target)
  const edits = modify(text, [CONFIG_KEY], [...existing, spec], {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  await Filesystem.write(target, applyEdits(text, edits))
}

export const AgentPluginAddCommand = effectCmd({
  command: "add <dir>",
  describe: "add an agent-plugins.org plugin directory",
  builder: (yargs) =>
    yargs
      .positional("dir", { describe: "plugin root directory", type: "string", demandOption: true })
      .option("global", { describe: "write to the global config instead of this project", type: "boolean" }),
  handler: Effect.fn("Cli.agentPlugin.add")(function* (args) {
    const cfgSvc = yield* Config.Service
    const fsys = yield* FSUtil.Service
    const directory = process.cwd()

    // Resolve and load BEFORE writing. Adding a path that turns out to have no
    // manifest would otherwise leave a broken entry in the config plus a warning
    // on every future start, and the user would have to work out which of the
    // two files to edit.
    const resolved = yield* AgentPluginLoader.resolve({ spec: args.dir }, fsys, Global.Path.home, directory)
    if (!resolved.ok) return yield* fail(resolved.value.message)
    const loaded = yield* AgentPluginLoader.load(resolved.value, fsys, path.join(Global.Path.data, "agent-plugins"))
    if (!loaded.ok) return yield* fail(loaded.value.message)

    const cfg = yield* cfgSvc.get()
    const existing = cfg.agentPlugins ?? []
    // Normalized comparison: an entry disabled from the Plugins pane is the
    // object form `{ spec, enabled: false }`, which a plain `.includes(dir)`
    // string check would never match, letting the same plugin get added twice.
    if (AgentPluginEntry.normalizeAll(existing).some((e) => e.spec === args.dir)) {
      return yield* fail(`"${args.dir}" is already in ${CONFIG_KEY}`)
    }

    const target = yield* Effect.promise(() => configPath(args.global === true, directory))
    yield* Effect.promise(() => append(target, args.dir, existing))

    const plugin = loaded.value
    prompts.log.success(`Added "${plugin.name}" (${plugin.mode} manifest) to ${target}`)
    prompts.log.info(`${Object.keys(plugin.mcp).length} MCP server(s), ${plugin.skillFiles.length} skill(s)`)
    for (const warning of plugin.warnings) prompts.log.warn(warning)
    prompts.outro("Start a new session to load it.")
  }),
})

export const AgentPluginListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list loaded agent-plugins.org plugins",
  handler: Effect.fn("Cli.agentPlugin.list")(function* () {
    UI.empty()
    prompts.intro("Agent Plugins")

    const plugins = yield* AgentPlugins.Service
    const loaded = yield* plugins.all()
    const problems = yield* plugins.problems()

    if (loaded.length === 0 && problems.length === 0) {
      prompts.log.warn(`No plugins configured`)
      prompts.outro("Add one with: origami agent-plugin add <dir>")
      return
    }

    for (const plugin of loaded) {
      const servers = Object.keys(plugin.mcp)
      prompts.log.info(
        [
          // A disabled entry's `mcp`/`skillFiles` are DECLARED, not registered —
          // it never reached the live session, so the line says so up front
          // rather than showing servers that are not actually running.
          `${plugin.enabled ? "✓" : "○ disabled"} ${plugin.name}${plugin.manifest.version ? ` ${plugin.manifest.version}` : ""} (${plugin.mode})`,
          `   ${plugin.root}`,
          `   mcp: ${servers.length > 0 ? servers.join(", ") : "none"}`,
          `   skills: ${plugin.skillFiles.length}`,
          ...plugin.warnings.map((warning) => `   ! ${warning}`),
        ].join("\n"),
      )
    }

    for (const problem of problems) prompts.log.error(`✗ ${problem.spec}\n   ${problem.message}`)
    prompts.outro(`${loaded.length} loaded, ${problems.length} skipped`)
  }),
})

export const AgentPluginCommand = cmd({
  command: "agent-plugin",
  aliases: ["agent-plugins"],
  describe: "manage agent-plugins.org plugins",
  builder: (yargs) => yargs.command(AgentPluginAddCommand).command(AgentPluginListCommand).demandCommand(),
  async handler() {},
})
