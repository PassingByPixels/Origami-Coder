// The MERGE MODEL for ~/.origami/repos.json, extracted from repoFile.ts. The old rule —
// "the extension is the only writer" — died when the engine's board_register landed:
// repos.json is now shared, so a rewrite that rebuilt repos[] from the extension's own list
// silently dropped anything it didn't author. Every writer now: reads the current file, keys
// entries by root, changes only the entries its operation touches, preserves every other
// entry and unknown field verbatim, and writes atomically.

import * as path from 'node:path';

export interface RepoFileEntry {
  root: string;
  name: string;
  workspace: boolean;
  /** First time this root appeared in the file. Carried across rewrites so a
   *  reader can order by registration age; 0 only for a hand-written file. */
  addedAt: number;
  /** Board display-name override (cosmetic; `name` above is the real one). */
  displayName?: string;
  /** Absolute path of the checkout that owns this repository's tickets/folds/apply. Absent =
   *  `root`; written by the board's Make Primary and by the engine, never cleared by an
   *  ordinary sync. */
  primary?: string;
  /** Unknown keys from another writer ride through every rewrite untouched. */
  [k: string]: unknown;
}

export interface RepoFile {
  version: 1;
  repos: RepoFileEntry[];
}

/** Comparison key: case-insensitive on Windows (its FS is), exact elsewhere -
 *  the same rule registry.ts uses, duplicated so this stays a leaf. */
export function repoFileKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

/** The checkout an entry's work happens in: its `primary` when set, else the entry root. */
export function primaryRoot(entry: Pick<RepoFileEntry, 'root' | 'primary'>): string {
  return entry.primary || entry.root;
}

/** Project the board's composed repo list onto the file, MERGING rather than replacing.
 *  Composed entries refresh in place; every other prior entry survives after them.
 *  `displayNames`, when passed, is an overlay the extension owns (an omitted root clears its
 *  override); when omitted entirely, the prior value rides through unchanged. `primary` has
 *  no such argument — never the extension's to clear from a plain sync. */
export function mergeRepoFile(
  entries: Array<{ root: string; name: string; workspace: boolean }>,
  prior: RepoFile | undefined,
  now = Date.now(),
  displayNames?: Readonly<Record<string, string>>,
): RepoFile {
  const before = new Map((prior?.repos ?? []).map((r) => [repoFileKey(r.root), r]));
  const touched = new Set<string>();
  const repos: RepoFileEntry[] = entries.map((e) => {
    const key = repoFileKey(e.root);
    touched.add(key);
    const old = before.get(key);
    const merged: RepoFileEntry = {
      ...(old ?? {}),                     // unknown keys + primary ride through
      // A name another writer set (board_register / board_repoint) is the key the board_*
      // tools use: the folder name only fills an entry that has none.
      root: e.root, name: typeof old?.name === 'string' && old.name ? old.name : e.name, workspace: e.workspace,
      addedAt: old?.addedAt ?? now,       // never re-date a long-registered repo
    };
    if (displayNames) {
      const label = displayNames[e.root];
      if (label) merged.displayName = label; else delete merged.displayName;
    }
    return merged;
  });
  for (const r of prior?.repos ?? []) {
    if (!touched.has(repoFileKey(r.root))) repos.push(r); // a foreign entry: verbatim
  }
  return { version: 1, repos };
}

/** Point one entry's `primary` at `primary`. Every other entry/field carries through
 *  unchanged; a primary equal to root drops the key; an unknown root is a no-op, never a new
 *  entry. */
export function setPrimary(file: RepoFile, root: string, primary: string): RepoFile {
  const key = repoFileKey(root);
  return {
    version: 1,
    repos: file.repos.map((r) => {
      if (repoFileKey(r.root) !== key) return r;
      const next = { ...r };
      if (repoFileKey(primary) === repoFileKey(r.root)) delete next.primary;
      else next.primary = primary;
      return next;
    }),
  };
}

/** Drop one entry (unregistering a repo): needed because the merge rule preserves anything
 *  the extension doesn't compose, so without an explicit delete an unregistered repo would
 *  survive and adopt-on-read would put it right back. */
export function dropEntry(file: RepoFile, root: string): RepoFile {
  const key = repoFileKey(root);
  return { version: 1, repos: file.repos.filter((r) => repoFileKey(r.root) !== key) };
}

/** Edit path: point one entry at the folder the repo moved to. `root` changes in place (key
 *  order kept); `dropPrimary` removes a primary that did not move with it. Every other entry and
 *  field carries through; an unknown root is a no-op. */
export function repointEntry(file: RepoFile, root: string, next: string, dropPrimary: boolean): RepoFile {
  const key = repoFileKey(root);
  return {
    version: 1,
    repos: file.repos.map((r) => {
      if (repoFileKey(r.root) !== key) return r;
      const moved = { ...r, root: next };
      if (dropPrimary) delete moved.primary;
      return moved;
    }),
  };
}

/** ADOPT-ON-READ: roots present in repos.json the extension's own known list has never
 *  heard of (e.g. registered via board_register); the board boot merges these in so a card
 *  draws next refresh. */
export function adoptRoots(
  file: RepoFile | undefined,
  known: string[],
  workspaceRoot: string | undefined,
): string[] {
  const seen = new Set(known.map((k) => repoFileKey(path.resolve(k))));
  if (workspaceRoot !== undefined) seen.add(repoFileKey(path.resolve(workspaceRoot)));
  const out: string[] = [];
  for (const r of file?.repos ?? []) {
    if (typeof r?.root !== 'string' || !r.root) continue;
    const key = repoFileKey(path.resolve(r.root));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.root);
  }
  return out;
}
