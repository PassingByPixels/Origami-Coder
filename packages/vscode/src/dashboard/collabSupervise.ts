// The SUPERVISION half of the collab wire (W3 wave 3, report 2.4 / 2.5) — the
// four per-member ext-methods wave 1 added to the engine, plus their dispatch.
//
// ITS OWN MODULE, AND ITS OWN DISPATCHER. collabData.ts (250) and
// collabManager.ts (300) were both within single figures of their caps when
// these four arrived, and the ratchet's remedy is a new module, never a raised
// number. collabManager keeps ONE line — it folds SUPERVISE_MESSAGE_TYPES into
// its own set and falls through to `handleSuperviseMessage` — so the panel's
// routing is unchanged and there is still exactly one collab dispatch entry.
//
// The leaves follow collabData.ts's shape exactly: a no-engine guard first, a
// throw turned into an `error` FIELD rather than a rejected promise, and a
// defensive read of a reply that crossed a JSON-RPC wire.
//
// ONE OF THEM IS DIFFERENT, DELIBERATELY. `collabPreview` answers a failure
// with SILENCE — an empty wake set and no error at all. Every other call here
// is a thing the user asked for and must hear about; a preview is a thing the
// user is only typing, and painting a red line under a half-written draft
// because the engine blinked would be worse than not previewing at all.
//
// No `vscode` import, so every decision below is exercised without an extension
// host.
import type { CollabPostResult, TaskEntry } from '../acpExtTypes';
// `message` is collabData.ts's own — shared rather than re-duplicated, so a
// refusal reads honestly here too instead of drifting back to "Internal
// error: <reason>" the next time only one of the two copies gets fixed.
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

/** Mirrors `CollabRunner.StopAgentResult`. NEVER a bare ok: an agent can have a
 *  turn in flight, a turn waiting behind it, both, or neither, and "neither" is
 *  a real answer the surface has to be able to report as already-idle. */
export interface CollabStopAgentPayload {
  collabId: string;
  agentSlug: string;
  interrupted: boolean;
  dequeued: boolean;
  error?: string;
}

/** Stop ONE agent: its turn in flight is interrupted and its child session
 *  cancelled, its slug alone leaves the queue, and the hop budget is untouched.
 *  Everything `collab_stop` does to the room, narrowed to one member. */
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

/** The human's verdict on a task an agent completed. `approve` accepts it;
 *  `reject` sends it back to its owner WITH the reason, which the room row then
 *  carries. An empty note is OMITTED rather than sent blank, so the engine's own
 *  "a reject needs a reason" refusal is what reaches the user. */
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
