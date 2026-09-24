import { PermissionV1 } from "@origami/core/v1/permission"
import { Permission } from "@/permission"
import BOT_DEF_TEMPLATE from "./bot-def-template.txt"

/** The commented definition a scaffolder writes for a NEW bot. Kept in the
 *  engine, not the shell: the engine decides what these keys mean, and a
 *  template held elsewhere drifts the moment one of them gains a value. */
export const TEMPLATE: string = BOT_DEF_TEMPLATE

/**
 * THE BOT CONTRACT — the frontmatter that turns an agent definition into a
 * configured character.
 *
 * A "bot" is the agent definition the engine already loads out of `agent/` (see
 * config/agent.ts), read for three more things it can declare about itself:
 *
 *   permissions:   strict | standard | open      a named tier
 *   skills:        [names] | [] | false          which skills it may load
 *   memory:        true | false                  its own persistent store
 *
 * The MODEL is not one of them: a bot pins `model:` or reports that it needs one
 * (`needsModelReason`). `model_prefer:` is a retired fourth key — still parses,
 * and is IGNORED.
 *
 * All three ride `options`, which `ConfigAgentV1.normalize` sweeps unknown
 * frontmatter keys into (the route `collab:` and `vision:` take), so none of
 * this needs a schema change and an older engine ignores the keys. A definition
 * carrying none of them produces an EMPTY ruleset.
 *
 * The tiers are the shipped collab presets under human-pickable names (`strict`
 * = OBSERVER, `standard` = WORKER; vscode/.../agentManager/collabPresets.ts),
 * re-expressed as a ruleset so the engine decides what a tier means.
 *
 * PRECEDENCE: `agent.ts` merges this ruleset BEFORE the definition's own
 * `permission:` block, so an explicit line always beats the tier it asked for. A
 * tier is a starting point, never a ceiling.
 */

export type PermissionTier = "strict" | "standard" | "open"

const TIERS = ["strict", "standard", "open"] as const

export type Contract = {
  readonly tier?: PermissionTier
  /** A `permissions:` value that is not a tier. Reported, never guessed at. */
  readonly unknownTier?: string
  /** Skill names this bot may load. `undefined` = every skill; an EMPTY array =
   *  none, which is a real, different answer. */
  readonly skills?: readonly string[]
  /** Default true. */
  readonly memory: boolean
}

/**
 * The permission block a tier expands to. Key order is precedence: `"*": deny`
 * first (flipping the engine's permissive base, as `explore` and `plan` do in
 * agent.ts), then the re-grants, so `findLast` resolves each named tool to its
 * allow and everything else to deny. No `write` key, deliberately — this engine
 * has no `write` permission; `edit` covers write/edit/patch.
 *
 * Both tiers re-grant `skill`, unlike the collab presets: a bare `"*": deny`
 * closes `skill` as a side effect, which would make the `skills:` allowlist
 * unreachable for every tiered bot. A skill is INSTRUCTIONS, not a capability —
 * the tools it names are still gated by the same ruleset — so `skills:` is the
 * control for skills and the tier stays out of it.
 */
const TIER_RULES: Record<PermissionTier, Record<string, PermissionV1.Action>> = {
  strict: {
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    wiki_search: "allow",
    wiki_related: "allow",
    list: "allow",
    skill: "allow",
    edit: "deny",
    bash: "deny",
    task: "deny",
    todowrite: "deny",
  },
  standard: {
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    wiki_search: "allow",
    wiki_related: "allow",
    list: "allow",
    skill: "allow",
    edit: "allow",
    bash: "allow",
    task: "deny",
    todowrite: "deny",
  },
  open: {},
}

/** A `permissions:` value that is not a tier, rendered for a human. Never
 *  `String(value)`: a mapping stringifies to "[object Object]", which tells the
 *  person who mistyped the key nothing. */
function describe(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

const isTier = (value: unknown): value is PermissionTier =>
  typeof value === "string" && (TIERS as readonly string[]).includes(value)

/** The skills list a definition declared. `false` and `[]` both mean NO skills;
 *  a missing key means every skill. Non-string entries are dropped: a pattern
 *  built from a number would match nothing and read as a typo that "worked". */
function readSkills(value: unknown): readonly string[] | undefined {
  if (value === false) return []
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

/**
 * Whether a definition is a BOT — a configured CHARACTER, not the workspace's
 * own agent.
 *
 * THREE facts, all written by the Bots pane on every file it saves
 * (`packages/vscode/src/dashboard/collabAgentSerialize.ts`):
 *
 *   native !== true   an engine agent is the workspace's own identity;
 *   hidden === true   off the chat picker — a roster member, not a mode;
 *   collab            opted into rooms, which is what a bot IS. Same truthiness
 *                     rule as `ACPCollab.collabCapable`, so a YAML-quoted
 *                     `collab: "true"` counts here exactly as it does there.
 *
 * Read off that shape rather than a new `compose:` flag, so every bot already on
 * disk gains the behaviour without being rewritten.
 *
 * WHAT IT DECIDES: how the turn's system prompt is composed. A bot's persona
 * sits ON TOP of the base prompt instead of replacing it, and the workspace's
 * instruction files are not delivered to it (`LLMRequestPrep.prepare`,
 * `SessionPrompt`). A `vision-profile: true` definition is NOT a bot — the
 * serializer writes that key INSTEAD of `collab:`, and such a def is
 * describe-only, never an identity a human chats as.
 */
export function isBot(info: {
  readonly native?: boolean
  readonly hidden?: boolean
  readonly options: Record<string, unknown>
}): boolean {
  return info.native !== true && info.hidden === true && Boolean(info.options["collab"])
}

export function read(options: Record<string, unknown>): Contract {
  const permissions = options["permissions"]
  return {
    ...(isTier(permissions) ? { tier: permissions } : {}),
    ...(permissions !== undefined && !isTier(permissions) ? { unknownTier: describe(permissions) } : {}),
    ...(readSkills(options["skills"]) !== undefined ? { skills: readSkills(options["skills"]) } : {}),
    memory: options["memory"] !== false,
  }
}

/**
 * The ruleset a contract adds, in evaluation order. The tier goes first so its
 * `"*": deny` cannot swallow the skills allowlist that follows — evaluation is
 * findLast, so a later `skill/alpha` allow still resolves under an earlier
 * deny-all.
 */
export function ruleset(contract: Contract): PermissionV1.Rule[] {
  const rules: PermissionV1.Rule[] = []
  if (contract.tier) rules.push(...Permission.fromConfig(TIER_RULES[contract.tier]))
  if (contract.skills) {
    rules.push(...Permission.fromConfig({ skill: { "*": "deny" } }))
    for (const name of contract.skills) rules.push(...Permission.fromConfig({ skill: { [name]: "allow" } }))
  }
  return rules
}

/** Read the contract and expand it in one step — what `agent.ts` calls. */
export function rulesetFor(options: Record<string, unknown>): PermissionV1.Rule[] {
  return ruleset(read(options))
}

export * as AgentBot from "./bot"
