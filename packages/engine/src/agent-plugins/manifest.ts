export * as AgentPluginManifest from "./manifest"

import { Cause, Exit, Schema, SchemaIssue } from "effect"
import { isRecord } from "@/util/record"

/**
 * Canonical schema ids from agent-plugins.org 1.0.0. `plugin.schema.json` is a
 * CLOSED object (`additionalProperties: false`) whose `required` list is
 * `["$schema", "name"]` — both facts are load-bearing below.
 */
export const MANIFEST_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

/**
 * Where a manifest is looked for, in probe order.
 *
 * `.claude-plugin/plugin.json` is not in the standard. It is here because it is
 * where the plugins we were told to load actually keep their manifest — see the
 * LENIENT MODE note below.
 */
export const MANIFEST_LOCATIONS = ["plugin.json", ".claude-plugin/plugin.json"] as const

/* ------------------------------------------------------------------------- *
 * LENIENT MODE — the decision, and why
 *
 * The 1.0.0 manifest schema is closed and requires `$schema`. Every plugin in
 * QwenLM/Qwen-MM-Plugins — the plugins this feature exists to run — fails it on
 * BOTH counts. Their real `.claude-plugin/plugin.json` (fetched 2026-08-11,
 * src/capabilities/blender) is:
 *
 *   { "name": "qwen-mm-plugins-blender", "version": "1.0.0", "description": "...",
 *     "skills": ["./skill"],
 *     "mcpServers": { "qwen-mm-plugins-blender": { "command": "uvx", "args": [...],
 *                                                  "env": { "QWEN_MM_AUTOLAUNCH": "1" } } } }
 *
 * No `$schema`; `skills` and `mcpServers` are keys the closed schema forbids;
 * the embedded server has no `type`. A strict-only parser loads nothing that
 * exists today.
 *
 * DECISION: two modes, one parser, and the mode is DERIVED, never configured.
 *
 *   - `$schema` present  -> STRICT. The manifest claims 1.0.0 conformance, so it
 *     is held to it: the id must match exactly, unknown keys are an error, and
 *     skills come from the `skills/` layout rather than any declaration.
 *   - `$schema` absent   -> LENIENT. Treated as a Claude-Code-format manifest:
 *     unknown keys are tolerated, and `skills` / `mcpServers` / `mcp` are read as
 *     the extension fields they are, normalised into the same shape strict mode
 *     produces. Every tolerated key is reported as a warning, so a typo in a
 *     lenient manifest is still visible instead of silent.
 *
 * Deriving the mode is what keeps this honest. A config flag would let a real
 * 1.0.0 manifest be loaded with its guarantees switched off; here a manifest that
 * asserts conformance can never be graded on a curve, and one that asserts
 * nothing is not failed for a promise it never made.
 *
 * `name` is validated in BOTH modes, deliberately. It is not only metadata: it
 * becomes the permission target `plugin:<name>:*`, so a name carrying `*` or `:`
 * would forge rule scope. The spec's own pattern already excludes both.
 * ------------------------------------------------------------------------- */

/** 1-64 chars, per the published `name` pattern plus its `maxLength`. */
const PluginName = Schema.String.check(
  Schema.isPattern(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  Schema.isPattern(/^.{1,64}$/s),
).annotate({ description: "Plugin name: lowercase alphanumerics, hyphens and periods, 1-64 characters" })

const Author = Schema.Struct({
  name: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
}).annotate({ identifier: "AgentPluginAuthor" })

/**
 * The 1.0.0 manifest. `$schema` is `optional` HERE and required by `parse` in
 * strict mode only — one Struct then serves both modes, and its absence is the
 * signal that selects the mode rather than a validation failure.
 */
export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({ description: "Canonical agent-plugins.org manifest schema id" }),
  name: PluginName,
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  author: Schema.optional(Author),
  homepage: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String),
  license: Schema.optional(Schema.String),
  keywords: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  extensions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "AgentPluginManifest" })
export type Info = Schema.Schema.Type<typeof Info>

/** Every key the closed 1.0.0 schema permits. Anything else is an unknown key. */
const KNOWN_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
])

/** Claude/Codex/Qoder manifest keys lenient mode understands rather than merely tolerates. */
const LENIENT_KEYS = new Set(["skills", "mcpServers", "mcp"])

export type Mode = "strict" | "lenient"

/**
 * A manifest reduced to what the loader consumes, with the format differences
 * already resolved. Both modes produce this; nothing downstream branches on mode.
 */
