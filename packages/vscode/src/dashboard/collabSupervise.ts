// The supervision half of the collab wire: the four per-member ext-methods plus their dispatch.
//
// collabPreview alone answers a failure with silence (empty wake set, no error): it previews a
// draft the user is only typing, so a blinking engine must not paint a red error line under it.
import type { CollabPostResult, TaskEntry } from '../acpExtTypes';
// `message` is collabData.ts's own — shared rather than re-duplicated, so a refusal reads honestly
// here too instead of drifting apart when only one copy is fixed.
import { message, type CollabSource } from './collabData';

const NO_SESSION = 'Open a chat first — this needs a live engine connection.';
const at = (cwd?: string): Record<string, unknown> => (cwd ? { cwd } : {});
const slugs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/** The slice of CollabManagerHost these need — structurally satisfied by it,
 *  which is why collabManager hands its own host straight through. */
export interface SuperviseHost {
  post(msg: Record<string, unknown>): void;
  cwd(): string;
  collabClient(): CollabSource | undefined;
}

/** Mirrors `CollabRunner.StopAgentResult`. NEVER a bare ok: an agent can have a turn in
 *  flight, one waiting behind it, both, or neither — and "neither" is a real answer. */
export interface CollabStopAgentPayload {
  collabId: string;
  agentSlug: string;
  interrupted: boolean;
  dequeued: boolean;
  error?: string;
}

/** Stop ONE agent: its in-flight turn is interrupted and its child session cancelled, its slug
 *  leaves the queue, and the hop budget is untouched. */
export async function collabStopAgent(
  client: CollabSource | null | undefined,
  collabId: string,
  agentSlug: string,
  cwd?: string,
): Promise<CollabStopAgentPayload> {
  const none = { collabId, agentSlug, interrupted: false, dequeued: false };
  if (!client) return { ...none, error: NO_SESSION };
  try {
    const res = await client.extMethod('collab_stop_agent', { collabId, agentSlug, ...at(cwd) });
    // A missing or mistyped flag reads as "that did not happen" — the surface
    // then reports an already-idle agent, which is the honest degraded answer.
    return { collabId, agentSlug, interrupted: res?.interrupted === true, dequeued: res?.dequeued === true };
  } catch (e) {
    return { ...none, error: message(e) };
  }
}

export interface CollabRedirectPayload {
  collabId: string;
  agentSlug: string;
  /** The seq the correction landed at, or null when it never landed. */
  seq: number | null;
  error?: string;
}

/** Correct ONE agent: a human message addressed to it alone, with its turn
 *  moved to the front of the queue. A MESSAGE, not a control — it goes into the
 *  log and buys a fresh hop budget like any human post. */
export async function collabRedirect(
  client: CollabSource | null | undefined,
  collabId: string,
  agentSlug: string,
  text: string,
  cwd?: string,
): Promise<CollabRedirectPayload> {
  if (!client) return { collabId, agentSlug, seq: null, error: NO_SESSION };
  try {
    const res = await client.extMethod('collab_redirect', { collabId, agentSlug, text, ...at(cwd) });
    return { collabId, agentSlug, seq: typeof res?.seq === 'number' ? res.seq : null };
  } catch (e) {
    return { collabId, agentSlug, seq: null, error: message(e) };
  }
}

export interface CollabReviewPayload {
  collabId: string;
  /** The task exactly as it now stands — never a partial patch — or null when
   *  the verdict was refused. */
  task: TaskEntry | null;
  error?: string;
}

/** The human's verdict on a task an agent completed. `approve` accepts it; `reject` sends it back
 *  to its owner WITH the reason. An empty note is OMITTED rather than sent blank, so the engine's
 *  own "a reject needs a reason" refusal reaches the user. */
export async function collabReview(
  client: CollabSource | null | undefined,
  collabId: string,
  taskId: string,
  verdict: 'approve' | 'reject',
  note?: string,
  cwd?: string,
): Promise<CollabReviewPayload> {
  if (!client) return { collabId, task: null, error: NO_SESSION };
  try {
    const res = await client.extMethod('collab_review', {
      collabId, taskId, verdict, ...(note ? { note } : {}), ...at(cwd),
    });
    const task = res?.task;
    return { collabId, task: task && typeof task === 'object' ? (task as TaskEntry) : null };
  } catch (e) {
    return { collabId, task: null, error: message(e) };
  }
}

