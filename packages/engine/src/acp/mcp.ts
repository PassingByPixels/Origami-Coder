import { Effect, Schema } from "effect"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { AgentPlugins } from "@/agent-plugins"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { McpConfigWrite } from "@/mcp/config-write"
import { ConfigMCPV1 } from "@origami/core/v1/config/mcp"
import { Global } from "@origami/core/global"
import { errorMessage } from "@/util/error"

/**
 * The MCP management pane's read (`mcp_list`) and its writes (`mcp_add`,
 * `mcp_remove`, `mcp_set_enabled`, `mcp_connect`, `mcp_disconnect`,
 * `mcp_authenticate`, `mcp_auth_remove`) — the ACP channel for what
 * `cli/cmd/mcp.ts` and the instance HTTP API already do. The extension talks
 * ACP over stdio and has no HTTP route to the engine, so those surfaces were
 * unreachable from it.
 *
 * THE MERGE RULE THIS PANE EXISTS TO MAKE VISIBLE (`mcp/index.ts`'s state
 * builder): the runtime server map is `{ ...pluginServers, ...cfg.mcp }`, so a
 * user's own `mcp` entry SHADOWS a plugin server of the same name. Without the
 * source and the shadow marker on every row, "I disabled it and it is still
 * running" cannot be explained from the UI.
 *
 * A `mcp` value with NO `type` is legal config (core `config.ts` allows
 * `{ enabled: boolean }`): it is the marker that turns off a plugin-provided
 * server. `mcp/index.ts` skips those, so they carry no live status — they are
 * reported here with `type: "unknown"` rather than dropped, because a row the
 * user cannot see is a row they cannot undo.
 */

export type ServerType = "local" | "remote" | "unknown"
export type Source = "config" | "plugin"

export type ServerEntry = {
  readonly name: string
  /** Where the definition the engine uses came from. */
  readonly source: Source
  /** A config entry of this name overrides a plugin server of the same name. */
  readonly shadowed: boolean
  /** `unknown` = a bare `{ enabled }` marker, which carries no server definition. */
  readonly type: ServerType
  readonly enabled: boolean
  readonly url?: string
  readonly command?: readonly string[]
  readonly status: MCP.Status
  /** Remote, with OAuth not explicitly off — whether Authenticate applies at all. */
  readonly supportsOAuth: boolean
  /** Credential state. Remote servers only, and never a token. */
  readonly auth?: MCP.AuthStatus
}

export type ListResult = { readonly servers: readonly ServerEntry[] }

export type WriteResult =
  | { readonly ok: true; readonly path?: string; readonly status?: MCP.Status }
  | { readonly ok: false; readonly message: string }

type Entry = McpConfigWrite.Entry

/**
 * The pure projection: the `mcp` config record, the plugin-provided servers and
 * the live status map, into one row per name. Pure, so the merge/shadow rules
 * above are testable without booting an engine instance — the same split
 * `ACPAgentPlugins.project` uses.
 */
export function project(
  cfg: Record<string, Entry>,
  pluginServers: Record<string, ConfigMCPV1.Info>,
  status: Record<string, MCP.Status>,
): readonly ServerEntry[] {
  const names = [...new Set([...Object.keys(pluginServers), ...Object.keys(cfg)])].toSorted((a, b) =>
    a.localeCompare(b),
  )
  return names.map((name) => {
    const configured = cfg[name]
    const plugin = pluginServers[name]
    // The SAME precedence mcp/index.ts applies: a cfg entry wins over a plugin's.
    const effective: Entry | undefined = configured ?? plugin
    const full = McpConfigWrite.isConfigured(effective) ? effective : undefined
    const remote = full?.type === "remote" ? full : undefined
    const local = full?.type === "local" ? full : undefined
    return {
      name,
      source: configured !== undefined ? ("config" as const) : ("plugin" as const),
      shadowed: configured !== undefined && plugin !== undefined,
      type: full ? full.type : ("unknown" as const),
      enabled: effective?.enabled !== false,
      ...(remote ? { url: remote.url } : {}),
      ...(local ? { command: local.command } : {}),
      status: status[name] ?? { status: "disabled" as const },
      supportsOAuth: !!remote && remote.oauth !== false,
    }
  })
}

/**
 * Runs against the process-wide AppRuntime for the reason `ACPAgentPlugins.list`
 * states: a private layer stack here would stand up a SECOND instance and
 * deadlock against the live one.
 */
const inInstance = <A, E, R>(directory: string, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const ctx = yield* store.load({ directory })
    return yield* body.pipe(Effect.provideService(InstanceRef, ctx))
  })

export const list = Effect.fn("ACPMcp.list")(function* (directory: string) {
  return yield* inInstance(
    directory,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const plugins = yield* AgentPlugins.Service
      const mcp = yield* MCP.Service

      const cfg = yield* config.get()
      const pluginServers = yield* plugins.mcpServers()
      const status = yield* mcp.status()

      const rows = project(cfg.mcp ?? {}, pluginServers, status)
      // Credential state is a per-name read, and only a remote server has one.
      const servers = yield* Effect.forEach(rows, (row) =>
        row.type === "remote"
          ? mcp.getAuthStatus(row.name).pipe(Effect.map((auth): ServerEntry => ({ ...row, auth })))
          : Effect.succeed(row),
      )
      return { servers } satisfies ListResult
    }),
  )
})

/** Every write answers the pane the same way: never throws, always a message. */
const asWrite = <E, R>(body: Effect.Effect<WriteResult, E, R>) =>
  body.pipe(Effect.catch((e) => Effect.succeed({ ok: false, message: errorMessage(e) } satisfies WriteResult)))

const promise = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({ try: fn, catch: (e) => new Error(errorMessage(e)) })

