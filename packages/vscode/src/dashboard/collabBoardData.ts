// Flock M4 wave X1 — the SIX new `collab_*` host leaves: lead, objective, the
// task board's two mutations, the cost ledger, and stop. A SIBLING of
// collabData.ts, not an addition to it — that file sits at 247/250 lines and
// the ratchet's remedy is a new module, never a raised cap.
//
// Same house pattern collabData.ts already established: a no-session guard, a
// throw turned into an `error` FIELD (never a rejected promise), a defensive
// read of a reply that crossed the JSON-RPC wire, and `collabId` self-carried
// on every payload — `post` fans every reply out to EVERY attached webview, so
// a payload with no id of its own would leave a collab-scoped view unable to
// tell whether a reply is its own.
//
// The engine does not carry these methods yet (E1/E2 land them in a later
// wave) — every call here reaches the wire once it does; until then each is
// exercised only by its own tests.
//
// No `vscode` import, so every decision below is exercised without an
// extension host.
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

/** Reopen an archived collab (collab-resume) — the inverse of collabData's
 *  collabArchive. Clears `archivedAt`; the room resumes exactly where it left
 *  off, since each participant's own session and last-seen position were
 *  never touched by archiving in the first place. */
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
 *  required-field enforcement (owner on claim, result on done, note on
 *  reopen) is the ENGINE's — this leaf passes through whatever the caller
 *  supplied rather than guessing one. */
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

/** The turn-cost ledger, newest-first. `limit` is sent only when it is a
 *  positive number — the engine's own default (100) applies otherwise, so
 *  this leaf invents nothing. */
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
