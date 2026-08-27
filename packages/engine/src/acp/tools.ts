import { Effect } from "effect"
import { ToolSearch } from "@/tool/tool-search"
import { ToolEnabled } from "@/tool/tool-enabled"
import { ToolRegistry } from "@/tool/registry"
import { SessionPromptCapture } from "@/session/prompt-capture"

/**
 * `list_tools` ext method — the shell's Tools pane.
 *
 * The list itself comes from the engine's own `GET /experimental/tool`, so the
 * pane shows exactly the tools a turn would be offered rather than a second
 * hand-maintained inventory. What that endpoint cannot answer is the question
 * the pane exists to ask — which of them the model is actually SENT, and which
 * are behind the `tool_search` catalog — so the deferral verdict is recomputed
 * here from the same rules `session/tools.ts` applies, over the same config.
 *
 * The verdict is the SESSION-START one: `loaded` is empty, because this method
 * answers about the workspace, not about one live chat. A tool a search has
 * already pulled in reads as `deferred` here and is callable in that session;
 * the pane says so rather than pretending otherwise.
 *
 * `source`/`location` come from a SECOND, separate read (`meta()` below) over
 * the live registry rather than from the endpoint's response — extending that
 * response's generated OpenAPI schema was judged too large a change for what
 * this ticket asked for (t-kgtaac round 3). A caller with no registry handy
 * (a unit test) can pass `project()` an empty map and still get correct
 * `deferred`/`hardRequired` verdicts; every row just reads as `source: "builtin"`.
 *
 * Two known blind spots remain, both from what the endpoint carries rather
 * than from this projection: it lists the REGISTRY tools only, so MCP tools
 * (the ones config defers by default) are absent as ROWS — `source: "mcp"` is
 * a valid value here for forward-compat, but nothing produces it yet; and it
 * drops the def's `deferrable` flag, so a builtin deferred by its own marking
 * reads as loaded here. Config `defer` patterns are honoured because they are
 * read from config, not from the row.
 */

export type ToolSource = "builtin" | "mcp" | "user-file" | "plugin"

/** One tool's origin, as read straight off the live registry. */
export type ToolMeta = {
  readonly source: ToolSource
  readonly location?: string
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
   * NO ENGINE ROW SETS THIS ANY MORE: the only set that ever did —
   * `SessionPromptCapture.REPAIR_ONLY_TOOLS` — is now dropped from the list
   * entirely (see `project()` below), so a disabled control is not needed for
   * a row that is not there. The field stays because the SHELL still produces
   * a row that needs it: the synthetic `tool_search` card the extension
   * appends (vscode/src/dashboard/toolSearchRow.ts) is never a registry tool
   * and can never defer itself. Kept as a computed verdict rather than a
   * constant `false` so a future addition to REPAIR_ONLY_TOOLS is handled by
   * the filter, not by a second place to remember.
   */
  readonly hardRequired: boolean
  /**
   * OFF — `tools: { <id>: false }` in origami.json. The third state, and the
   * only one that is not about presentation: a deferred tool is still offered
   * (as a catalog line the model can expand), a disabled one is not built into
   * the tools map at all (session/tools.ts). The row is STILL LISTED when this
   * is true, because a state you cannot see is a state you cannot leave.
   */
  readonly disabled: boolean
}

/**
 * A user tool FILE the registry found but could not load.
 *
 * A SIBLING of `tools`, never a row: the file produced no tool, so there is no
 * id, no description and no state to set — the only honest thing to show is the
 * path and the reason. Same shape and same placement the Plugins pane already
 * uses for an unloadable plugin (`acp/agent-plugins.ts` `PluginProblem`), keyed
 * by the thing that failed rather than by a name that does not exist yet.
 */
export type ToolProblem = {
  readonly file: string
  readonly message: string
}

