// Per-worktree git stats for the board rows, with content-hash suppression so an unchanged
// worktree never re-broadcasts.

import { runGit, runGitStdout } from './worktrees';

export interface WorktreeGitStats {
  /** Commits the worktree branch is ahead of the record's base. */
  ahead: number;
  /** Working-tree line adds/dels vs the base commit (uncommitted included -
   *  an agent that edits without committing still shows its footprint). */
  adds: number;
  dels: number;
}

/** Parse `git diff --shortstat` output ("3 files changed, 41 insertions(+), 7 deletions(-)"). */
export function parseShortstat(line: string): { adds: number; dels: number } {
  const adds = /(\d+) insertion/.exec(line || '');
  const dels = /(\d+) deletion/.exec(line || '');
  return { adds: adds ? parseInt(adds[1], 10) : 0, dels: dels ? parseInt(dels[1], 10) : 0 };
}

export function statsKey(s: WorktreeGitStats): string {
  return `${s.ahead}|${s.adds}|${s.dels}`;
}

/** Mark every untracked worktree file intent-to-add so `git diff` sees new files
 *  (otherwise invisible to it), matching the badge and patch paths. .gitignore is respected;
 *  best-effort, since a locked index must never break stats. */
export async function markUntracked(worktreePath: string): Promise<void> {
  try { await runGit(['add', '-A', '--intent-to-add'], worktreePath); }
  catch { /* best-effort - a locked index must not break stats */ }
}

export async function readWorktreeStats(worktreePath: string, baseSha: string): Promise<WorktreeGitStats> {
  await markUntracked(worktreePath); // so new (untracked) files count toward the badge
  const [ahead, diff] = await Promise.all([
    // rev-list --count is PARSED (parseInt) - runGitStdout so a stderr warning
    // can't glue itself to the count (the same hazard that corrupted numstat).
    runGitStdout(['rev-list', '--count', `${baseSha}..HEAD`], worktreePath),
    // Exclude the engine's own .origami/ artifacts from the badge counts, as diffFiles does, so
    // a plan-only run shows 0/0.
    runGit(['diff', '--shortstat', baseSha, '--', '.', ':(exclude).origami'], worktreePath),
  ]);
  const { adds, dels } = parseShortstat(diff.ok ? diff.output : '');
  return { ahead: ahead.ok ? parseInt(ahead.output, 10) || 0 : 0, adds, dels };
}

export const POLL_VISIBLE_MS = 5_000;
export const POLL_HIDDEN_MS = 60_000;
