import { Effect } from "effect"
import { PermissionV1 } from "@origami/core/v1/permission"
import type { Permission } from "@/permission"
import type { Session } from "./session"
import type { SessionID } from "./schema"

/**
 * Write a chat's permission ruleset the way the AUTO-APPROVE PRESETS need it —
 * the one call behind both writers that can carry a preset (the HTTP
 * `session.update` route and a prompt's `tools` map). Two things must happen
 * beyond the row itself:
 *  1. The write CASCADES to live sub-agents, via `Session.setPermission`.
 *  2. The asks ALREADY WAITING on those rows are re-read against the new rules,
 *     or the preset clears the future and leaves the on-screen prompts unanswered.
 *
 * The services are ARGUMENTS, not `yield* Service`, so this stays callable from
 * `session/prompt.ts`, whose `prompt` is typed with no remaining requirements.
 * collab/seal.ts deliberately does NOT come through here: it swaps a room seal
 * onto a row without changing the preset, and has no pending ask to release.
 */
export const writeSessionPermission = Effect.fn("Session.writeSessionPermission")(function* (
  services: { sessions: Session.Interface; permissions: Permission.Interface },
  input: { sessionID: SessionID; permission: PermissionV1.Ruleset },
) {
  const written = yield* services.sessions.setPermission(input)
  for (const row of written) {
    yield* services.permissions.refresh({ sessionID: row.sessionID, ruleset: row.permission })
  }
  return written
})
