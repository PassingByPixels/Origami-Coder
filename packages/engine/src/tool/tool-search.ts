import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Config } from "@/config/config"

/**
 * Deferred tool catalog for the PRIMARY tool list.
 *
 * The problem: every connected MCP server pushes its whole tool list — names,
 * descriptions and full JSON Schemas — into the system prompt of every turn,
 * whether or not the model ever calls one. With two or three servers that is
 * thousands of tokens the user pays for on every request.
 *
 * The trade this module makes is the one `$codemode.search` already makes
 * inside the confined interpreter (packages/codemode/src/tool-runtime.ts): a
 * deferred tool is advertised as ONE catalog line — id, kind and a truncated
 * first line of its description — instead of a schema. `tool_search` turns a
 * query into the matching tools' full schemas, and the ids it matched are
 * remembered per session, so the tool stays callable for the rest of that
 * session rather than only for the step that searched.
 *
 * The scoring is ported from `makeSearchTool` in tool-runtime.ts deliberately:
 * two search surfaces that rank the same tools differently would be a bug the
 * user experiences as "it found it in code mode but not here".
 *
 * Everything above the service at the bottom of this file is PURE — no Effect,
 * no config, no MCP — so the ranking, the deferral rules and the rendered
 * catalog can all be tested without booting an engine.
 */

export const TOOL_SEARCH_TOOL = "tool_search"

/** How many tools one search materialises when the caller names no limit. */
export const DEFAULT_SEARCH_LIMIT = 5
/** Hard ceiling, so a `limit: 500` cannot undo the whole point of deferral. */
export const MAX_SEARCH_LIMIT = 20

export type Kind = "builtin" | "mcp"

/**
 * What the deferral decision needs. Deliberately smaller than `Candidate`:
 * the decision runs over EVERY tool on every step of the loop, while the
 * search text is only ever read for the handful that end up deferred, so
 * building it for all of them would be work thrown away on each step.
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

/**
 * Pattern match for the `defer` / `always` opt-in lists. `*` is the only
 * wildcard and it matches any run of characters, so a whole MCP server is
 * named `board_*` and one tool by its exact id. Anchored at both ends: a bare
 * `board` must not silently opt in `board_create` too.
 */
export function matches(pattern: string, id: string): boolean {
  if (pattern === id) return true
  if (!pattern.includes("*")) return false
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === "*" ? "[\\s\\S]*" : "\\" + char))
  return new RegExp("^" + escaped + "$").test(id)
}

const listed = (patterns: readonly string[], id: string) => patterns.some((pattern) => matches(pattern, id))

/**
 * Which candidates are hidden behind the catalog for THIS session.
 *
 * Order matters and is the reason this is one function rather than three
 * predicates: `always` is the user's escape hatch and outranks everything,
 * then anything already loaded by a search this session, then the explicit
 * `defer` list, and only then the by-kind defaults. Without that order a user
 * who wrote `always: ["board_*"]` would still lose the tools the moment the
 * MCP default flipped them on.
 */
export function deferred(
  entries: readonly Entry[],
  config: Settings,
  loaded: ReadonlySet<string> = new Set(),
): string[] {
  if (!config.enabled) return []
  return entries
    .filter((entry) => {
      if (entry.id === TOOL_SEARCH_TOOL) return false
      if (listed(config.always, entry.id)) return false
      if (loaded.has(entry.id)) return false
      if (listed(config.defer, entry.id)) return true
      if (entry.kind === "mcp") return config.mcp
      return entry.deferrable === true
    })
    .map((entry) => entry.id)
}

/**
 * Split a query into lowercased terms. camelCase boundaries split
 * (`readFile` -> `read file`) and every non-alphanumeric character separates,
 * so `read-file`, `readFile` and `read file` tokenize alike. `*` is dropped.
 * Ported verbatim from tool-runtime.ts's `tokenize`.
 */
export function tokenize(query: string): string[] {
  return query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && term !== "*")
}

/**
 * A term plus its naive singular variants, so a plural query term ("tickets")
 * still matches text carrying only the singular ("ticket"). Matching is
 * one-directional substring containment, so the variants are needed only on
 * the query side. Ported from tool-runtime.ts's `termForms`.
 */
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
 * search text, including parameter names (2). The weights are tool-runtime's,
 * with `path` read as the tool id — an MCP id is already `server_tool`, so the
 * "segment" rule matches the same way a dotted path did.
 */
export function score(candidate: Candidate, terms: readonly (readonly string[])[]): number {
  const id = candidate.id.toLowerCase()
  const description = candidate.description.toLowerCase()
  return terms.reduce(
    (total, forms) =>
      total +
      (forms.some((form) => id === form || id.endsWith(`_${form}`)) ? 20 : 0) +
      (forms.some((form) => id.includes(form)) ? 8 : 0) +
      (forms.some((form) => description.includes(form)) ? 4 : 0) +
      (forms.some((form) => candidate.text.includes(form)) ? 2 : 0),
    0,
  )
}

/**
 * Rank and cut. An empty query returns the catalog in id order (browse), which
 * is why the `score > 0` filter is skipped when there are no terms. Ties break
 * on id so two runs of the same query never disagree.
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

/** One catalog line: the id, its origin, and the first line of its description. */
export function catalogLine(candidate: Candidate): string {
  const first = candidate.description.split("\n", 1)[0]!.trim()
  const summary = first.length > 120 ? first.slice(0, 119) + "…" : first
  return summary === "" ? `- ${candidate.id} (${candidate.kind})` : `- ${candidate.id} (${candidate.kind}) — ${summary}`
}

/**
 * The `tool_search` description: the whole catalog, one line per deferred
 * tool, plus how to reach one. This string IS the saving — it replaces every
 * listed tool's full JSON Schema in the request.
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

/** The model-facing result of a search: what was loaded, and how to call it. */
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

/**
 * Session-scoped loaded-tool state.
 *
 * Deliberately in memory rather than on the session row: this is a context
 * budget decision for a live conversation, not user data, and the model
 * re-searches for free after an engine restart. The cost of getting that wrong
 * is one extra `tool_search` call; the cost of a schema migration is not.
 */
export interface Interface {
  /** `experimental.tool_search` from config, defaults applied. Read per turn, so an edit takes effect without a restart. */
  readonly settings: () => Effect.Effect<Settings>
  readonly loaded: (sessionID: string) => Effect.Effect<ReadonlySet<string>>
  readonly load: (sessionID: string, ids: readonly string[]) => Effect.Effect<void>
  readonly clear: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@origami/ToolSearch") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const state = new Map<string, Set<string>>()
    return Service.of({
      settings: Effect.fn("ToolSearch.settings")(function* () {
        return settings((yield* config.get()).experimental?.tool_search)
      }),
      loaded: (sessionID) => Effect.sync(() => (state.get(sessionID) ?? new Set()) as ReadonlySet<string>),
      load: (sessionID, ids) =>
        Effect.sync(() => {
          const set = state.get(sessionID) ?? new Set<string>()
          for (const id of ids) set.add(id)
          state.set(sessionID, set)
        }),
      clear: (sessionID) => Effect.sync(() => void state.delete(sessionID)),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node] })

export * as ToolSearch from "./tool-search"
