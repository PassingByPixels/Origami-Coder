// Agent Manager - repoMerge.ts (Folds board, repo cards): the MERGE MODEL for
// ~/.origami/repos.json, extracted from repoFile.ts (at its line cap) when that
// file stopped being an extension-owned mirror.
//
// The old rule - "the extension is the only writer" - died when the engine's
// board_register landed: repos.json is now a SHARED file with more than one
// writer, so a rewrite that rebuilt repos[] from the extension's own known list
// silently dropped everything it did not author (a foreign entry, a hand-added
// key, a primary pointer). The rule every writer follows instead:
//
//   read the current file -> key entries by `root`, case-insensitively on
//   Windows -> change ONLY the entries your operation touches -> preserve every
//   other entry AND every unknown field on every entry verbatim -> write
//   atomically (tmp + rename, in repoFile.ts).
//
// Pure over plain objects: no fs, no vscode, so the whole rule is unit-tested
// on literals. The fs half (path / read / atomic write / sync) stays next door.

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
  /** Absolute path of the checkout that OWNS this repository's tickets, fold
   *  branching and apply-to-main. Absent = `root` itself. Written by the board's
   *  "Make primary" and by the engine; never cleared by an ordinary sync. */
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

/** The checkout an entry's work happens in: its `primary` when set, else the
 *  entry root. Pure - the caller decides what to do about a primary that has
 *  since vanished from disk (repoFile.primaryFor degrades it back to root). */
export function primaryRoot(entry: Pick<RepoFileEntry, 'root' | 'primary'>): string {
  return entry.primary || entry.root;
}

/**
 * Project the board's composed repo list onto the file, MERGING rather than
 * replacing. Entries the extension composes are refreshed in place (name /
 * workspace, and addedAt only when the entry is genuinely new); every other
 * entry in `prior` survives after them, in its own order.
 *
 * `displayNames` is an OVERLAY the extension owns: when it is PASSED the
 * extension is speaking about display names, so an omitted root clears its
 * override; when the argument is omitted entirely the caller is not speaking
 * about them at all and the prior value rides through. `primary` has no such
 * argument - it is never the extension's to clear from a plain sync.
 */
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
      root: e.root, name: e.name, workspace: e.workspace,
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

/**
 * Point ONE entry's `primary` at `primary` (the board's "Make primary"). Every
 * other entry, and every other field of the touched one, is carried through
 * unchanged; a primary equal to the root drops the key (absent = root); an
 * unknown root is a no-op, never a new entry - registration is a separate act.
 */
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

/**
 * Drop ONE entry (the board unregistering a repo). Needed because the merge rule
 * above preserves anything the extension does not compose: without an explicit
 * delete, an unregistered repo would survive in the file and adopt-on-read would
 * put it straight back on the board next refresh.
 */
export function dropEntry(file: RepoFile, root: string): RepoFile {
  const key = repoFileKey(root);
  return { version: 1, repos: file.repos.filter((r) => repoFileKey(r.root) !== key) };
}

/**
 * ADOPT-ON-READ: the roots present in repos.json that the extension's own known
 * list (and this window's workspace repo) have never heard of. A repo the engine
 * registered with board_register is invisible to the board until its root joins
 * that list, so the board boot merges these in and it draws a card next refresh.
 * Order follows the file, so the oldest foreign registration adopts first.
 */
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
