import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Skill } from "@/skill"
import { Effect } from "effect"
import type * as ACPError from "./error"

/**
 * Read-only projection of the engine's skill registry for the `list_skills`
 * ext method. The VS Code Skills pane (`SkillsPane.svelte`) indexes into six
 * fixed fields on every entry — this module maps `Skill.Info` (`@/skill`,
 * the registry actually wired into `AppLayer` and behind the SDK's
 * `app.skills` endpoint — NOT `packages/core/src/skill.ts`'s unwired "v2"
 * registry) onto that shape.
 */

export type SkillTier = "base" | "optin" | "agentspecific"

export type SkillEntry = {
  readonly name: string
  readonly description: string
  readonly tier: SkillTier
  readonly ownerAgents: readonly string[]
  readonly tags: readonly string[]
  readonly immutable: boolean
  /**
   * The skill's own `category:` frontmatter, verbatim — a REAL engine fact,
   * unlike the four constants above. It is FREE-FORM: the registry never checks
   * it against a list, so a consumer must render whatever arrives and must not
   * switch on a closed set.
   *
   * OMITTED for a skill that has no usable one, which folds together three
   * frontmatter spellings that all mean "uncategorised": no `category:` line at
   * all, a bare `category:` (YAML null), and an explicit empty string. Sending
   * `""` for the last would render as a blank chip — a category that exists and
   * says nothing — so all three arrive here as absent.
   */
  readonly category?: string
  /**
   * Where the skill was discovered — the SKILL.md path (or pulled-URL cache
   * path) from `Skill.Info.location`. A real, engine-known fact, unlike the
   * four constants above: the card can show provenance instead of guessing it.
   */
  readonly location: string
  /**
   * Opening excerpt of the skill body, hard-capped. Omitted when the body is
   * blank — an empty string would render as a card with a mysteriously empty
   * section. Full content stays off the wire: a shell that wants it opens
   * `location` itself, the same rule `list_instructions` follows for sizes.
   */
  readonly contentPreview?: string
}

/** A SKILL.md found on disk that produced no skill — see `Skill.Problem`. */
export type SkillProblem = {
  readonly location: string
  readonly message: string
}

export type SkillsResult = {
  readonly skills: readonly SkillEntry[]
  /** Omitted entirely when the scan was clean, so a healthy list stays a bare `{ skills }`. */
  readonly problems?: readonly SkillProblem[]
}

/** The seam the ACP service depends on, so tests need no engine boot. */
export type Interface = {
  readonly list: (directory: string, options?: ListOptions) => Effect.Effect<SkillsResult, ACPError.Error>
}

/**
 * `refresh` makes the call re-walk the skill directories instead of answering
 * from the boot-time scan. Off by default: the initial load of a pane does not
 * need it, and a re-scan re-fetches every configured `skills.urls` entry over
 * the network. The Skills pane's refresh BUTTON sets it — that button re-read a
 * cache that could never change, so it looked like a refresh and did nothing.
 */
export type ListOptions = {
  readonly refresh?: boolean
}

/** Hard cap on a `contentPreview`, counted in code points. */
export const CONTENT_PREVIEW_LIMIT = 300

/**
 * Truncate on CODE POINTS, never UTF-16 units, so a cut can't leave a lone
 * surrogate half on the wire (same rule `run-steps.ts` applies to `preview`).
 * A skill body is markdown authored by anyone — emoji and CJK are normal.
 */
export function contentPreview(content: string): string | undefined {
  const trimmed = (content ?? "").trim()
  if (!trimmed) return undefined
  const points = Array.from(trimmed)
  if (points.length <= CONTENT_PREVIEW_LIMIT) return trimmed
  return `${points.slice(0, CONTENT_PREVIEW_LIMIT - 1).join("")}…`
}

/**
 * Project one engine skill onto the consumer's six fields. `Skill.Info` is
 * `{ name, description?, location, content }` (see `@/skill`) — everything
 * beyond name/description is a DEFAULT, not a derived fact, because this
 * fork's registry has no equivalent concept:
 *
 * - `tier`: always "base". Discovery (`discoverSkills` in `@/skill`) is a
 *   flat merge of external dirs, configured directories/paths, and pulled
 *   URLs — there is no opt-in/agent-specific classification on a skill
 *   itself. `Permission.evaluate("skill", …)` gates a skill per the CALLING
 *   agent's ruleset (ask/allow/deny) — that is agent-scoped policy, not a
 *   property of the skill, so it cannot be collapsed into a fixed tier here.
 * - `ownerAgents`: always `[]`. No per-skill "restricted to these agents"
 *   declaration exists anywhere in `Skill.Info` or the discovery pipeline.
 * - `tags`: always `[]`. No tag field exists on `Skill.Info`. `category` is NOT
 *   folded in here — it is a real frontmatter field and is projected as itself,
 *   so a card cannot present an engine fact and a placeholder as one list.
 * - `immutable`: always `false`. This fork has no bundled/shipped-with-
 *   Origami skill source (no `EmbeddedSource` in this registry, unlike the
 *   unused v2 one in `packages/core/src/skill.ts`) — every discovered skill
 *   comes from a filesystem location or pulled URL cache the user controls.
 *
 * `category`, `location` and `contentPreview` are the opposite: all three are
 * read straight off `Skill.Info`, so they are the only genuinely engine-derived
 * context a card can show beyond name/description.
 */
export function toEntry(skill: Skill.Info): SkillEntry {
  const excerpt = contentPreview(skill.content ?? "")
  return {
    name: skill.name,
    description: skill.description ?? "",
    tier: "base",
    ownerAgents: [],
    tags: [],
    immutable: false,
    location: skill.location,
    ...(skill.category ? { category: skill.category } : {}),
    ...(excerpt ? { contentPreview: excerpt } : {}),
  }
}

/** Sorted by name for a stable, scannable list — the registry's own `all()` makes no ordering promise. */
export function project(skills: readonly Skill.Info[], problems: readonly Skill.Problem[] = []): SkillsResult {
  const entries = skills.toSorted((a, b) => a.name.localeCompare(b.name)).map(toEntry)
  if (problems.length === 0) return { skills: entries }
  return {
    skills: entries,
    problems: problems
      .map((problem) => ({ location: problem.location, message: problem.message }))
      .toSorted((a, b) => a.location.localeCompare(b.location)),
  }
}

/**
 * Runs against the process-wide AppRuntime, which already provides
 * `Skill.Service` (see `AppLayer` in `@/effect/app-runtime`). Building a
 * private layer stack instead would stand up a SECOND Database/Config/Plugin
 * instance and deadlock against the live one — same rule `Instructions.list`
 * follows.
 */
export const list = Effect.fn("ACPSkills.list")(function* (directory: string, options?: ListOptions) {
  const store = yield* InstanceStore.Service
  const skill = yield* Skill.Service
  const ctx = yield* store.load({ directory })

  // Every call is scoped to the SAME instance ctx, so the refresh below and the
  // two reads after it address one cache entry: the re-scan cannot land on a
  // different instance than the list that reports it.
  if (options?.refresh) yield* skill.refresh().pipe(Effect.provideService(InstanceRef, ctx))
  const skills = yield* skill.all().pipe(Effect.provideService(InstanceRef, ctx))
  const problems = yield* skill.problems().pipe(Effect.provideService(InstanceRef, ctx))
  return project(skills, problems)
})

export * as Skills from "./skills"
