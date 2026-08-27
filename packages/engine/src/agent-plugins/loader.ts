export * as AgentPluginLoader from "./loader"

import path from "path"
import { Effect } from "effect"
import type { ConfigMCPV1 } from "@origami/core/v1/config/mcp"
import { FSUtil } from "@origami/core/fs-util"
import { Glob } from "@origami/core/util/glob"
import { AgentPluginManifest } from "./manifest"
import { AgentPluginMcp } from "./mcp-adapter"
import { AgentPluginPath } from "./containment"

/**
 * The Plan -> Resolved -> Loaded staging from `plugin/loader.ts`, applied to
 * agent-plugins.org packages.
 *
 * Same reason as there: each stage can fail for its own reason, and a plugin
 * that was skipped should be able to say WHICH stage skipped it — "no manifest
 * at <dir>" and "manifest at <file> is not valid 1.0.0" are different problems
 * for the user and must not collapse into "plugin failed".
 */

/** A plugin as configured, before any filesystem work. */
export interface Plan {
  /** The `agentPlugins` entry verbatim: a directory path, possibly `~/`-relative. */
  readonly spec: string
}

/** A plugin whose root and manifest file exist on disk and parsed as JSON. */
export interface Resolved extends Plan {
  readonly root: string
  readonly manifestPath: string
  readonly raw: unknown
}

/** A resolved plugin whose manifest validated and whose components have been collected. */
export interface Loaded extends Resolved {
  readonly name: string
  readonly mode: AgentPluginManifest.Mode
  readonly manifest: AgentPluginManifest.Normalized
  readonly dataDir: string
  readonly mcp: Record<string, ConfigMCPV1.Info>
  /** Absolute SKILL.md paths, already filtered through §4.1. */
  readonly skillFiles: string[]
  readonly warnings: string[]
}

export interface Failure extends Plan {
  readonly root?: string
  readonly message: string
}

const SKILL_PATTERN = "**/SKILL.md"

/** Expand `~/`, then resolve a relative spec against the instance directory. */
export function absolute(spec: string, home: string, directory: string): string {
  const expanded = spec.startsWith("~/") || spec.startsWith("~\\") ? path.join(home, spec.slice(2)) : spec
  return path.resolve(directory, expanded)
}

export const resolve = Effect.fnUntraced(function* (plan: Plan, fsys: FSUtil.Interface, home: string, directory: string) {
  const root = AgentPluginPath.real(absolute(plan.spec, home, directory))
  if (!(yield* fsys.isDir(root))) {
    return { ok: false as const, value: { ...plan, message: `plugin directory not found: ${root}` } }
  }

  for (const location of AgentPluginManifest.MANIFEST_LOCATIONS) {
    const manifestPath = path.join(root, location)
    if (!(yield* fsys.isFile(manifestPath))) continue
    const raw = yield* fsys.readJson(manifestPath).pipe(Effect.catch((error) => Effect.succeed(error)))
    if (raw instanceof Error) {
      return { ok: false as const, value: { ...plan, root, message: `${manifestPath}: ${raw.message}` } }
    }
    return { ok: true as const, value: { ...plan, root, manifestPath, raw } }
  }

  return {
    ok: false as const,
    value: {
      ...plan,
      root,
      message: `no manifest at ${root} (looked for ${AgentPluginManifest.MANIFEST_LOCATIONS.join(", ")})`,
    },
  }
})

/**
 * Collect the SKILL.md files a plugin ships.
 *
 * Two layouts, because the two formats disagree about where skills live. A 1.0.0
 * package puts them under `skills/` and says nothing in the manifest; a
 * Claude-format one names its directories in `skills` and the real ones are not
 * called `skills/` at all (the Qwen plugins use `skill/`). Declared paths win
 * when present, and the standard layout is scanned when they are not.
 *
 * Every hit is re-checked against the root AFTER globbing. `Glob.scan` follows
 * symlinks, so a `skills/x -> /etc` link would otherwise hand the model file
 * contents from outside the package under the plugin's name.
 */
