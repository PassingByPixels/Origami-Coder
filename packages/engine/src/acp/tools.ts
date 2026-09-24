import { Effect } from "effect"
import { ToolSearch } from "@/tool/tool-search"
import { ToolEnabled } from "@/tool/tool-enabled"
import { ToolRegistry } from "@/tool/registry"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { Agent } from "@/agent/agent"
import { ACPSubagentTools } from "./subagent-tools"
import { SubagentDepth } from "@/session/subagent-depth"

/**
 * `list_tools` ext method - the shell's Tools pane.
 *
 * The list comes from the engine's own `GET /experimental/tool`, so the pane shows
 * exactly the tools a turn would be offered. That endpoint cannot say which of them
 * the model is actually SENT and which sit behind the `tool_search` catalog, so the
 * deferral verdict is recomputed here from the rules `session/tools.ts` applies,
 * over the same config. It is the SESSION-START verdict: `loaded` is empty, because
 * this answers about the workspace, not about one live chat.
 *
 * `source`/`location` come from a SECOND read (`meta()` below) over the live
 * registry; `project()` with an empty map still gives correct `deferred` and
 * `hardRequired` verdicts. Two blind spots come from the endpoint itself: it lists
 * REGISTRY tools only, so MCP tools are absent as ROWS (`source: "mcp"` is valid
 * for forward-compat but nothing produces it yet), and it drops the def's
 * `deferrable` flag. t-fijeld: that flag now rides on `ToolMeta` from the same
 * registry read as `source`, so a builtin deferred by its own marking reads as
 * deferred here too - the spawn path (`session/tools.ts`) has always honoured it.
 */

export type ToolSource = "builtin" | "mcp" | "user-file" | "plugin"

/** One tool's origin, as read straight off the live registry. */
export type ToolMeta = {
  readonly source: ToolSource
  readonly location?: string
  /** The def's own `deferrable: true`. Absent means not marked. */
  readonly deferrable?: boolean
}

export type ToolRow = {
  readonly id: string
  readonly description: string
  readonly deferred: boolean
  readonly source: ToolSource
  readonly location?: string
  /**
   * True for a tool the pane must show without a state control.
   *
   * No engine row sets this any more - `SessionPromptCapture.REPAIR_ONLY_TOOLS` is
   * dropped from the list entirely (see `project()` below). The field stays for the
   * SHELL's synthetic `tool_search` card, which is never a registry tool and can
   * never defer itself.
   */
  readonly hardRequired: boolean
  /** OFF - `tools: { <id>: false }` in origami.json. A deferred tool is still
   *  offered (as a catalog line the model can expand), a disabled one is not built
   *  into the tools map at all. The row is STILL LISTED when this is true, because
   *  a state you cannot see is a state you cannot leave. */
  readonly disabled: boolean
}

/**
 * A user tool FILE the registry found but could not load.
 *
 * A SIBLING of `tools`, never a row: the file produced no tool, so there is no id
 * and no state to set - the only honest thing to show is the path and the reason.
 */
export type ToolProblem = {
  readonly file: string
  readonly message: string
}

