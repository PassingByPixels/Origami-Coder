// Agent Manager - rows.ts (S6b): the record+runtime -> AgentRow projection,
// extracted from manager.ts to keep it under its line cap. Pure over (state
// file, runtime map, host.sessionAlive), so it stays unit-testable and the
// owner just calls buildRows in its broadcast.

import { loadState } from './state';
import type { AgentRunState, Runtime, ManagerHost } from './manager';

export interface AgentRow {
  id: string;
  name: string;
  branch: string;
  path: string;
  orphan: boolean;
  state: AgentRunState;
  agentName: string;
  model: string;
  stopReason: string;
  errorDetail: string;
  setupNote: string;
  startedAt: number;
  hasSession: boolean;
  ahead: number;
  adds: number;
  dels: number;
  /** The stored task of a queued record ('' otherwise) - the card's tooltip and
   *  a card-filter target. */
  queuedPrompt: string;
  mergedAt: number; // ms of a CLEAN apply-to-main (0 = not merged); >0 retires the card to Merged
  /** Fan-out race grouping (S5): siblings of one race share this id; '' = none. */
  groupId: string;
  /** S7: a pending engine QUESTION with no mounted view to answer it (null = none).
   *  Projected only while the row is IN PROGRESS, so a settled run never shows a
   *  stale chip and the status-bar aggregate can trust it directly. */
  needsYou: { kind: 'question'; preview: string } | null;
  /** Folds board: the ticket this fold came from ('' = a plain fold), its title
   *  resolved from the list passed IN (so this stays pure), and the live activity
   *  line - working rows only, so a settled row can't show a stale "doing now". */
  ticketId: string;
  ticketTitle: string;
  activity: string;
}

/** Project a repo's records + their runtime onto the board rows. */
export function buildRows(root: string, runtime: Map<string, Runtime>, host: ManagerHost, titles?: ReadonlyMap<string, string>): AgentRow[] {
  return loadState(root).worktrees.map((rec) => {
    const rt = runtime.get(rec.id) ?? { state: 'detached' as AgentRunState };
    const alive = rt.sessionId ? host.sessionAlive(rt.sessionId) : false;
    // A WORKING row whose engine session has died mid-run is a real failure ->
    // surface it red, never as a benign 'detached'. An IDLE row whose session
    // is gone STAYS idle (it finished; hasSession false simply hides Chat).
    const diedMidRun = rt.state === 'working' && !alive;
    const state: AgentRunState = diedMidRun ? 'error' : rt.state;
    return {
      id: rec.id, name: rec.name, branch: rec.branch, path: rec.path,
      orphan: rec.orphan === true,
      state,
      agentName: rt.agentName ?? '',
      model: rt.model ?? '',
      stopReason: rt.stopReason ?? '',
      errorDetail: diedMidRun ? 'engine session died mid-run' : (rt.errorDetail ?? ''),
      setupNote: rt.setupNote ?? '', startedAt: rt.startedAt ?? rec.createdAt,
      hasSession: alive,
      ahead: rt.stats?.ahead ?? 0, adds: rt.stats?.adds ?? 0, dels: rt.stats?.dels ?? 0,
      queuedPrompt: rec.queuedTask?.prompt ?? '', mergedAt: rec.merged?.at ?? 0,
      groupId: rec.groupId ?? '',
      // Only surface a pending question while the run is IN PROGRESS — a died /
      // completed / answered run must never leave a stale "needs you" chip.
      needsYou: state === 'working' ? (rt.needsYou ?? null) : null,
      ticketId: rec.ticketId ?? '', ticketTitle: titles?.get(rec.ticketId ?? '') ?? '', activity: state === 'working' ? (rt.activity ?? '') : '',
    };
  });
}
