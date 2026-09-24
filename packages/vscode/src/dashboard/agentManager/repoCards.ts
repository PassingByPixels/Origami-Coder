// The REPOSITORY, as opposed to the registered path: one card per repo (every entry
// sharing a git common dir), replacing the old one-pill-per-registered-entry top bar. The
// ident cache answers "which repository is this path, and what is it on" (refreshed on the
// map-status beat); the message half is the four am* routes, each re-checking the path it
// was handed really is one of that repository's worktrees, since "make primary" writes it
// to a file other processes obey.

import * as path from 'node:path';
import { runGitStdout } from './gitRun';
import { repoKey } from './registry';
import { listWorktrees, WORKTREES_DIRNAME, type WorktreeListEntry } from './worktrees';
import { foreignRoots, setPrimary, updateRepoFile } from './repoFile';
import { fileLacksKnown, foreignLabels } from './repoRemovals';
import type { ManagerHost } from './manager';

/** ADOPT-ON-READ: repos.json is now written by the engine's board_register too, so an entry
 *  this window has never heard of is invisible until its root joins the known list. Run on
 *  every board request; a no-op (no Memento write) when there's nothing new. A known root the
 *  file lacks also syncs, so a removal made outside the window (repoRemovals.ts) shows now. */
export function adoptForeign(host: ManagerHost): void {
  const known = host.knownRepos();
  const extra = foreignRoots(known, host.repoRoot());
  // A board label another writer set comes in with the repo. The overlay is saved FIRST: a
  // sync with the root known and its label absent would clear the label from the file.
  const labels = foreignLabels(extra);
  if (Object.keys(labels).length > 0) host.saveRepoDisplayNames({ ...host.repoDisplayNames(), ...labels });
  if (extra.length > 0 || fileLacksKnown(known)) host.saveKnownRepos([...known, ...extra]);
}

/** What a card needs about one checkout: which repository it belongs to and what it's on;
 *  `groupId` is the resolved git common dir. */
export interface RepoIdent { groupId: string; branch: string }

/** Ask git which repository a checkout belongs to and what it is on. Never
 *  throws: an unreadable path yields no ident and the card simply stands alone. */
export async function readIdent(root: string): Promise<RepoIdent | undefined> {
  const common = await runGitStdout(['rev-parse', '--git-common-dir'], root);
  if (!common.ok) return undefined;
  const branch = await runGitStdout(['branch', '--show-current'], root);
  return {
    groupId: repoKey(path.resolve(root, common.output.trim())),
    branch: branch.ok ? branch.output.trim() : '',
  };
}

/** Refresh idents for every root that needs one; returns true on any real change, so the
 *  poll only broadcasts on a real move. Roots that vanish from the list are dropped. */
export async function refreshIdents(roots: string[], cache: Map<string, RepoIdent>): Promise<boolean> {
  let changed = false;
  const wanted = new Set(roots);
  for (const key of [...cache.keys()]) {
    if (!wanted.has(key)) { cache.delete(key); changed = true; }
  }
  for (const root of wanted) {
    const next = await readIdent(root);
    if (!next) continue; // keep whatever we had; an unreachable repo is not a new identity
    const prev = cache.get(root);
    if (prev?.groupId === next.groupId && prev.branch === next.branch) continue;
    cache.set(root, next);
    changed = true;
  }
  return changed;
}

/** One row under an open repo card. `fold` marks an Origami-managed worktree so the user
 *  can tell their own checkouts apart. */
export interface WorktreeCardRow {
  name: string;
  branch: string;
  path: string;
  primary: boolean;
  fold: boolean;
}

/** Project `git worktree list --porcelain` onto the card's rows. Pure - the
 *  primary row leads, the rest follow git's order. */
export function worktreeRows(entries: WorktreeListEntry[], primary: string): WorktreeCardRow[] {
  const foldDir = repoKey(path.resolve(primary, WORKTREES_DIRNAME)) + path.sep;
  const rows = entries.map((e) => {
    const abs = path.resolve(e.path);
    return {
      name: path.basename(abs),
      branch: e.branch ?? '',
      path: abs,
      primary: repoKey(abs) === repoKey(path.resolve(primary)),
      fold: repoKey(abs).startsWith(foldDir),
    };
  });
  return [...rows.filter((r) => r.primary), ...rows.filter((r) => !r.primary)];
}

/** The repository's local branch names, read at the PRIMARY (any worktree of a repository
 *  answers the same). Never throws — a repository git cannot read reports no branches rather
 *  than failing the whole reply. */
export async function localBranches(primary: string): Promise<string[]> {
  const r = await runGitStdout(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], primary);
  if (!r.ok) return [];
  return r.output.split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

/** The window the repo-card routes drive the fleet owner through. */
export interface RepoCardCtx {
  host: ManagerHost;
  /** The board's standard scoped check: names a composed, non-missing repo and
   *  resolves it to that repository's PRIMARY checkout (else amError + undefined). */
  validateRoot(raw: unknown): string | undefined;
  broadcast(): void;
}

/** Route an `amRepoWorktrees` / `amMakePrimary` / `amWorktreeTerminal` /
 *  `amWorktreeChat` message. */
export async function handleRepoCardMessage(ctx: RepoCardCtx, m: { type?: string; [k: string]: unknown }): Promise<void> {
  const primary = ctx.validateRoot(m.root);
  if (!primary) return; // validateRoot already surfaced amError
  const rows = worktreeRows(await listWorktrees(primary), primary);
  if (m.type === 'amRepoWorktrees') {
    // Echo the ENTRY root back, not the primary: the card is keyed by the root
    // the board drew it from, and a reply keyed by anything else lands nowhere.
    ctx.host.post({
      type: 'amWorktrees', root: String(m.root ?? ''), primary, worktrees: rows,
      branches: await localBranches(primary),
    });
    return;
  }
  // Every remaining route acts on a path from the webview — it must be one of THIS
  // repository's worktrees, since "make primary" writes it to a shared file and the others
  // would otherwise open a shell/agent session at any path a stray message named.
  const target = rows.find((r) => repoKey(r.path) === repoKey(path.resolve(String(m.path ?? ''))));
  if (!target) { ctx.host.post({ type: 'amError', message: 'That worktree is no longer part of this repository.' }); return; }
  switch (m.type) {
    case 'amWorktreeTerminal':
      ctx.host.openTerminal(target.path, `Folds: ${target.name}`);
      return;
    case 'amWorktreeChat': {
      // A NEW session whose cwd IS the worktree, opened in front of the user -
      // the same seam a spec run uses, with no worktree record and no fold.
      try {
        ctx.host.openChat(await ctx.host.createAgentSession(target.path));
      } catch (e) {
        ctx.host.post({ type: 'amError', message: `Could not start a chat in ${target.name}: ${e instanceof Error ? e.message : String(e)}` });
      }
      return;
    }
    case 'amMakePrimary':
      // Sync first: setPrimary only edits an entry that already exists, so a repo registered in
      // this window but never yet synced would otherwise be a silent no-op. Through the host, so
      // the sync runs the removal check (repoRemovals.ts) like every other write.
      ctx.host.saveKnownRepos(ctx.host.knownRepos());
      // Keyed by the ENTRY root: repos.json holds that, and the merge writer only changes its
      // `primary`, leaving every other field alone.
      updateRepoFile((doc) => setPrimary(doc, String(m.root ?? ''), target.path));
      ctx.broadcast();
      return;
  }
}
