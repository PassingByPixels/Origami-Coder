// The repo/branch picker's rules — repoBranchPicker.ts. Pure, so these are the
// assertions a render could never make honestly: every one of these answers is a
// STRING COMPARISON between paths that arrive from three different sources
// (repos.json, `git worktree list`, the session record) spelling one folder three
// different ways.
//
// The file is named ...Rules.test.ts, not repoBranchPicker.test.ts, because Windows
// folds case: that name IS RepoBranchPicker.test.ts, the component suite beside it,
// and writing one silently destroys the other.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  branchForCwd, filterBranches, rememberSelection, repoForCwd, resetSelections,
  sameDir, selectionFor,
} from './repoBranchPicker';

const REPOS = [
  { root: 'C:\\Repos\\Origami Coder\\origami-coder', name: 'Origami Coder' },
  { root: 'C:/Repos/Projects/demo-app', name: 'Demo app' },
];

describe('sameDir', () => {
  it('folds separators, case and a trailing slash — the three ways one folder is spelled here', () => {
    expect(sameDir('C:\\Repos\\a\\', 'c:/repos/A')).toBe(true);
  });

  it('is false for an empty path, so two unknown directories are never "the same"', () => {
    expect(sameDir('', '')).toBe(false);
    expect(sameDir(undefined, 'C:/Repos/a')).toBe(false);
  });

  it('does not treat a sibling with a shared prefix as the same folder', () => {
    expect(sameDir('C:/Repos/a', 'C:/Repos/ab')).toBe(false);
  });
});

describe('repoForCwd', () => {
  it('finds the repo a worktree lives under', () => {
    expect(repoForCwd(REPOS, 'C:/Repos/Origami Coder/origami-coder/.origami/worktrees/x')?.name).toBe('Origami Coder');
  });

  it('prefers the DEEPER registration when one repo is nested in another', () => {
    const nested = [{ root: 'C:/Repos', name: 'all' }, ...REPOS];
    expect(repoForCwd(nested, 'C:/Repos/Projects/demo-app')?.name).toBe('Demo app');
  });

  it('is undefined for a folder no registered repo contains', () => {
    expect(repoForCwd(REPOS, 'D:/scratch')).toBeUndefined();
    expect(repoForCwd(REPOS, undefined)).toBeUndefined();
  });
});

describe('branchForCwd', () => {
  const rows = [
    { branch: 'master', path: 'C:/Repos/a' },
    { branch: 'origami/x', path: 'C:\\Repos\\a\\.origami\\worktrees\\x' },
  ];

  it('names the branch of the worktree the chat actually sits in', () => {
    expect(branchForCwd(rows, 'C:/Repos/a/.origami/worktrees/x')).toBe('origami/x');
  });

  it('is empty for a cwd that is not one of them, rather than naming the first row', () => {
    expect(branchForCwd(rows, 'C:/Repos/b')).toBe('');
  });
});

describe('filterBranches', () => {
  const rows = [
    { branch: 'feat/care-calendar', path: 'p1' },
    { branch: 'main', path: 'p2' },
  ];

  it('matches anywhere in the name, ignoring case', () => {
    expect(filterBranches(rows, 'CARE').map((r) => r.branch)).toEqual(['feat/care-calendar']);
  });

  it('an empty or blank query is every row, in the list s own order', () => {
    expect(filterBranches(rows, '   ').map((r) => r.branch)).toEqual(['feat/care-calendar', 'main']);
  });

  it('returns a copy, so a caller sorting the result cannot reorder the source list', () => {
    const out = filterBranches(rows, '');
    out.reverse();
    expect(rows[0].branch).toBe('feat/care-calendar');
  });
});

describe('per-session memory', () => {
  beforeEach(resetSelections);

  it('keeps one pick per session, so two chats never share a branch pill', () => {
    rememberSelection('session-1', { root: 'r1', path: 'p1', branch: 'b1' });
    rememberSelection('session-2', { root: 'r2', path: 'p2', branch: 'b2' });
    expect(selectionFor('session-1')?.branch).toBe('b1');
    expect(selectionFor('session-2')?.branch).toBe('b2');
  });

  it('ignores an empty session id rather than making a pick every chat would read', () => {
    rememberSelection('', { root: 'r', path: 'p', branch: 'b' });
    expect(selectionFor('')).toBeUndefined();
  });
});
