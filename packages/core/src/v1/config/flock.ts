export * as FlockConfigV1 from "./flock"

import { Schema, SchemaGetter } from "effect"
import { PositiveInt } from "../../schema"

/**
 * The one thing a Flock profile still decides: the model SUBAGENT sessions run
 * on. Everything else routing once did — per-role bindings, slots, fan-out caps,
 * a role roster on the task tool — is gone. Collabs replaced it.
 */
export const Binding = Schema.Struct({
  use: Schema.String.annotate({
    description: "Binding in the format of provider/model, eg anthropic/claude-2",
  }),
  fallback: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description:
      "Ordered health-fallback bindings, each in the format of provider/model. Tried in order when the binding before it is unreachable",
  }),
}).annotate({ identifier: "FlockBinding" })
export type Binding = Schema.Schema.Type<typeof Binding>

/**
 * The role names the pre-E1 shape allowed under `roles`. Kept ONLY so a config
 * file written against that shape still loads — nothing routes by role any
 * more, and `agent.role:` frontmatter is accepted and ignored for the same
 * reason. A name outside this list still fails the load out loud rather than
 * being dropped, which is the behaviour those files were written against.
 */
export const ROLE_NAMES = [
  "read",
  "locate",
  "scout",
  "plan",
  "execute",
  "transform",
  "judge",
  "repair",
  "research",
  "vision",
  "embed",
  "compact",
] as const

export const RoleName = Schema.Literals(ROLE_NAMES).annotate({
  identifier: "FlockRoleName",
  description: "Legacy Flock work role. Accepted and ignored by this version",
})
export type RoleName = typeof RoleName.Type

// The `roles` record validates its keys with a filter rather than with
// `Schema.Literals`. A literal-keyed record makes every role REQUIRED, and one
// with optional values silently DROPS keys it does not recognise — a typo'd
// role would then vanish with no explanation.
//
// The `patterns` hint is load-bearing, not decoration: `Schema.toArbitrary` on
// the whole config (core/test/config/config.test.ts property test) otherwise
// samples random strings against a twelve-value allowlist and never lands one.
const RoleNameKey = Schema.String.check(
  Schema.makeFilter(
    (name: string) =>
      (ROLE_NAMES as readonly string[]).includes(name)
        ? undefined
        : `unknown flock role "${name}", expected one of: ${ROLE_NAMES.join(", ")}`,
    { arbitrary: { constraint: { patterns: [`^(${ROLE_NAMES.join("|")})$`] } } },
  ),
).annotate({ description: "Legacy Flock role name" })

/** The three slot keys the pre-E1 shape allowed. Legacy, like `roles`. */
export const SLOT_NAMES = ["executor", "scout", "workhorse"] as const

/**
 * A pre-E1 slot or role entry. `fanout` and `escalate` are still ACCEPTED here
 * because dropping them from the schema would fail the config load of every
 * file that carries one; they route nothing.
 */
export const LegacyEntry = Schema.Struct({
  use: Schema.String.annotate({
    description: "Binding in the format of provider/model, eg anthropic/claude-2",
  }),
  fallback: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Ordered health-fallback bindings, each in the format of provider/model",
  }),
  fanout: Schema.optional(PositiveInt).annotate({
    description: "Legacy parallel-generation cap. Accepted and ignored by this version",
  }),
  escalate: Schema.optional(Schema.String).annotate({
    description: "Legacy escalation binding. Accepted and ignored by this version",
  }),
}).annotate({ identifier: "FlockLegacyBinding" })
export type LegacyEntry = Schema.Schema.Type<typeof LegacyEntry>

