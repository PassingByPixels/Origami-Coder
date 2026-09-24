// Flock — the SIX `collab_*` host leaves: lead, objective, the task board's
// two mutations, the cost ledger, and stop. A sibling of collabData.ts, not
// an addition to it, since that file is at its own cap.
//
// Same house pattern: a no-session guard, a throw turned into an `error`
// field, a defensive wire read, and `collabId` self-carried on every payload
// since `post` fans out to every attached webview.
import type { CollabCostTotal, LedgerEntry, TaskEntry } from '../acpExtTypes';
// `message` is collabData.ts's own — shared rather than re-duplicated, so a
// refusal (an archived room, a blank title…) reads honestly here too.
import { message, type CollabOkPayload, type CollabSource } from './collabData';

export interface CollabTaskPayload {
  collabId: string;
  /** Null when the call failed — `error` then says why. */
  task: TaskEntry | null;
  error?: string;
}

export interface CollabLedgerPayload {
  collabId: string;
  entries: LedgerEntry[];
  totals: CollabCostTotal[];
  error?: string;
}

const NO_SESSION = 'Open a chat first — this needs a live engine connection.';
const array = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
/** `cwd` is omitted rather than sent blank when there is none — mirrors collabData's `at`. */
const at = (cwd?: string): Record<string, unknown> => (cwd ? { cwd } : {});

/** ONE body for every ack-only mutation — mirrors collabData.ts's collabOk. */
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

/** Set (or clear, with `null`) the collab's lead. "Must be an active
 *  participant or null" is the ENGINE's rule to enforce, not this leaf's. */
export const collabSetLead = (
  client: CollabSource | null | undefined,
  collabId: string,
  agentSlug: string | null,
  cwd?: string,
): Promise<CollabOkPayload> => collabOk(client, 'collab_set_lead', collabId, { agentSlug }, cwd);

/** Set the collab's standing objective. An empty string is the engine's to
 *  refuse, not this leaf's — inventing a client-side rule would let the two disagree. */
export const collabSetObjective = (
  client: CollabSource | null | undefined,
  collabId: string,
  objective: string,
  cwd?: string,
): Promise<CollabOkPayload> => collabOk(client, 'collab_set_objective', collabId, { objective }, cwd);

/** Interrupt the active drain fiber and suspend the collab (hop remaining ->
 *  0) until the next human post. Not called by any UI yet — X2 wires the Stop
 *  button; this leaf exists so the button has a wire the day it lands. */
export const collabStop = (
  client: CollabSource | null | undefined,
  collabId: string,
  cwd?: string,
): Promise<CollabOkPayload> => collabOk(client, 'collab_stop', collabId, {}, cwd);

/** Reopen an archived collab — the inverse of collabArchive. Clears
 *  `archivedAt`; nothing else about the room was touched by archiving. */
export const collabUnarchive = (
  client: CollabSource | null | undefined,
  collabId: string,
  cwd?: string,
): Promise<CollabOkPayload> => collabOk(client, 'collab_unarchive', collabId, {}, cwd);

/** A `{task}` reply parsed the same way collabData's collabCreate treats
 *  `{collab}` — no id, no usable task, never a half-real row on screen. */
function taskFromResult(collabId: string, res: unknown): CollabTaskPayload {
  const task = (res as { task?: TaskEntry } | undefined)?.task;
  if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id) {
    return { collabId, task: null, error: 'The engine did not return a task.' };
  }
  return { collabId, task };
}

/** Open a task on the board (state 'open', createdBy the caller — the engine's job). */
export async function collabTaskAdd(
  client: CollabSource | null | undefined,
  collabId: string,
  title: string,
  cwd?: string,
): Promise<CollabTaskPayload> {
  if (!collabId) return { collabId, task: null, error: 'No collab was selected.' };
  if (!client) return { collabId, task: null, error: NO_SESSION };
  try {
    return taskFromResult(collabId, await client.extMethod('collab_task_add', { collabId, title, ...at(cwd) }));
  } catch (e) {
    return { collabId, task: null, error: message(e) };
  }
}

/** Advance a task (claim/done/accept/reopen). Legal-transition and
 *  required-field enforcement is the ENGINE's, not this leaf's. */
export async function collabTaskUpdate(
  client: CollabSource | null | undefined,
  collabId: string,
  taskId: string,
  action: 'claim' | 'done' | 'accept' | 'reopen',
  extra: { result?: string; note?: string; owner?: string } = {},
  cwd?: string,
): Promise<CollabTaskPayload> {
  if (!collabId) return { collabId, task: null, error: 'No collab was selected.' };
  if (!taskId) return { collabId, task: null, error: 'No task was selected.' };
  if (!client) return { collabId, task: null, error: NO_SESSION };
  try {
    return taskFromResult(
      collabId,
      await client.extMethod('collab_task_update', { collabId, taskId, action, ...extra, ...at(cwd) }),
    );
  } catch (e) {
    return { collabId, task: null, error: message(e) };
  }
}

/** The turn-cost ledger, newest-first. `limit` is sent only when positive —
 *  the engine's own default applies otherwise. */
export async function collabLedger(
  client: CollabSource | null | undefined,
  collabId: string,
  limit?: number,
  cwd?: string,
): Promise<CollabLedgerPayload> {
  const empty: CollabLedgerPayload = { collabId, entries: [], totals: [] };
  if (!collabId) return { ...empty, error: 'No collab was selected.' };
  if (!client) return { ...empty, error: NO_SESSION };
  try {
    const res = (await client.extMethod('collab_ledger', {
      collabId,
      ...(typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? { limit: Math.trunc(limit) } : {}),
      ...at(cwd),
    })) as unknown as { entries?: LedgerEntry[]; totals?: CollabCostTotal[] };
    return { collabId, entries: array<LedgerEntry>(res?.entries), totals: array<CollabCostTotal>(res?.totals) };
  } catch (e) {
    return { ...empty, error: message(e) };
  }
}