export type ToolsResult = {
  readonly tools: readonly ToolRow[]
  readonly settings: ToolSearch.Settings
  readonly problems: readonly ToolProblem[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined

const boolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)

/**
 * Read `experimental.tool_search` out of whatever the config endpoint returned.
 * Defensive on purpose: this key is newer than the generated SDK types, so the
 * value arrives as plain JSON and a hand-edited origami.json can put anything
 * in it. An unreadable field falls back to the shipped defaults rather than
 * failing the pane.
 */
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

export function project(
  list: readonly { readonly id: string; readonly description: string }[],
  config: unknown,
  meta: ReadonlyMap<string, ToolMeta> = new Map(),
  problems: readonly ToolProblem[] = [],
): ToolsResult {
  const settings = readSettings(config)
  // REPAIR-ONLY TOOLS ARE NOT CATALOG ENTRIES. `invalid` (tool/invalid.ts,
  // description "Do not use") is registered so the AI SDK's
  // `experimental_repairToolCall` hook has a destination for a tool call whose
  // arguments would not parse (session/llm.ts's `toolName: "invalid"`), and it
  // is never offered to the model — `SessionPromptCapture.offeredToolNames`
  // filters it out of the very map that gets sent. Listing it as a card the
  // user could reason about (let alone load, defer or switch off) advertises a
  // tool that does not exist for them and cannot be acted on. It is dropped
  // HERE, in the list method, rather than in the pane: the shell should not
  // have to know which engine internals are furniture.
  const visible = list.filter((item) => !SessionPromptCapture.REPAIR_ONLY_TOOLS.has(item.id))
  const off = ToolEnabled.offPatterns(config)
  const hidden = new Set(
    ToolSearch.deferred(
      visible.map((item) => ({ id: item.id, kind: "builtin" as const })),
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
    // DEDUPED BY FILE, not just sorted. `config.directories()` can name the
    // same folder twice (directory === worktree is the ordinary case), and the
    // registry globs each entry, so one bad file can be found — and reported —
    // more than once. The pane renders this as a keyed `{#each}`, and a
    // repeated key is a runtime error there: the containment fix would then
    // break the very pane it exists to keep alive.
    problems: [...new Map(problems.map((item) => [item.file, item])).values()].sort((a, b) =>
      a.file.localeCompare(b.file),
    ),
  }
}

/**
 * Per-tool origin, straight off the live registry — `registry.all()` rather
 * than `registry.tools()` because this needs no provider/model to answer and
 * must include every tool regardless of the model-specific edit/apply_patch
 * filtering that projection applies. `undefined` on a `Tool.Def.source` reads
 * as "builtin" (registry.ts only sets it on a `custom` tool).
 *
 * Deliberately NOT folded into `project()` above: that function stays PURE
 * and unit-testable with no engine booted, and this is the one impure read —
 * kept to a single Effect so the caller (acp/service.ts) can run it exactly
 * like `Instructions.list` / `Skills.list` already do, on the process-wide
 * AppRuntime, with no private layer stack.
 */
export const meta = Effect.fn("ACPTools.meta")(function* () {
  const registry = yield* ToolRegistry.Service
  const all = yield* registry.all()
  const map = new Map<string, ToolMeta>()
  for (const tool of all) {
    map.set(tool.id, tool.source ? { source: tool.source, ...(tool.location ? { location: tool.location } : {}) } : { source: "builtin" })
  }
  return map
})

/**
 * User tool files the registry skipped, straight off the live registry.
 *
 * A SECOND read beside `meta()` rather than a field on it: `meta()` answers
 * per-tool and degrades to an empty Map, and a problem has no tool to hang off
 * — the whole point is that no tool was produced. Kept to its own Effect for
 * the same reason `meta()` is: `project()` stays pure, and the caller runs this
 * on the process-wide AppRuntime with no private layer stack.
 */
export const problems = Effect.fn("ACPTools.problems")(function* () {
  const registry = yield* ToolRegistry.Service
  return (yield* registry.problems()).map((item) => ({ file: item.file, message: item.message }))
})

export * as ACPTools from "./tools"
