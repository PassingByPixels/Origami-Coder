// Edit path: point a registered repo at the folder it moved to. The picked folder must be a
// git repo root with a tickets folder. repos.json keeps the entry (name, addedAt, displayName
// and unknown keys) with the new root; the known list and the board label follow it. No file
// in either folder is moved or changed. A primary that did not move with the repo is dropped.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { findEntry, isGitRepo, normalizeRepoPath, repoKey } from './registry';
import { primaryFor, updateRepoFile } from './repoFile';
import { repointEntry } from './repoMerge';
import { repoHasLiveWork, type RepoRegistryContext } from './repoOps';

export async function onRepointRepo(ctx: RepoRegistryContext, root: string | undefined): Promise<void> {
  const fail = (message: string): void => ctx.host.post({ type: 'amError', message });
  const entry = findEntry(ctx.composed(), root);
  if (!entry) { fail(`Repository not available: ${root ?? '(none)'}`); return; }
  if (entry.workspace) { fail('This window\'s own folder cannot be moved from the board. Open the new folder in VS Code.'); return; }
  if (repoHasLiveWork(ctx, entry.root) || ctx.mapRunning(entry.root)) {
    fail('This repo has active agents or a map run. Stop them before you edit its path.');
    return;
  }
  const picked = await ctx.host.pickRepoFolder();
  if (picked === undefined) return; // cancelled
  const next = normalizeRepoPath(picked);
  if (repoKey(next) === repoKey(entry.root)) return;
  if (!isGitRepo(next)) { fail(`Not a git repository root: ${next}`); return; }
  if (ctx.composed().some((e) => repoKey(e.root) === repoKey(next))) { fail(`Already on the board: ${next}`); return; }
  // primaryFor degrades to the root when the primary folder is gone: then it moved away.
  const primary = primaryFor(entry.root);
  const keepPrimary = repoKey(primary) !== repoKey(entry.root);
  if (!fs.existsSync(path.join(keepPrimary ? primary : next, '.origami', 'tickets'))) {
    fail(`No tickets folder in ${next}. Pick the folder the repo moved to. A repo with no tickets can be removed and added again.`);
    return;
  }

  updateRepoFile((doc) => repointEntry(doc, entry.root, next, !keepPrimary));
  const oldKey = repoKey(entry.root);
  ctx.host.saveKnownRepos(ctx.host.knownRepos().map((k) => (repoKey(normalizeRepoPath(k)) === oldKey ? next : k)));
  const names = { ...ctx.host.repoDisplayNames() };
  if (names[entry.root]) {
    names[next] = names[entry.root];
    delete names[entry.root];
    ctx.host.saveRepoDisplayNames(names);
  }
  ctx.reconciled.delete(oldKey);
  ctx.missingSeen.delete(oldKey);
  await ctx.ensureReconciled(primaryFor(next));
  ctx.broadcast();
  ctx.schedulePoll(0);
}
