import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Config } from "@/config/config"
import { Database } from "@origami/core/database/database"
import { SessionRequestMemoryRows } from "@/session/request-memory-rows"

/**
 * Deferred tool catalog for the primary tool list.
 *
 * A connected MCP server pushes every tool's full JSON Schema into the system
 * prompt of every turn, called or not. A deferred tool is advertised as ONE
 * catalog line instead; `tool_search` turns a query into the matching tools'
 * schemas, and the matched ids stay callable for the rest of the session.
 *
 * The scoring is ported from `makeSearchTool` in
 * packages/codemode/src/tool-runtime.ts deliberately: two search surfaces that
 * rank the same tools differently is a bug the user sees as "it found it in
 * code mode but not here". Everything above the service at the bottom is pure,
 * so ranking and deferral are testable without booting an engine.
 */

export const TOOL_SEARCH_TOOL = "tool_search"

/** How many tools one search materialises when the caller names no limit. */
export const DEFAULT_SEARCH_LIMIT = 5
/** Hard ceiling, so a `limit: 500` cannot undo the whole point of deferral. */
export const MAX_SEARCH_LIMIT = 20

export type Kind = "builtin" | "mcp"

/**
 * What the deferral decision needs. Smaller than `Candidate` on purpose: the
 * decision runs over every tool on every step, while the search text is only
 * read for the handful that end up deferred.
 */
export type Entry = {
  readonly id: string
  readonly kind: Kind
  /** A builtin that has declared itself safe to hide behind the catalog. */
  readonly deferrable?: boolean
}

export type Candidate = Entry & {
  readonly description: string
  /** Lowercased id + description + parameter names/descriptions. Built by `searchText`. */
  readonly text: string
}

/** `experimental.tool_search` in origami.json, with the defaults filled in. */
export type Settings = {
  readonly enabled: boolean
  readonly mcp: boolean
  readonly defer: readonly string[]
  readonly always: readonly string[]
}

/**
 * The tools that are NEVER a catalog line, whatever a Def or a config says.
 * Hiding one buys a `tool_search` round trip on nearly every session, and
 * `invalid` is the repair path the registry routes an unknown tool name to. A
 * hard guard, because `defer: ["*"]` in a user's config would otherwise take
 * `read` and `edit` away from every agent.
 */
export const CORE: ReadonlySet<string> = new Set([
  "read",
  "edit",
  "write",
  "apply_patch",
  "bash",
  "grep",
  "glob",
  "todowrite",
  "task",
  "question",
  "invalid",
  // A remembered fact must never cost a `tool_search` first.
  "remember",
])

/**
 * Builtins deferred by default, listed here because `tool/browser.ts`,
 * `tool/webmcp.ts` and `tool/flock.ts` do not yet carry a `deferrable` flag on
 * their Def. `flock_reply` is deliberately absent: the envelope
 * `flock/deliver.ts` puts in a chat names the tool the model must call to
 * answer, and a deferred tool is not in that turn's schema.
 */
const BUILTIN_DEFER = ["browser", "webmcp_*", "flock_who", "flock_ask"]

/**
 * `task`'s own companions (t-fdveov). `task/task.ts`'s BACKGROUND_STARTED
 * text tells the model to call `task_list` and `task_stop` by name once a
 * background task is running - the same contract `CORE` protects `read` and
 * `edit` under, one level down. Both Defs carry `deferrable: true` (a
 * deferred-by-default builtin, same as `browser`), and either one could also
 * land on a `defer` list from config or the Tools pane's per-agent matrix.
 * Whichever way it happens, a hidden companion while `task` itself is loaded
 * is the bug this guards: the model calls a tool named in the prompt it was
 * just given and gets "Unknown tool" back. So this is one-directional and
 * unconditional - it does NOT go through `always`/`defer` at all - unlike
 * `send_message` <-> `list_agents`, which have no anchor tool that is itself
 * guaranteed loaded the way `task` is (via `CORE`); making that pair follow
 * each other would need a fixed-point over the whole entry list rather than
 * one anchor check, so it is left alone here.
 */
export const TASK_COMPANIONS: ReadonlySet<string> = new Set(["task_list", "task_stop"])

export const DEFAULTS: Settings = { enabled: true, mcp: true, defer: [], always: [] }

