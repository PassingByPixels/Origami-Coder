// agentTreeHost.ts — the agent map's data on the host side (t-z1xlfy).
//
// The webview builds its sub-agent rows from THIS chat's `task` cards, which
// name direct children only. Two facts come from the engine for the rest:
//   - the roster (`origami/subagentRoster`): parent id + depth of EVERY
//     descendant, sent at restore and again when any descendant changes status;
//   - a sub-agent's background shell (`origami/backgroundTask`), start and stop.
// Both are kept on the chat's Session, so a map that opens later asks for them
// (`agentTreeRequest`) instead of having missed the one post that carried them.
//
// Every reader FAILS CLOSED: a field of the wrong type drops the frame.

import type { RosterRow, SubagentRoster } from '../acpHistory';

/** `origami/backgroundTask` (engine acp/agent-tree.ts). */
export interface BackgroundTask {
  ownerSessionId: string;
  jobId: string;
  kind: 'shell';
  title: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  startedAt: number;
  endedAt?: number;
}

export interface AgentTree {
  rows: RosterRow[];
  background: BackgroundTask[];
}

export const newAgentTree = (): AgentTree => ({ rows: [], background: [] });

const STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'error', 'cancelled']);

export function backgroundTaskFrom(raw: unknown): BackgroundTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const { ownerSessionId, jobId, title, status, startedAt, endedAt } = o;
  if (typeof ownerSessionId !== 'string' || !ownerSessionId || typeof jobId !== 'string' || !jobId) return null;
  if (typeof status !== 'string' || !STATUSES.has(status) || typeof startedAt !== 'number') return null;
  return {
    ownerSessionId, jobId, kind: 'shell',
    title: typeof title === 'string' ? title : '',
    status: status as BackgroundTask['status'],
    startedAt,
    ...(typeof endedAt === 'number' ? { endedAt } : {}),
  };
}

/** The roster replaces the rows whole: it is the engine's full list each time. */
export function adoptTreeRoster(tree: AgentTree, roster: SubagentRoster): void {
  tree.rows = roster.rows;
}

/** One entry per job: a stop replaces its own start. */
export function noteBackgroundTask(tree: AgentTree, task: BackgroundTask): void {
  tree.background = [...tree.background.filter((t) => t.jobId !== task.jobId), task];
}

export function agentTreePost(sessionId: string, tree: AgentTree): Record<string, unknown> {
  return { type: 'agentTree', sessionId, rows: tree.rows, background: tree.background };
}
