import { LayerNode } from "@origami/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@origami/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@origami/core/global"
import { Permission } from "@/permission"
import { FSUtil } from "@origami/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@origami/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@origami/core/util/glob"
import { Discovery } from "./discovery"
import { AgentPlugins } from "@/agent-plugins"
import { isRecord } from "@/util/record"
import { escapeHtml } from "@/util/html"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const ORIGAMI_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

// FORK STRIP: the built-in `customize-origami` skill is gone. Its body told the
// model to fetch the config JSON Schema from a hosted URL this fork
// does not own and has no service behind, so it was a live-fetch instruction to
// a dead domain rather than a usable schema reference.

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /**
   * The skill's own `category:` frontmatter — a FREE-FORM grouping label, never
   * checked against a list. A category this build has never seen is carried
   * through verbatim, so a shell that groups by it can show the author's own
   * word instead of dropping the skill into "other".
   */
  category: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

// `category` is deliberately UNCHECKED here — it is typed `unknown` and narrowed
// where it is read, so a malformed one costs the value and not the whole skill.
// A category is a grouping hint; refusing to load a skill over it would hide the
// skill entirely to punish a label nobody depends on.
function isSkillFrontmatter(data: unknown): data is { name: string; description?: string; category?: unknown } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

/**
 * A SKILL.md that exists on disk but produced no skill. Cheap diagnostic, not a
 * validation framework: without it a mistyped `name:` makes the file vanish with
 * no output anywhere, which is indistinguishable from "I never saved the file".
 */
export type Problem = {
  location: string
  message: string
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
  problems: Problem[]
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
  /** SKILL.md files found but not loaded, from the most recent scan. */
  readonly problems: () => Effect.Effect<Problem[]>
  /**
   * Drop the cached scan so the next read re-walks the skill directories.
   * Discovery is otherwise a once-per-instance event, which made every
   * "refresh" surface a no-op until the process restarted.
   */
  readonly refresh: () => Effect.Effect<void>
}

const add = Effect.fnUntraced(function* (state: State, match: string, events: EventV2Bridge.Service["Service"]) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        state.problems.push({ location: match, message })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) {
    // Was a bare `return`: the file existed, parsed fine, and disappeared with
    // no log, no event, nothing. Name the field that actually failed — the
    // whole class is typos in `name:`, not one specific mistake.
    const message = !isRecord(md.data)
      ? "frontmatter is missing or is not a mapping"
      : md.data.name === undefined
        ? "frontmatter has no `name` field"
        : typeof md.data.name !== "string"
          ? `frontmatter \`name\` must be a string, got ${typeof md.data.name}`
          : `frontmatter \`description\` must be a string, got ${typeof md.data.description}`
    yield* Effect.logWarning("skipped skill with invalid frontmatter", { skill: match, reason: message })
    state.problems.push({ location: match, message })
    return
  }

  if (state.skills[md.data.name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    category: typeof md.data.category === "string" ? md.data.category : undefined,
    location: match,
    content: md.content,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  agentPlugins: AgentPlugins.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set() }

  // agent-plugins.org plugins hand over finished SKILL.md paths rather than a
  // directory to scan. The scan happens in the plugin loader because that is
  // where the §4.1 root is known: a `skills/` entry symlinked outside the
  // package has to be dropped, and `scan` below deliberately follows symlinks.
  for (const match of yield* agentPlugins.skillFiles()) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, ORIGAMI_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length, problems: state.problems.length })
})

export class Service extends Context.Service<Service, Interface>()("@origami/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const agentPlugins = yield* AgentPlugins.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          agentPlugins,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set(), problems: [] }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    const problems = Effect.fn("Skill.problems")(function* () {
      const s = yield* InstanceState.get(state)
      return s.problems
    })

    const refresh = Effect.fn("Skill.refresh")(function* () {
      // BOTH, and `discovered` is not optional: `state`'s loader reads the
      // discovered match list, so invalidating `state` alone would re-parse
      // exactly the same set of files and a newly added skill would still be
      // invisible. Neither entry holds a scoped resource, so dropping them
      // releases nothing an in-flight session could be holding — a session
      // that already resolved a skill keeps its own `Info` value.
      //
      // THREE now, not two: plugin SKILL.md paths come from the AgentPlugins
      // scan, which caches separately. Dropping only the two local entries
      // re-reads the same plugin file list, so a skill from a plugin installed
      // since startup stayed invisible until the process restarted - the exact
      // bug this refresh exists to prevent, reintroduced through a new source.
      yield* agentPlugins.refresh()
      yield* InstanceState.invalidate(discovered)
      yield* InstanceState.invalidate(state)
    })

    return Service.of({ get, require, all, dirs, available, problems, refresh })
  }),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${escapeHtml(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Discovery.node,
    Config.node,
    EventV2Bridge.node,
    FSUtil.node,
    Global.node,
    RuntimeFlags.node,
    AgentPlugins.node,
  ],
})

export * as Skill from "."
