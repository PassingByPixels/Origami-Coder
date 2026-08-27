// Agent Manager - repoCards.ts (Folds board, repo cards): the REPOSITORY, as
// opposed to the registered path. The old top bar was one pill per registered
// entry, which drew two pills for a repo checked out twice; a card is one
// REPOSITORY - every entry sharing a git common dir - and selecting it reveals
// that repository's worktrees with the three things you actually want to do to
// one: open a terminal in it, start a chat in it, make it primary.
//
// Two halves. The IDENT cache answers "which repository is this path, and what
// is it on" - git subprocesses, so it is refreshed on the same beats as the map
// status (board request + poll tick) and read synchronously by the broadcast.
// The MESSAGE half is the four am* routes; every one of them re-checks that the
// path it was handed is really one of that repository's worktrees, because the
// path arrives off a webview message and "make primary" writes it to a shared
// file that other processes obey.
//
// Deliberately vscode-free (the host interface is the only seam), so it runs
// against a throwaway `git worktree add` fixture in vitest.

import * as path from 'node:path';
import { runGitStdout } from './gitRun';
import { repoKey } from './registry';
import { listWorktrees, WORKTREES_DIRNAME, type WorktreeListEntry } from './worktrees';
import { foreignRoots, setPrimary, syncRepoFile, updateRepoFile } from './repoFile';
import type { ManagerHost } from './manager';

/**
 * ADOPT-ON-READ, the other half of the merge model: repos.json is written by the
 * engine's board_register too, and an entry this window has never heard of is
 * invisible until its root joins the known list. Run on every board request, so
 * a repo registered from a chat shows up as a card on the next refresh without
 * the user re-adding it by hand. A no-op - and NO Memento write - when there is
 * nothing new, which is the ordinary case.
 */
export function adoptForeign(host: ManagerHost): void {
  const known = host.knownRepos();
  const extra = foreignRoots(known, host.repoRoot());
  if (extra.length > 0) host.saveKnownRepos([...known, ...extra]);
}

/** What a card needs to know about ONE checkout: which repository it belongs to
 *  and what it is currently on. `groupId` is the resolved git COMMON dir, so
 *  every worktree of one repository shares it. */
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

/**
 * Refresh the ident of every root that needs one. Returns true when anything
 * CHANGED, so the caller can broadcast only on a real move (the poll runs this
 * every tick). Roots that vanish from the list are dropped, so an unregistered
 * repo does not keep a stale card identity alive.
 */
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

/** One row under an open repo card. `fold` marks an Origami-managed worktree
 *  (under the primary's .origami/worktrees/) so the user can tell their own
 *  checkouts from the board's. */
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

/**
 * The repository's LOCAL branch names, read at the PRIMARY (every worktree of a
 * repository shares one common dir, so any of them would answer the same).
 * Read-only in the pane: which of them is checked out WHERE is derivable from
 * the worktree rows, so it is not sent a second time.
 *
 * Never throws. A repository git cannot read reports NO branches rather than
 * failing the whole reply, which still carries the checkouts.
 */
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
  // Every remaining route acts ON a path that arrived from the webview. It must
  // be one of THIS repository's worktrees: "make primary" writes it to a file
  // other processes obey, and the other two would otherwise open a shell or an
  // agent session at any path a stray message named.
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
      // Sync FIRST: setPrimary only ever edits an entry that already exists (a
      // registration is a separate act), so a repo registered in this window but
      // never yet written to the shared file would otherwise be a silent no-op.
      // The sync is a merge, so it costs nothing when the entry is already there.
      syncRepoFile(ctx.host.repoRoot(), ctx.host.knownRepos(), undefined, ctx.host.repoDisplayNames());
      // Keyed by the ENTRY root: that is the entry repos.json holds, and the
      // merge writer changes only its `primary`, leaving every other entry and
      // every unknown field alone.
      updateRepoFile((doc) => setPrimary(doc, String(m.root ?? ''), target.path));
      ctx.broadcast();
      return;
  }
}
