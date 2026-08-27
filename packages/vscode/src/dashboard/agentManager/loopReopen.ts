// loopReopen.ts — bring a persistent loop's CHAT back after it was closed.
//
// A loop marked persistent keeps running with no chat: closeSession pulls its
// engine session back up on a headless (`kind: 'agent'`) local session and
// re-arms the timer there (DashboardPanel.recallLoopHeadless). Turns keep
// accumulating on the engine's transcript with nowhere to read them, which is
// only worth anything if you can get the conversation back. This is that move,
// and it is closeSession's exact mirror.
//
// THE INVARIANT, taken unchanged from closeSession: ONE live client per engine
// session — two would race each other's prompts. So a reopen never attaches a
// second client. It DETACHES the headless one first, then opens a chat on the
// SAME engine id through the ordinary recall path (loadSession replays the whole
// transcript, so nothing the headless loop wrote is lost).
//
// TIMER OWNERSHIP falls out of that order rather than being tracked separately:
// the headless session's timer dies with the headless session, and the reopened
// chat arms exactly one. Reversed, the loop is double-armed — two timers
// prompting one engine session — which is the bug this file's ordering exists to
// make impossible.
//
// A reopen that CANNOT recall the engine session (deleted, engine wiped) never
// eats the schedule: nothing here calls the stop path, so the persisted record
// is left exactly as it was and the loop degrades to the existing "needs
// attention" row with its prompt intact. A detach that then fails to reopen is
// put back the way it was found — headless.

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

/**
 * Resolve a Loops-pane row id to a reopen plan.
 *
 * `rowId` arrives in one of two id spaces, exactly as it does for cancel: a live
 * row sends its LOCAL session id, a needs-attention row the persisted ENGINE id.
 * The spaces never collide, so a plain lookup tells them apart.
 */
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
  // A CHAT session already HAS the surface this action exists to bring back.
  // Revealing its tab is the whole job — tearing a live chat down and rebuilding
  // it would be strictly worse, and doing nothing at all is the worst button
  // there is.
  if (session.kind !== 'agent') return { kind: 'already-open', localId: rowId };
  const engineId = session.client.currentSessionId;
  if (!engineId) return { kind: 'unknown' };
  // A headless session whose loop was stopped between the broadcast and the
  // click has no live schedule left; the persisted record is then the only
  // description of the loop, and if that is gone too there is nothing to re-arm.
  const loop = liveLoop(engineId, session) ?? persisted.find((l) => l.sessionId === engineId);
  return loop ? { kind: 'detach', localId: rowId, engineId, loop } : { kind: 'unknown' };
}

/** Callbacks DashboardPanel supplies to enact a plan. */
export interface ReopenHost {
  /** Close the headless session — client disposed, session unregistered — WITHOUT
   *  entering the stop path, so the persisted record survives for the reopened
   *  chat to re-arm from. */
  detach: (localId: string) => void;
  /** Open a CHAT on this ENGINE session (the loadSession recall path). Resolves
   *  to the new LOCAL id, or null when the engine session could not be recalled
   *  — a local id returned for a session that never loaded would arm a timer on
   *  a dead client. */
  openChat: (engineId: string) => Promise<string | null>;
  /** Install the schedule and arm its NEXT tick on the given local session.
   *  Implementations must only schedule (never prompt immediately), for the same
   *  reason loopRearm.ts's RearmHost must not. */
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
    // Undo the detach, so a failed reopen never costs a loop that WAS running.
    // Only for a persistent one: recallHeadless is the persistent path (it
    // re-arms with the flag set), and re-running a non-persistent loop through it
    // would silently promote it. That one degrades to needs-attention instead —
    // record intact, nothing invented.
    if (plan.kind === 'detach' && isPersistent(plan.loop)) await host.recallHeadless(plan.loop);
    return 'unavailable';
  }
  host.arm(localId, plan.loop);
  return 'reopened';
}
