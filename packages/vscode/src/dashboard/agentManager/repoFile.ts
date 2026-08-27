// Agent Manager - repoFile.ts (Folds board): the EXTENSION's half of the repo
// registry at ~/.origami/repos.json. It is NO LONGER the only writer - the
// engine's board_register writes entries this window has never seen - so every
// rewrite goes through the merge rule in repoMerge.ts (change only what you
// touched, keep everything else verbatim). This file is the fs half: where the
// file lives, reading it, the atomic write, the sync, and the two lookups the
// board asks it for (which checkout is primary, which entries to adopt).
//
// The write is atomic (tmp + rename), mirroring state.ts saveState, and BEST
// EFFORT throughout: this file is a convenience for other processes, so a
// read-only home dir must never break the board's boot.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { composeRepoList } from './registry';
import { adoptRoots, mergeRepoFile, primaryRoot, repoFileKey, type RepoFile, type RepoFileEntry } from './repoMerge';

// The merge model + the shared shapes live in repoMerge.ts (extracted at this
// file's line cap). Re-exported so long-standing importers stay unchanged.
export { adoptRoots, dropEntry, mergeRepoFile, primaryRoot, setPrimary, type RepoFile, type RepoFileEntry } from './repoMerge';

/** Where `.origami/repos.json` is rooted. `ORIGAMI_REPOS_HOME` overrides the
 *  real home the same way `XDG_CONFIG_HOME` overrides `~/.config` for
 *  globalConfig.ts - the test suite points it at a temp dir so no suite can
 *  read or write the developer's own registry. Unset in production. */
function repoHome(): string {
  return process.env.ORIGAMI_REPOS_HOME || os.homedir();
}

export function repoFilePath(home: string = repoHome()): string {
  return path.join(home, '.origami', 'repos.json');
}

export function readRepoFile(file: string): RepoFile | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RepoFile;
    return parsed?.version === 1 && Array.isArray(parsed.repos) ? parsed : undefined;
  } catch { return undefined; } // missing or corrupt: treated as no prior file
}

/** Atomic write: tmp + rename, so a reader mid-write never sees half a file. */
export function writeRepoFile(file: string, doc: RepoFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Refresh ~/.origami/repos.json from the board's own repo list (the workspace
 * repo, when it is one, plus every registered repo), MERGED onto whatever is
 * there. Called at AgentManager construction and on every saveKnownRepos, so the
 * file tracks the hub without anything else having to remember it exists. Never
 * throws - a failure here costs the engine its repo list, not the user their board.
 */
export function syncRepoFile(
  workspaceRoot: string | undefined,
  known: string[],
  home?: string,
  displayNames?: Readonly<Record<string, string>>,
): void {
  try {
    const file = repoFilePath(home);
    writeRepoFile(file, mergeRepoFile(composeRepoList(workspaceRoot, known), readRepoFile(file), undefined, displayNames));
  } catch { /* best effort - the board boots either way */ }
}

/** Re-read the file and hand ONE entry's doc to `edit`, then write the result -
 *  the read-modify-write every writer of this shared file owes the others. Best
 *  effort, like everything here: an unwritable home costs the setting, not the board. */
export function updateRepoFile(edit: (doc: RepoFile) => RepoFile, home?: string): void {
  try {
    const file = repoFilePath(home);
    writeRepoFile(file, edit(readRepoFile(file) ?? { version: 1, repos: [] }));
  } catch { /* best effort */ }
}

/**
 * The checkout a repo's WORK happens in: tickets, fold branching and
 * apply-to-main all target this, not necessarily the registered root. Absent
 * `primary` - the default nobody has touched - returns `root` unchanged, so the
 * whole feature is a no-op until someone sets one. A primary whose folder has
 * since vanished degrades back to the root rather than pointing the board at
 * nothing.
 */
export function primaryFor(root: string, home?: string): string {
  const key = repoFileKey(root);
  const entry = readRepoFile(repoFilePath(home))?.repos.find((r) => repoFileKey(r.root) === key);
  const target = entry ? primaryRoot(entry) : root;
  if (target === root) return root;
  return fs.existsSync(target) ? target : root;
}

/** The registered roots repos.json knows and the extension does not (adopt-on-read). */
export function foreignRoots(known: string[], workspaceRoot: string | undefined, home?: string): string[] {
  return adoptRoots(readRepoFile(repoFilePath(home)), known, workspaceRoot);
}