export type ToolsResult = {
  readonly tools: readonly ToolRow[]
  readonly settings: ToolSearch.Settings
  readonly problems: readonly ToolProblem[]
  /**
   * One row per SUB-AGENT TYPE, with this workspace's effective state for every
   * tool above (acp/subagent-tools.ts). A SIBLING of `tools` for the same reason
   * `problems` is: the states belong to an agent, not to a tool. Empty for an
   * older client or when the registry could not be read.
   */
  readonly subagents: readonly ACPSubagentTools.SubagentRow[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined

const boolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)

/** Read `experimental.tool_search` out of whatever the config endpoint returned.
 *  Defensive on purpose: this key is newer than the generated SDK types, so the
 *  value arrives as plain JSON. An unreadable field falls back to the defaults. */
export function readSettings(config: unknown): ToolSearch.Settings {
  const experimental = isRecord(config) ? config["experimental"] : undefined
  const raw = isRecord(experimental) ? experimental["tool_search"] : undefined
  if (!isRecord(raw)) return ToolSearch.settings()
  return ToolSearch.settings({
    ...(boolean(raw["enabled"]) !== undefined ? { enabled: boolean(raw["enabled"])! } : {}),
    ...(boolean(raw["mcp"]) !== undefined ? { mcp: boolean(raw["mcp"])! } : {}),
    ...(stringArray(raw["defer"]) ? { defer: stringArray(raw["defer"])! } : {}),
    ...(stringArray(raw["always"]) ? { always: stringArray(raw["always"])! } : {}),
  })
}

/** `subagent_depth` off the raw config, defensively - like `readSettings`
 *  above, this arrives as plain JSON and an unreadable value must fall back to
 *  the engine default rather than blank the matrix (t-h8s3xg). */
function subagentDepth(config: unknown): number | undefined {
  const raw = isRecord(config) ? config["subagent_depth"] : undefined
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined
}

export function project(
  list: readonly { readonly id: string; readonly description: string }[],
  config: unknown,
  meta: ReadonlyMap<string, ToolMeta> = new Map(),
  problems: readonly ToolProblem[] = [],
  agents: readonly ACPSubagentTools.SubagentInfo[] = [],
): ToolsResult {
  const settings = readSettings(config)
  // REPAIR-ONLY TOOLS ARE NOT CATALOG ENTRIES. `invalid` (tool/invalid.ts) exists
  // so the AI SDK's `experimental_repairToolCall` hook has a destination, and it is
  // never offered to the model. Listing it advertises a tool that does not exist
  // for the user and cannot be acted on. Dropped HERE rather than in the pane: the
  // shell should not have to know which engine internals are furniture.
  const visible = list.filter((item) => !SessionPromptCapture.REPAIR_ONLY_TOOLS.has(item.id))
  const off = ToolEnabled.offPatterns(config)
  // t-fijeld. OFF outranks DEFERRED, the order session/tools.ts applies: a tool
  // switched off never reaches the deferral verdict. Running `deferred()` over
  // the OFF tools too let an OFF `task` keep its companions "loaded" here while
  // the spawn path deferred them - the same lie t-ffjjxr was filed for, one
  // view over. `visible` still lists the OFF rows; only the verdict skips them.
  const offered = visible.filter((item) => !ToolEnabled.isOff(item.id, off))
  const deferrable = new Set([...meta].filter(([, found]) => found.deferrable === true).map(([id]) => id))
  const hidden = new Set(
    ToolSearch.deferred(
      offered.map((item) => ({
        id: item.id,
        kind: "builtin" as const,
        ...(deferrable.has(item.id) ? { deferrable: true } : {}),
      })),
      settings,
    ),
  )
  return {
    tools: visible
      .map((item) => {
        const found = meta.get(item.id)
        return {
          id: item.id,
          description: item.description,
          deferred: hidden.has(item.id),
          source: found?.source ?? "builtin",
          ...(found?.location ? { location: found.location } : {}),
          hardRequired: SessionPromptCapture.REPAIR_ONLY_TOOLS.has(item.id),
          disabled: ToolEnabled.isOff(item.id, off),
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
    settings,
    // DEDUPED BY FILE, not just sorted. `config.directories()` can name the same
    // folder twice, and the registry globs each entry, so one bad file can be
    // reported more than once. The pane renders this as a keyed `{#each}`, and a
    // repeated key is a runtime error there.
    problems: [...new Map(problems.map((item) => [item.file, item])).values()].sort((a, b) =>
      a.file.localeCompare(b.file),
    ),
    // Over the SAME visible list the rows above are built from, so the matrix
    // can never carry a column the pane has no row for.
    subagents: ACPSubagentTools.project({
      agents,
      tools: visible.map((item) => item.id),
      deferrable,
      settings,
      config,
      nestingCapped: SubagentDepth.atCap(1, subagentDepth(config)),
    }),
  }
}

/**
 * Per-tool origin, straight off the live registry - `registry.all()` rather than
 * `registry.tools()` because this needs no provider/model to answer and must
 * include every tool regardless of the model-specific edit/apply_patch filtering.
 * `undefined` on a `Tool.Def.source` reads as "builtin".
 *
 * Deliberately NOT folded into `project()`: that function stays PURE and
 * unit-testable with no engine booted, and this is the one impure read.
 */
export const meta = Effect.fn("ACPTools.meta")(function* () {
  const registry = yield* ToolRegistry.Service
  const all = yield* registry.all()
  const map = new Map<string, ToolMeta>()
  for (const tool of all) {
    map.set(tool.id, {
      ...(tool.source ? { source: tool.source, ...(tool.location ? { location: tool.location } : {}) } : { source: "builtin" }),
      ...(tool.deferrable === true ? { deferrable: true } : {}),
    })
  }
  return map
})

/**
 * User tool files the registry skipped, straight off the live registry.
 *
 * A SECOND read beside `meta()` rather than a field on it: `meta()` answers
 * per-tool, and a problem has no tool to hang off. Kept to its own Effect for the
 * same reason `meta()` is: `project()` stays pure.
 */
/**
 * The sub-agent DEFINITIONS, straight off the live agent registry - the one read
 * the matrix needs and `project()` must not do itself. Native archetypes and
 * markdown/config definitions arrive in the same list, which is the point: the
 * pane's rows are whatever this engine can actually spawn.
 */
export const agents = Effect.fn("ACPTools.agents")(function* () {
  const registry = yield* Agent.Service
  return (yield* registry.list()).map((agent) => ({
    name: agent.name,
    mode: agent.mode,
    ...(agent.native === true ? { native: true } : {}),
    ...(agent.hidden === true ? { hidden: true } : {}),
    ...(agent.description ? { description: agent.description } : {}),
    // The archetype's own deferral defaults ride along, or a native's D list
    // would be invisible to the matrix until a user wrote a config block.
    ...(agent.tool_search ? { tool_search: agent.tool_search } : {}),
    permission: agent.permission,
  })) satisfies ACPSubagentTools.SubagentInfo[]
})

export const problems = Effect.fn("ACPTools.problems")(function* () {
  const registry = yield* ToolRegistry.Service
  return (yield* registry.problems()).map((item) => ({ file: item.file, message: item.message }))
})

export * as ACPTools from "./tools"