export function settings(input?: {
  enabled?: boolean
  mcp?: boolean
  defer?: readonly string[]
  always?: readonly string[]
}): Settings {
  return {
    enabled: input?.enabled ?? DEFAULTS.enabled,
    mcp: input?.mcp ?? DEFAULTS.mcp,
    defer: input?.defer ?? DEFAULTS.defer,
    always: input?.always ?? DEFAULTS.always,
  }
}

/** One agent's own `tool_search` block, as ConfigAgentV1 accepts it. */
export type AgentSettings = {
  readonly defer?: readonly string[]
  readonly always?: readonly string[]
}

/**
 * The global settings as ONE agent sees them: its own `defer` / `always`
 * entries overlaid on the workspace lists.
 *
 * t-di2u7z. The Tools tab's per-agent matrix needs "deferred for `general`,
 * loaded for `orchestrator`", and the settings are read once per resolve from a
 * single global key. Overlaying HERE - pure, at the one call site that knows
 * which agent is resolving - keeps the deferred catalog global state out of it:
 * nothing in the service becomes per-session.
 *
 * An agent naming a tool wins over the global list on BOTH sides, so
 * `always: ["browser"]` for one agent really un-defers it even while the
 * workspace defers it, and the reverse. Naming a tool in both of an agent's own
 * lists resolves as `always`, the same precedence `deferred` applies below.
 */
export function forAgent(settings: Settings, agent?: AgentSettings): Settings {
  const defer = agent?.defer ?? []
  const always = agent?.always ?? []
  if (defer.length === 0 && always.length === 0) return settings
  return {
    ...settings,
    defer: [...settings.defer.filter((id) => !always.includes(id)), ...defer.filter((id) => !always.includes(id))],
    always: [...settings.always.filter((id) => !defer.includes(id)), ...always],
  }
}

/**
 * The settings ONE SPAWNED AGENT sees: the workspace lists, then the
 * ARCHETYPE'S OWN defaults (`Agent.Info.tool_search`), then the user's
 * `agent.<name>.tool_search` block - each layer winning over the one before on
 * the tools it names, and leaving the rest alone.
 *
 * That order is the contract. A native ships a default deferred list so the
 * Sub-agents ledger is right with no config file present; a user who writes
 * `always: ["webfetch"]` for `general` un-defers exactly that tool and keeps
 * the rest of the archetype default. Both call sites - session/tools.ts at
 * spawn and acp/subagent-tools.ts for the matrix - go through this one
 * function, so the ledger cannot disagree with what the child really gets.
 */
export function forSpawn(settings: Settings, native?: AgentSettings, config?: AgentSettings): Settings {
  return forAgent(forAgent(settings, native), config)
}

/**
 * Pattern match for the `defer` / `always` opt-in lists. `*` is the only
 * wildcard. Anchored at both ends: a bare `board` must not silently opt in
 * `board_create` too.
 */
export function matches(pattern: string, id: string): boolean {
  if (pattern === id) return true
  if (!pattern.includes("*")) return false
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === "*" ? "[\\s\\S]*" : "\\" + char))
  return new RegExp("^" + escaped + "$").test(id)
}

const listed = (patterns: readonly string[], id: string) => patterns.some((pattern) => matches(pattern, id))

/**
 * Which candidates are hidden behind the catalog for THIS session. The order is
 * the invariant: `always` outranks everything, then anything already loaded by
 * a search this session, then the explicit `defer` list, then the by-kind
 * defaults. Any other order loses `always: ["board_*"]` the moment the MCP
 * default flips those tools on.
 *
 * t-fdveov: `task_list` / `task_stop` are checked AHEAD of that order, but
 * only while `task` itself is among `entries` - the same guard `CORE` uses,
 * one level down, so an agent that never gets `task` (off, or caged) leaves
 * its companions to the normal rules. Ahead of `always` too: the point is
 * that no config entry, `defer` or otherwise, can hide them while `task` is
 * loaded, not that they need a config entry to escape.
 *
 * `onOverride`, when given, is called at most once, with every companion id
 * that would otherwise have been deferred (by a `defer` entry or by its own
 * `deferrable: true`) - the caller logs the single INFO line from that.
 */