const skills = Effect.fnUntraced(function* (root: string, declared: readonly string[], warnings: string[]) {
  const roots: string[] = []
  if (declared.length > 0) {
    for (const item of declared) {
      const dir = AgentPluginPath.resolveInPackage(item, root)
      if (!dir) {
        warnings.push(`ignored skill path ${JSON.stringify(item)}: it resolves outside the plugin root`)
        continue
      }
      roots.push(dir)
    }
  } else {
    roots.push(path.join(root, "skills"))
  }

  const found: string[] = []
  for (const dir of roots) {
    const matches = yield* Effect.tryPromise({
      try: () => Glob.scan(SKILL_PATTERN, { cwd: dir, absolute: true, include: "file", symlink: true }),
      catch: (error) => error,
    }).pipe(Effect.catch(() => Effect.succeed([] as string[])))
    for (const match of matches) found.push(match)
  }

  const contained = AgentPluginPath.containedIn(root, found)
  if (contained.length !== found.length) {
    warnings.push(`skipped ${found.length - contained.length} skill file(s) that resolve outside the plugin root`)
  }
  return contained
})

export const load = Effect.fnUntraced(function* (row: Resolved, fsys: FSUtil.Interface, dataRoot: string) {
  const parsed = AgentPluginManifest.parse(row.raw)
  if (!parsed.ok) {
    // §4.1's failure boundary: an invalid manifest rejects the WHOLE plugin,
    // unlike a bad component which only costs that component.
    return { ok: false as const, value: { ...row, message: `${row.manifestPath}: ${parsed.issues.join("; ")}` } }
  }

  const warnings = [...parsed.warnings]
  const name = parsed.manifest.name
  const dataDir = path.join(dataRoot, name)
  // The standard requires the data directory to exist and be writeable BEFORE a
  // server subprocess starts, so it is created here rather than lazily.
  yield* fsys.ensureDir(dataDir).pipe(Effect.catch(() => Effect.void))

  let serverSource: unknown = parsed.manifest.inlineMcpServers
  if (serverSource === undefined) {
    // `mcp.json` is the standard's filename. `.mcp.json` is probed only in
    // lenient mode, because that is the Claude-Code convention the Qwen packages
    // follow and a manifest asserting 1.0.0 should not have a non-standard
    // filename honoured behind its own claim.
    const fallbacks = parsed.mode === "lenient" ? ["mcp.json", ".mcp.json"] : ["mcp.json"]
    const declared = parsed.manifest.mcpPath
      ? AgentPluginPath.resolveInside(parsed.manifest.mcpPath, { root: row.root, data: dataDir })
      : undefined
    if (parsed.manifest.mcpPath && !declared) {
      warnings.push(`ignored ${JSON.stringify(parsed.manifest.mcpPath)}: it resolves outside the plugin root`)
    } else {
      const candidates = declared ? [declared] : fallbacks.map((file) => path.join(row.root, file))
      for (const candidate of candidates) {
        if (!(yield* fsys.isFile(candidate))) continue
        const raw = yield* fsys.readJson(candidate).pipe(Effect.catch((error) => Effect.succeed(error)))
        if (raw instanceof Error) {
          warnings.push(`ignored ${candidate}: ${raw.message}`)
          break
        }
        serverSource = AgentPluginMcp.serversOf(raw)
        if (serverSource === undefined) warnings.push(`ignored ${candidate}: no "mcpServers" object`)
        break
      }
    }
  }

  const adapted =
    serverSource === undefined
      ? { servers: {}, warnings: [] }
      : AgentPluginMcp.adapt(serverSource, { name, root: row.root, data: dataDir })
  warnings.push(...adapted.warnings)

  const skillFiles = yield* skills(row.root, parsed.manifest.skillPaths, warnings)

  return {
    ok: true as const,
    value: {
      ...row,
      name,
      mode: parsed.mode,
      manifest: parsed.manifest,
      dataDir,
      mcp: adapted.servers,
      skillFiles,
      warnings,
    },
  }
})
