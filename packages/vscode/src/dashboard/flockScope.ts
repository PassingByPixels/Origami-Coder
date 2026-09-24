// What the Flock pane's scope pickers may offer, and the folder browser behind "Browse…". The scope
// fields used to be free-text globs, which is not a permission control but a spelling test: a typo
// shares nothing and says nothing.
//
// Each offered list has one source: repos from ~/.origami/repos.json (the same registry the Folds
// board uses), wiki from the workspace's top-level wiki/ folders. Skills are NOT a source — a skill
// is a set of instructions, not a secret, so it was never a permission and the desk reads them
// unconditionally. Folders have no registry and stay ABSOLUTE — the point is sharing something
// outside this workspace, which has no relative form here.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { readRepoFile, repoFilePath } from './agentManager/repoFile';

export const FLOCK_SCOPE_MESSAGE_TYPES = new Set(['flockScopeOptions', 'flockBrowseFolder']);

/** One repo the checklist can offer. `root` is what a scope entry stores. */
export interface RepoOption {
  root: string;
  name: string;
}

export interface FlockScopeHost {
  /** The open workspace folder. Only the WIKI list and the picker's start
   *  folder need it; a window with no folder open still has a friends list. */
  cwd?: string;
  post(message: Record<string, unknown>): void;
}

/**
 * The registered repos, in the file's own order, preferring the board's display name over the raw
 *  folder name.
 * A missing or corrupt registry is an empty list, never a throw — a broken file must not take the
 *  whole Permissions section down.
 */
export function repoOptions(home?: string): RepoOption[] {
  const file = readRepoFile(repoFilePath(home));
  if (!file) return [];
  return file.repos.map((entry) => ({
    root: entry.root,
    name: (typeof entry.displayName === 'string' && entry.displayName) || entry.name || path.basename(entry.root),
  }));
}

/**
 * The top-level folders under `<workspace>/wiki`, as workspace-relative posix paths — folders only,
 *  since the engine's cage expands a bare entry to `<entry>/**`. Posix separators on purpose — the
 *  engine matches these as globs.
 */
export function wikiFolders(workspace: string | undefined): string[] {
  if (!workspace) return [];
  try {
    return fs
      .readdirSync(path.join(workspace, 'wiki'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => `wiki/${entry.name}`)
      .sort();
  } catch {
    return []; // no wiki in this workspace — the picker says so rather than guessing
  }
}

/** Workspace-relative posix, or the absolute path when it is somewhere else. A
 *  `..` climb is nobody's glob, so a folder outside the workspace stays whole.
 *  NOT used for the `folders` list — see `handleFlockScopeMessage`. */
export function relativeToWorkspace(folder: string, cwd?: string): string {
  if (!cwd) return folder;
  const relative = path.relative(cwd, folder);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return folder;
  return relative.split(path.sep).join('/');
}

/**
 * Answer both scope messages. Both offered lists are local file reads now, so there is no engine
 *  round trip left to fail.
 */
export async function handleFlockScopeMessage(
  host: FlockScopeHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type === 'flockScopeOptions') {
    host.post({ type: 'flockScopeOptions', repos: repoOptions(), wiki: wikiFolders(host.cwd) });
    return;
  }
  if (m.type !== 'flockBrowseFolder') return;
  const kind = typeof m['kind'] === 'string' ? m['kind'] : 'repos';
  // WHICH PICKER ASKED. Two are on screen at once — the desk defaults in the
  // Permissions chip and one contact's Edit popover — so the pick is echoed back
  // with the handle it was browsed for ('' for the defaults). Without it both
  // would take the folder, and one of the two shares nobody made.
  const target = typeof m['target'] === 'string' ? m['target'] : '';
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: kind === 'wiki' ? 'Share this wiki folder' : 'Share this folder',
    ...(host.cwd ? { defaultUri: vscode.Uri.file(host.cwd) } : {}),
  });
  const folder = picked?.[0]?.fsPath;
  if (!folder) return;
  // A `folders` entry is stored ABSOLUTE. The engine refuses a relative one
  // outright (`flock/scope-folders.ts`), and rightly: the point of the list is a
  // folder that is NOT in this workspace, which has no relative form here.
  const path = kind === 'folders' ? folder : relativeToWorkspace(folder, host.cwd);
  host.post({ type: 'flockScopePicked', kind, path, target });
}
