// The host-side collab poll: one slow timer for the whole workspace, so a collab keeps reporting
// while its editor tab is shut — a mounted CollabPane was previously the only producer of a ring
// update.
//
// Does not replace the pane's own faster poll (collabPollLoop.ts) — this is the floor,
// unconditional and slower, not the ceiling. Module state on purpose: collabs are workspace-scoped
// and one engine answers for all of them, so a second watch would duplicate every round trip; the
// panel must call stopCollabWatch() on dispose.
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
