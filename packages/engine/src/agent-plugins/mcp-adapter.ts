export * as AgentPluginMcp from "./mcp-adapter"

import type { ConfigMCPV1 } from "@origami/core/v1/config/mcp"
import { isRecord } from "@/util/record"
import { AgentPluginPath } from "./containment"

/**
 * agent-plugins.org 1.0.0 mcp.json -> this fork's `ConfigMCPV1.Info`.
 *
 * Two shapes arrive here and both are handled the same way after this comment:
 * a standalone `mcp.json` (`{ "$schema": ..., "mcpServers": {...} }`) and the
 * `mcpServers` object embedded in a Claude-format manifest. They differ only in
 * where the record was read from, so `adapt` takes the record.
 */

export interface Context {
  /** Plugin name — used only for messages and for the reserved-name warning. */
  readonly name: string
  readonly root: string
  readonly data: string
}

export interface Adapted {
  readonly servers: Record<string, ConfigMCPV1.Info>
  readonly warnings: string[]
}

/** Pull `mcpServers` out of a parsed mcp.json. Returns undefined if it is not there. */
export function serversOf(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined
  const servers = raw["mcpServers"]
  return isRecord(servers) ? servers : undefined
}

/**
 * Split a `command` string that carries its own arguments.
 *
 * Only reached when `args` is absent: the standard's stdio server keeps them
 * apart, but Claude-format manifests in the wild write `"command": "npx -y foo"`.
 * Quote-aware because the alternative breaks every Windows install — splitting
 * `"C:\Program Files\node\node.exe" --x` on whitespace produces a command nobody
 * can spawn.
 */
export function tokenize(command: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let started = false
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) out.push(current)
      current = ""
      started = false
      continue
    }
    current += char
    started = true
  }
  if (started) out.push(current)
  return out
}

/** Read a `Record<string, string>`, dropping and reporting non-string values. */
function stringMap(value: unknown, label: string, warnings: string[]): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    warnings.push(`ignored "${label}": expected an object of strings`)
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item
    else warnings.push(`ignored "${label}.${key}": expected a string`)
  }
  return out
}

/**
 * Which transport a server declares.
 *
 * `type` is required by the standard and absent from every Claude-format server
 * we have seen, so it is inferred from the field that IS present. The inference
 * is only ever run on a server that omitted `type`; a declared type is never
 * second-guessed, including a declared type this fork does not know, which is
 * refused rather than guessed at.
 */
function transportOf(server: Record<string, unknown>, warnings: string[], key: string) {
  const declared = server["type"]
  if (typeof declared === "string") {
    if (declared === "stdio" || declared === "streamable-http" || declared === "sse") return declared
    warnings.push(`skipped server "${key}": unknown transport type ${JSON.stringify(declared)}`)
    return undefined
  }
  if (declared !== undefined) {
    warnings.push(`skipped server "${key}": "type" must be a string`)
    return undefined
  }
  const hasCommand = typeof server["command"] === "string"
  const hasUrl = typeof server["url"] === "string"
  if (hasCommand && hasUrl) {
    warnings.push(`skipped server "${key}": no "type" and both "command" and "url" are set, so it is ambiguous`)
    return undefined
  }
  if (hasCommand) return "stdio" as const
  if (hasUrl) return "streamable-http" as const
  warnings.push(`skipped server "${key}": no "type", and neither "command" nor "url" is set`)
  return undefined
}

