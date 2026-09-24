// The two consumers of ONE host message. Both are asserted here rather than in each
// component's own file, because the thing worth protecting is that they agree: a dot
// on the composer's branch pill and a dot on the Agent Manager's repo card, from the
// same `worktreeState`.
//
// jsdom has no layout (vitest.config.mts sets no css:true), so nothing below asserts a
// size, a colour or a position — only what was asked for, what rendered, and what the
// tooltip says.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import RepoBranchPicker from '../components/RepoBranchPicker.svelte';
import RepoCards from '../components/RepoCards.svelte';
import WorktreeDot from '../components/WorktreeDot.svelte';
import { resetSelections } from '../components/repoBranchPicker';
import { WORKTREE_STATE_FIELDS, worktreeCounts, worktreeStateOf, worktreeTip } from '../components/worktreeStateView';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO = 'C:/Repos/alpha';

function posted(): Record<string, unknown>[] {
  return globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]);
}

function deliver(message: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

const DIRTY = { dirty: 3, ahead: 2, behind: 1, detached: false };

beforeEach(() => {
  resetSelections();
  globalThis.__vscodeApiMock.postMessage.mockClear();
});
afterEach(() => cleanup());

describe('worktreeStateView', () => {
  it('mirrors the host type field for field', () => {
    const host = readFileSync(path.join(pkgRoot, 'src/dashboard/worktreeState.ts'), 'utf8');
    const match = /export interface WorktreeState \{([\s\S]*?)\n\}/.exec(host);
    expect(match, 'no WorktreeState interface in src/dashboard/worktreeState.ts').toBeTruthy();
    const hostFields = [...match![1].matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]).sort();
    expect(hostFields).toEqual([...WORKTREE_STATE_FIELDS].sort());
  });

  it('reads a payload, and answers undefined for one that is not there', () => {
    expect(worktreeStateOf(DIRTY)).toEqual(DIRTY);
    expect(worktreeStateOf(undefined)).toBeUndefined();
    expect(worktreeStateOf('nonsense')).toBeUndefined();
  });

  it('never reports a negative or fractional count', () => {
    expect(worktreeStateOf({ dirty: -4, ahead: 2.7, behind: Number.NaN })).toEqual({ dirty: 0, ahead: 2, behind: 0, detached: false });
  });

  it('prints only the non-zero counts, so a clean synced tree adds no text', () => {
    expect(worktreeCounts(DIRTY)).toBe('3~ ↑2 ↓1');
    expect(worktreeCounts({ dirty: 0, ahead: 0, behind: 0, detached: false })).toBe('');
    expect(worktreeCounts({ dirty: 0, ahead: 0, behind: 0, detached: true })).toBe('detached');
  });

  it('spells the tip out in words', () => {
    expect(worktreeTip(DIRTY)).toBe('3 changes · 2 ahead · 1 behind');
    expect(worktreeTip({ dirty: 1, ahead: 0, behind: 0, detached: false })).toBe('1 change');
    expect(worktreeTip({ dirty: 0, ahead: 0, behind: 0, detached: true })).toBe('0 changes · detached HEAD');
  });
});

describe('WorktreeDot', () => {
  it('asks the host for the directory it was given', () => {
    render(WorktreeDot, { props: { dir: REPO } });
    expect(posted()).toContainEqual({ type: 'requestWorktreeState', root: REPO });
  });

  it('renders NOTHING until a state arrives — an old host leaves no dot', async () => {
    const view = render(WorktreeDot, { props: { dir: REPO } });
    expect(view.container.querySelector('[data-testid="worktree-dot"]')).toBeNull();
    deliver({ type: 'worktreeState', root: REPO });
    await vi.waitFor(() => expect(view.container.querySelector('[data-testid="worktree-dot"]')).toBeNull());
  });

  it('ignores a state for a different directory', async () => {
    const view = render(WorktreeDot, { props: { dir: REPO } });
    deliver({ type: 'worktreeState', root: 'C:/Repos/beta', state: DIRTY });
    await vi.waitFor(() => expect(view.container.querySelector('[data-testid="worktree-dot"]')).toBeNull());
  });

  it('matches its directory whatever the separators and case', async () => {
    const view = render(WorktreeDot, { props: { dir: REPO } });
    deliver({ type: 'worktreeState', root: 'c:\\repos\\ALPHA\\', state: DIRTY });
    await vi.waitFor(() => expect(view.container.querySelector('[data-testid="worktree-dot"]')).not.toBeNull());
  });

  it('carries the counts in its tooltip, and prints them only when asked to', async () => {
    const bare = render(WorktreeDot, { props: { dir: REPO } });
    deliver({ type: 'worktreeState', root: REPO, state: DIRTY });
    await vi.waitFor(() => expect(bare.container.querySelector('[data-testid="worktree-state"]')?.getAttribute('data-tip')).toBe('3 changes · 2 ahead · 1 behind'));
    expect(bare.container.textContent).not.toContain('3~');

    const withCounts = render(WorktreeDot, { props: { dir: REPO, counts: true } });
    deliver({ type: 'worktreeState', root: REPO, state: DIRTY });
    await vi.waitFor(() => expect(withCounts.container.textContent).toContain('3~ ↑2 ↓1'));
  });
});

describe('the two consumers read the same message', () => {
  it('the composer branch pill takes a dot for the chat directory', async () => {
    const view = render(RepoBranchPicker, { props: { sessionId: 'session-1' } });
    deliver({ type: 'repoPickerOptions', repos: [{ root: REPO, name: 'alpha' }], defaultRoot: REPO, cwdBySession: { 'session-1': REPO } });
    await vi.waitFor(() => expect(posted()).toContainEqual({ type: 'requestWorktreeState', root: REPO }));
    deliver({ type: 'worktreeState', root: REPO, state: DIRTY });
    await vi.waitFor(() => {
      const pill = view.getByTestId('branch-pill');
      expect(pill.querySelector('[data-testid="worktree-dot"]')).not.toBeNull();
    });
  });

  it('the Agent Manager repo card takes a dot AND the counts for the repo root', async () => {
    const view = render(RepoCards, {
      props: {
        repos: [{ root: REPO, name: 'alpha', working: 0, blocked: 0, queued: 0, done: 0 }],
        displayNames: {}, selected: '', onselect: () => {}, post: () => {},
      } as never,
    });
    deliver({ type: 'worktreeState', root: REPO, state: DIRTY });
    await vi.waitFor(() => {
      const card = view.container.querySelector('.am-repocard');
      expect(card?.querySelector('[data-testid="worktree-dot"]')).not.toBeNull();
      expect(card?.textContent).toContain('3~ ↑2 ↓1');
    });
  });

  it('neither consumer renders a dot when the host never sends the field', async () => {
    const pill = render(RepoBranchPicker, { props: { sessionId: 'session-1' } });
    deliver({ type: 'repoPickerOptions', repos: [{ root: REPO, name: 'alpha' }], defaultRoot: REPO, cwdBySession: { 'session-1': REPO } });
    await vi.waitFor(() => expect(pill.getByTestId('branch-pill')).toBeTruthy());
    expect(pill.container.querySelector('[data-testid="worktree-dot"]')).toBeNull();
  });
});
