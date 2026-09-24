// The porcelain fixtures below are REAL output, captured with
// `git status --porcelain=v2 --branch` in this repository's worktrees — not invented,
// because a parser tested against its own author's guess about a format proves only
// self-consistency (WORKING_ON_ORIGAMI_CODER.md, Part 6).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKTREE_POLL_MS,
  handleWorktreeStateMessage,
  parseStatusV2,
  resetWorktreeState,
  type WorktreeStateHost,
} from '../../../src/dashboard/worktreeState';

const CLEAN = ['# branch.oid 042ef7073aa1f0d69b04e9c8453dc796fbaf039c', '# branch.head master', '# branch.upstream gitea/master', '# branch.ab +0 -0'].join('\n');

const NO_UPSTREAM = ['# branch.oid 042ef7073aa1f0d69b04e9c8453dc796fbaf039c', '# branch.head lane/t-ru1i84-live-state'].join('\n');

const DIRTY = [
  '# branch.oid 042ef7073aa1f0d69b04e9c8453dc796fbaf039c',
  '# branch.head master',
  '# branch.upstream gitea/master',
  '# branch.ab +2 -3',
  '1 .M N... 100644 100644 100644 aaaa bbbb packages/vscode/src/a.ts',
  '1 M. N... 100644 100644 100644 cccc dddd packages/vscode/src/b.ts',
  '2 R. N... 100644 100644 100644 eeee ffff R100 new.ts\told.ts',
  'u UU N... 100644 100644 100644 100644 1111 2222 3333 conflict.ts',
  '? untracked.ts',
].join('\n');

describe('parseStatusV2', () => {
  it('reads a clean tracking branch as all zeroes, attached', () => {
    expect(parseStatusV2(CLEAN)).toEqual({ dirty: 0, ahead: 0, behind: 0, detached: false });
  });

  it('counts changed, renamed, unmerged and untracked entries as dirty, with ahead/behind', () => {
    expect(parseStatusV2(DIRTY)).toEqual({ dirty: 5, ahead: 2, behind: 3, detached: false });
  });

  it('reads a branch with no upstream as 0/0 rather than inventing a divergence', () => {
    expect(parseStatusV2(NO_UPSTREAM)).toEqual({ dirty: 0, ahead: 0, behind: 0, detached: false });
  });

  it('flags a detached HEAD', () => {
    expect(parseStatusV2('# branch.oid 042ef70\n# branch.head (detached)')).toMatchObject({ detached: true });
  });

  it('survives empty output', () => {
    expect(parseStatusV2('')).toEqual({ dirty: 0, ahead: 0, behind: 0, detached: false });
  });
});

function hostFor(read: (dir: string) => Promise<string | undefined>, clock: { t: number }) {
  const post = vi.fn();
  const host: WorktreeStateHost = { post, read, now: () => clock.t };
  return { host, post };
}

describe('handleWorktreeStateMessage', () => {
  beforeEach(() => resetWorktreeState());

  it('posts one worktreeState carrying the parsed state', async () => {
    const clock = { t: 1_000 };
    const { host, post } = hostFor(async () => DIRTY, clock);
    await handleWorktreeStateMessage(host, { type: 'requestWorktreeState', root: 'C:/Repos/one' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toEqual({
      type: 'worktreeState',
      root: 'C:/Repos/one',
      state: { dirty: 5, ahead: 2, behind: 3, detached: false },
    });
  });

  it('runs git ONCE for two asks inside the window, and still answers the second', async () => {
    const clock = { t: 1_000 };
    const read = vi.fn(async () => CLEAN);
    const { host, post } = hostFor(read, clock);
    await handleWorktreeStateMessage(host, { type: 'requestWorktreeState', root: 'C:/Repos/two' });
    clock.t += WORKTREE_POLL_MS - 1;
    await handleWorktreeStateMessage(host, { type: 'requestWorktreeState', root: 'C:/Repos/two' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0]).toEqual(post.mock.calls[0][0]);
  });

  it('reads again once the window has passed', async () => {
    const clock = { t: 1_000 };
    const read = vi.fn(async () => CLEAN);
    const { host } = hostFor(read, clock);
    await handleWorktreeStateMessage(host, { type: 'requestWorktreeState', root: 'C:/Repos/three' });
    clock.t += WORKTREE_POLL_MS;
    await handleWorktreeStateMessage(host, { type: 'requestWorktreeState', root: 'C:/Repos/three' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('throttles per directory, not globally', async () => {
    const clock = { t: 1_000 };
    const read = vi.fn(async () => CLEAN);
    const { host } = hostFor(read, clock);
    await handleWorktreeStateMessage(host, { type: 'requestWorktreeState', root: 'C:/Repos/a' });
    await handleWorktreeStateMessage(host, { type: 'requestWorktreeState', root: 'C:/Repos/b' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('says nothing when git fails — a zeroed state would claim the tree is clean', async () => {
    const clock = { t: 1_000 };
    const { host, post } = hostFor(async () => undefined, clock);
    await handleWorktreeStateMessage(host, { type: 'requestWorktreeState', root: 'C:/not-a-repo' });
    expect(post).not.toHaveBeenCalled();
  });

  it('ignores a request with no root, and any other message type', async () => {
    const clock = { t: 1_000 };
    const read = vi.fn(async () => CLEAN);
    const { host, post } = hostFor(read, clock);
    await handleWorktreeStateMessage(host, { type: 'requestWorktreeState' });
    await handleWorktreeStateMessage(host, { type: 'somethingElse', root: 'C:/Repos/a' });
    expect(read).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
