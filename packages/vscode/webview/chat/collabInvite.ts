// Collabs M3 — the invite candidate list: engine agents (joinable NOW, from
// `collab_agents`) MERGED with fs-side agent defs (on disk, not yet loaded by
// the engine — collabAgentCrud.ts). Pure, so the merge rule is testable
// without a DOM. Mirrors the house pattern (modelGrouping.ts, labyrinthLayout.ts).
//
// THE ONE THING THIS MUST NEVER DO: offer an already-active participant as
// invitable. A REMOVED one (removedAt set) is free again — re-inviting it is
// how a roster un-removes someone, per collabData.ts's collabAddParticipant.

import { agentHealth, type AgentHealth, type ProviderLiveness } from './collabHealth';

/** `model` is OPTIONAL on both inputs: an engine that predates the field sends
 *  none, and absent must read as "no pin", never as an error. */
export interface EngineAgent { slug: string; displayName: string; model?: string | null }
export interface FsAgentDef { slug: string; displayName: string; model?: string | null }
export interface ActiveParticipant { agentSlug: string; removedAt?: string }

export interface InviteCandidate {
  slug: string;
  displayName: string;
  /** True when only the FILESYSTEM knows this def. Since the engine rescans
   *  defs on demand (M4.3), a valid file is always engine-joinable — so a row
   *  stuck fs-only means the FILE failed to load, not that a restart is due. */
  disabled: boolean;
  reason?: string;
  /** The def's PINNED `provider/model`, or null for unpinned. NORMALISED here:
   *  the fs half writes `''` for "no pin" and the engine half writes null, and
   *  a consumer must not have to know which half a row came from. */
  model: string | null;
  /** Whether that pin can actually run right now (collabHealth.ts). Report 1.4:
   *  the invite list is where a dead provider has to be visible, not the first
   *  turn's error badge. */
  health: AgentHealth;
}

export const FS_ONLY_REASON = 'not loadable — check its definition in the Agents tab';

/** Defensive parse of either wire's agent list — duck-typed, mirroring every
 *  other collab message handler in this package. The two halves differ ONLY in
 *  which field carries the name: `collab_agents` sends `displayName`, and a
 *  `CollabAgentDef` has no such field, so its `description` stands in. */
function parseAgents(raw: unknown, nameKey: 'displayName' | 'description'): EngineAgent[] {
  const list = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
  return list
    .map((a) => {
      const name = a[nameKey];
      return {
        slug: String(a.slug ?? ''),
        displayName: typeof name === 'string' && name ? name : String(a.slug ?? ''),
        model: typeof a.model === 'string' && a.model ? a.model : null,
      };
    })
    .filter((a) => a.slug);
}

export const parseEngineAgents = (raw: unknown): EngineAgent[] => parseAgents(raw, 'displayName');
export const parseFsAgents = (raw: unknown): FsAgentDef[] => parseAgents(raw, 'description');

/** Engine agents ∪ fs defs, keyed by slug (the engine's own displayName wins
 *  a collision — it is the live def), minus anyone already an active
 *  participant. Sorted by slug for a stable popover order. */
export function mergeInviteCandidates(
  engineAgents: EngineAgent[],
  fsAgents: FsAgentDef[],
  participants: ActiveParticipant[],
  providers: ProviderLiveness[] = [],
): InviteCandidate[] {
  const active = new Set(participants.filter((p) => !p.removedAt).map((p) => p.agentSlug));
  const bySlug = new Map<string, InviteCandidate>();
  // The normalisation InviteCandidate.model names: fs writes '', engine null.
  const pin = (m: string | null | undefined): string | null => m || null;
  for (const a of engineAgents) {
    if (active.has(a.slug)) continue;
    const model = pin(a.model);
    bySlug.set(a.slug, { slug: a.slug, displayName: a.displayName || a.slug, disabled: false, model, health: agentHealth(model, providers) });
  }
  for (const d of fsAgents) {
    if (active.has(d.slug) || bySlug.has(d.slug)) continue;
    const model = pin(d.model);
    bySlug.set(d.slug, { slug: d.slug, displayName: d.displayName || d.slug, disabled: true, reason: FS_ONLY_REASON, model, health: agentHealth(model, providers) });
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}
