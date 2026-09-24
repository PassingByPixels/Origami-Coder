// The chat pane's repo/branch pills, HOST side — src/dashboard/repoPicker.ts.
//
// The thing under test is not "does a dropdown get a list". It is the one way this
// feature could quietly destroy something: a Session's `cwd` is fixed at creation, so
// re-pointing a chat that already has turns would leave a transcript describing work
// in a directory it was never run in. `selectionPlan` is that rule; the fake host here
// fails the test if anything tries to write a session's cwd at all.
//
// The git half runs against a REAL temp repository, because the claim being made is
// about `git worktree list` and `git worktree add` — a fixture of invented porcelain
// would only prove this file agrees with itself.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  branchRows,
  handleRepoPickerMessage,
  selectionPlan,
  type RepoPickerHost,
  type RepoPickerSession,
} from '../../../src/dashboard/repoPicker';
import { createWorktree, listWorktrees, runGit } from '../../../src/dashboard/agentManager/worktrees';
import { reconcile } from '../../../src/dashboard/agentManager/state';

function fakeHost(sessions: RepoPickerSession[], home?: string) {
  const posted: Record<string, unknown>[] = [];
  const created: string[] = [];
  const closed: string[] = [];
  // Frozen session records: a write to `cwd` throws instead of passing silently.
  const frozen = sessions.map((s) => Object.freeze({ ...s }));
  const host: RepoPickerHost = {
    cwd: 'C:/workspace',
    post: (m) => void posted.push(m),
    sessions: () => frozen,
    createChat: async (cwd) => {
      created.push(cwd);
      return `session-${created.length + 90}`;
    },
    closeChat: (id) => void closed.push(id),
    ...(home ? { home } : {}),
  };
  return { host, posted, created, closed, frozen };
}

describe('selectionPlan — a session cwd is fixed at creation', () => {
  const withTurns: RepoPickerSession = { id: 'session-1', cwd: 'C:/Repos/a', hasTurns: true };
  const empty: RepoPickerSession = { id: 'session-2', cwd: 'C:/Repos/a', hasTurns: false };

  it('a chat WITH turns keeps its directory and gets a new chat beside it', () => {
    expect(selectionPlan(withTurns, 'C:/Repos/b')).toEqual({ openNew: true, closeOrigin: false });
  });

  it('a chat with NO turns is replaced, so the pills read as switching that chat', () => {
    expect(selectionPlan(empty, 'C:/Repos/b')).toEqual({ openNew: true, closeOrigin: true });
  });

  it('picking the directory the chat is already in does nothing at all', () => {
    expect(selectionPlan(withTurns, 'C:\\Repos\\A\\')).toEqual({ openNew: false, closeOrigin: false });
  });

  it('an unknown session still opens the chat rather than dropping the pick', () => {
    expect(selectionPlan(undefined, 'C:/Repos/b')).toEqual({ openNew: true, closeOrigin: false });
  });
});

describe('repoPickerSelect', () => {
  it('a repo change on a chat WITH turns never mutates that session, and opens a new chat', async () => {
    const { host, created, closed, frozen } = fakeHost([{ id: 'session-1', cwd: 'C:/Repos/a', hasTurns: true }]);
    await handleRepoPickerMessage(host, {
      type: 'repoPickerSelect', sessionId: 'session-1', root: 'C:/Repos/b', branch: 'main', path: 'C:/Repos/b',
    });
    expect(created).toEqual(['C:/Repos/b']);
    expect(closed).toEqual([]);
    expect(frozen[0].cwd).toBe('C:/Repos/a');
  });

  it('a repo change on an EMPTY chat closes the one it replaced', async () => {
    const { host, created, closed } = fakeHost([{ id: 'session-1', cwd: 'C:/Repos/a', hasTurns: false }]);
    await handleRepoPickerMessage(host, {
      type: 'repoPickerSelect', sessionId: 'session-1', root: 'C:/Repos/b', branch: 'main', path: 'C:/Repos/b',
    });
    expect(created).toEqual(['C:/Repos/b']);
    expect(closed).toEqual(['session-1']);
  });

  it('a message with no path is ignored rather than opening a chat at ""', async () => {
    const { host, created, posted } = fakeHost([]);
    await handleRepoPickerMessage(host, { type: 'repoPickerSelect', sessionId: 'session-1', root: 'C:/Repos/b' });
    expect(created).toEqual([]);
    expect(posted).toEqual([]);
  });
});

