// Agent Manager - worktrees.ts (S2): the git worktree lifecycle, Kilo-shaped.
// Worktrees live IN the repo at .origami/worktrees/<name> (excluded via
// .git/info/exclude, so the primary tree never sees them), one branch per
// worktree named origami/<name> with -2/-3 collision suffixes, created from a
// dereferenced commit so the branch carries no upstream tracking. All mutating
// git goes through a per-repo mutex - concurrent worktree adds/removes on one
// repo would otherwise race index.lock.
//
// Deliberately vscode-free: plain child_process + fs so the whole module runs
// against a throwaway `git init` fixture in vitest. The setup-script hook
// (Kilo's .kilo/setup-script) is DEFERRED to S3 - it runs as a VS Code task
// attached to a live agent flow, which does not exist until the manager lands.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from './gitRun';

// The git child-process layer moved to gitRun.ts (S6d) when a third capture
// variant (runGitStdout) had to land beside its siblings and this file was at
// cap. Re-exported so every long-standing importer of `from './worktrees'`
// (apply/pollers/diffProvider/state/tests) keeps working unchanged.
export { runGit, runGitStdout, runGitStdoutToFile, type GitResult } from './gitRun';

export const WORKTREES_DIRNAME = path.join('.origami', 'worktrees');
export const BRANCH_PREFIX = 'origami/';

// ---------------------------------------------------------------------------
// Per-repo git mutex: a promise chain keyed by the repo root, so every
// MUTATING git op (worktree add/remove/prune, later apply) on one repo runs
// strictly serialized. Read-only ops (list, rev-parse) may bypass it.
// In-process only - two VS Code windows on the same repo still race, which is
// the accepted solo-dev risk (Kilo carries the same one).
// ---------------------------------------------------------------------------

const repoLocks = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot).toLowerCase();
  // Stored tails are always failure-swallowed, so prev never rejects.
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  repoLocks.set(key, next.catch(() => undefined));
  return next;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Sanitize a user-typed worktree name into a git-ref-safe, path-safe slug.
 *  End-trimming runs LAST so the length cap cannot re-expose a trailing `.`
 *  (an invalid ref ending) it would otherwise cut mid-slug. */
export function sanitizeWorktreeName(raw: string): string {
  const slug = (raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')   // spaces + anything git refs reject -> dash
    .replace(/\.{2,}/g, '.')          // no ".." (ref rule)
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/\.lock$/, '')           // refs can't end in .lock
    .replace(/^[-.]+|[-.]+$/g, '');   // refs can't start/end with - or .
  return slug || 'agent';
}

// ---------------------------------------------------------------------------
// Worktree list (read-only)
// ---------------------------------------------------------------------------

export interface WorktreeListEntry { path: string; head: string; branch?: string }

