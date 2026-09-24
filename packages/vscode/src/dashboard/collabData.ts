// The `collab_*` host leaf — the six Collabs ext-methods, wrapped in the
// shape boardData.ts/promptCapture.ts already established (no-session guard,
// an `error` field rather than a rejected promise, a defensive wire read).
// Every call goes through the generic `extMethod` seam, not a typed wrapper.
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
// The SDK wraps every thrown-not-RequestError exception in an "Internal
// error: " (etc.) label, which painted a collab refusal as a bug. Stripped
// below; a bare label with nothing else known is left as-is.
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
/** `cwd` is omitted rather than sent blank — the engine resolves its own
 *  directory in that case. */
const at = (cwd?: string): Record<string, unknown> => (cwd ? { cwd } : {});

/** The collab-capable agent defs the engine can see. An empty list is valid. */
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

/** Post a HUMAN message; the engine fans out to mentions, or the lead when there are none. */
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
 * The collab's live state. `sinceSeq` asks for only what is new. `suspended`
 * is read as strict `=== true` — a build that omits the field must render as
 * running, not paused, or a working stream would look frozen.
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
        // Answered once, off the payload as it stands — the single builder of
        // every `collabStateData`. The rule itself lives in collabAttention.ts.
    return { ...payload, needsUser: collabNeedsUser(payload) };
  } catch (e) {
    return { ...empty, error: message(e) };
  }
}

/** ONE body for every ack-only mutation. The reply is discarded — `{ok:true}`
 *  is the only success the wire defines. Nothing local is spliced; the
 *  caller re-polls the engine's own view. */
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

/** Set the loop breaker. `null` restores the default, `0` turns it off (overnight mode). */
export const collabSetCap = (client: CollabSource | null | undefined, collabId: string, cap: number | null, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_set_cap', collabId, { cap }, cwd);
/** Set the room's dispatch width. 1 is serial. Raising it is refused by the
 *  engine unless every member is read-only for files. */
export const collabSetConcurrency = (client: CollabSource | null | undefined, collabId: string, concurrency: number, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_set_concurrency', collabId, { concurrency }, cwd);
/** Turn a room into a COUNCIL, or back. The engine seals a council's round
 *  turns read-only per turn instead of gating the flip. */
export const collabSetFlavor = (client: CollabSource | null | undefined, collabId: string, flavor: string, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_set_flavor', collabId, { flavor }, cwd);
/** Archive a collab. It stays listable (`archivedAt` set) — a close, not a delete. */
export const collabArchive = (client: CollabSource | null | undefined, collabId: string, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_archive', collabId, {}, cwd);
/** Retitle a collab. An empty title is the engine's to refuse. */
export const collabRename = (client: CollabSource | null | undefined, collabId: string, title: string, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_rename', collabId, { title }, cwd);
/** Add an agent to the roster. Re-adding a soft-removed slug revives it. */
export const collabAddParticipant = (client: CollabSource | null | undefined, collabId: string, agentSlug: string, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_add_participant', collabId, { agentSlug }, cwd);
/** Remove an agent — a soft delete; past messages stay attributable. */
export const collabRemoveParticipant = (client: CollabSource | null | undefined, collabId: string, agentSlug: string, cwd?: string): Promise<CollabOkPayload> => collabOk(client, 'collab_remove_participant', collabId, { agentSlug }, cwd);
