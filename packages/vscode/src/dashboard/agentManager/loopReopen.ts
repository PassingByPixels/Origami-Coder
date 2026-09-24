// Bring a persistent loop's chat back after it was closed — closeSession's exact mirror.
// The invariant: one live client per engine session, since two would race each other's
// prompts, so reopen detaches the headless client first, then opens a chat on the SAME
// engine id via the ordinary recall path (which replays the whole transcript). Timer
// ownership falls out of that order: the headless timer dies with the headless session, and
// the reopened chat arms exactly one — reversed, the loop would be double-armed. A reopen
// that cannot recall the engine session never eats the schedule; it stays persisted as a
// "needs attention" row.

import { isPersistent, type PersistedLoop } from './loopPersistence';

/** The slice of a live session this module reads — kept structural (not imported
 *  from DashboardPanel.ts) so it has no dependency on the host's private type. */
export interface ReopenSessionSource {
  /** 'agent' == headless: running with no chat tab of its own. */
  kind?: 'chat' | 'agent';
  client: { currentSessionId: string | null };
  loopSchedule?: { intervalMs: number; prompt: string; runs: number; createdAt: number; persistent: boolean };
}

/** What reopening THIS row actually means, decided before anything is torn down. */
export type ReopenPlan =
  | { kind: 'already-open'; localId: string }
  | { kind: 'detach'; localId: string; engineId: string; loop: PersistedLoop }
  | { kind: 'recall'; engineId: string; loop: PersistedLoop }
  | { kind: 'unknown' };

function liveLoop(engineId: string, session: ReopenSessionSource): PersistedLoop | null {
  const s = session.loopSchedule;
  // The LIVE schedule wins over the persisted copy: `runs` is only flushed to
  // storage after each tick, so mid-interval the persisted count is behind.
  return s
    ? { sessionId: engineId, intervalMs: s.intervalMs, prompt: s.prompt, runs: s.runs, createdAt: s.createdAt, persistent: s.persistent }
    : null;
}

/** Resolve a Loops-pane row id to a reopen plan. `rowId` arrives in one of two id spaces
 *  (live row = local session id, needs-attention row = persisted engine id); the spaces
 *  never collide, so a plain lookup tells them apart. */
export function planLoopReopen(
  rowId: string,
  sessions: ReadonlyMap<string, ReopenSessionSource>,
  persisted: readonly PersistedLoop[],
): ReopenPlan {
  const session = sessions.get(rowId);
  if (!session) {
    const loop = persisted.find((l) => l.sessionId === rowId);
    return loop ? { kind: 'recall', engineId: rowId, loop } : { kind: 'unknown' };
  }
  // A chat session already has this surface — revealing its tab is the whole job; tearing it
  // down and rebuilding would be strictly worse.
  if (session.kind !== 'agent') return { kind: 'already-open', localId: rowId };
  const engineId = session.client.currentSessionId;
  if (!engineId) return { kind: 'unknown' };
  // A headless session whose loop was stopped between broadcast and click has no live
  // schedule; if the persisted record is gone too there is nothing to re-arm.
  const loop = liveLoop(engineId, session) ?? persisted.find((l) => l.sessionId === engineId);
  return loop ? { kind: 'detach', localId: rowId, engineId, loop } : { kind: 'unknown' };
}

/** Callbacks DashboardPanel supplies to enact a plan. */
export interface ReopenHost {
  /** Close the headless session (client disposed, unregistered) without entering the stop
   *  path, so the persisted record survives for the reopened chat to re-arm from. */
  detach: (localId: string) => void;
  /** Open a chat on this engine session; resolves to the new local id, or null when it can't
   *  be recalled — never a local id for a dead client. */
  openChat: (engineId: string) => Promise<string | null>;
  /** Install the schedule and arm its next tick; implementations must only schedule, never
   *  prompt immediately. */
  arm: (localId: string, loop: PersistedLoop) => void;
  /** Put a persistent loop back on a headless session — the state `detach`
   *  undoes, restored when the reopen that followed it failed. */
  recallHeadless: (loop: PersistedLoop) => Promise<void>;
  /** Reveal an already-open chat's editor tab. */
  reveal: (localId: string) => void;
  /** Say, in the chat, what actually happened. */
  report: (message: string) => void;
}

export type ReopenOutcome = 'reopened' | 'revealed' | 'unavailable' | 'unknown';

/** Enact a plan. Nothing here writes to storage: a loop's persisted record is
 *  its survival, and every failure path below leaves it untouched. */
export async function reopenLoopChat(plan: ReopenPlan, host: ReopenHost): Promise<ReopenOutcome> {
  if (plan.kind === 'unknown') {
    host.report('Loop: there is no chat to reopen — this schedule is no longer registered.');
    return 'unknown';
  }
  if (plan.kind === 'already-open') {
    host.reveal(plan.localId);
    return 'revealed';
  }
  // Detach FIRST. Opening the chat while the headless client is still live would
  // put two clients on one engine session, each with its own armed timer.
  if (plan.kind === 'detach') host.detach(plan.localId);
  const localId = await host.openChat(plan.engineId);
  if (localId === null) {
    host.report(
      `Loop: could not reopen the chat — engine session ${plan.engineId} would not load. `
      + 'The schedule is kept; cancel it from the Loops pane if that session is gone for good.',
    );
    // Undo the detach so a failed reopen never costs a loop that was running (only for a
    // persistent one, since recallHeadless is the persistent path); a non-persistent loop
    // degrades to needs-attention instead, record intact.
    if (plan.kind === 'detach' && isPersistent(plan.loop)) await host.recallHeadless(plan.loop);
    return 'unavailable';
  }
  host.arm(localId, plan.loop);
  return 'reopened';
}
