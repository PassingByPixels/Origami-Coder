// The record+runtime -> AgentRow projection, extracted from manager.ts. Pure, so it stays testable.

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
  /** The stored task of a queued record ('' otherwise) — the card's tooltip and filter target. */
  queuedPrompt: string;
  mergedAt: number; // ms of a CLEAN apply-to-main (0 = not merged); >0 retires the card to Merged
  /** Fan-out race grouping (S5): siblings of one race share this id; '' = none. */
  groupId: string;
  /** A pending engine QUESTION with no mounted view, projected only while the row is in progress,
   *  so a settled run shows no stale chip. */
  needsYou: { kind: 'question'; preview: string } | null;
  /** Folds board: the ticket this fold came from, its title resolved from the passed-in list, and
   *  the live activity line. */
  ticketId: string;
  ticketTitle: string;
  activity: string;
}

/** Project a repo's records + their runtime onto the board rows. */
export function buildRows(root: string, runtime: Map<string, Runtime>, host: ManagerHost, titles?: ReadonlyMap<string, string>): AgentRow[] {
  return loadState(root).worktrees.map((rec) => {
    const rt = runtime.get(rec.id) ?? { state: 'detached' as AgentRunState };
    const alive = rt.sessionId ? host.sessionAlive(rt.sessionId) : false;
    // A WORKING row whose session died mid-run is a real failure, surfaced red; an IDLE row
    // whose session is gone stays idle since it finished.
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
