// The `collab_*` host leaf — the six Collabs ext-methods, wrapped in the shape
// boardData.ts/promptCapture.ts already established (no-session guard, a throw
// turned into an `error` FIELD rather than a rejected promise, and a defensive
// read of a reply that crossed a JSON-RPC wire).
//
// Its own module, not a method on AcpClient: that file is at 1348/1350 lines
// and the ratchet's remedy is a new module, never a raised cap. So every call
// here goes through the GENERIC `extMethod` seam instead of a typed wrapper —
// which is also why `CollabSource` is one method wide and a test can fake it
// with an object literal.
//
// No `vscode` import, so every decision below is exercised without an
// extension host.
import { collabNeedsUser } from './collabAttention';
import type {
  CollabAgentInfo,
  CollabAgentsResult,
  CollabAgentStatus,
  CollabCreateResult,
  CollabListResult,
  CollabMessage,
  CollabParticipant,
  CollabPostResult,
  CollabStateResult,
  CollabSummary,
} from '../acpExtTypes';

/** The ONE public member of AcpClient this needs. Collabs are workspace-scoped
 *  (keyed by `cwd`), not session-scoped, so unlike promptCapture there is no
 *  `currentSessionId` here — any live client can answer for the workspace. */
export interface CollabSource {
  extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

// The reply SHAPES moved to collabPayloads.ts when this file reached its cap;
// they are re-exported here so every existing importer still reads them off
// collabData, which is where a reader looks for them.
import type {
  CollabAgentsPayload, CollabCreatePayload, CollabListPayload, CollabOkPayload,
  CollabPostPayload, CollabSetCapPayload, CollabStatePayload,
} from './collabPayloads';
export type {
  CollabAgentsPayload, CollabCreatePayload, CollabListPayload, CollabOkPayload,
  CollabPostPayload, CollabSetCapPayload, CollabStatePayload,
};

const NO_SESSION = 'Open a chat first — this needs a live engine connection.';
// `@agentclientprotocol/sdk` wraps EVERY thrown-not-`RequestError` exception
// in this label (`RequestError.internalError` / `.invalidParams` / …), which
// is why a collab REFUSAL used to reach the user as "Internal error: parallel
// turns need every member to be read-only for files…" — a refusal painted as
// a bug. STRIPPED below; a BARE label (nothing else known) is left as-is —
// that IS a genuinely unexpected failure, and must keep saying so.
const RPC_LABEL = /^(?:Internal error|Invalid params|Invalid request|Parse error|Authentication required): /;
/** Every ext-method failure that crossed the wire, read honestly: a typed
 *  `data.reason` (a refusal MAY arrive that way instead) wins when present;
 *  otherwise the label above is stripped off `.message`. */
export const message = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const data = (e as { data?: unknown }).data;
  const reason = data && typeof data === 'object' ? (data as Record<string, unknown>).reason : undefined;
  return typeof reason === 'string' && reason ? reason : e.message.replace(RPC_LABEL, '');
};
const array = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
/** `cwd` is omitted rather than sent blank when there is none — the engine
 *  resolves its own directory in that case, and an empty string would be a
 *  path, not a "you decide". Mirrors boardData's runStepsPayload. */
const at = (cwd?: string): Record<string, unknown> => (cwd ? { cwd } : {});

/** The collab-capable agent defs the engine can see. An EMPTY list is a valid
 *  answer (no def carries `collab: true` yet) and must not read as an error. */
export async function collabAgents(
  client: CollabSource | null | undefined,
  cwd?: string,
): Promise<CollabAgentsPayload> {
  if (!client) return { agents: [], error: NO_SESSION };
  try {
    const res = (await client.extMethod('collab_agents', at(cwd))) as unknown as Partial<CollabAgentsResult>;
    return { agents: array<CollabAgentInfo>(res?.agents) };
  } catch (e) {
    return { agents: [], error: message(e) };
  }
}

/** Every collab in this workspace. Same rule: no collabs is not a failure. */
export async function collabList(
  client: CollabSource | null | undefined,
  cwd?: string,
): Promise<CollabListPayload> {
  if (!client) return { collabs: [], error: NO_SESSION };
  try {
    const res = (await client.extMethod('collab_list', at(cwd))) as unknown as Partial<CollabListResult>;
    return { collabs: array<CollabSummary>(res?.collabs) };
  } catch (e) {
    return { collabs: [], error: message(e) };
  }
}

