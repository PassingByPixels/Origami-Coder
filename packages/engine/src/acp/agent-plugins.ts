import path from "path"
import { Effect } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { AgentPlugins } from "@/agent-plugins"
import { AgentPluginConfigWrite } from "@/agent-plugins/config-write"
import { AgentPluginLoader } from "@/agent-plugins/loader"
import type { AgentPluginManifest } from "@/agent-plugins/manifest"
import { FSUtil } from "@origami/core/fs-util"
import { Global } from "@origami/core/global"
import { MCP } from "@/mcp"
import type * as ACPError from "./error"

/**
 * The Plugins management pane's read (`list_agent_plugins`) and two writes
 * (`agent_plugin_add`, `agent_plugin_set_enabled`).
 *
 * `list` reads `AgentPlugins.Service` (which carries BOTH enabled and disabled
 * plugins, see `agent-plugins/index.ts`) and cross-references each ENABLED plugin's
 * declared MCP servers against `MCP.Service.status()` - the SAME status a running
 * session's MCP connections report, so the pane can never show a state the engine
 * does not believe. A DISABLED plugin's `mcp` is the loader's raw DECLARED map,
 * whose names can collide with an unrelated enabled plugin's own server, so its
 * servers are reported `disabled` unconditionally, never cross-referenced.
 */

export type PluginMcpServer = {
  readonly name: string
  readonly type: "local" | "remote"
  readonly status: MCP.Status
}

export type PluginEntry = {
  readonly name: string
  readonly version?: string
  readonly mode: AgentPluginManifest.Mode
  /** The plugin's resolved root directory on disk. */
  readonly root: string
  /** The `agentPlugins` config entry verbatim — what a write action targets. */
  readonly spec: string
  readonly enabled: boolean
  readonly skillFiles: readonly string[]
  readonly mcp: readonly PluginMcpServer[]
  readonly warnings: readonly string[]
}

export type PluginProblem = {
  readonly spec: string
  readonly message: string
}

export type PluginsResult = {
  readonly plugins: readonly PluginEntry[]
  readonly problems: readonly PluginProblem[]
}

export type WriteResult =
  | { readonly ok: true; readonly path: string; readonly name: string }
  | { readonly ok: false; readonly message: string }

export type SetEnabledResult = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string }

/** The seam the ACP service depends on, so tests need no engine boot. */
export type Interface = {
  readonly list: (directory: string) => Effect.Effect<PluginsResult, ACPError.Error>
  readonly add: (directory: string, dir: string) => Effect.Effect<WriteResult, ACPError.Error>
  readonly setEnabled: (directory: string, spec: string, enabled: boolean) => Effect.Effect<SetEnabledResult, ACPError.Error>
}

export function project(item: AgentPlugins.Entry, status: Record<string, MCP.Status>): PluginEntry {
  return {
    name: item.name,
    ...(item.manifest.version ? { version: item.manifest.version } : {}),
    mode: item.mode,
    root: item.root,
    spec: item.spec,
    enabled: item.enabled,
    skillFiles: item.skillFiles,
    // Only an ENABLED plugin's `mcp` names are ones it actually registered
    // (index.ts dedupes `registered` against `state.owners`); a disabled plugin's
    // raw declared map can share a name with an enabled plugin's own server.
    mcp: Object.entries(item.mcp)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, info]) => ({
        name,
        type: info.type,
        status: item.enabled ? (status[name] ?? { status: "disabled" as const }) : { status: "disabled" as const },
      })),
    warnings: item.warnings,
  }
}

/** Runs against the process-wide AppRuntime, which already provides
 *  `AgentPlugins.Service` and `MCP.Service` - same rationale as `ACPSkills.list`: a
 *  private layer stack here would stand up a second instance and deadlock. */
export const list = Effect.fn("ACPAgentPlugins.list")(function* (directory: string) {
  const store = yield* InstanceStore.Service
  const plugins = yield* AgentPlugins.Service
  const mcp = yield* MCP.Service
  const ctx = yield* store.load({ directory })

  return yield* Effect.gen(function* () {
    const loaded = yield* plugins.all()
    const problems = yield* plugins.problems()
    const status = yield* mcp.status()

    return {
      plugins: loaded.toSorted((a, b) => a.name.localeCompare(b.name)).map((item) => project(item, status)),
      problems: problems.map((p) => ({ spec: p.spec, message: p.message })).toSorted((a, b) => a.spec.localeCompare(b.spec)),
    } satisfies PluginsResult
  }).pipe(Effect.provideService(InstanceRef, ctx))
})

/** Validate a folder as an agent-plugins.org package - resolve it, then run it
 *  through the SAME manifest parser `agent-plugin add` uses - and only then append
 *  it to the project config. A parser failure never reaches the filesystem write,
 *  and its message is returned verbatim so the pane shows what the CLI would. */
export const add = Effect.fn("ACPAgentPlugins.add")(function* (directory: string, dir: string) {
  const fsys = yield* FSUtil.Service
  const resolved = yield* AgentPluginLoader.resolve({ spec: dir }, fsys, Global.Path.home, directory)
  if (!resolved.ok) return { ok: false, message: resolved.value.message } satisfies WriteResult

  const dataRoot = path.join(Global.Path.data, "agent-plugins")
  const loaded = yield* AgentPluginLoader.load(resolved.value, fsys, dataRoot)
  if (!loaded.ok) return { ok: false, message: loaded.value.message } satisfies WriteResult
  const name = loaded.value.name

  return yield* Effect.tryPromise({
    try: async (): Promise<WriteResult> => {
      const written = await AgentPluginConfigWrite.addPlugin(directory, dir)
      return { ok: true, path: written.path, name }
    },
    catch: (e) => (e instanceof Error ? e.message : String(e)),
  }).pipe(Effect.catch((message) => Effect.succeed({ ok: false, message } satisfies WriteResult)))
})

/** Flip one plugin's enabled state in the config file it already lives in. */
export const setEnabled = Effect.fn("ACPAgentPlugins.setEnabled")(function* (
  directory: string,
  spec: string,
  enabled: boolean,
) {
  return yield* Effect.tryPromise({
    try: async (): Promise<SetEnabledResult> => {
      const written = await AgentPluginConfigWrite.setEnabled(directory, spec, enabled)
      return { ok: true, path: written.path }
    },
    catch: (e) => (e instanceof Error ? e.message : String(e)),
  }).pipe(Effect.catch((message) => Effect.succeed({ ok: false, message } satisfies SetEnabledResult)))
})

export * as ACPAgentPlugins from "./agent-plugins"
