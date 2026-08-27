// Agent Manager - registry.ts (S3.5): the multi-repo "hub" layer. The board no
// longer requires the window's own workspace folder to be a git repo - the user
// registers any repo on disk (folder picker) and drives its worktree agents from
// one window. The pure list logic (composeRepoList + path helpers) is unit-tested
// with no vscode; the thin VS Code glue (picker + Memento storage) sits at the
// bottom. `vscode` is import-analysed but only touched by the glue, so vitest
// (which aliases vscode to a stub) loads this module for the pure tests fine.

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

/**
 * Build the ordered, deduped repo list for the board. The workspace repo (when
 * defined AND a real git repo) is always first with workspace:true; the known
 * (user-registered) repos follow in order, deduped against the workspace entry
 * and each other by comparison key. A known repo whose dir/.git no longer exists
 * is KEPT and flagged missing:true - the user registered it, they get to see and
 * unregister it rather than have it silently vanish.
 */
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

// ---------------------------------------------------------------------------
// VS Code glue (folder picker + Memento storage) - the only part touching vscode
// ---------------------------------------------------------------------------

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

// S5.2 - board-level "auto-approve agent permissions" toggle. Persisted here as a
// sibling of the repo list (same Memento helper pattern). Default ON: a
// background agent session has no webview to answer a permission ask, so without
// auto-approve it hangs forever - the safe-by-default is to consent.
const AUTO_APPROVE_KEY = 'origami.agentManager.autoApprove';

/** The auto-approve setting; absent (never set) reads as the default ON. */
export function loadAutoApprove(memento: vscode.Memento): boolean {
  const v = memento.get<boolean>(AUTO_APPROVE_KEY);
  return typeof v === 'boolean' ? v : true;
}

export function saveAutoApprove(memento: vscode.Memento, on: boolean): void {
  void memento.update(AUTO_APPROVE_KEY, on);
}

// S6a - the persisted agent-type roster: the engine's real agent modes (build /
// plan / any custom primaries), harvested from a live board session. A sibling
// of the repo list + auto-approve toggle (same Memento helper pattern). Each
// entry is a mode {id,name,default?}; the board's picker derives its options
// from this (see AgentTypeSelect - it hides the entry flagged as the engine
// default behind "Tsuru", whatever `default_agent` resolves to).
const AGENT_TYPES_KEY = 'origami.agentManager.agentTypes';

/** The harvested agent-type roster; a missing / malformed value reads as empty
 *  (each surviving entry must be a {id,name} of strings; the optional default
 *  flag rides through untouched). */
export function loadAgentTypes(memento: vscode.Memento): Array<{ id: string; name: string; default?: boolean }> {
  const v = memento.get<Array<{ id: string; name: string; default?: boolean }>>(AGENT_TYPES_KEY);
  return Array.isArray(v) ? v.filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string') : [];
}

export function saveAgentTypes(memento: vscode.Memento, types: Array<{ id: string; name: string; default?: boolean }>): void {
  void memento.update(AGENT_TYPES_KEY, types);
}
