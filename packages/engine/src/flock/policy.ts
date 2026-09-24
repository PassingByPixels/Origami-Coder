import path from "node:path"
import type { PermissionV1 } from "@origami/core/v1/permission"

/**
 * The three switches an owner sets per friend, in read order.
 *
 * 1. MODEL — no default, and deliberately never will be: choosing one would
 *    spend the owner's money on a decision they never made. Unset means every
 *    inbound question is refused with a sentence the asker can act on.
 * 2. BUDGET, before the approval prompt: approving a question the next check
 *    refuses anyway is a worse prompt than no prompt.
 * 3. AUTO-ANSWER, off by default — running a model against the owner's files
 *    is a decision, not a default.
 *
 * Scope is not a switch: it is the cage `frontdesk.ts` builds, sharing nothing.
 */

/** What an owner may override for ONE friend. Anything absent falls back to `flock.frontDesk`. */
export interface Overrides {
  readonly autoAnswer?: boolean
  readonly dailyBudgetTokens?: number
  readonly model?: string
  readonly scope?: Scope
}

/** The repos, wiki folders and plain folders an owner marked shareable. SKILLS
 *  ARE NOT HERE: a skill is instructions, not a secret, so the desk reads them
 *  unconditionally through the `skill` permission on the archetype. A stored
 *  `skills` list from an older config is DROPPED on read ({@link sanitiseScope})
 *  rather than honoured, so an old tick cannot go on quietly widening a path cage
 *  nobody can see any more. FOLDERS are ABSOLUTE paths, checked before they are
 *  stored (`scope-folders.ts`), and turned into read rules the way `repos` are. */
export interface Scope {
  readonly repos?: readonly string[]
  readonly wiki?: readonly string[]
  readonly folders?: readonly string[]
}

/** Every list in a scope, in the one order the ruleset and the card both use. */
export function globs(scope: Scope): string[] {
  return [...(scope.repos ?? []), ...(scope.wiki ?? []), ...(scope.folders ?? [])].filter(Boolean)
}

/** A scope as read from disk, with anything no longer shareable dropped. Both
 *  stores are hand-editable files that predate this shape, so a `skills` list in
 *  either is dropped here, on the READ, rather than left to a writer that may
 *  never run. Unknown keys go with it: only the three lists are returned, so a
 *  field a newer build added cannot reach the ruleset through an older one. */
export function sanitiseScope(raw: unknown): Scope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const list = (key: string): string[] | undefined => {
    const value = source[key]
    if (!Array.isArray(value)) return undefined
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
  }
  const scope: { repos?: string[]; wiki?: string[]; folders?: string[] } = {}
  for (const key of ["repos", "wiki", "folders"] as const) {
    const value = list(key)
    if (value) scope[key] = value
  }
  return scope
}

/** The `flock.frontDesk` config block, as read. Every field is optional; `model` is required to ANSWER. */
export interface FrontDeskConfig {
  readonly model?: string
  readonly dailyBudgetTokens?: number
  readonly scope?: Scope
  /** The DESK-WIDE default for `autoAnswer`, for a friend with no override of
   *  their own. Still off unless the owner turns it on; this only saves setting
   *  the same switch twenty times. Stored in `flock.json` (`store.ts` says why),
   *  not in the config file the other three fields come from. */
  readonly autoAnswer?: boolean
}

export interface Resolved {
  readonly model: string | undefined
  readonly dailyBudgetTokens: number | undefined
  readonly autoAnswer: boolean
  readonly scope: Scope
}

export function resolve(input: { config?: FrontDeskConfig; overrides?: Overrides }): Resolved {
  return {
    model: input.overrides?.model ?? input.config?.model,
    dailyBudgetTokens: input.overrides?.dailyBudgetTokens ?? input.config?.dailyBudgetTokens,
    autoAnswer: input.overrides?.autoAnswer ?? input.config?.autoAnswer ?? false,
    scope: input.overrides?.scope ?? input.config?.scope ?? {},
  }
}

/** The refusal an unset model produces, verbatim on both sides of the wire. */
export const MODEL_UNSET = "front desk model not set"

