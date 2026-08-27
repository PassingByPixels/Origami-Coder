import { PermissionV1 } from "@origami/core/v1/permission"
import { Permission } from "@/permission"
import BOT_DEF_TEMPLATE from "./bot-def-template.txt"

/**
 * The commented definition a scaffolder writes for a NEW bot.
 *
 * Kept in the engine and exported rather than duplicated in the shell: the
 * engine is what decides what `permissions`, `skills` and `memory` mean, so a
 * template held anywhere else drifts the moment one of them gains a value. A UI
 * that offers "new bot" writes THIS.
 */
export const TEMPLATE: string = BOT_DEF_TEMPLATE

/**
 * THE BOT CONTRACT — the frontmatter that turns an agent definition into a
 * configured character.
 *
 * A "bot" is NOT a new concept. It is the agent definition the engine already
 * loads out of the `agent/` directory of every config directory (see
 * config/agent.ts), read for three more things it can now declare about itself:
 *
 *   permissions:   strict | standard | open      a named tier
 *   skills:        [names] | [] | false          which skills it may load
 *   memory:        true | false                  its own persistent store
 *
 * THE MODEL IS NOT ONE OF THEM. A bot pins `model:` or it does not, and an
 * unpinned bot reports that it needs one (`needsModelReason`). There WAS a
 * fourth key — `model_prefer:`, an ordered list of capability tokens resolved
 * against the live catalog whenever no pin was present — and the owner's ruling
 * removed it: "a bot simply needs a pinned model, period". It was a second
 * answer to "which model does this run on" that fired only when the first was
 * missing, so the honest reading of a bot's model needed two rules and a catalog
 * lookup instead of one line of frontmatter. A definition still carrying the key
 * parses exactly as before and the key is IGNORED.
 *
 * ALL OF THEM RIDE `options`. `ConfigAgentV1.normalize` sweeps every frontmatter
 * key it does not know into `options`, which is the same route `collab:` and
 * `vision:` already take — so none of this needs a schema change and an older
 * engine reading a newer definition simply ignores the keys. That is also what
 * makes dropping `model_prefer:` a no-op for files on disk.
 *
 * EVERY DEFAULT IS TODAY'S BEHAVIOUR. A definition carrying none of these keys
 * produces an EMPTY ruleset, so nothing already on disk changes meaning.
 *
 * WHERE THE TIERS COME FROM. They are the shipped collab presets under names a
 * human can pick from a list: `strict` is the OBSERVER block and `standard` is
 * the WORKER block (packages/vscode/src/dashboard/agentManager/collabPresets.ts),
 * re-expressed here as a ruleset instead of a YAML string so the engine — not a
 * text template — is what decides what a tier means. `open` adds nothing, which
 * is what a definition with no `permission:` block has always been.
 *
 * PRECEDENCE. `agent.ts` merges this ruleset BEFORE the definition's own
 * `permission:` block, so an explicit line in the file always beats the tier it
 * asked for. A tier is a starting point, never a ceiling.
 */

export type PermissionTier = "strict" | "standard" | "open"

const TIERS = ["strict", "standard", "open"] as const

export type Contract = {
  /** The named tier, when the definition asked for one this build knows. */
  readonly tier?: PermissionTier
  /** A `permissions:` value that is not a tier. Reported, never guessed at. */
  readonly unknownTier?: string
  /**
   * Skill names this bot may load. `undefined` = every skill (today's
   * behaviour). An EMPTY array = none, which is a real, different answer.
   */
  readonly skills?: readonly string[]
  /** Whether this bot keeps its own persistent memory. Default true. */
  readonly memory: boolean
}

/**
 * The permission block a tier expands to.
 *
 * Key order is precedence: `"*": deny` first (it flips the engine's permissive
 * base default, the same way `explore` and `plan` do in agent.ts), then the
 * re-grants, so `findLast` resolves each named tool to its allow and everything
 * else to deny.
 *
 * NO `write` KEY, deliberately — this engine has no `write` permission; `edit`
 * covers write/edit/patch. A `write: allow` line would parse and grant nothing.
 *
 * ONE DELIBERATE DIFFERENCE FROM THE COLLAB PRESETS: both tiers re-grant
 * `skill`. A preset's bare `"*": deny` closes `skill` as a side effect, which
 * would make the `skills:` allowlist unreachable for every tiered bot — the
 * allowlist could only ever narrow a door the tier had already shut. A skill is
 * INSTRUCTIONS, not a capability: the tools it tells the model to reach for are
 * still gated by the same ruleset, so granting it costs nothing the tier meant
 * to withhold. `skills:` is the control for skills; the tier stays out of it.
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

/** A `permissions:` value that is not a tier, rendered for a human to read.
 *  Never `String(value)`: a mapping stringifies to "[object Object]", which
 *  tells the person who mistyped the key nothing about what they wrote. */
function describe(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

const isTier = (value: unknown): value is PermissionTier =>
  typeof value === "string" && (TIERS as readonly string[]).includes(value)

/**
 * The skills list a definition declared.
 *
 * `false` and `[]` both mean NO skills — a bot that should never load one. A
 * missing key means every skill, which is what an agent has always had.
 * Non-string entries are dropped rather than written out as a pattern: a
 * pattern built from a number would silently match nothing and read as a typo
 * that "worked".
 */
function readSkills(value: unknown): readonly string[] | undefined {
  if (value === false) return []
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

/**
 * Whether a definition is a BOT — a configured CHARACTER, not the workspace's
 * own agent.
 *
 * THREE facts, all already on disk, and all three written by the Bots pane on
 * every file it saves (`packages/vscode/src/dashboard/collabAgentSerialize.ts`
 * emits `mode: all` + `hidden: true` + `collab: true`):
 *
 *   native !== true   an engine agent (build/plan/explore/compaction/…) is the
 *                     workspace's own identity and never a character;
 *   hidden === true   off the ordinary chat picker — a roster member, not a mode;
 *   collab            opted into rooms, which is what a bot IS. Same truthiness
 *                     rule as `ACPCollab.collabCapable`, so a YAML-quoted
 *                     `collab: "true"` counts here exactly as it does there.
 *
 * NO NEW FRONTMATTER KEY, deliberately. A `compose:` flag would have to be
 * written by the extension before any definition could gain the behaviour, and
 * every bot already on disk would keep the old composition — the shape above
 * already says "character", so it is the data this reads.
 *
 * WHAT IT DECIDES: how the turn's system prompt is composed. A bot's persona
 * sits ON TOP of the base prompt instead of replacing it, and the workspace's
 * instruction files are not delivered to it — see `LLMRequestPrep.prepare` and
 * `SessionPrompt` for the two halves of that matrix.
 *
 * A `vision-profile: true` definition is NOT a bot: the serializer writes that
 * key INSTEAD of `collab:`, and such a def is a describe-only agent a tool
 * calls, never an identity a human chats as.
 */
export function isBot(info: {
  readonly native?: boolean
  readonly hidden?: boolean
  readonly options: Record<string, unknown>
}): boolean {
  return info.native !== true && info.hidden === true && Boolean(info.options["collab"])
}

/** Read the contract off a definition's swept-up `options` record. */
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
 * The ruleset a contract adds, in evaluation order.
 *
 * The tier goes first so its `"*": deny` cannot swallow the skills allowlist
 * that follows it — `Permission.evaluate` is findLast, so a later `skill/alpha`
 * allow still resolves under an earlier deny-all.
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