/** Start a collab over a roster of agent slugs. The engine owns the id, the
 *  timestamps and the default cap — nothing is synthesised here, so a create
 *  that half-succeeded cannot be presented as a real collab. `objective` (M4) is omitted when blank: an empty objective is not one. */
export async function collabCreate(
  client: CollabSource | null | undefined,
  title: string,
  agentSlugs: string[],
  cwd?: string, objective?: string,
): Promise<CollabCreatePayload> {
  if (!client) return { collab: null, error: NO_SESSION };
  try {
    const res = (await client.extMethod('collab_create', {
      title,
      agentSlugs,
      ...(objective ? { objective } : {}), ...at(cwd),
    })) as unknown as Partial<CollabCreateResult>;
    const collab = res?.collab;
    if (!collab || typeof collab !== 'object' || typeof collab.id !== 'string' || !collab.id) {
      return { collab: null, error: 'The engine did not return a collab.' };
    }
    return { collab };
  } catch (e) {
    return { collab: null, error: message(e) };
  }
}

/** Post a HUMAN message; the engine fans it out per C17 (the `mentions` when there are any, the lead when there are none — an unknown slug is ITS to refuse). The field is OMITTED when empty, so an unaddressed post keeps today's exact wire shape. `images` (bare `data:` URLs) rides the same rule; the engine owns the count/size limits and names the one it refuses on. */
export async function collabPost(
  client: CollabSource | null | undefined,
  collabId: string,
  text: string,
  cwd?: string, mentions?: string[], images?: string[],
): Promise<CollabPostPayload> {
  if (!client) return { collabId, seq: null, error: NO_SESSION };
  try {
    const res = (await client.extMethod('collab_post', {
      collabId,
      text,
      ...(mentions && mentions.length ? { mentions } : {}), ...(images && images.length ? { images } : {}), ...at(cwd),
    })) as unknown as Partial<CollabPostResult>;
    // `notice` is taken ONLY when it is a value the contract names. An unknown
    // string is dropped rather than forwarded: the room renders a notice as a
    // sentence, and a sentence for a code nobody defined cannot be written.
    return { collabId, seq: typeof res?.seq === 'number' ? res.seq : null, ...(res?.notice === 'no-lead' ? { notice: res.notice } : {}) };
  } catch (e) {
    return { collabId, seq: null, error: message(e) };
  }
}

/**
 * The collab's live state. `sinceSeq` asks for only what is NEW; absent (or 0)
 * asks for everything.
 *
 * `suspended` is read as a strict `=== true`: a build that does not send the
 * field must render as RUNNING, not as paused — telling a user their collab is
 * waiting on them when it is not would freeze a working stream behind a banner.
 */
export async function collabState(
  client: CollabSource | null | undefined,
  collabId: string,
  sinceSeq = 0,
  cwd?: string,
): Promise<CollabStatePayload> {
  const empty: CollabStatePayload = { collabId, sinceSeq, collab: null, participants: [], messages: [], agents: [], suspended: false, needsUser: false };
  if (!collabId) return { ...empty, error: 'No collab was selected.' };
  if (!client) return { ...empty, error: NO_SESSION };
  try {
    const res = (await client.extMethod('collab_state', {
      collabId,
      ...(sinceSeq > 0 ? { sinceSeq } : {}),
      ...at(cwd),
    })) as unknown as Partial<CollabStateResult>;
    const payload: CollabStatePayload = {
      collabId,
      sinceSeq,
      needsUser: false,
      collab: res?.collab && typeof res.collab === 'object' ? res.collab : null,
      participants: array<CollabParticipant>(res?.participants),
      messages: array<CollabMessage>(res?.messages),
      agents: array<CollabAgentStatus>(res?.agents),
      suspended: res?.suspended === true,
      // Each board field is taken ONLY when it arrives in the shape the
      // contract names. A malformed one is DROPPED, never coerced: `tasks: 42`
      // rendered as `[]` would say "this collab has no tasks", which is a
      // claim the reply never made.
      ...(typeof res?.lead === 'string' || res?.lead === null ? { lead: res.lead } : {}),
      ...(typeof res?.objective === 'string' || res?.objective === null ? { objective: res.objective } : {}),
      ...(Array.isArray(res?.tasks) ? { tasks: res.tasks } : {}),
      ...(Array.isArray(res?.costTotals) ? { costTotals: res.costTotals } : {}),
      ...(res?.hopState && typeof res.hopState === 'object' ? { hopState: res.hopState } : {}),
    };
    // Answered ONCE, off the payload as it now stands, because this function is
    // the single builder of every `collabStateData` (the room's own poll and
    // collabWatch's background poll both land here). The rule itself stays in
    // collabAttention.ts — this only carries its verdict to the surfaces that
    // cannot import it. See CollabStatePayload.needsUser.
    return { ...payload, needsUser: collabNeedsUser(payload) };
  } catch (e) {
    return { ...empty, error: message(e) };
  }
}

