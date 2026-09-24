// The chat pane's repo/branch pills, host side — routed out of DashboardPanel.ts like
// flockScope.ts, and for the same reason: the panel is at its cap and this is a leaf
// with one job.
//
// The registry read is `repoOptions()` (flockScope.ts), not a second reader of
// repos.json. The branch list is `git worktree list` through the Agent Manager's own
// `listWorktrees`, and "New branch…" is its `createWorktree` — the picker owns NO git
// of its own, so it cannot invent a second worktree layout or, worse, check a branch
// out inside somebody's primary checkout while they are working in it.
//
// THE INVARIANT THIS FILE EXISTS TO HOLD: a Session's `cwd` is fixed at creation
// (DashboardPanel.createSession). Nothing here writes `session.cwd`. A selection that
// differs from the chat's current directory opens a NEW chat; the old one is closed
// only when it has no turns to lose. `selectionPlan` is that rule, pure and tested.

import { repoOptions } from './flockScope';
import { primaryFor } from './agentManager/repoFile';
import { createWorktree, listWorktrees, type WorktreeListEntry } from './agentManager/worktrees';

export const REPO_PICKER_MESSAGE_TYPES = new Set([
  'repoPickerOptions',
  'repoPickerBranches',
  'repoPickerSelect',
  'repoPickerNewBranch',
]);

export interface RepoPickerSession {
  id: string;
  cwd: string;
  /** Whether the chat has sent or received anything yet. A chat with turns is never
   *  re-pointed — its transcript belongs to the directory it was opened in. */
  hasTurns: boolean;
}

export interface BranchRow {
  branch: string;
  path: string;
}

export interface RepoPickerHost {
  /** The open workspace folder — the default every chat gets with no pick. */
  cwd?: string;
  post(message: Record<string, unknown>): void;
  sessions(): RepoPickerSession[];
  createChat(cwd: string): Promise<string | undefined>;
  closeChat(sessionId: string): void;
  /** Where repos.json is rooted. Tests pass a temp home; production omits it. */
  home?: string;
}

export interface SelectionPlan {
  openNew: boolean;
  closeOrigin: boolean;
}

/** What a pick does to the chat it was made from. Pure — this is the cwd-is-fixed rule
 *  itself, and the one thing in the feature that could silently corrupt a transcript. */
export function selectionPlan(origin: RepoPickerSession | undefined, cwd: string): SelectionPlan {
  if (!cwd) return { openNew: false, closeOrigin: false };
  if (!origin) return { openNew: true, closeOrigin: false };
  if (samePath(origin.cwd, cwd)) return { openNew: false, closeOrigin: false };
  return { openNew: true, closeOrigin: !origin.hasTurns };
}

function samePath(a: string | undefined, b: string | undefined): boolean {
  const key = (p: string | undefined) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return key(a) !== '' && key(a) === key(b);
}

/** `git worktree list` rows as the dropdown's rows. The primary checkout comes first —
 *  git lists it first and that order is the one the board shows. A detached worktree
 *  has no branch; it is labelled by its short HEAD rather than dropped, because a
 *  directory the user can be cwd'd into must be selectable from the pill that claims
 *  to show where they are. */
export function branchRows(entries: readonly WorktreeListEntry[]): BranchRow[] {
  return entries
    .filter((entry) => !!entry.path)
    .map((entry) => ({ branch: entry.branch || (entry.head || '').slice(0, 7) || '(detached)', path: entry.path }));
}

async function listFor(root: string): Promise<{ primary: string; rows: BranchRow[] }> {
  const primary = primaryFor(root);
  try {
    return { primary, rows: branchRows(await listWorktrees(primary)) };
  } catch {
    return { primary, rows: [] }; // a broken repo costs the pill its list, never the pane
  }
}

/** Open the picked directory as a chat, honouring `selectionPlan`. Returns the new
 *  chat's id when one was opened. */
async function apply(host: RepoPickerHost, sessionId: string, root: string, row: BranchRow): Promise<void> {
  const origin = host.sessions().find((s) => s.id === sessionId);
  const plan = selectionPlan(origin, row.path);
  const newSessionId = plan.openNew ? await host.createChat(row.path) : undefined;
  if (plan.closeOrigin && origin && newSessionId) host.closeChat(origin.id);
  host.post({
    type: 'repoPickerSelected',
    root,
    branch: row.branch,
    path: row.path,
    sessionId: newSessionId ?? sessionId,
    openedNewChat: plan.openNew,
  });
}

export async function handleRepoPickerMessage(
  host: RepoPickerHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  const str = (k: string): string => (typeof m[k] === 'string' ? (m[k] as string) : '');

  if (m.type === 'repoPickerOptions') {
    const cwdBySession: Record<string, string> = {};
    for (const s of host.sessions()) cwdBySession[s.id] = s.cwd;
    host.post({
      type: 'repoPickerOptions',
      repos: repoOptions(host.home),
      defaultRoot: host.cwd ?? '',
      cwdBySession,
    });
    return;
  }

  if (m.type === 'repoPickerBranches') {
    const root = str('root');
    const { rows } = await listFor(root);
    host.post({ type: 'repoPickerBranches', root, branches: rows });
    return;
  }

  if (m.type === 'repoPickerSelect') {
    const root = str('root');
    const path = str('path');
    if (!path) return;
    await apply(host, str('sessionId'), root, { branch: str('branch'), path });
    return;
  }

  if (m.type !== 'repoPickerNewBranch') return;
  const root = str('root');
  const primary = primaryFor(root);
  try {
    // The Agent Manager's own creator: `.origami/worktrees/<slug>` on a fresh
    // `origami/<slug>` branch off the primary's HEAD, under the per-repo git mutex.
    const made = await createWorktree(primary, str('name'));
    host.post({ type: 'repoPickerBranches', root, branches: branchRows(await listWorktrees(primary)) });
    await apply(host, str('sessionId'), root, { branch: made.branch, path: made.path });
  } catch (err) {
    host.post({ type: 'repoPickerError', root, message: err instanceof Error ? err.message : String(err) });
  }
}
