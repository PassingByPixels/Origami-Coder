import { LayerNode } from "@origami/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import path from "path"
import type { ConfigMCPV1 } from "@origami/core/v1/config/mcp"
import { FSUtil } from "@origami/core/fs-util"
import { Global } from "@origami/core/global"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { AgentPluginEntry } from "./entry"
import { AgentPluginLoader } from "./loader"

/**
 * agent-plugins.org 1.0.0 support: the session-facing view of every plugin named
 * in `agentPlugins`.
 *
 * The service owns discovery only. It hands MCP server definitions to `MCP`, skill
 * files to `Skill`, and ownership lookups to the permission gate in
 * `session/tools.ts`, rather than reaching into any of them — so a plugin's MCP
 * server is connected by exactly the code that connects a user's own, and gets
 * the same lifecycle, timeouts and teardown for free.
 */

/** A plugin that was configured but did not load, kept so the user can see why. */
export interface Problem {
  readonly spec: string
  readonly message: string
}

/**
 * A loaded plugin plus whether it is ENABLED — the config-level verdict, not a
 * loader fact. A disabled plugin is still resolved and parsed (so the Plugins
 * pane has its name/version/skills/mcp to show), but it never reaches
 * `skillFiles()`/`mcpServers()`/`owner()`: those three feed the live session,
 * and "disabled" means the loader skips it there.
 */
export interface Entry extends AgentPluginLoader.Loaded {
  readonly enabled: boolean
}

export interface Interface {
  /** Every configured plugin that resolved and parsed, enabled or not. */
  readonly all: () => Effect.Effect<Entry[]>
  /** Every ENABLED plugin's registered MCP server, keyed as the plugin declared it. */
  readonly mcpServers: () => Effect.Effect<Record<string, ConfigMCPV1.Info>>
  /** Which plugin owns an MCP server name, for `plugin:<name>:*` permission targeting. */
  readonly owner: (server: string) => Effect.Effect<string | undefined>
  /** Absolute SKILL.md paths from every ENABLED plugin, already contained to their roots. */
  readonly skillFiles: () => Effect.Effect<string[]>
  readonly problems: () => Effect.Effect<Problem[]>
  readonly refresh: () => Effect.Effect<void>
}

interface State {
  loaded: Entry[]
  /** MCP server name -> owning plugin name (ENABLED plugins only). */
  owners: Map<string, string>
  servers: Record<string, ConfigMCPV1.Info>
  problems: Problem[]
}

export class Service extends Context.Service<Service, Interface>()("@origami/AgentPlugins") {}

const discover = Effect.fnUntraced(function* (
  entries: readonly AgentPluginEntry.Normalized[],
  fsys: FSUtil.Interface,
  home: string,
  dataRoot: string,
  directory: string,
) {
  const state: State = { loaded: [], owners: new Map(), servers: {}, problems: [] }

  for (const entry of entries) {
    const spec = entry.spec
    const resolved = yield* AgentPluginLoader.resolve({ spec }, fsys, home, directory)
    if (!resolved.ok) {
      yield* Effect.logWarning("agent plugin skipped", { spec, reason: resolved.value.message })
      state.problems.push({ spec, message: resolved.value.message })
      continue
    }

    const loaded = yield* AgentPluginLoader.load(resolved.value, fsys, dataRoot)
    if (!loaded.ok) {
      yield* Effect.logWarning("agent plugin skipped", { spec, reason: loaded.value.message })
      state.problems.push({ spec, message: loaded.value.message })
      continue
    }

    const plugin = loaded.value
    if (state.loaded.some((item) => item.name === plugin.name)) {
      const message = `duplicate plugin name "${plugin.name}"`
      yield* Effect.logWarning("agent plugin skipped", { spec, reason: message })
      state.problems.push({ spec, message })
      continue
    }

    if (!entry.enabled) {
      // Disabled: resolved and parsed so the Plugins pane can still show its
      // name/version/skills/mcp, but nothing here reaches a live session —
      // `plugin.mcp` is what loader.load() DECLARED, never deduped against
      // `state.owners`, because a disabled plugin never competes for a server
      // name it will not actually register.
      state.loaded.push({ ...plugin, enabled: false })
      yield* Effect.logInfo("agent plugin disabled", { name: plugin.name, root: plugin.root })
      continue
    }

    const registered: Record<string, ConfigMCPV1.Info> = {}
    for (const [server, info] of Object.entries(plugin.mcp)) {
      if (state.owners.has(server)) {
        // First writer wins, and the user's own `mcp` config is merged AFTER
        // this map in MCP.state, so a plugin can never take over a server name
        // the user configured themselves. Silent shadowing is the failure mode
        // worth spending a warning on: the tools keep their names and only the
        // process behind them changes.
        plugin.warnings.push(`MCP server "${server}" is already provided by "${state.owners.get(server)}"; skipped`)
        continue
      }
      state.owners.set(server, plugin.name)
      state.servers[server] = info
      registered[server] = info
    }

    // Store what was REGISTERED, not what was declared. `agent-plugin list` and
    // the log line below both read this, and listing a server that lost a name
    // collision would name a process that is not running.
    state.loaded.push({ ...plugin, mcp: registered, enabled: true })
    yield* Effect.logInfo("agent plugin loaded", {
      name: plugin.name,
      mode: plugin.mode,
      root: plugin.root,
      mcp: Object.keys(registered).length,
      skills: plugin.skillFiles.length,
      warnings: plugin.warnings.length,
    })
    for (const warning of plugin.warnings) {
      yield* Effect.logWarning("agent plugin warning", { name: plugin.name, warning })
    }
  }

  return state
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const dataRoot = path.join(global.data, "agent-plugins")

    const state = yield* InstanceState.make(
      Effect.fn("AgentPlugins.state")(function* (ctx) {
        const cfg = yield* config.get()
        const entries = AgentPluginEntry.normalizeAll(cfg.agentPlugins)
        if (entries.length === 0) {
          return { loaded: [], owners: new Map(), servers: {}, problems: [] } satisfies State
        }
        return yield* discover(entries, fsys, global.home, dataRoot, ctx.directory)
      }),
    )

    const all = Effect.fn("AgentPlugins.all")(function* () {
      return (yield* InstanceState.get(state)).loaded
    })

    const mcpServers = Effect.fn("AgentPlugins.mcpServers")(function* () {
      return (yield* InstanceState.get(state)).servers
    })

    const owner = Effect.fn("AgentPlugins.owner")(function* (server: string) {
      return (yield* InstanceState.get(state)).owners.get(server)
    })

    const skillFiles = Effect.fn("AgentPlugins.skillFiles")(function* () {
      return (yield* InstanceState.get(state))
        .loaded.filter((item) => item.enabled)
        .flatMap((item) => item.skillFiles)
    })

    const problems = Effect.fn("AgentPlugins.problems")(function* () {
      return (yield* InstanceState.get(state)).problems
    })

    const refresh = Effect.fn("AgentPlugins.refresh")(function* () {
      yield* InstanceState.invalidate(state)
    })

    return Service.of({ all, mcpServers, owner, skillFiles, problems, refresh })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, FSUtil.node, Global.node],
})

export * as AgentPlugins from "."
