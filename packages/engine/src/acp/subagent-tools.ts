import { PermissionV1 } from "@origami/core/v1/permission"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { Permission } from "@/permission"
import { ToolEnabled } from "@/tool/tool-enabled"
import { ToolSearch } from "@/tool/tool-search"
import { SubagentDepth } from "@/session/subagent-depth"
import type { Agent } from "@/agent/agent"

/**
 * The Tools pane's SUB-AGENT MATRIX: for every sub-agent type, what each tool's
 * state would be when the `task` tool spawns it right now.
 *
 * Three states, the same three the pane already uses for the workspace rows -
 * `loaded`, `deferred`, `off` - and each is read from the key the table writes:
 *
 * | state      | where it lives                          | who honours it            |
 * |------------|-----------------------------------------|---------------------------|
 * | `off`      | `agent.<name>.permission.<tool>: deny`   | session/tools.ts `caged`  |
 * | `deferred` | `agent.<name>.tool_search.defer`         | session/tools.ts deferral |
 * | `loaded`   | `agent.<name>.tool_search.always`        | session/tools.ts deferral |
 *
 * A NATIVE needs no config line for any of the three: its ruleset carries the
 * `off` verdicts and its own `tool_search` block (`Agent.Info.tool_search`)
 * carries the `deferred` ones, overlaid under the user block by
 * `ToolSearch.forSpawn` - the same call the spawn path makes.
 *
 * The verdicts are computed from the SAME functions the spawn path uses -
 * `deriveSubagentSessionPermission` for the child's ruleset, `Permission.disabled`
 * for the cage, `ToolSearch.forAgent` + `ToolSearch.deferred` for the catalog -
 * so a default the table draws is a default the child really gets. That is what
 * makes `explore` read `todowrite: off`, and `general` read its D list
 * `deferred`, without a line of config anywhere.
 *
 * PURE, like `project()` beside it: the live reads (the agent registry, the
 * config) stay in acp/tools.ts, so the whole matrix is testable with no engine.
 *
 * ONE KNOWN BLIND SPOT, inherited from `project()`: `/experimental/tool` drops a
 * Def's `deferrable` flag, so a builtin deferred by its own marking reads as
 * `loaded` here. It is the same blind spot on the same rows, rather than two
 * answers that disagree.
 */

export type SubagentToolState = "loaded" | "deferred" | "off"

/** The spawning tools, from the one place the cap is written down. */
const NESTED: readonly string[] = SubagentDepth.NESTED_TASK_TOOLS

/** What one sub-agent row needs. A thin slice of `Agent.Info`, so the projection
 *  can be driven from a fixture without building a registry. */
export type SubagentInfo = {
  readonly name: string
  readonly mode: Agent.Info["mode"]
  readonly native?: boolean
  readonly hidden?: boolean
  readonly description?: string
  readonly permission: PermissionV1.Ruleset
  /** The archetype's OWN deferral defaults, off `Agent.Info.tool_search`. A
   *  native carries one; the user's config block overlays it (`forSpawn`). */
  readonly tool_search?: ToolSearch.AgentSettings
}

export type SubagentRow = {
  readonly agent: string
  /** An engine archetype (`general`, `explore`, ...) rather than a file or a
   *  config block. The pane says so: a native row has no definition to open. */
  readonly native: boolean
  readonly description?: string
  /** Tool id -> state. Every tool the pane lists gets an entry, so a cell is
   *  never rendered from a default the shell invented. */
  readonly states: Record<string, SubagentToolState>
  /**
   * Tool id -> why this cell is OFF and cannot be set (t-h8s3xg).
   *
   * A state alone cannot say this: `off` is normally a setting the user may
   * cycle, and the nesting tools at the depth cap are not. The key exists only
   * for the tools it names, so an older row and a row with nothing to explain
   * are the same shape.
   */
  readonly unavailable?: Record<string, string>
}

/** One agent's own `tool_search` block out of `config.agent[name]`, defensively:
 *  origami.json is hand-editable and a malformed block must not blank a row. */
function agentSearch(block: unknown): ToolSearch.AgentSettings | undefined {
  if (typeof block !== "object" || block === null || Array.isArray(block)) return undefined
  const raw = (block as Record<string, unknown>)["tool_search"]
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined
  const defer = list((raw as Record<string, unknown>)["defer"])
  const always = list((raw as Record<string, unknown>)["always"])
  return defer || always ? { ...(defer ? { defer } : {}), ...(always ? { always } : {}) } : undefined
}

/** The `agent` record out of whatever the config endpoint returned. */
function agentBlocks(config: unknown): Record<string, unknown> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return {}
  const agents = (config as Record<string, unknown>)["agent"]
  return typeof agents === "object" && agents !== null && !Array.isArray(agents)
    ? (agents as Record<string, unknown>)
    : {}
}

