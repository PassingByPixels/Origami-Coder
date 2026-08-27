// Agent Manager - pollers.ts (S3): per-worktree git stats for the board rows,
// Kilo cadence (5s while the board is visible, 60s hidden) with content-hash
// suppression so an unchanged worktree never re-broadcasts. Read-only git -
// no repo mutex needed; the runGit Semaphore(3) bounds the spawn fan-out.

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

/**
 * Mark every untracked file in the worktree intent-to-add so `git diff` sees it.
 * `git add -A --intent-to-add` records that new files WILL be added WITHOUT
 * staging their content, so `git diff <base>` (badge) and `git diff --binary
 * <base>` (patch) emit proper new-file entries for them - they are otherwise
 * invisible to `git diff`. .gitignore is respected, so ignored files stay out;
 * the worktree is disposable, so marking its index is harmless. Best-effort: a
 * locked index must NEVER break stats, so any failure is swallowed.
 */
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
    // Exclude the engine's own .origami/ artifacts from the badge counts, exactly
    // as diffFiles does - a plan-mode run whose only output is .origami/plans/x.md
    // shows 0/0 (its plan stays readable via Chat). shortstat's regex is tolerant
    // of stderr noise, so it stays on the merged runGit.
    runGit(['diff', '--shortstat', baseSha, '--', '.', ':(exclude).origami'], worktreePath),
  ]);
  const { adds, dels } = parseShortstat(diff.ok ? diff.output : '');
  return { ahead: ahead.ok ? parseInt(ahead.output, 10) || 0 : 0, adds, dels };
}

export const POLL_VISIBLE_MS = 5_000;
export const POLL_HIDDEN_MS = 60_000;
