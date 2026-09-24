// The MERGE half of Apply-to-main: a fold whose work is committed and whose tree is clean is
// a branch, not a diff, so it lands via `git merge --no-ff` instead of a patch. Anything else
// (uncommitted or mixed) still goes through apply.ts's patch path, the only one that can carry
// working-tree changes. mergeable() is the whole decision, and stays deliberately strict.

import * as path from 'node:path';
import { runGit, runGitStdout, withRepoLock } from './worktrees';
import { loadState, saveState, type WorktreeRecord } from './state';
import { readTicket, scalar, stampFold } from './tickets';
import type { ApplyContext } from './apply';

export interface MergeOutcome { ok: boolean; conflicts: string[]; detail: string; sha: string }

/** True when the fold has commits past its base AND nothing uncommitted or untracked. Strict
 *  by design: an engine-written plan file or a stray .env counts as untracked, so such a fold
 *  falls back to the patch path instead of merging a tree nobody reviewed. */
export async function mergeable(worktreePath: string, baseSha: string): Promise<boolean> {
  const commits = await runGitStdout(['rev-list', '--count', `${baseSha}..HEAD`], worktreePath);
  if (!commits.ok || !(parseInt(commits.output.trim(), 10) > 0)) return false;
  const status = await runGitStdout(['status', '--porcelain'], worktreePath);
  return status.ok && status.output.trim() === '';
}

/** The repo's current branch, '' when detached. Merging into a detached HEAD
 *  would strand the merge commit on no ref at all, so the caller refuses. */
export async function currentBranch(repoRoot: string): Promise<string> {
  const r = await runGitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const name = r.ok ? r.output.trim() : '';
  return name === 'HEAD' ? '' : name;
}

/** The paths git left conflicted. Read BEFORE the abort - the index is where
 *  the U entries live and `merge --abort` clears it. */
async function conflictPaths(repoRoot: string): Promise<string[]> {
  const r = await runGitStdout(['diff', '--name-only', '--diff-filter=U'], repoRoot);
  return r.ok ? r.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
}

/** `git merge --no-ff --no-edit` the fold's branch. On failure the merge is aborted so the
 *  primary's tree/index return exactly as they were. */
export async function mergeFold(repoRoot: string, branch: string, message: string): Promise<MergeOutcome> {
  const r = await runGit(['merge', '--no-ff', '--no-edit', '-m', message, branch], repoRoot);
  if (r.ok) {
    const head = await runGitStdout(['rev-parse', '--short', 'HEAD'], repoRoot);
    return { ok: true, conflicts: [], detail: r.output, sha: head.ok ? head.output.trim() : '' };
  }
  const conflicts = await conflictPaths(repoRoot);
  await runGit(['merge', '--abort'], repoRoot);
  return { ok: false, conflicts, detail: r.output, sha: '' };
}

/** `merge <branch>: <ticket title> (<ticket id>)`, or just `merge <branch>` for
 *  a fold with no ticket (or whose ticket file has since gone). */
export function mergeMessage(repoRoot: string, rec: WorktreeRecord): string {
  const t = rec.ticketId ? readTicket(repoRoot, rec.ticketId) : undefined;
  if (!t) return `merge ${rec.branch}`;
  return `merge ${rec.branch}: ${scalar(t.fm, 'title') || t.id} (${t.id})`;
}

/** The Apply MERGE path. `files` is ignored — a merge is all-or-nothing. Shares the patch
 *  path's per-repo lock so a merge and an apply on one repo cannot race. */
export async function runMerge(ctx: ApplyContext, root: string, rec: WorktreeRecord, id: string): Promise<void> {
  const { host } = ctx;
  const target = await currentBranch(root);
  if (!target) {
    host.post({ type: 'amApplyResult', id, ok: false, conflicts: [], error: `${path.basename(root)} has a detached HEAD — check out a branch before merging this fold.` });
    return;
  }
  const out = await withRepoLock(root, () => mergeFold(root, rec.branch, mergeMessage(root, rec)));
  if (!out.ok) {
    // Aborted leaves the primary byte-identical to before; `diverged` is the pane's "main moved
    // under you" state.
    const named = out.conflicts.length > 0;
    host.post({ type: 'amApplyResult', id, ok: false, conflicts: out.conflicts, diverged: true, ...(named ? {} : { error: out.detail.split(/\r?\n/)[0] || 'git could not merge this fold.' }) });
    return;
  }
  // Retire the card exactly as a clean apply does, via a FRESH load-mutate-save
  // so a concurrent write is not clobbered.
  const state = loadState(root);
  const fresh = state.worktrees.find((r) => r.id === id);
  if (fresh) { fresh.merged = { at: Date.now() }; saveState(root, state); }
  stampFold(root, id, 'merged', `merged into ${target} as ${out.sha}`);
  ctx.broadcast();
  host.info(`Merged ${rec.branch} into ${target} as ${out.sha}.`);
  host.post({ type: 'amApplyResult', id, ok: true, mode: 'merge' });
}