/**
 * Which agents get a row: the ones the `task` tool can actually spawn.
 *
 * `mode: "primary"` is the chat's own agent, not a delegate, and a `hidden`
 * archetype (`goal-critic`, `front-desk`) is spawned by the engine itself and
 * never named by a model - neither has a sub-agent row to set.
 */
export function spawnable(agents: readonly SubagentInfo[]): SubagentInfo[] {
  return [...agents]
    .filter((agent) => agent.mode !== "primary" && agent.hidden !== true)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every tool's state for one agent, over rulesets and settings already
 * resolved - ONE `ToolSearch.deferred` call across the whole offered set,
 * not one per tool.
 *
 * t-ffjjxr: the per-tool call this replaced built `entries` as a single-tool
 * array, so `deferred`'s "is `task` among `entries`" check for
 * `TASK_COMPANIONS` was always false and `task_list`/`task_stop` fell through
 * to the ordinary defer rules - the ledger called them deferred while the
 * spawn path (`session/tools.ts`, which passes its whole `offered` list at
 * once) kept them loaded. Passing every OFFERED tool - the ones OFF or caged
 * are decided first and never reach `deferred` at all - reproduces the same
 * `taskLoaded` context the spawn path builds.
 */
function statesFor(input: {
  readonly tools: readonly string[]
  readonly cage: PermissionV1.Ruleset
  readonly settings: ToolSearch.Settings
  readonly off: readonly string[]
  /** Tools whose def says `deferrable: true` (t-fijeld). Without it every
   *  self-deferring builtin read "loaded" here while the spawn path hid it. */
  readonly deferrable: ReadonlySet<string>
}): Record<string, SubagentToolState> {
  // OFF outranks DEFERRED, the same order session/tools.ts applies: a tool the
  // workspace switched off never reaches the deferral decision, and neither
  // does one this agent's ruleset denies.
  const disabled = Permission.disabled([...input.tools], input.cage)
  const offTools = new Set(input.tools.filter((tool) => ToolEnabled.isOff(tool, input.off) || disabled.has(tool)))
  const offered = input.tools.filter((tool) => !offTools.has(tool))
  const deferred = new Set(
    ToolSearch.deferred(
      offered.map((tool) => ({
        id: tool,
        kind: "builtin" as const,
        ...(input.deferrable.has(tool) ? { deferrable: true } : {}),
      })),
      input.settings,
    ),
  )
  const states: Record<string, SubagentToolState> = {}
  for (const tool of input.tools) states[tool] = offTools.has(tool) ? "off" : deferred.has(tool) ? "deferred" : "loaded"
  return states
}

export function project(input: {
  readonly agents: readonly SubagentInfo[]
  readonly tools: readonly string[]
  /** Ids whose def is `deferrable: true`; defaults to none for callers that
   *  have no registry read (tests over the pure projection). */
  readonly deferrable?: ReadonlySet<string>
  readonly settings: ToolSearch.Settings
  readonly config: unknown
  /**
   * `subagent_depth` allows no nesting (t-h8s3xg). EVERY row here is a CHILD -
   * the matrix answers "what does this agent type get when `task` spawns it" -
   * so at the cap none of them can spawn in turn, whatever their permission or
   * `tool_search` block says. The archetypes the seed matrix marks `task: L`
   * (orchestrator, architect, cartographer, ask) are no exception: that mark is
   * meaningful for a PRIMARY agent, and these rows are not primary ones.
   * `session/tools.ts` drops the same three ids from the child's real catalog,
   * so this is the pane telling the truth about that, not a second rule.
   */
  readonly nestingCapped?: boolean
}): SubagentRow[] {
  const blocks = agentBlocks(input.config)
  const capped = input.nestingCapped === true ? input.tools.filter((tool) => NESTED.includes(tool)) : []
  const off = ToolEnabled.offPatterns(input.config)
  return spawnable(input.agents).map((agent) => {
    // The child's ruleset as the spawn path builds it. The parent session
    // contributes nothing here on purpose: the matrix answers "what does this
    // agent type get", and what one chat's own rules add is that chat's answer.
    const cage = Permission.merge(
      agent.permission,
      deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: agent as Agent.Info }),
    )
    const settings = ToolSearch.forSpawn(input.settings, agent.tool_search, agentSearch(blocks[agent.name]))
    const states = statesFor({ tools: input.tools, cage, settings, off, deferrable: input.deferrable ?? new Set() })
    for (const tool of capped) states[tool] = "off"
    return {
      agent: agent.name,
      native: agent.native === true,
      ...(agent.description ? { description: agent.description } : {}),
      states,
      ...(capped.length > 0
        ? { unavailable: Object.fromEntries(capped.map((tool) => [tool, SubagentDepth.LEDGER_REASON])) }
        : {}),
    }
  })
}

export * as ACPSubagentTools from "./subagent-tools"