function local(
  key: string,
  server: Record<string, unknown>,
  ctx: Context,
  warnings: string[],
): ConfigMCPV1.Info | undefined {
  const roots = { root: ctx.root, data: ctx.data }
  const raw = server["command"]
  if (typeof raw !== "string" || raw.trim() === "") {
    warnings.push(`skipped server "${key}": stdio server has no "command"`)
    return undefined
  }

  const argv = server["args"]
  let command: string[]
  if (argv === undefined) {
    command = tokenize(raw)
  } else if (Array.isArray(argv) && argv.every((item) => typeof item === "string")) {
    // `args` present means the author already did the splitting. Re-splitting
    // `command` here would corrupt any executable path containing a space.
    command = [raw, ...(argv as string[]).map((item) => AgentPluginPath.expand(item, roots))]
  } else {
    warnings.push(`skipped server "${key}": "args" must be an array of strings`)
    return undefined
  }
  if (command.length === 0) {
    warnings.push(`skipped server "${key}": "command" is empty`)
    return undefined
  }

  // A `./`-prefixed command is a file the package ships, so §4.1 applies to it.
  // A bare token is an executable looked up on PATH and is not the plugin's file.
  const head = command[0]!
  if (head.startsWith("./") || head.startsWith(".\\")) {
    const resolved = AgentPluginPath.resolveInside(head, roots)
    if (!resolved) {
      warnings.push(`skipped server "${key}": command ${JSON.stringify(head)} resolves outside the plugin root`)
      return undefined
    }
    command[0] = resolved
  }

  const declaredEnv = stringMap(server["env"], "env", warnings) ?? {}
  for (const reserved of ["PLUGIN_ROOT", "PLUGIN_DATA"]) {
    if (reserved in declaredEnv) {
      // The mcp schema forbids these names outright. Dropping the plugin's value
      // rather than the server keeps a working plugin working, but a plugin that
      // thinks it can relocate its own root should hear about it.
      warnings.push(`server "${key}" set reserved env "${reserved}"; the client value is used instead`)
      delete declaredEnv[reserved]
    }
  }

  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(declaredEnv)) environment[name] = AgentPluginPath.expand(value, roots)
  environment["PLUGIN_ROOT"] = ctx.root
  environment["PLUGIN_DATA"] = ctx.data

  const info: ConfigMCPV1.Info = { type: "local", command, environment }

  const cwd = server["cwd"]
  if (typeof cwd === "string") {
    const resolved = AgentPluginPath.resolveInside(cwd, roots)
    if (!resolved) {
      warnings.push(`skipped server "${key}": cwd ${JSON.stringify(cwd)} resolves outside the plugin root`)
      return undefined
    }
    return { ...info, cwd: resolved }
  }
  if (cwd !== undefined) warnings.push(`ignored "cwd" for server "${key}": expected a string`)
  return info
}

function remote(
  key: string,
  server: Record<string, unknown>,
  warnings: string[],
  transport: "streamable-http" | "sse",
): ConfigMCPV1.Info | undefined {
  const url = server["url"]
  if (typeof url !== "string" || url.trim() === "") {
    warnings.push(`skipped server "${key}": ${transport} server has no "url"`)
    return undefined
  }
  // `ConfigMCPV1.Remote` has one remote kind, and `MCP.connectRemote` tries
  // StreamableHTTP first and falls back to SSE on the same url, so collapsing the
  // two transports onto `type: "remote"` costs an extra failed handshake for an
  // SSE-only server and nothing else. Encoding the distinction would mean a new
  // field on the shared v1 config schema for no behaviour.
  const headers = stringMap(server["headers"], "headers", warnings)
  return { type: "remote", url, ...(headers && Object.keys(headers).length > 0 ? { headers } : {}) }
}

/** Adapt one `mcpServers` record. Bad servers are skipped with a warning; good ones still load. */
export function adapt(raw: unknown, ctx: Context): Adapted {
  const warnings: string[] = []
  const servers: Record<string, ConfigMCPV1.Info> = {}
  if (!isRecord(raw)) {
    warnings.push(`ignored "mcpServers": expected an object`)
    return { servers, warnings }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      warnings.push(`skipped server "${key}": not an object`)
      continue
    }
    const transport = transportOf(value, warnings, key)
    if (!transport) continue
    const info =
      transport === "stdio" ? local(key, value, ctx, warnings) : remote(key, value, warnings, transport)
    if (info) servers[key] = info
  }

  return { servers, warnings }
}