export function deferred(
  entries: readonly Entry[],
  config: Settings,
  loaded: ReadonlySet<string> = new Set(),
  onOverride?: (ids: readonly string[]) => void,
): string[] {
  if (!config.enabled) return []
  const taskLoaded = entries.some((entry) => entry.kind === "builtin" && entry.id === "task")
  const overridden: string[] = []
  const ids = entries
    .filter((entry) => {
      if (entry.id === TOOL_SEARCH_TOOL) return false
      // Ahead of `defer`, unlike `always`: less than core is a broken loop.
      if (entry.kind === "builtin" && CORE.has(entry.id)) return false
      if (taskLoaded && entry.kind === "builtin" && TASK_COMPANIONS.has(entry.id)) {
        const wouldDefer = !loaded.has(entry.id) && !listed(config.always, entry.id) &&
          (listed(config.defer, entry.id) || entry.deferrable === true || listed(BUILTIN_DEFER, entry.id))
        if (wouldDefer) overridden.push(entry.id)
        return false
      }
      if (listed(config.always, entry.id)) return false
      if (loaded.has(entry.id)) return false
      if (listed(config.defer, entry.id)) return true
      if (entry.kind === "mcp") return config.mcp
      return entry.deferrable === true || listed(BUILTIN_DEFER, entry.id)
    })
    .map((entry) => entry.id)
  if (overridden.length > 0) onOverride?.(overridden)
  return ids
}

/**
 * Split a query into lowercased terms, so `read-file`, `readFile` and
 * `read file` tokenize alike. Ported verbatim from tool-runtime.ts's
 * `tokenize`.
 */
export function tokenize(query: string): string[] {
  return query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && term !== "*")
}

/** A term plus its naive singular variants, so "tickets" matches text carrying
 *  only "ticket". Matching is one-directional substring containment, so the
 *  variants are needed only on the query side. Ported from tool-runtime.ts. */
export function termForms(term: string): string[] {
  const forms = [term]
  if (term.endsWith("es") && term.length > 3) forms.push(term.slice(0, -2))
  if (term.endsWith("s") && term.length > 2) forms.push(term.slice(0, -1))
  return forms
}

/** The lowercased haystack one candidate is matched against. */
export function searchText(
  id: string,
  description: string,
  properties: Record<string, unknown> | undefined,
): string {
  const params = Object.entries(properties ?? {}).flatMap(([name, schema]) => {
    const detail =
      typeof schema === "object" && schema !== null && typeof (schema as { description?: unknown }).description === "string"
        ? (schema as { description: string }).description
        : undefined
    return detail === undefined ? [name] : [name, detail]
  })
  return [id, description, ...params].join("\n").toLowerCase()
}

/**
 * Additive field-weighted scoring, summed across terms: exact id or id segment
 * (20) > id substring (8) > description substring (4) > anything else in the
 * search text (2). The weights are tool-runtime's, with `path` read as the
 * tool id.
 */
export function score(candidate: Candidate, terms: readonly (readonly string[])[]): number {
  const id = candidate.id.toLowerCase()
  const description = candidate.description.toLowerCase()
  return terms.reduce((total, forms) => {
    // A term under three characters ("in", "to") is a substring of half the
    // catalog, and one such query would un-defer unrelated tools for the whole
    // session. It still counts as an exact id match, so a tool really called
    // `db` stays findable by name.
    const substantive = (forms[0]?.length ?? 0) >= 3
    return (
      total +
      (forms.some((form) => id === form || id.endsWith(`_${form}`)) ? 20 : 0) +
      (substantive && forms.some((form) => id.includes(form)) ? 8 : 0) +
      (substantive && forms.some((form) => description.includes(form)) ? 4 : 0) +
      (substantive && forms.some((form) => candidate.text.includes(form)) ? 2 : 0)
    )
  }, 0)
}

/**
 * Rank and cut. An empty query returns the catalog in id order (browse), which
 * is why the `score > 0` filter is skipped when there are no terms. Ties break
 * on id so two runs of one query never disagree.
 */
export function rank(candidates: readonly Candidate[], query: string, limit = DEFAULT_SEARCH_LIMIT): Candidate[] {
  const terms = tokenize(query).map(termForms)
  const capped = Math.max(1, Math.min(Math.trunc(limit) || DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT))
  return candidates
    .map((candidate) => ({ candidate, value: score(candidate, terms) }))
    .filter((entry) => terms.length === 0 || entry.value > 0)
    .sort((left, right) => right.value - left.value || left.candidate.id.localeCompare(right.candidate.id))
    .slice(0, capped)
    .map((entry) => entry.candidate)
}

export function catalogLine(candidate: Candidate): string {
  const first = candidate.description.split("\n", 1)[0]!.trim()
  const summary = first.length > 120 ? first.slice(0, 119) + "…" : first
  return summary === "" ? `- ${candidate.id} (${candidate.kind})` : `- ${candidate.id} (${candidate.kind}) — ${summary}`
}

