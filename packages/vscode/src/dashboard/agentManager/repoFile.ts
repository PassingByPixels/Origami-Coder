// The extension's half of the repo registry at ~/.origami/repos.json. No longer the only
// writer — the engine's board_register writes entries this window has never seen — so every
// rewrite goes through repoMerge.ts's merge rule (change only what you touched, keep
// everything else verbatim). Atomic write, best-effort throughout, since this file is a
// convenience other processes read.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { composeRepoList } from './registry';
import { adoptRoots, mergeRepoFile, primaryRoot, repoFileKey, type RepoFile, type RepoFileEntry } from './repoMerge';

// The merge model + the shared shapes live in repoMerge.ts (extracted at this
// file's line cap). Re-exported so long-standing importers stay unchanged.
export { adoptRoots, dropEntry, mergeRepoFile, primaryRoot, setPrimary, type RepoFile, type RepoFileEntry } from './repoMerge';

/** Where repos.json is rooted; `ORIGAMI_REPOS_HOME` overrides the real home the same way
 *  `XDG_CONFIG_HOME` does, so the test suite never touches the developer's own registry. */
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

/** Refresh repos.json from the board's own repo list, merged onto whatever is there. Called
 *  at construction and every saveKnownRepos, so the file tracks the hub automatically. Never
 *  throws — a failure costs the engine its repo list, not the user their board. */
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

/** Re-read the file, hand one entry's doc to `edit`, write the result — the read-modify-write
 *  every writer of this shared file owes the others. A file that does not parse is left alone:
 *  every edit here changes an existing entry, and an empty list would read as "all removed"
 *  (repoRemovals.ts). */
export function updateRepoFile(edit: (doc: RepoFile) => RepoFile, home?: string): void {
  try {
    const file = repoFilePath(home);
    const doc = readRepoFile(file);
    if (doc) writeRepoFile(file, edit(doc));
  } catch { /* best effort */ }
}

/** The checkout a repo's work happens in — tickets, folds, apply-to-main all target this.
 *  Absent `primary` returns `root` unchanged, so the feature is a no-op until set; a primary
 *  whose folder vanished degrades back to root. */
export function primaryFor(root: string, home?: string): string {
  const key = repoFileKey(root);
  const entry = readRepoFile(repoFilePath(home))?.repos.find((r) => repoFileKey(r.root) === key);
  const target = entry ? primaryRoot(entry) : root;
  if (target === root) return root;
  return fs.existsSync(target) ? target : root;
}

/** The name repos.json gives a root (the key the board_* tools resolve), when it has one. */
export function registeredName(root: string, home?: string): string | undefined {
  const key = repoFileKey(root);
  const name = readRepoFile(repoFilePath(home))?.repos.find((r) => repoFileKey(r.root) === key)?.name;
  return typeof name === 'string' && name ? name : undefined;
}

/** The registered roots repos.json knows and the extension does not (adopt-on-read). */
export function foreignRoots(known: string[], workspaceRoot: string | undefined, home?: string): string[] {
  return adoptRoots(readRepoFile(repoFilePath(home)), known, workspaceRoot);
}