const ProfileFields = Schema.Struct({
  description: Schema.optional(Schema.String).annotate({ description: "What this profile is for" }),
  subagents: Schema.optional(Binding).annotate({
    description:
      "The model task/subagent sessions run on while this profile is active. Omit it and a subagent runs on the session's own model",
  }),
  // Read-compat only, all four. `executor` is the one that still carries a
  // binding forward (see `subagentsOf`): it was the trusted slot, the one that
  // ran plan/execute/repair/judge, so it is the honest single answer to "which
  // model did this user trust with real work". The rest are read and dropped.
  executor: Schema.optional(LegacyEntry).annotate({
    description: "Legacy slot. Read as `subagents` when `subagents` is absent",
  }),
  scout: Schema.optional(LegacyEntry).annotate({ description: "Legacy slot. Accepted and ignored by this version" }),
  workhorse: Schema.optional(LegacyEntry).annotate({
    description: "Legacy slot. Accepted and ignored by this version",
  }),
  roles: Schema.optional(Schema.Record(RoleNameKey, LegacyEntry)).annotate({
    description: "Legacy per-role overrides. Accepted and ignored by this version",
  }),
})

const PROFILE_KEYS = ["description", "subagents", ...SLOT_NAMES, "roles"] as const

// A binding and a profile are near enough the same shape that a stale profile
// would decode as one that binds NOTHING — `Schema.Struct` strips keys it does
// not declare and the config loader asks for `onExcessProperty: "ignore"`
// (core/src/config.ts:143). Validating the profile's KEYS through a record makes
// an unknown key fail the config load out loud instead of routing silently to
// the main model, the same reason `RoleNameKey` above exists. The `patterns`
// hint is load-bearing for the same reason it is there.
const ProfileKey = Schema.String.check(
  Schema.makeFilter(
    (name: string) =>
      (PROFILE_KEYS as readonly string[]).includes(name)
        ? undefined
        : `unknown flock profile key "${name}", expected one of: ${PROFILE_KEYS.join(", ")}`,
    { arbitrary: { constraint: { patterns: [`^(${PROFILE_KEYS.join("|")})$`] } } },
  ),
).annotate({ description: "Flock profile key" })

export const Profile = Schema.Record(ProfileKey, Schema.Unknown)
  .pipe(
    Schema.decodeTo(ProfileFields, {
      decode: SchemaGetter.passthrough({ strict: false }),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  )
  .annotate({ identifier: "FlockProfile" })
export type Profile = Schema.Schema.Type<typeof ProfileFields>

/**
 * Whether a profile still carries any pre-E1 key. Asked separately from
 * `subagentsOf` on purpose: a profile that bound only `scout`, `workhorse` or
 * `roles` maps to NO binding at all, and that is precisely the user who most
 * needs telling — their profile stopped routing, and every other signal they
 * have says it is still fine.
 */
export function hasLegacyShape(profile: Profile): boolean {
  return (
    profile.executor !== undefined ||
    profile.scout !== undefined ||
    profile.workhorse !== undefined ||
    profile.roles !== undefined
  )
}

/**
 * The subagent binding a profile resolves to, and whether it came from the
 * pre-E1 shape. The migration is a READ: the user's file is never rewritten, so
 * an old profile keeps working and keeps saying what it says. `legacy` exists so
 * the engine can tell the user once, rather than silently honouring half of a
 * profile whose other half no longer does anything.
 */
export function subagentsOf(profile: Profile): { binding: Binding; legacy: boolean } | undefined {
  if (profile.subagents) return { binding: profile.subagents, legacy: false }
  const executor = profile.executor
  if (!executor) return undefined
  return {
    binding: { use: executor.use, ...(executor.fallback ? { fallback: executor.fallback } : {}) },
    legacy: true,
  }
}

export const Info = Schema.Struct({
  profile: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: "Name of the active profile in 'profiles'. Absent or null means Flock routing is off",
  }),
  profiles: Schema.optional(Schema.Record(Schema.String, Profile)).annotate({
    description: "Named routing profiles, keyed by profile name",
  }),
}).annotate({ identifier: "FlockConfig" })
export type Info = Schema.Schema.Type<typeof Info>
