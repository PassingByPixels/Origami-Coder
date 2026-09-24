// The repo/branch picker's RULES — no DOM, no vscode api, so every one of them is
// testable without a render (jsdom has no layout, so anything asserted through a
// component would be asserting markup, not behaviour).
//
// Two facts shape this file:
//   1. A branch here IS a worktree directory. The host never checks a branch out in
//      the primary, so the picker's unit of choice is a path, and the branch name is
//      only its label.
//   2. A session's cwd is fixed when the session is created. So a selection is never
//      an edit of the current chat — it is at most a NEW chat. `CHANGE_REPO_FOOTER`
//      is the dropdown's own statement of that, and the host enforces it.

export interface RepoOption {
  root: string;
  name: string;
}

/** One row of the branch dropdown: a live worktree of the selected repo. */
export interface BranchRow {
  branch: string;
  path: string;
}

export interface PickerSelection {
  root: string;
  path: string;
  branch: string;
}

export const NEW_BRANCH_LABEL = 'New branch…';
export const CHANGE_REPO_FOOTER = 'Changing the repo starts a new chat';
export const SEARCH_PLACEHOLDER = 'Search branches';

/** Compare two filesystem paths the way Windows does: separators normalised, case
 *  folded, a trailing separator ignored. Both sides of this comparison come from
 *  different sources (repos.json, `git worktree list`, the session record), and any
 *  two of them can disagree on all three of those things for the same folder. */
export function sameDir(a: string | undefined, b: string | undefined): boolean {
  return dirKey(a) === dirKey(b) && dirKey(a) !== '';
}

function dirKey(p: string | undefined): string {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Which registered repo a cwd belongs to. Longest root wins: a worktree under
 *  `<repo>/.origami/worktrees/x` is inside the repo root, and so is a second
 *  registered repo nested beneath it — the deeper registration is the right answer. */
export function repoForCwd(repos: readonly RepoOption[], cwd: string | undefined): RepoOption | undefined {
  const target = dirKey(cwd);
  if (!target) return undefined;
  let best: RepoOption | undefined;
  for (const repo of repos) {
    const root = dirKey(repo.root);
    if (!root) continue;
    if (target !== root && !target.startsWith(`${root}/`)) continue;
    if (!best || dirKey(best.root).length < root.length) best = repo;
  }
  return best;
}

/** The label for the branch pill: the branch of the worktree the session sits in, or
 *  '' when the cwd is not one of them (an unregistered folder — the pill says so
 *  rather than naming a branch the session is not actually on). */
export function branchForCwd(rows: readonly BranchRow[], cwd: string | undefined): string {
  return rows.find((row) => sameDir(row.path, cwd))?.branch ?? '';
}

/** Case-insensitive substring filter, order preserved. An empty query is every row —
 *  the field narrows a list, it never becomes the list. */
export function filterBranches(rows: readonly BranchRow[], query: string): BranchRow[] {
  const needle = (query || '').trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => row.branch.toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// Per-session memory (mirrors ChatPane's `modelBySession`)
// ---------------------------------------------------------------------------
//
// Module level, not component state: the picker is mounted per chat CELL, and a
// layout flip (single <-> grid) destroys and remounts those cells. Component state
// would lose the pick on a flip the user reads as unrelated.

const selections: Record<string, PickerSelection> = {};

export function rememberSelection(sessionId: string, selection: PickerSelection): void {
  if (sessionId) selections[sessionId] = selection;
}

export function selectionFor(sessionId: string): PickerSelection | undefined {
  return selections[sessionId];
}

/** Test seam only — the record is module state, so one suite's picks would otherwise
 *  leak into the next. */
export function resetSelections(): void {
  for (const id of Object.keys(selections)) delete selections[id];
}