export interface CollabPreviewPayload {
  collabId: string;
  /** The slugs that would take a turn, in roster order. */
  wake: string[];
  /** Same meaning as on a post: the draft would reach nobody. */
  notice?: CollabPostResult['notice'];
  /** Addresses that are not on the active roster — `collab_post` REFUSES such a
   *  draft, so the composer has to say so before the send. */
  unknown?: string[];
}

/** Who a draft WOULD wake. A pure read: nothing is posted, no turn scheduled and
 *  no token spent, so it is safe on a keystroke path. SILENT on failure — see
 *  the header for why this one call has no `error` field at all. */
export async function collabPreview(
  client: CollabSource | null | undefined,
  collabId: string,
  mentions: string[],
  cwd?: string,
): Promise<CollabPreviewPayload> {
  if (!client) return { collabId, wake: [] };
  try {
    // OMITTED when empty, exactly as collab_post does it: an unaddressed draft
    // is a real question about the lead, not a draft addressed to nobody.
    const res = await client.extMethod('collab_preview', {
      collabId, ...(mentions.length ? { mentions } : {}), ...at(cwd),
    });
    const unknown = slugs(res?.unknown);
    return {
      collabId,
      wake: slugs(res?.wake),
      // Taken ONLY when it is a value the contract names — a sentence cannot be
      // written for a code nobody defined. Same rule collabPost follows.
      ...(res?.notice === 'no-lead' ? { notice: 'no-lead' as const } : {}),
      ...(unknown.length ? { unknown } : {}),
    };
  } catch {
    return { collabId, wake: [] };
  }
}

/** The four wire types this module owns. Folded into COLLAB_MESSAGE_TYPES by
 *  collabManager, so the panel still checks ONE set before its own switch. */
export const SUPERVISE_MESSAGE_TYPES = new Set([
  'collabStopAgent', 'collabRedirect', 'collabReview', 'collabPreview',
]);

/** Route one supervision message. Same calling convention as
 *  handleCollabMessage, and the same engine-stays-authoritative shape: a result
 *  payload back, no optimistic splice — the room re-polls for the truth. */
export async function handleSuperviseMessage(
  host: SuperviseHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  const id = typeof m.collabId === 'string' ? m.collabId : '';
  const slug = typeof m.agentSlug === 'string' ? m.agentSlug : '';
  switch (m.type) {
    case 'collabStopAgent': {
      host.post({ type: 'collabStopAgentResult', ...(await collabStopAgent(host.collabClient(), id, slug, host.cwd())) });
      return;
    }
    case 'collabRedirect': {
      const text = typeof m.text === 'string' ? m.text : '';
      host.post({ type: 'collabRedirectResult', ...(await collabRedirect(host.collabClient(), id, slug, text, host.cwd())) });
      return;
    }
    case 'collabReview': {
      const taskId = typeof m.taskId === 'string' ? m.taskId : '';
      // `approve` and `reject` are the only two the contract names. A third is
      // refused HERE with a reason rather than guessed at: coercing it would
      // let a stale shell close a task the human never accepted.
      const verdict = m.verdict === 'approve' || m.verdict === 'reject' ? m.verdict : undefined;
      if (!verdict) {
        host.post({ type: 'collabReviewResult', collabId: id, task: null, error: 'Unknown review verdict.' });
        return;
      }
      const note = typeof m.note === 'string' ? m.note.trim() : '';
      host.post({ type: 'collabReviewResult', ...(await collabReview(host.collabClient(), id, taskId, verdict, note, host.cwd())) });
      return;
    }
    case 'collabPreview': {
      host.post({ type: 'collabPreviewData', ...(await collabPreview(host.collabClient(), id, slugs(m.mentions), host.cwd())) });
      return;
    }
  }
}
