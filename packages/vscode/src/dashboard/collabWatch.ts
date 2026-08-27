// The HOST-side collab poll — one slow timer for the whole workspace, so a
// collab keeps reporting while its editor tab is shut (report F1 / plan 2.1).
//
// WHY THE HOST HAS TO OWN ONE. The sidebar's per-collab ring has exactly one
// input: a `collabStateData` payload. Until this file existed, only a mounted
// CollabPane ever produced one, so closing a room's tab took its ring with it
// and a collab working in the background was invisible. CollabsList.svelte says
// so in its own comment ("a ring only lives while some pane for that collab is
// polling"). This is that honest limit removed, not worked around.
//
// IT DOES NOT REPLACE THE PANE'S POLL. An open tab still runs its own faster
// loop (collabPollLoop.ts, 1.2 s busy / 4 s idle) because that is the surface a
// lag is felt on. This one is deliberately slower and unconditional: it is the
// floor, not the ceiling.
//
// MODULE STATE, ON PURPOSE. Collabs are workspace-scoped, one engine answers
// for all of them, and the payloads are fanned out to every view — so a second
// watch would be a second set of identical round trips. The panel calls
// stopCollabWatch() when it goes away, and nothing else may leave a timer
// running behind a disposed webview.
//
// No `vscode` import, so the whole lifecycle is exercised with fake timers.
import { collabState, type CollabSource } from './collabData';

/** The slice of CollabManagerHost this needs — structurally satisfied by it,
 *  which is why collabManager can hand its own host straight through. */
export interface CollabWatchHost {
  post(msg: Record<string, unknown>): void;
  cwd(): string;
  collabClient(): CollabSource | undefined;
}

/** Slower than the pane's idle cadence by design — see the header. */
export const COLLAB_WATCH_MS = 5000;

let timer: ReturnType<typeof setTimeout> | null = null;
let watched: string[] = [];
let current: CollabWatchHost | null = null;
/** Highest seq this WATCH has seen per collab, so a tick asks for what is new
 *  instead of re-fetching a whole transcript every five seconds. It is the
 *  watch's own count, never a pane's: the two poll independently and each
 *  payload carries the `sinceSeq` it was answered for. */
const seen = new Map<string, number>();

/** Point the watch at the collabs that are currently live. Called from every
 *  list refresh, so an archived or deleted room falls out of the set on its own
 *  and a new one joins it without a second wire call. */
export function watchCollabs(host: CollabWatchHost, ids: string[]): void {
  current = host;
  watched = ids;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  // No collabs, no timer. A workspace that never opens one pays nothing.
  if (ids.length > 0) timer = setTimeout(tick, COLLAB_WATCH_MS);
}

/** Teardown, owned by DashboardPanel.dispose(). Module state outlives any one
 *  panel, so without this a disposed panel's `post` would be called forever. */
export function stopCollabWatch(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  watched = [];
  current = null;
  seen.clear();
}

async function tick(): Promise<void> {
  timer = null;
  const host = current;
  // Re-armed rather than intervalled, and the whole sweep is awaited before the
  // next delay is scheduled — a slow engine can never stack two sweeps.
  if (host) for (const id of watched) await pollOne(host, id);
  if (current && watched.length > 0 && timer === null) timer = setTimeout(tick, COLLAB_WATCH_MS);
}

async function pollOne(host: CollabWatchHost, collabId: string): Promise<void> {
  const client = host.collabClient();
  // No engine yet is NOT a failure worth reporting. `collabState` would answer
  // "Open a chat first", and posting that would paint an error banner over a
  // collab nobody is even looking at.
  if (!client) return;
  const payload = await collabState(client, collabId, seen.get(collabId) ?? 0, host.cwd());
  // Same rule for a poll that actually failed: this is a BACKGROUND observer,
  // and the open room's own poll is what reports a dead engine to the user.
  if (payload.error) return;
  for (const m of payload.messages) if (m.seq > (seen.get(collabId) ?? 0)) seen.set(collabId, m.seq);
  host.post({ type: 'collabStateData', ...payload });
}