export type Decision =
  | { readonly kind: "answer"; readonly model: string }
  /** The owner has to say yes first. `frontdesk.ts` parks on the permission surface. */
  | { readonly kind: "approve"; readonly model: string }
  | { readonly kind: "refuse"; readonly reason: string }

/** The UTC day a spend counts against. UTC, not local: two friends in two zones share one budget. */
export function day(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** When the budget refills, as an ISO instant the refusal can name. */
export function resetsAt(now = new Date()): string {
  const next = new Date(now)
  next.setUTCHours(0, 0, 0, 0)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString()
}

export function decide(input: { policy: Resolved; spentToday: number; now?: Date }): Decision {
  const model = input.policy.model
  if (!model) return { kind: "refuse", reason: MODEL_UNSET }
  const budget = input.policy.dailyBudgetTokens
  if (budget !== undefined && input.spentToday >= budget) {
    return {
      kind: "refuse",
      reason: `daily budget of ${budget} tokens is spent; it resets at ${resetsAt(input.now)}`,
    }
  }
  return input.policy.autoAnswer ? { kind: "answer", model } : { kind: "approve", model }
}

/** A trailing separator off a glob, so `D:/notes/` and `D:/notes` build one rule. */
function trimmed(glob: string): string {
  return glob.replace(/[/\\]+$/, "")
}

/**
 * THE PATH CAGE, as permission rules the front desk session runs under.
 *
 * Deny first, then allow each shareable glob: `Permission.evaluate` is findLast,
 * so the denial must be the rule the allows overwrite. An empty scope produces a
 * bare deny, the correct answer for an owner who has shared nothing.
 *
 * Two permissions, because a shared folder crosses two gates. `read` is the path
 * gate and `tool/read.ts` asks with `path.relative(worktree, filepath)`, so a
 * rule must be written in the SAME relative form or it matches nothing — that is
 * why {@link scopeRuleset} takes a worktree. Both forms are emitted, because on
 * win32 across drives `path.relative` hands back the absolute path unchanged.
 *
 * `external_directory` is the boundary gate, denied outright by the archetype and
 * re-allowed here for exactly the shared entries and nothing else.
 * `tool/external-directory.ts` fixes the shape it must match: the ask is always
 * the parent directory of the target plus `/`+`*`, so an entry glob covers the
 * entry and everything under it, while a sibling or the level above fails.
 *
 * NOT GATED HERE: `grep` and `glob` ask with the SEARCH PATTERN, not a path, so
 * no ruleset written here can path-scope them; they are bounded by the same
 * `external_directory` ask, which they make with their SEARCH ROOT.
 */
export function scopeRuleset(scope: Scope, options: { worktree?: string } = {}): PermissionV1.Rule[] {
  const shareable = globs(scope)
  const rules: PermissionV1.Rule[] = [{ permission: "read", pattern: "*", action: "deny" }]
  const allowRead = (glob: string) => {
    rules.push({ permission: "read", pattern: glob, action: "allow" })
    // A bare folder in the scope means the folder AND what is under it. Writing
    // `wiki` in a config and getting nothing but the directory entry itself is
    // the mistake every one of these lists invites.
    if (!glob.includes("*")) rules.push({ permission: "read", pattern: `${trimmed(glob)}/**`, action: "allow" })
  }
  for (const glob of shareable) {
    allowRead(glob)
    // Only an ABSOLUTE entry can name something outside the worktree. A relative
    // one is already worktree-shaped and needs neither of the two rules below.
    if (!path.isAbsolute(glob)) continue
    rules.push({ permission: "external_directory", pattern: `${trimmed(glob)}/**`, action: "allow" })
    if (!options.worktree) continue
    const relative = path.relative(options.worktree, glob).replaceAll("\\", "/")
    // '' means the entry IS the worktree, and an unchanged path means win32
    // gave back the absolute one across drives. Neither is a second rule.
    if (!relative || relative === glob.replaceAll("\\", "/")) continue
    allowRead(relative)
  }
  return rules
}

export * as FlockPolicy from "./policy"
