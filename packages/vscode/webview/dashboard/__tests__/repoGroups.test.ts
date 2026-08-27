// Folds board — repo CARDS, the pure grouping half, plus the mirror guard the
// house rule demands: a webview .ts cannot import from src/ (tsconfig rootDir),
// so WorktreeRowInfo is declared twice and this file fails when the two sides
// disagree.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { groupRepos } from '../components/repoGroups';
import type { RepoBoard } from '../components/boardBuckets';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const board = (over: Partial<RepoBoard>): RepoBoard => ({
  root: '/x/a', name: 'a', workspace: false, missing: false, defaultModel: '',
  rows: [], map: { status: 'none' }, tickets: [],
  primary: '/x/a', groupId: 'g-a', branch: 'main',
  ...over,
});

describe('groupRepos — one card per REPOSITORY, not per registered path', () => {
  it('two checkouts of one repo become ONE card, led by the primary entry', () => {
    const main = board({ root: '/r/main', name: 'main', primary: '/r/main', groupId: 'g1', branch: 'trunk' });
    const wt = board({ root: '/r/wt', name: 'wt', primary: '/r/main', groupId: 'g1', branch: 'feature' });
    // The non-primary entry is listed FIRST, so "the lead is the primary" is a
    // real choice here and not an artefact of ordering.
    const cards = groupRepos([wt, main]);
    expect(cards).toHaveLength(1);
    expect(cards[0].key).toBe('g1');
    expect(cards[0].lead.root).toBe('/r/main');
    expect(cards[0].lead.branch).toBe('trunk');
    expect(cards[0].entries.map((e) => e.root)).toEqual(['/r/wt', '/r/main']);
  });

  it('a repository whose primary is NOT registered still draws one card, led by the first entry', () => {
    const wt = board({ root: '/r/wt', name: 'wt', primary: '/r/unregistered', groupId: 'g1' });
    const wt2 = board({ root: '/r/wt2', name: 'wt2', primary: '/r/unregistered', groupId: 'g1' });
    const cards = groupRepos([wt, wt2]);
    expect(cards).toHaveLength(1);
    expect(cards[0].lead.root).toBe('/r/wt');
  });

  it('separate repositories keep separate cards, in first-appearance order', () => {
    const cards = groupRepos([
      board({ root: '/r/one', groupId: 'g1' }),
      board({ root: '/r/two', groupId: 'g2' }),
      board({ root: '/r/one-wt', groupId: 'g1' }),
    ]);
    expect(cards.map((c) => c.key)).toEqual(['g1', 'g2']);
    expect(cards[0].entries).toHaveLength(2);
  });

  it('no groupId (git not asked yet, or the folder is gone) stands alone under its own root', () => {
    // An older host sends no groupId at all; a missing repo never gets one. Both
    // must still draw — collapsing them into one "" card would merge unrelated
    // repositories into a single row, which is worse than an ungrouped card.
    const cards = groupRepos([
      board({ root: '/r/old', groupId: undefined }),
      board({ root: '/r/gone', groupId: '', missing: true }),
    ]);
    expect(cards.map((c) => c.key)).toEqual(['/r/old', '/r/gone']);
    expect(cards.every((c) => c.entries.length === 1)).toBe(true);
  });

  it('an empty board yields no cards', () => {
    expect(groupRepos([])).toEqual([]);
  });
});

describe('mirror guard — the webview shapes still match the host', () => {
  const read = (rel: string) => readFileSync(path.join(pkgRoot, rel), 'utf8');

  it('WorktreeRowInfo names exactly the fields repoCards.ts WorktreeCardRow sends', () => {
    const host = read('src/dashboard/agentManager/repoCards.ts');
    const hostShape = /export interface WorktreeCardRow \{([\s\S]*?)\n\}/.exec(host)?.[1] ?? '';
    const mine = read('webview/dashboard/components/repoGroups.ts');
    const myShape = /export interface WorktreeRowInfo \{([\s\S]*?)\n\}/.exec(mine)?.[1] ?? '';
    const fields = (block: string) => [...block.matchAll(/^\s{2}([a-zA-Z]+)\??:/gm)].map((m) => m[1]).sort();
    expect(hostShape, 'WorktreeCardRow not found in repoCards.ts').not.toBe('');
    expect(myShape, 'WorktreeRowInfo not found in repoGroups.ts').not.toBe('');
    expect(fields(myShape)).toEqual(fields(hostShape));
  });

  it('RepoDetailInfo names the fields the amWorktrees reply actually sends', () => {
    // The reply is composed inline, so the guard reads the literal itself. The
    // drift it catches is silent: `branches` renamed on one side leaves the
    // detail pane's Branches section permanently empty, with nothing failing.
    const host = read('src/dashboard/agentManager/repoCards.ts');
    const reply = /type: 'amWorktrees'([\s\S]*?)\}\);/.exec(host)?.[1] ?? '';
    expect(reply, 'the amWorktrees reply is no longer composed in repoCards.ts').not.toBe('');
    const mine = read('webview/dashboard/components/repoGroups.ts');
    const myShape = /export interface RepoDetailInfo \{([\s\S]*?)\n\}/.exec(mine)?.[1] ?? '';
    expect(myShape, 'RepoDetailInfo not found in repoGroups.ts').not.toBe('');
    for (const field of ['worktrees', 'branches']) {
      expect(reply, `the reply no longer sends ${field}`).toContain(`${field}:`);
      expect(myShape, `the webview mirror dropped ${field}`).toContain(`${field}:`);
    }
  });

  it('the RepoBoard mirror carries the three card fields board.ts broadcasts', () => {
    const host = read('src/dashboard/agentManager/board.ts');
    const mine = read('webview/dashboard/components/boardBuckets.ts');
    const shape = /export interface RepoBoard \{([\s\S]*?)\n\}/.exec(mine)?.[1] ?? '';
    for (const field of ['primary', 'groupId', 'branch']) {
      expect(host, `board.ts no longer sends ${field}`).toContain(`${field}:`);
      expect(shape, `the webview mirror dropped ${field}`).toContain(`${field}?:`);
    }
  });
});
