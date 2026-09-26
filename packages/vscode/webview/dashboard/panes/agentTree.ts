// agentTree.ts — every agent and background task the agent map draws, as ONE
// tree (t-z1xlfy). Pure and DOM-free.
//
// Three sources, each the only one that has its fact:
//   - the direct children: the pull-out's own rows (subagentRows.ts), from this
//     chat's `task` cards;
//   - the deeper tiers: the engine roster (parent id + depth of every
//     descendant), sent by the host as `agentTree` (src/dashboard/agentTreeHost.ts).
//     A grandchild's `task` card lives in the child's session and never reaches
//     this chat, so the roster is the only source for it;
//   - background shells: this chat's own from its bash cards (the card carries
//     the job), a sub-agent's from the host's `background` list.

import type { RosterRow } from './chatHistory';
import type { ToolShell } from './chatToolMeta';
import type { SubagentRow } from './subagentRows';
import { subagentShort } from './subagentLabel';

/** The host's `agentTree` post, as the webview keeps it. */
export interface AgentTreeData {
  rows: RosterRow[];
  background: HostBackgroundTask[];
}
export interface HostBackgroundTask {
  ownerSessionId: string;
  jobId: string;
  title: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  startedAt: number;
  endedAt?: number;
}

export const HUB = 'hub';

/** One agent on the map. `parent` is another node's key, or HUB. */
export interface TreeAgent {
  row: SubagentRow;
  parent: string;
  depth: number;
}

/** One background task on the map: a dashed chip after its owner's sub-agents. */
export interface TreeTask {
  key: string;
  owner: string;
  title: string;
  status: HostBackgroundTask['status'];
  startedAt: number;
}

export interface AgentTreeView {
  agents: TreeAgent[];
  tasks: TreeTask[];
}

/** The subset of a transcript card this reads for the chat's own shells. */
export interface ShellCard {
  toolName?: string;
  toolStatus?: string;
  toolCallId?: string;
  toolShell?: ToolShell;
  timestamp?: number;
}

/** This chat's own background shells, off their bash cards. A shell that was
 *  never backgrounded is not a task. */
export function chatShells(messages: ReadonlyArray<ShellCard>): TreeTask[] {
  const out: TreeTask[] = [];
  for (const m of messages) {
    const sh = m.toolShell;
    if (!sh || !(sh.state === 'background' || sh.state === 'promoted') || !(m.toolName === 'bash' || m.toolName === 'shell')) continue;
    const running = m.toolStatus === 'in_progress' || m.toolStatus === 'pending';
    const status: TreeTask['status'] = running ? 'running' : m.toolStatus === 'completed' ? 'completed' : sh.exit === null ? 'cancelled' : 'error';
    out.push({ key: sh.jobId ?? m.toolCallId ?? `bg-${out.length}`, owner: HUB, title: sh.command ?? '', status, startedAt: sh.startedAt ?? m.timestamp ?? 0 });
  }
  return out;
}

const rosterState = (r: RosterRow): SubagentRow['state'] => (r.status === 'running' ? 'running' : 'done');

/** A roster row as a card row. Only what the roster knows: no live activity. */
function nestedRow(r: RosterRow, short: string, now: number): SubagentRow {
  const running = r.status === 'running';
  const spent = r.tokens.input > 0 || r.tokens.output > 0;
  return {
    key: r.id, taskSessionId: r.id, ordinal: 0, short,
    ...(r.title ? { description: r.title } : {}),
    ...(r.agent ? { agentType: r.agent } : {}),
    title: r.title || r.id,
    state: rosterState(r),
    elapsedMs: Math.max(0, (running ? now : r.updated) - r.created),
    settled: !running,
    activity: '', thinking: '', thought: '',
    ...(spent ? { tokens: { input: r.tokens.input, output: r.tokens.output, cost: r.cost, ...(r.steps !== null ? { steps: r.steps } : {}) } } : {}),
  };
}

/**
 * The tree the map draws. Direct children are the pull-out's rows; a roster row
 * of depth 2+ hangs under the node whose session is its parent, numbered from
 * that parent (`T3.1`, `T3.1.2`) in the roster's own order (created, then id).
 * A row whose parent is not on the map (dismissed, or not in the roster) is
 * left out with its whole branch: it has nowhere true to hang.
 */
export function agentTree(direct: ReadonlyArray<SubagentRow>, data: AgentTreeData | undefined, chatTasks: ReadonlyArray<TreeTask>, now: number): AgentTreeView {
  const agents: TreeAgent[] = direct.map((row) => ({ row, parent: HUB, depth: 1 }));
  const bySession = new Map<string, TreeAgent>();
  for (const a of agents) if (a.row.taskSessionId) bySession.set(a.row.taskSessionId, a);
  const kids = new Map<string, number>();
  const deep = [...(data?.rows ?? [])].filter((r) => r.depth >= 2).sort((a, b) => a.depth - b.depth);
  for (const r of deep) {
    const parent = bySession.get(r.parentId);
    if (!parent || bySession.has(r.id)) continue;
    const n = (kids.get(parent.row.key) ?? 0) + 1;
    kids.set(parent.row.key, n);
    const node: TreeAgent = { row: nestedRow(r, `${subagentShort(parent.row)}.${n}`, now), parent: parent.row.key, depth: parent.depth + 1 };
    agents.push(node);
    bySession.set(r.id, node);
  }
  const tasks = [...chatTasks];
  for (const t of data?.background ?? []) {
    const owner = bySession.get(t.ownerSessionId);
    tasks.push({ key: t.jobId, owner: owner ? owner.row.key : HUB, title: t.title, status: t.status, startedAt: t.startedAt });
  }
  return { agents, tasks };
}

/** What a chip prints at its end: the ticking age while it runs, else why it stopped. */
export function taskEnd(task: TreeTask, owner: SubagentRow | undefined, now: number, age: (ms: number) => string): string {
  if (task.status === 'running') return age(Math.max(0, now - task.startedAt));
  if (task.status === 'cancelled') return owner?.settled ? `stopped with ${subagentShort(owner)}` : 'stopped';
  return task.status === 'error' ? 'failed' : 'ended';
}

/** The host's `agentTree` post for THIS chat, decoded; undefined for any other message. */
export function treeFromMessage(msg: unknown, sessionId: string): AgentTreeData | undefined {
  const m = msg as { type?: unknown; sessionId?: unknown; rows?: unknown; background?: unknown } | null;
  if (!m || m.type !== 'agentTree' || m.sessionId !== sessionId) return undefined;
  return {
    rows: Array.isArray(m.rows) ? (m.rows as RosterRow[]) : [],
    background: Array.isArray(m.background) ? (m.background as HostBackgroundTask[]) : [],
  };
}

/** Ask the host once (a map that opens after the post still gets the tree), then keep listening. */
export function watchAgentTree(deps: {
  sessionId: string;
  post(msg: unknown): void;
  listen(handler: (msg: unknown) => void): () => void;
  onTree(tree: AgentTreeData): void;
}): () => void {
  const stop = deps.listen((msg) => {
    const tree = treeFromMessage(msg, deps.sessionId);
    if (tree) deps.onTree(tree);
  });
  deps.post({ type: 'agentTreeRequest', sessionId: deps.sessionId });
  return stop;
}
