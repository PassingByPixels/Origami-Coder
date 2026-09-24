// The multi-repo "hub" layer: the board no longer requires the window's own folder to be a
// git repo — the user registers any repo and drives its worktree agents from one window.
// Pure list logic is unit-tested with no vscode; the folder-picker/Memento glue sits at the
// bottom.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** A repo the board can target. `workspace` = the window's own git folder;
 *  `missing` = a registered repo whose dir/.git has since vanished (kept, flagged). */
export interface RepoEntry {
  root: string;
  name: string;
  workspace: boolean;
  missing: boolean;
}

/** path.resolve + strip trailing separators (without eating a filesystem root). */
export function normalizeRepoPath(p: string): string {
  const resolved = path.resolve(p);
  const stripped = resolved.replace(/[\\/]+$/, '');
  if (stripped === '' || /^[a-zA-Z]:$/.test(stripped)) return resolved;
  return stripped;
}

/** Comparison key: case-insensitive on Windows (its FS is), exact elsewhere. */
export function repoKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

/** A git repo has a .git entry - a DIR (normal clone) or a FILE (worktree /
 *  submodule gitlink). existsSync covers both. */
export function isGitRepo(root: string): boolean {
  return fs.existsSync(path.join(root, '.git'));
}

/** Build the ordered, deduped repo list for the board: the workspace repo first (when it's a
 *  real git repo), then known repos, deduped by comparison key. A known repo whose folder
 *  vanished is kept and flagged missing — the user registered it, they unregister it, it
 *  doesn't silently disappear. */
export function composeRepoList(workspaceRepo: string | undefined, known: string[]): RepoEntry[] {
  const out: RepoEntry[] = [];
  const seen = new Set<string>();
  if (workspaceRepo !== undefined) {
    const root = normalizeRepoPath(workspaceRepo);
    if (isGitRepo(root)) {
      out.push({ root, name: path.basename(root), workspace: true, missing: false });
      seen.add(repoKey(root));
    }
  }
  for (const raw of known) {
    const root = normalizeRepoPath(raw);
    const key = repoKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ root, name: path.basename(root), workspace: false, missing: !isGitRepo(root) });
  }
  return out;
}

/** The composed entry matching `root` by comparison key, or undefined. */
export function findEntry(list: RepoEntry[], root: string | undefined): RepoEntry | undefined {
  if (!root) return undefined;
  const key = repoKey(normalizeRepoPath(root));
  return list.find((e) => repoKey(e.root) === key);
}

// VS Code glue (folder picker + Memento storage) — the only part touching vscode.

const REPOS_KEY = 'origami.agentManager.repos';

/** Folder picker for "Add repo…". Returns the chosen fsPath or undefined. */
export async function pickRepoFolder(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Add repository',
  });
  return picked?.[0]?.fsPath;
}

export function loadKnownRepos(memento: vscode.Memento): string[] {
  const v = memento.get<string[]>(REPOS_KEY);
  return Array.isArray(v) ? v : [];
}

export function saveKnownRepos(memento: vscode.Memento, paths: string[]): void {
  void memento.update(REPOS_KEY, paths);
}

// Board-level "auto-approve agent permissions" toggle, persisted as a sibling of the repo
// list. Default ON: a background agent session has no webview to answer a permission ask,
// so the safe default is to consent.
const AUTO_APPROVE_KEY = 'origami.agentManager.autoApprove';

/** The auto-approve setting; absent (never set) reads as the default ON. */
export function loadAutoApprove(memento: vscode.Memento): boolean {
  const v = memento.get<boolean>(AUTO_APPROVE_KEY);
  return typeof v === 'boolean' ? v : true;
}

export function saveAutoApprove(memento: vscode.Memento, on: boolean): void {
  void memento.update(AUTO_APPROVE_KEY, on);
}

// The persisted agent-type roster: the engine's real agent modes, harvested from a live
// board session, a sibling of the repo list (same Memento pattern). The board's picker
// derives its options from this.
const AGENT_TYPES_KEY = 'origami.agentManager.agentTypes';

/** The harvested agent-type roster; a missing/malformed value reads as empty. */
export function loadAgentTypes(memento: vscode.Memento): Array<{ id: string; name: string; default?: boolean }> {
  const v = memento.get<Array<{ id: string; name: string; default?: boolean }>>(AGENT_TYPES_KEY);
  return Array.isArray(v) ? v.filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string') : [];
}

export function saveAgentTypes(memento: vscode.Memento, types: Array<{ id: string; name: string; default?: boolean }>): void {
  void memento.update(AGENT_TYPES_KEY, types);
}