/** The live status of one server, read from the same map `list` reads. */
const statusOf = (directory: string, name: string) =>
  inInstance(
    directory,
    MCP.Service.use((mcp) => mcp.status()),
  ).pipe(Effect.map((all) => all[name]))

/**
 * Add a server: validate the shape against the SAME schema the config file is
 * read with, PERSIST it, then `MCP.add` it so it connects without a session
 * restart. Both halves matter — `MCP.add` is in-memory only (mcp/index.ts), so
 * a runtime-only add vanishes on the next restart, and a config-only add looks
 * inert until one.
 */
export const add = Effect.fn("ACPMcp.add")(function* (
  directory: string,
  name: string,
  server: unknown,
  scope: "project" | "global",
) {
  return yield* asWrite(
    Effect.gen(function* () {
      const trimmed = name.trim()
      if (!trimmed) return { ok: false, message: "A server name is required" } satisfies WriteResult

      const decoded = yield* Schema.decodeUnknownEffect(ConfigMCPV1.Info)(server).pipe(
        Effect.mapError((e) => new Error(`"${trimmed}" is not a valid MCP server: ${errorMessage(e)}`)),
      )

      const existing = yield* promise(() => McpConfigWrite.locate(directory, trimmed))
      if (existing) {
        return { ok: false, message: `"${trimmed}" is already configured (${existing.path})` } satisfies WriteResult
      }

      const base = scope === "global" ? Global.Path.config : directory
      const target = yield* promise(() => McpConfigWrite.resolveConfigPath(base, scope === "global"))
      yield* promise(() => McpConfigWrite.addServer(target, trimmed, decoded))

      // Connect NOW, then report the status map's own answer rather than
      // `add`'s union return, so a row's state comes from one source only.
      yield* inInstance(
        directory,
        MCP.Service.use((mcp) => mcp.add(trimmed, decoded)),
      )
      const status = yield* statusOf(directory, trimmed)
      return { ok: true, path: target, ...(status ? { status } : {}) } satisfies WriteResult
    }),
  )
})

/** Delete one `mcp.<name>` entry and drop its live connection. */
export const remove = Effect.fn("ACPMcp.remove")(function* (directory: string, name: string) {
  return yield* asWrite(
    Effect.gen(function* () {
      const written = yield* promise(() => McpConfigWrite.remove(directory, name))
      // Best-effort: the entry is already gone from disk, and a server that was
      // never connected has nothing to close.
      yield* inInstance(
        directory,
        MCP.Service.use((mcp) => mcp.disconnect(name)),
      ).pipe(Effect.ignore)
      return { ok: true, path: written.path } satisfies WriteResult
    }),
  )
})

/** Flip one server on or off, in config AND at runtime. */
export const setEnabled = Effect.fn("ACPMcp.setEnabled")(function* (
  directory: string,
  name: string,
  enabled: boolean,
) {
  return yield* asWrite(
    Effect.gen(function* () {
      const written = yield* promise(() => McpConfigWrite.setEnabled(directory, name, enabled))
      // Runtime is best-effort and REPORTED: the config write is what persists,
      // but a toggle that did not take effect must not read as if it had.
      const status = yield* inInstance(
        directory,
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          yield* enabled ? mcp.connect(name) : mcp.disconnect(name)
          return (yield* mcp.status())[name]
        }),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
      return { ok: true, path: written.path, ...(status ? { status } : {}) } satisfies WriteResult
    }),
  )
})

export const connect = Effect.fn("ACPMcp.connect")(function* (directory: string, name: string) {
  return yield* asWrite(
    Effect.gen(function* () {
      const status = yield* inInstance(
        directory,
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          yield* mcp.connect(name)
          return (yield* mcp.status())[name]
        }),
      )
      return { ok: true, ...(status ? { status } : {}) } satisfies WriteResult
    }),
  )
})

export const disconnect = Effect.fn("ACPMcp.disconnect")(function* (directory: string, name: string) {
  return yield* asWrite(
    Effect.gen(function* () {
      const status = yield* inInstance(
        directory,
        Effect.gen(function* () {
          const mcp = yield* MCP.Service
          yield* mcp.disconnect(name)
          return (yield* mcp.status())[name]
        }),
      )
      return { ok: true, ...(status ? { status } : {}) } satisfies WriteResult
    }),
  )
})

/**
 * Run the OAuth flow. BLOCKS until the loopback callback arrives — safe for the
 * same reason `ACPProviderAuth.callback` is: the ACP SDK's read loop calls
 * `processMessage` WITHOUT awaiting it, so a slow handler does not stall the
 * channel.
 *
 * The engine opens the browser itself (`McpBrowser`), but `onAuthorization`
 * fires with the URL FIRST, and `onUrl` forwards it. Without that, a failed
 * `open` leaves the pane waiting on a window that never appeared, with no link
 * to fall back to.
 */
export const authenticate = Effect.fn("ACPMcp.authenticate")(function* (
  directory: string,
  name: string,
  onUrl?: (url: string) => void,
) {
  return yield* asWrite(
    Effect.gen(function* () {
      const status = yield* inInstance(
        directory,
        MCP.Service.use((mcp) => mcp.authenticate(name, onUrl)),
      )
      return { ok: true, status } satisfies WriteResult
    }),
  )
})

/** Forget the stored credential. Reports only that it is gone, never a token. */
export const authRemove = Effect.fn("ACPMcp.authRemove")(function* (directory: string, name: string) {
  return yield* asWrite(
    Effect.gen(function* () {
      yield* inInstance(
        directory,
        MCP.Service.use((mcp) => mcp.removeAuth(name)),
      )
      return { ok: true } satisfies WriteResult
    }),
  )
})

export * as ACPMcp from "./mcp"