export interface Normalized {
  readonly name: string
  readonly version?: string
  readonly description?: string
  /**
   * Plugin-relative skill directories DECLARED by a lenient manifest's `skills`
   * field. Always empty in strict mode, where skills are found by layout
   * (`skills/`) and not by declaration — the standard has no `skills` key.
   */
  readonly skillPaths: readonly string[]
  /** An inline `mcpServers` record (Claude format). */
  readonly inlineMcpServers?: Record<string, unknown>
  /** A plugin-relative path to an mcp.json, from `mcpServers: "./x.json"` or `mcp: "x.json"`. */
  readonly mcpPath?: string
}

export type Result =
  | { readonly ok: true; readonly mode: Mode; readonly manifest: Normalized; readonly warnings: string[] }
  | { readonly ok: false; readonly issues: string[] }

function decodeIssues(error: unknown): string[] {
  if (Schema.isSchemaError(error)) {
    return SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => {
      const at = issue.path?.length ? `${issue.path.map(String).join(".")}: ` : ""
      return `${at}${issue.message}`
    })
  }
  return [String(error)]
}

/**
 * Read a `skills` declaration. Codex-format manifests write a bare string where
 * Claude-format writes an array; both mean the same thing, so both are accepted
 * rather than making the caller care which client wrote the file.
 */
function skillPaths(value: unknown, warnings: string[]): string[] {
  if (value === undefined) return []
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const item of value) {
      if (typeof item === "string") out.push(item)
      else warnings.push(`ignored non-string entry in "skills": ${JSON.stringify(item)}`)
    }
    return out
  }
  warnings.push(`ignored "skills": expected a string or an array of strings`)
  return []
}

/** Parse a manifest object. `raw` is the already-decoded JSON, not text. */
export function parse(raw: unknown): Result {
  if (!isRecord(raw)) return { ok: false, issues: ["manifest is not a JSON object"] }

  const declared = raw["$schema"]
  const mode: Mode = declared === undefined ? "lenient" : "strict"
  const issues: string[] = []
  const warnings: string[] = []

  if (mode === "strict" && declared !== MANIFEST_SCHEMA) {
    issues.push(`"$schema" must be "${MANIFEST_SCHEMA}", got ${JSON.stringify(declared)}`)
  }

  const extra = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key))
  if (mode === "strict" && extra.length > 0) {
    // The closed schema. A strict manifest carrying `mcpServers` is not a
    // 1.0.0 manifest with a bonus field, it is a Claude manifest wearing a
    // `$schema` it does not satisfy — and quietly honouring the field would
    // make the strict mode worth nothing.
    issues.push(`unrecognized key${extra.length === 1 ? "" : "s"} for a 1.0.0 manifest: ${extra.join(", ")}`)
  }

  const decoded = Schema.decodeUnknownExit(Info)(raw, { errors: "all", propertyOrder: "original" })
  if (Exit.isFailure(decoded)) {
    issues.push(...decodeIssues(Cause.squash(decoded.cause)))
    return { ok: false, issues }
  }
  if (issues.length > 0) return { ok: false, issues }

  const info = decoded.value
  if (mode === "strict") {
    return {
      ok: true,
      mode,
      warnings,
      manifest: { name: info.name, version: info.version, description: info.description, skillPaths: [] },
    }
  }

  for (const key of extra) {
    if (LENIENT_KEYS.has(key)) continue
    warnings.push(`ignored unrecognized manifest key "${key}"`)
  }

  const servers = raw["mcpServers"]
  const mcp = raw["mcp"]
  let inlineMcpServers: Record<string, unknown> | undefined
  let mcpPath: string | undefined

  if (isRecord(servers)) inlineMcpServers = servers
  else if (typeof servers === "string") mcpPath = servers
  else if (servers !== undefined) warnings.push(`ignored "mcpServers": expected an object or a path string`)

  if (mcpPath === undefined && typeof mcp === "string") mcpPath = mcp
  else if (mcpPath !== undefined && typeof mcp === "string" && mcp !== mcpPath) {
    warnings.push(`ignored "mcp": "mcpServers" already names ${mcpPath}`)
  }

  return {
    ok: true,
    mode,
    warnings,
    manifest: {
      name: info.name,
      version: info.version,
      description: info.description,
      skillPaths: skillPaths(raw["skills"], warnings),
      ...(inlineMcpServers ? { inlineMcpServers } : {}),
      ...(mcpPath ? { mcpPath } : {}),
    },
  }
}
