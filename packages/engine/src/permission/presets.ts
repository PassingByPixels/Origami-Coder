import { PermissionV1 } from "@origami/core/v1/permission"

/**
 * The per-chat auto-approve presets, expressed as the `tools` map a prompt
 * carries (acp/service.ts sends it on EVERY prompt; session/prompt.ts turns each
 * entry into `{ permission: key, pattern: "*", action: enabled ? allow : deny }`
 * and REPLACES the session ruleset with the result).
 *
 * - `default` is an EMPTY map, which clears the session ruleset back to the
 *   agent defaults (ask). That reset is why the map is always sent.
 * - `auto` allows file edits (edit/write/apply_patch all ask under `edit`).
 * - `bypass` allows every permission via the `*` wildcard.
 *
 * The table lives here, not in acp/service.ts, because two very different
 * callers need it: the ACP frontend WRITES these rules, and
 * agent/subagent-permissions.ts has to RECOGNISE them coming back out of a
 * parent session. A copy in each place would be a mirror that drifts.
 */
const PRESETS: Record<string, Record<string, boolean>> = {
  default: {},
  auto: { edit: true },
  bypass: { "*": true },
}

/** The prompt `tools` map for a preset. Unknown/absent mode = `default`. */
export function tools(mode: string | undefined): Record<string, boolean> {
  return { ...(PRESETS[mode ?? "default"] ?? PRESETS["default"]) }
}

/**
 * The SESSION RULESET a preset stands for - the same translation session/prompt.ts
 * makes out of the `tools` map, done here so the ACP layer can write the rules onto
 * the engine's session row the moment the user picks a preset, instead of waiting
 * for a prompt to carry them. `default` is an empty ruleset, which is the reset.
 */
export function rules(mode: string | undefined): PermissionV1.Rule[] {
  return Object.entries(tools(mode)).map(([permission, enabled]) => ({
    permission,
    action: enabled ? "allow" : "deny",
    pattern: "*",
  }))
}

/**
 * Is this session rule one a preset wrote - i.e. the user's LIVE auto-approve
 * choice for this chat, rather than an ordinary configured allow?
 *
 * Derived from the table above, so adding a preset key cannot leave this behind.
 */
export function isOverride(rule: PermissionV1.Rule): boolean {
  if (rule.action !== "allow" || rule.pattern !== "*") return false
  return Object.values(PRESETS).some((map) => map[rule.permission] === true)
}

/**
 * Which preset wrote this stored ruleset, if any - the inverse of {@link rules},
 * off the same table.
 *
 * A chat that is LOADED, RESUMED or FORKED has to come back on the preset its row
 * still carries. Without this the ACP layer reports `default` for a chat the user
 * left on bypass, and the next prompt's empty `tools` map clears the grant the row
 * was holding (prompt.ts treats a present map as an authoritative replace).
 * Anything the table cannot name exactly - no preset rules, an ordinary configured
 * allow, or two presets' rules at once - is `undefined`, i.e. `default`, because
 * guessing here silently changes what a chat may do.
 */
export function modeFor(ruleset: PermissionV1.Ruleset | undefined): string | undefined {
  const permissions = new Set((ruleset ?? []).filter(isOverride).map((rule) => rule.permission))
  if (permissions.size === 0) return undefined
  for (const [mode, map] of Object.entries(PRESETS)) {
    const keys = Object.keys(map)
    if (keys.length !== permissions.size) continue
    if (keys.every((key) => permissions.has(key))) return mode
  }
  return undefined
}

export * as PermissionPresets from "./presets"