/** ONE body for every ack-only mutation. Guards in a fixed order (no collab
 *  beats no engine), and the reply is DISCARDED on purpose: `{ok:true}` is the
 *  only success the wire defines, so reading it back could only restate the
 *  absence of a throw. Nothing local is spliced either — the caller re-polls,
 *  and the engine stays the single source of what a collab now looks like. */
async function collabOk(
  client: CollabSource | null | undefined,
  method: string,
  collabId: string,
  extra: Record<string, unknown>,
  cwd?: string,
): Promise<CollabOkPayload> {
  if (!collabId) return { collabId, ok: false, error: 'No collab was selected.' };
  if (!client) return { collabId, ok: false, error: NO_SESSION };
  try {
    await client.extMethod(method, { collabId, ...extra, ...at(cwd) });
    return { collabId, ok: true };
  } catch (e) {
    return { collabId, ok: false, error: message(e) };
  }
}

/** Set the loop breaker. `null` restores the engine default, `0` turns it OFF
 *  (overnight mode). Passed through UNCOALESCED — see CollabSummary. */
export const collabSetCap = (client: CollabSource | null | undefined, collabId: string, cap: number | null, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_set_cap', collabId, { cap }, cwd);
/** Set the room's dispatch width. 1 is serial. Raising it is REFUSED by the
 *  engine unless every member is read-only for files, and that refusal arrives
 *  as `ok: false` with the reason — never swallowed, because the setting the
 *  user just chose did not take. */
export const collabSetConcurrency = (client: CollabSource | null | undefined, collabId: string, concurrency: number, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_set_concurrency', collabId, { concurrency }, cwd);
/** Turn a room into a COUNCIL, or back into a discuss room. Never refused on
 *  permissions: the engine seals a council's round turns read-only per turn
 *  (COUNCIL_SEAL) instead of gating the flip. The only refusal left is an
 *  unknown flavor, and it still arrives as `ok: false` with the reason. */
export const collabSetFlavor = (client: CollabSource | null | undefined, collabId: string, flavor: string, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_set_flavor', collabId, { flavor }, cwd);
/** Archive a collab. It stays LISTABLE (with `archivedAt` set) — this is a
 *  close, not a delete, and a list that quietly lost a row would be a lie. */
export const collabArchive = (client: CollabSource | null | undefined, collabId: string, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_archive', collabId, {}, cwd);
/** Retitle a collab. An empty title is the ENGINE's to refuse, not this leaf's:
 *  inventing a client-side rule here would let the two disagree. */
export const collabRename = (client: CollabSource | null | undefined, collabId: string, title: string, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_rename', collabId, { title }, cwd);
/** Add an agent to the roster. Re-adding a soft-removed slug REVIVES it (the
 *  engine clears `removedAt`) rather than creating a second entry. */
export const collabAddParticipant = (client: CollabSource | null | undefined, collabId: string, agentSlug: string, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_add_participant', collabId, { agentSlug }, cwd);
/** Remove an agent — a SOFT delete. The participant keeps its place in the
 *  roster with `removedAt` set, so its past messages stay attributable. */
export const collabRemoveParticipant = (client: CollabSource | null | undefined, collabId: string, agentSlug: string, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_remove_participant', collabId, { agentSlug }, cwd);
