import { SessionPromptCapture } from "@/session/prompt-capture"
import { ToolSearch } from "./tool-search"

/**
 * The off state — `tools: { <id>: false }` in origami.json.
 *
 * Off is not deferred. `tool-search.ts` decides how a tool is presented: a
 * deferred tool still exists, costs one catalog line, and `tool_search` can pull
 * its schema in mid-turn. Off means the tool is in neither the map handed to the
 * model nor the catalog, so there is nothing for a search to find — which is why
 * the two live in separate modules over separate config keys.
 *
 * Everything here is pure — plain JSON in, ids out.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The patterns switched off, read out of whatever the config object carries.
 * origami.json is hand-editable, so a malformed `tools` value must leave every
 * tool on rather than fail the turn. Only an explicit `false` switches a tool
 * off; `true` and every non-boolean mean "not switched off".
 */
export function offPatterns(config: unknown): string[] {
  const raw = isRecord(config) ? config["tools"] : undefined
  if (!isRecord(raw)) return []
  return Object.entries(raw)
    .filter(([, value]) => value === false)
    .map(([id]) => id)
}

/**
 * Is this tool switched off? Wildcards go through `ToolSearch.matches` rather
 * than a second implementation, or the same string would work in one setting
 * and not the other.
 *
 * Repair-only tools are exempt: `invalid` is where
 * `experimental_repairToolCall` rewrites a malformed call, so switching it off
 * would break the repair path for every model that emits bad JSON. The UI cannot
 * reach it, but a hand-edited config can, so the guard lives here at the read.
 */
export function isOff(id: string, patterns: readonly string[]): boolean {
  if (SessionPromptCapture.REPAIR_ONLY_TOOLS.has(id)) return false
  return patterns.some((pattern) => ToolSearch.matches(pattern, id))
}

/** Drop the switched-off entries, keeping order. */
export function keepEnabled<T extends { readonly id: string }>(
  items: readonly T[],
  patterns: readonly string[],
): T[] {
  if (patterns.length === 0) return [...items]
  return items.filter((item) => !isOff(item.id, patterns))
}

export * as ToolEnabled from "./tool-enabled"