/** Parse `git worktree list --porcelain` output. Pure - unit tested directly. */
export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: Partial<WorktreeListEntry> | null = null;
  for (const line of (porcelain || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current?.path) entries.push(current as WorktreeListEntry);
      current = { path: line.slice('worktree '.length).trim(), head: '' };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (current && line.startsWith('branch ')) {
      // "branch refs/heads/origami/foo" -> "origami/foo"
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  if (current?.path) entries.push(current as WorktreeListEntry);
  return entries;
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeListEntry[]> {
  const r = await runGit(['worktree', 'list', '--porcelain'], repoRoot);
  return r.ok ? parseWorktreeList(r.output) : [];
}

/** The subset of worktrees that are OURS (under .origami/worktrees/). */
export function ownWorktrees(entries: WorktreeListEntry[], repoRoot: string): WorktreeListEntry[] {
  const root = path.resolve(repoRoot, WORKTREES_DIRNAME).toLowerCase() + path.sep;
  return entries.filter((e) => path.resolve(e.path).toLowerCase().startsWith(root));
}

// ---------------------------------------------------------------------------
// Exclude (local-only ignore - no .gitignore edit)
// ---------------------------------------------------------------------------

const EXCLUDE_LINES = ['.origami/worktrees/', '.origami/agent-manager.json', '.origami/map/'];

/**
 * The git directory whose `info/` git actually reads for `repoRoot`.
 *
 * A registered repo may itself BE a linked worktree (Origami Coder is developed
 * that way), whose `.git` is a one-line `gitdir: <path>` FILE - so the old
 * `mkdir <root>/.git/info` threw ENOTDIR/ENOENT because the parent is a file.
 * Two hops, both synchronous (no git subprocess - this runs inside a sync fs
 * helper): the pointer file names the per-worktree git dir, and that dir's
 * `commondir` names the shared one. The COMMON dir is the answer, not the
 * per-worktree dir: git maps `info/` onto the common dir for every linked
 * worktree, so an exclude written to the per-worktree dir is a file git never
 * reads (verified against a real `git worktree add` fixture). A relative
 * pointer (the submodule shape) resolves against the root. Anything
 * unreadable degrades to `<root>/.git` - the old behaviour, never a throw.
 */
export function resolveGitDir(repoRoot: string): string {
  const dot = path.join(repoRoot, '.git');
  try { if (fs.statSync(dot).isDirectory()) return dot; } catch { return dot; }
  const pointer = /^\s*gitdir:\s*(.+?)\s*$/m.exec(safeRead(dot));
  if (!pointer) return dot;
  const gitDir = path.resolve(repoRoot, pointer[1]);
  const common = safeRead(path.join(gitDir, 'commondir')).trim();
  return common ? path.resolve(gitDir, common) : gitDir;
}

function safeRead(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** Append our entries to the git dir's info/exclude once (idempotent). */
export function ensureExcluded(repoRoot: string): void {
  const infoDir = path.join(resolveGitDir(repoRoot), 'info');
  const excludeFile = path.join(infoDir, 'exclude');
  let existing = '';
  try { existing = fs.readFileSync(excludeFile, 'utf8'); } catch { /* absent is fine */ }
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = EXCLUDE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  fs.mkdirSync(infoDir, { recursive: true });
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(excludeFile, `${sep}# Origami Agent Manager (local worktrees + state)\n${missing.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreatedWorktree { name: string; branch: string; path: string; baseSha: string }

/**
 * Create a worktree + branch from `base` (a ref; defaults to HEAD). Kilo
 * mechanics: name collisions get -2/-3 suffixes (branch and directory share
 * the suffixed name); the start point is the DEREFERENCED commit so the new
 * branch has no upstream tracking; root .env* files are copied in afterwards
 * (COPYFILE_EXCL - never overwrite something already there).
 */
export async function createWorktree(
  repoRoot: string,
  rawName: string,
  base = 'HEAD',
): Promise<CreatedWorktree> {
  return withRepoLock(repoRoot, async () => {
    const baseName = sanitizeWorktreeName(rawName);
    const sha = await runGit(['rev-parse', '--verify', `${base}^{commit}`], repoRoot);
    if (!sha.ok) throw new Error(`cannot resolve base '${base}': ${sha.output}`);
    const baseSha = sha.output.split(/\r?\n/)[0].trim();

    // Find a free name: branch AND directory must both be free (they travel
    // together; a stale dir with no branch still blocks `worktree add`).
    let name = baseName;
    for (let i = 2; i <= 20; i++) {
      const branchTaken = (await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH_PREFIX}${name}`], repoRoot)).ok;
      const dirTaken = fs.existsSync(path.join(repoRoot, WORKTREES_DIRNAME, name));
      if (!branchTaken && !dirTaken) break;
      name = `${baseName}-${i}`;
    }
    const branch = `${BRANCH_PREFIX}${name}`;
    const wtPath = path.join(repoRoot, WORKTREES_DIRNAME, name);

    ensureExcluded(repoRoot);
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    const add = await runGit(['worktree', 'add', '-b', branch, wtPath, baseSha], repoRoot);
    if (!add.ok) throw new Error(`git worktree add failed: ${add.output}`);

    // Copy root .env* (gitignored config an agent's build/tests need). Never
    // overwrite: the base commit may legitimately track such a file.
    for (const entry of fs.readdirSync(repoRoot)) {
      if (!entry.startsWith('.env')) continue;
      const src = path.join(repoRoot, entry);
      if (!fs.statSync(src).isFile()) continue;
      try { fs.copyFileSync(src, path.join(wtPath, entry), fs.constants.COPYFILE_EXCL); } catch { /* exists - keep theirs */ }
    }

    return { name, branch, path: wtPath, baseSha };
  });
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Remove a worktree: plain remove -> retry x3 with backoff (Windows file
 * locks from a just-killed engine child release asynchronously) -> --force ->
 * prune. Caller must have stopped any session running in it first. The branch
 * is deleted only when asked - it is the safety net that keeps the agent's
 * work recoverable after the directory is gone.
 */
export async function removeWorktree(
  repoRoot: string,
  wtPath: string,
  opts: { deleteBranch?: string } = {},
): Promise<{ ok: boolean; detail: string }> {
  return withRepoLock(repoRoot, async () => {
    let last = '';
    let removed = false;
    for (let attempt = 0; attempt < 3 && !removed; attempt++) {
      if (attempt > 0) await sleep(250 * attempt);
      const r = await runGit(['worktree', 'remove', wtPath], repoRoot);
      removed = r.ok;
      last = r.output;
    }
    if (!removed) {
      const forced = await runGit(['worktree', 'remove', '--force', wtPath], repoRoot);
      removed = forced.ok;
      last = forced.output;
    }
    await runGit(['worktree', 'prune'], repoRoot);
    if (removed && opts.deleteBranch) {
      const del = await runGit(['branch', '-D', opts.deleteBranch], repoRoot);
      if (!del.ok) return { ok: true, detail: `worktree removed; branch delete failed: ${del.output}` };
    }
    return { ok: removed, detail: removed ? 'removed' : `could not remove worktree: ${last}` };
  });
}