/**
 * The `tool_search` description: the whole catalog, one line per deferred
 * tool. This string is the saving — it replaces every listed tool's full JSON
 * Schema in the request.
 */
export function describe(candidates: readonly Candidate[]): string {
  const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id))
  return [
    "Load the full schema of a tool that is not in your tool list yet.",
    "",
    `The ${sorted.length} tool${sorted.length === 1 ? "" : "s"} below ${sorted.length === 1 ? "is" : "are"} available but deferred: you can see what ${sorted.length === 1 ? "it does" : "they do"}, not how to call ${sorted.length === 1 ? "it" : "them"}.`,
    "Search with the intent plus the key nouns (e.g. \"list tickets on a board\"). Matching tools are added to your",
    "tool list from the next step onward and stay there for the rest of the session, so search once and then call them directly.",
    "",
    "Deferred tools:",
    ...sorted.map(catalogLine),
  ].join("\n")
}

export function report(
  matched: readonly { candidate: Candidate; schema: unknown }[],
  query: string,
  remaining: number,
): string {
  if (matched.length === 0) {
    return [
      `No deferred tool matched "${query}".`,
      remaining > 0
        ? `${remaining} deferred tool${remaining === 1 ? " is" : "s are"} still available — search again with different nouns, or with an empty query to browse them all.`
        : "There are no deferred tools left to find.",
    ].join("\n")
  }
  return [
    `Loaded ${matched.length} tool${matched.length === 1 ? "" : "s"}. ${matched.length === 1 ? "It is" : "They are"} in your tool list from the next step onward, for the rest of this session.`,
    "",
    ...matched.map((entry) =>
      [`## ${entry.candidate.id}`, entry.candidate.description, "", "Parameters:", JSON.stringify(entry.schema, null, 2)].join(
        "\n",
      ),
    ),
  ].join("\n\n")
}

/** Session-scoped loaded-tool state. Held in memory and persisted per session
 *  (t-w2qb1x, session/request-memory-rows.ts): the loaded set decides which
 *  tools the request declares, the head of every provider's cached prefix, so
 *  an engine that forgot it on a restart sent a different tool block and lost
 *  the whole cache. A session this service does not hold is read back from
 *  the database on first use. */
export interface Interface {
  /** `experimental.tool_search` from config, defaults applied. Read per turn, so an edit takes effect without a restart. */
  readonly settings: () => Effect.Effect<Settings>
  readonly loaded: (sessionID: string) => Effect.Effect<ReadonlySet<string>>
  readonly load: (sessionID: string, ids: readonly string[]) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@origami/ToolSearch") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const { db } = yield* Database.Service
    const state = new Map<string, Set<string>>()

    /** The session's set, read from the database when this service does not
     *  hold it. A failed read answers empty and is not kept, so the next call
     *  reads again. */
    const held = Effect.fnUntraced(function* (sessionID: string) {
      const existing = state.get(sessionID)
      if (existing) return existing
      const rows = yield* SessionRequestMemoryRows.load(db, sessionID, "tool_search").pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("tool_search loaded set not read", { "session.id": sessionID, cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      )
      if (!rows) return new Set<string>()
      // Another fiber may have filled it while the read ran.
      const set = state.get(sessionID) ?? new Set(rows.map((row) => row.key))
      state.set(sessionID, set)
      return set
    })

    return Service.of({
      settings: Effect.fn("ToolSearch.settings")(function* () {
        return settings((yield* config.get()).experimental?.tool_search)
      }),
      loaded: (sessionID) => held(sessionID).pipe(Effect.map((set) => set as ReadonlySet<string>)),
      load: (sessionID, ids) =>
        Effect.gen(function* () {
          const set = yield* held(sessionID)
          const added = [...new Set(ids)].filter((id) => !set.has(id))
          if (added.length === 0) return
          // Written before the set changes, and so before the next request
          // declares the tools. A failed write still loads them for this
          // process; only a restart of this session would forget them.
          yield* SessionRequestMemoryRows.write(
            db,
            sessionID,
            added.map((id) => ({ kind: "tool_search" as const, key: id, data: true })),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("tool_search loaded set not written", { "session.id": sessionID, cause }),
            ),
          )
          for (const id of added) set.add(id)
          state.set(sessionID, set)
        }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node, Database.node] })

export * as ToolSearch from "./tool-search"
