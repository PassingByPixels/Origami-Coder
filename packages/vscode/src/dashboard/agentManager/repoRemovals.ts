// Registry removals made OUTSIDE this window: the board MCP server's board_unregister and
// board_repoint, or a hand edit of ~/.origami/repos.json. The window's repo list lives in
// globalState and every sync merges it back into the file, so without this a removed entry
// is written straight back. The rule: a root this window SAW in the file at its last sync,
// and that is now absent from a file that parsed, was removed on purpose. It is dropped from
// the known list before the sync. A file that is missing or does not parse drops nothing.
// A board label another writer set is carried in when a repo is adopted (foreignLabels).

import * as path from 'node:path';
import type * as vscode from 'vscode';
import { normalizeRepoPath, saveKnownRepos } from './registry';
import { readRepoFile, repoFilePath, syncRepoFile, type RepoFile } from './repoFile';
import { repoFileKey } from './repoMerge';

/** globalState key: comparison keys of the roots in repos.json after this window's last sync. */
export const SEEN_KEY = 'origami.agentManager.repoFileSeen';

const keyOf = (root: string): string => repoFileKey(path.resolve(root));

function fileKeys(file: RepoFile): Set<string> {
  return new Set(file.repos.filter((r) => typeof r?.root === 'string' && r.root).map((r) => keyOf(r.root)));
}

/** The known roots another writer removed. Pure. No last-seen set (first run) or no parsed
 *  file: nothing. */
export function removedRoots(known: readonly string[], seen: readonly string[] | undefined, file: RepoFile | undefined): string[] {
  if (!file || !seen) return [];
  const inFile = fileKeys(file);
  const wasSeen = new Set(seen);
  return known.filter((root) => wasSeen.has(keyOf(root)) && !inFile.has(keyOf(root)));
}

/** syncRepoFile with the removal check in front and the last-seen update behind. Every
 *  extension sync of repos.json goes through here. */
export function syncRegistry(
  memento: vscode.Memento,
  workspaceRoot: string | undefined,
  known: string[],
  displayNames?: Readonly<Record<string, string>>,
  home?: string,
): void {
  const before = readRepoFile(repoFilePath(home));
  const seen = memento.get<string[]>(SEEN_KEY);
  const gone = new Set(removedRoots(known, seen, before).map(keyOf));
  const kept = gone.size > 0 ? known.filter((root) => !gone.has(keyOf(root))) : known;
  if (gone.size > 0) saveKnownRepos(memento, kept);
  syncRepoFile(workspaceRoot, kept, home, displayNames);
  // A sync that started from an unreadable file keeps an existing set (the next sync reads
  // a good file and records it then); a first run starts one from what it just wrote.
  const after = before || !seen ? readRepoFile(repoFilePath(home)) : undefined;
  if (after) void memento.update(SEEN_KEY, [...fileKeys(after)]);
}

/** True when repos.json parses and lacks a root this window knows: the board request then
 *  runs a sync, so a removal made outside shows without a reload. */
export function fileLacksKnown(known: readonly string[], home?: string): boolean {
  const file = readRepoFile(repoFilePath(home));
  if (!file) return false;
  const inFile = fileKeys(file);
  return known.some((root) => !inFile.has(keyOf(root)));
}

/** Board labels repos.json gives the roots being adopted, keyed as the board keys them. */
export function foreignLabels(roots: readonly string[], home?: string): Record<string, string> {
  const wanted = new Set(roots.map((r) => repoFileKey(r)));
  const out: Record<string, string> = {};
  for (const r of readRepoFile(repoFilePath(home))?.repos ?? []) {
    const label = r.displayName;
    if (wanted.has(repoFileKey(r.root)) && typeof label === 'string' && label) out[normalizeRepoPath(r.root)] = label;
  }
  return out;
}
