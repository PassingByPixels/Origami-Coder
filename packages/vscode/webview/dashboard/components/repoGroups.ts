// Folds board — repo CARDS: the pure half of "one card per REPOSITORY".
//
// A registered entry is a PATH. Check one repo out twice (a linked worktree per
// branch, which is how Origami Coder itself is developed) and the old bar drew
// two pills for one repository. The host asks git for each checkout's common
// dir and puts the answer on every RepoBoard as `groupId`, so the grouping
// itself is decidable from data alone — which is why it lives here, unit-tested
// directly, instead of inside the card component.
//
// The wire shapes below are MIRRORS: a webview .ts may not import from src/
// (tsconfig rootDir), so the host's RepoIdent/WorktreeCardRow fields are
// re-declared here and a drift test compares the two sides.

import type { RepoBoard } from './boardBuckets';

/** One row under an open card: a checkout of this repository (ext contract:
 *  src/dashboard/agentManager/repoCards.ts WorktreeCardRow). */
export interface WorktreeRowInfo {
  name: string;
  branch: string;
  path: string;
  /** This is the checkout that owns the repository's tickets, folds and apply. */
  primary: boolean;
  /** An Origami-managed fold worktree (under the primary's .origami/worktrees/). */
  fold: boolean;
}

/** Everything the host answers about ONE repository — the `amWorktrees` reply,
 *  mirrored (ext contract: src/dashboard/agentManager/repoCards.ts). Its
 *  checkouts, and the LOCAL branch names read at the primary.
 *
 *  Which branch is checked out WHERE is deliberately absent: every row already
 *  carries the branch its checkout is on, so the detail pane derives it. Two
 *  senders for one fact can only ever disagree. */
export interface RepoDetailInfo {
  worktrees: WorktreeRowInfo[];
  branches: string[];
}

/** One card: the repository, the entry the board drives it through, and every
 *  registered entry that resolved to the same git common dir. */
export interface RepoCard {
  key: string;
  lead: RepoBoard;
  entries: RepoBoard[];
}

/**
 * Group the broadcast's entries into cards. Entries sharing a non-empty
 * `groupId` are ONE repository; an entry with no groupId (git not asked yet, or
 * a missing folder) stands alone under its own root, so a card is never lost to
 * an unresolved identity. Cards keep first-appearance order.
 *
 * The LEAD is the entry the card selects: the one that IS its own repository's
 * primary checkout when that checkout is itself registered, else simply the
 * first. Every entry of a group projects the same primary, so the columns are
 * identical either way — the lead only decides the name and branch on the face.
 */
export function groupRepos(repos: RepoBoard[]): RepoCard[] {
  const byKey = new Map<string, RepoBoard[]>();
  for (const r of repos) {
    const key = r.groupId || r.root;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r); else byKey.set(key, [r]);
  }
  return [...byKey].map(([key, entries]) => ({
    key,
    lead: entries.find((e) => e.primary && e.primary === e.root) ?? entries[0],
    entries,
  }));
}