describe('repoPickerOptions', () => {
  let home: string;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-picker-home-'));
    fs.mkdirSync(path.join(home, '.origami'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.origami', 'repos.json'),
      JSON.stringify({ version: 1, repos: [{ root: 'C:/Repos/Projects/learning-apps', name: 'learning-apps', displayName: 'Learning apps', addedAt: 1 }] }),
    );
  });

  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

  it('offers the registry, the workspace default, and each chat s own directory', async () => {
    const { host, posted } = fakeHost([{ id: 'session-1', cwd: 'C:/Repos/a', hasTurns: false }], home);
    await handleRepoPickerMessage(host, { type: 'repoPickerOptions' });
    expect(posted[0]).toEqual({
      type: 'repoPickerOptions',
      repos: [{ root: 'C:/Repos/Projects/learning-apps', name: 'Learning apps' }],
      defaultRoot: 'C:/workspace',
      cwdBySession: { 'session-1': 'C:/Repos/a' },
    });
  });
});

describe('branchRows', () => {
  it('labels a detached worktree by its short HEAD instead of dropping a selectable directory', () => {
    expect(branchRows([
      { path: 'C:/Repos/a', head: 'abc1234def', branch: 'master' },
      { path: 'C:/Repos/a/.origami/worktrees/x', head: '0123456789abcdef' },
    ])).toEqual([
      { branch: 'master', path: 'C:/Repos/a' },
      { branch: '0123456', path: 'C:/Repos/a/.origami/worktrees/x' },
    ]);
  });
});

describe('against a real git repository', () => {
  let repo: string;
  let ok = false;

  beforeAll(async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-picker-git-')));
    const init = await runGit(['init', '-b', 'main', '.'], repo);
    if (!init.ok) return;
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n');
    await runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], repo);
    const commit = await runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], repo);
    ok = commit.ok;
  }, 30000);

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('lists the primary checkout as a branch row', async () => {
    expect(ok).toBe(true);
    const rows = branchRows(await listWorktrees(repo));
    expect(rows.map((r) => r.branch)).toContain('main');
  });

  it('New branch... adds a worktree and leaves the PRIMARY on its own branch', async () => {
    expect(ok).toBe(true);
    const before = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).output.trim();
    const { host, created } = fakeHost([{ id: 'session-1', cwd: repo, hasTurns: true }]);
    await handleRepoPickerMessage(host, { type: 'repoPickerNewBranch', sessionId: 'session-1', root: repo, name: 'Care Calendar' });

    const after = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).output.trim();
    expect(after).toBe(before); // never a checkout in the primary
    const rows = branchRows(await listWorktrees(repo));
    expect(rows.map((r) => r.branch)).toContain('origami/care-calendar');
    expect(created).toEqual([path.join(repo, '.origami', 'worktrees', 'care-calendar')]);
  }, 30000);

  // BOARD LINKAGE — decision (b) in the ticket: the board already tolerates a worktree
  // the picker made. Proof rather than assertion: createWorktree puts it under
  // .origami/worktrees/, which is exactly the set `ownWorktrees` matches, so the Agent
  // Manager's boot reconcile ADOPTS it as an orphan record — and the 5s/60s stats
  // poller walks `loadState().worktrees`, which is that same list. No fold record is
  // written by the picker, and none is needed for the board to see the directory.
  it('a picker-created worktree is adopted by the board s own reconcile, so the poller sees it', async () => {
    expect(ok).toBe(true);
    const made = await createWorktree(repo, 'board-linkage');
    const result = reconcile({ version: 1, worktrees: [] }, await listWorktrees(repo), repo);
    const adopted = result.orphans.find((r) => path.resolve(r.path) === path.resolve(made.path));
    expect(adopted).toBeDefined();
    expect(adopted?.branch).toBe(made.branch);
    expect(result.state.worktrees).toContain(adopted);
  }, 30000);
});
