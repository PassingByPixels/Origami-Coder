import { SessionPromptCapture } from "@/session/prompt-capture"
import { ToolSearch } from "./tool-search"

/**
 * The OFF state — `tools: { <id>: false }` in origami.json.
 *
 * WHAT THIS FIXES. `tools` has been in the config SCHEMA since the fork
 * (packages/core/src/v1/config/config.ts, `Schema.Record(String, Boolean)`)
 * and nothing in the engine ever read it. A user who wrote
 * `"tools": { "browser": false }` got a file that validated, an editor that
 * autocompleted it, and a tool that stayed switched on — the worst kind of
 * silence, because the setting LOOKS honoured. This module is the read that
 * was missing.
 *
 * OFF IS NOT DEFERRED. `tool-search.ts` decides how a tool is PRESENTED: a
 * deferred tool still exists, costs one catalog line, and `tool_search` can
 * pull its schema in mid-turn. Off means the tool is not in the map handed to
 * the model and not in the catalog either, so there is nothing for a search to
 * find. That is why the two live in separate modules over separate config
 * keys rather than as a third value in `Settings`.
 *
 * Everything here is PURE — plain JSON in, ids out — so the rules are testable
 * without booting an engine, the same shape tool-search.ts keeps.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The patterns switched off, read out of whatever the config object carries.
 *
 * Defensive for the same reason `ACPTools.readSettings` is: origami.json is
 * hand-editable, and a malformed `tools` value must leave every tool ON rather
 * than fail the turn. ONLY an explicit `false` switches a tool off — `true`
 * and every non-boolean are "not switched off", so a truthy value can never
 * disable something by accident.
 */
export function offPatterns(config: unknown): string[] {
  const raw = isRecord(config) ? config["tools"] : undefined
  if (!isRecord(raw)) return []
  return Object.entries(raw)
    .filter(([, value]) => value === false)
    .map(([id]) => id)
}

/**
 * Is this tool switched off?
 *
 * Wildcards are `ToolSearch.matches`, not a second implementation: `defer`
 * and `always` already read `board_*` that way, and two pattern dialects over
 * the same tool ids would be a bug the user experiences as "the same string
 * works in one setting and not the other".
 *
 * REPAIR-ONLY TOOLS ARE EXEMPT, and it is not a courtesy. `invalid` is the
 * destination `experimental_repairToolCall` rewrites a malformed tool call to
 * (session/llm.ts); switch it off and that redirect targets a tool missing
 * from `prepared.tools`, so the repair path breaks for every model that ever
 * emits bad JSON. The UI cannot reach it (it is not listed — acp/tools.ts),
 * but a hand-edited config can name it, so the guard lives HERE, at the read,
 * where every caller inherits it.
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
