// Folds board — repo CARDS and the PRIMARY checkout, host side.
//
// Two claims are worth real git for, and both are here rather than in a mocked
// unit test: that two registered checkouts of one repository resolve to the same
// identity (`git rev-parse --git-common-dir`), and that pointing a repository's
// primary at another checkout genuinely moves where its tickets and its folds
// land. Everything in the primary path defaults to the entry root, so the FIRST
// assertion of each pair is that nothing changed for a user who never sets one.

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentManager, type ManagerHost } from '../../../src/dashboard/agentManager/manager';
import { runGit, WORKTREES_DIRNAME } from '../../../src/dashboard/agentManager/worktrees';
import { loadState } from '../../../src/dashboard/agentManager/state';
import { listTickets, ticketsDir } from '../../../src/dashboard/agentManager/tickets';
import { readIdent, refreshIdents, worktreeRows, type RepoIdent } from '../../../src/dashboard/agentManager/repoCards';
import { primaryFor, readRepoFile, repoFilePath } from '../../../src/dashboard/agentManager/repoFile';

const made: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
});

// Every test gets its OWN repos.json home. The suite-wide setup already points
// ORIGAMI_REPOS_HOME at a temp dir (never the developer's ~/.origami); this
// narrows it further so one test's primary cannot leak into the next.
let priorHome: string | undefined;
beforeEach(() => { priorHome = process.env.ORIGAMI_REPOS_HOME; process.env.ORIGAMI_REPOS_HOME = tempDir('origami-cards-home-'); });
afterEach(() => { if (priorHome === undefined) delete process.env.ORIGAMI_REPOS_HOME; else process.env.ORIGAMI_REPOS_HOME = priorHome; });

interface FakeHost extends ManagerHost {
  posts: Array<Record<string, unknown>>;
  terminals: Array<{ cwd: string; title: string }>;
  sessions: string[];
  openedChats: string[];
  repos: string[];
}

function makeHost(known: string[]): FakeHost {
  const host: FakeHost = {
    posts: [], terminals: [], sessions: [], openedChats: [], repos: [...known],
    repoRoot: () => undefined,
    knownRepos: () => host.repos,
    saveKnownRepos: (paths) => { host.repos = [...paths]; },
    pickRepoFolder: async () => undefined,
    repoDisplayNames: () => ({}),
    saveRepoDisplayNames: () => undefined,
    autoApprove: () => true,
    setAutoApprove: () => undefined,
    createAgentSession: async (cwd) => { host.sessions.push(cwd); return `session-${host.sessions.length}`; },
    promptSession: async () => 'end_turn',
    cancelSession: async () => undefined,
    closeSession: () => undefined,
    sessionAlive: () => false,
    openChat: (id) => { host.openedChats.push(id); },
    post: (msg) => { host.posts.push(msg as Record<string, unknown>); },
    openTerminal: (cwd, title) => { host.terminals.push({ cwd, title }); },
    setSessionModel: async () => undefined,
    agentModes: () => null,
    setSessionAgentMode: async () => undefined,
    agentTypes: () => [],
    saveAgentTypes: () => undefined,
    archetypeMarker: () => ({ get: () => true, set: () => undefined }),
    harvestAnySessionModes: () => null,
    openCrossDiff: () => undefined,
    engineSessionId: () => undefined,
    reopenAgentSession: async () => 'session-r',
    openFileDiff: () => undefined,
    info: () => undefined,
    openConflicted: () => undefined,
    openFile: () => undefined,
  };
  return host;
}

/** A real repo with ONE linked worktree beside it - the shape this whole slice
 *  exists for (Origami Coder is developed as `origami-coder.wt/<branch>`). */
async function makeRepoWithWorktree(): Promise<{ main: string; wt: string }> {
  const main = tempDir('origami-cards-main-');
  expect((await runGit(['init', '-b', 'main'], main)).ok).toBe(true);
  await runGit(['config', 'user.email', 'uat@origami.local'], main);
  await runGit(['config', 'user.name', 'Origami UAT'], main);
  fs.writeFileSync(path.join(main, 'app.txt'), 'v1\n');
  await runGit(['add', 'app.txt'], main);
  expect((await runGit(['commit', '-m', 'seed'], main)).ok).toBe(true);
  const wt = path.join(main, 'sibling');
  expect((await runGit(['worktree', 'add', '-b', 'feature', wt], main)).ok).toBe(true);
  return { main, wt };
}

const lastState = (host: FakeHost) =>
  [...host.posts].reverse().find((p) => p.type === 'amState') as unknown as
    { repos: Array<{ root: string; primary: string; groupId: string; branch: string; tickets: unknown[] }> } | undefined;
const lastOf = (host: FakeHost, type: string) =>
  [...host.posts].reverse().find((p) => p.type === type) as Record<string, unknown> | undefined;

describe('worktreeRows (pure projection)', () => {
  const P = path.resolve('/repo/main');
  it('flags the primary, leads with it, and marks Origami folds under it', () => {
    const rows = worktreeRows([
      { path: path.join(P, WORKTREES_DIRNAME, 'fold-a'), head: 'aaa', branch: 'origami/fold-a' },
      { path: path.resolve('/repo/other'), head: 'bbb' },
      { path: P, head: 'ccc', branch: 'main' },
    ], P);
    expect(rows.map((r) => r.name)).toEqual(['main', 'fold-a', 'other']); // primary leads
    expect(rows[0]).toMatchObject({ primary: true, fold: false, branch: 'main' });
    expect(rows[1]).toMatchObject({ primary: false, fold: true, branch: 'origami/fold-a' });
    // A detached worktree carries NO branch rather than a made-up one.
    expect(rows[2]).toMatchObject({ primary: false, fold: false, branch: '' });
  });

  it('a sibling whose path merely STARTS with the folds dir name is not a fold', () => {
    const rows = worktreeRows([{ path: `${path.join(P, WORKTREES_DIRNAME)}-backup`, head: 'a' }], P);
    expect(rows[0].fold).toBe(false);
  });
});

describe('repo identity (real git)', () => {
  it('a repo and its linked worktree share ONE groupId and report their own branches', async () => {
    const { main, wt } = await makeRepoWithWorktree();
    const a = await readIdent(main);
    const b = await readIdent(wt);
    expect(a?.groupId).toBe(b?.groupId);      // one repository, two checkouts
    expect(a?.branch).toBe('main');
    expect(b?.branch).toBe('feature');
    // A directory that is not a git repo yields nothing at all - never a bogus id.
    expect(await readIdent(tempDir('origami-cards-plain-'))).toBeUndefined();
  }, 30_000);

  it('refreshIdents reports a change only on a real move, and forgets dropped roots', async () => {
    const { main, wt } = await makeRepoWithWorktree();
    const cache = new Map<string, RepoIdent>();
    expect(await refreshIdents([main, wt], cache)).toBe(true);
    expect(await refreshIdents([main, wt], cache)).toBe(false); // nothing moved
    expect((await runGit(['checkout', '-q', '-b', 'renamed'], wt)).ok).toBe(true);
    expect(await refreshIdents([main, wt], cache)).toBe(true);  // the branch moved
    expect(cache.get(wt)?.branch).toBe('renamed');
    expect(await refreshIdents([main], cache)).toBe(true);      // wt unregistered
    expect(cache.has(wt)).toBe(false);
  }, 30_000);
});

describe('repo card routes (real git, faked host)', () => {
  it('amRepoWorktrees answers with the rows, keyed by the ENTRY root the card drew', async () => {
    const { main, wt } = await makeRepoWithWorktree();
    const host = makeHost([wt]);
    const mgr = new AgentManager(host);
    try {
      await mgr.handle({ type: 'amRequestState' });
      await mgr.handle({ type: 'amRepoWorktrees', root: wt });
      const replyOf = () => lastOf(host, 'amWorktrees') as unknown as
        { root: string; primary: string; branches: string[]; worktrees: Array<{ name: string; primary: boolean }> };
      const reply = replyOf();
      expect(reply.root).toBe(wt);      // the card's key, not the primary
      expect(reply.primary).toBe(wt);   // no primary set -> the entry itself
      expect(reply.worktrees.find((r) => r.primary)?.name).toBe(path.basename(wt));
      expect(reply.worktrees.map((r) => r.name).sort()).toEqual([path.basename(main), path.basename(wt)].sort());
      // ...and the repository's LOCAL branches ride along, so the detail pane can
      // say which of them a checkout already has out.
      expect([...reply.branches].sort()).toEqual(['feature', 'main']);

      // A branch NO worktree has checked out is still listed. This is the
      // assertion that makes the field real: derive `branches` from the worktree
      // rows instead of reading refs/heads and every line above still passes.
      expect((await runGit(['branch', 'shelved'], main)).ok).toBe(true);
      await mgr.handle({ type: 'amRepoWorktrees', root: wt });
      expect([...replyOf().branches].sort()).toEqual(['feature', 'main', 'shelved']);
    } finally { mgr.dispose(); }
  }, 30_000);

  it('terminal + chat open at the ROW path, and a path outside the repository is refused', async () => {
    const { main, wt } = await makeRepoWithWorktree();
    const host = makeHost([wt]);
    const mgr = new AgentManager(host);
    try {
      await mgr.handle({ type: 'amRequestState' });
      await mgr.handle({ type: 'amWorktreeTerminal', root: wt, path: main });
      expect(host.terminals).toEqual([{ cwd: path.resolve(main), title: `Folds: ${path.basename(main)}` }]);

      await mgr.handle({ type: 'amWorktreeChat', root: wt, path: main });
      expect(host.sessions).toEqual([path.resolve(main)]); // a NEW session whose cwd IS that checkout
      expect(host.openedChats).toHaveLength(1);            // ...opened in front of the user

      // A path that is not one of this repository's worktrees never reaches the host.
      const stray = tempDir('origami-cards-stray-');
      await mgr.handle({ type: 'amWorktreeTerminal', root: wt, path: stray });
      expect(host.terminals).toHaveLength(1);
      expect(lastOf(host, 'amError')?.message).toContain('no longer part of this repository');
    } finally { mgr.dispose(); }
  }, 30_000);
});

describe('the PRIMARY checkout owns the work', () => {
  it('default (no primary): tickets and folds land at the registered root, exactly as before', async () => {
    const { main, wt } = await makeRepoWithWorktree();
    const host = makeHost([wt]);
    const mgr = new AgentManager(host);
    try {
      await mgr.handle({ type: 'amRequestState' });
      expect(primaryFor(wt)).toBe(wt);
      const board = lastState(host)?.repos[0];
      expect(board).toMatchObject({ root: wt, primary: wt, branch: 'feature' });
      expect(board?.groupId).not.toBe('');

      await mgr.handle({ type: 'amTicketQuickAdd', root: wt, title: 'stays home' });
      expect(listTickets(wt).map((t) => t.id)).toHaveLength(1);
      expect(fs.existsSync(ticketsDir(wt))).toBe(true);

      // The whole reason this slice exists: the registered root is ITSELF a
      // linked worktree, so `<root>/.git` is a FILE. Provisioning a fold used to
      // die in ensureExcluded's `mkdir <root>/.git/info` before git ran at all.
      expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
      const id = listTickets(wt)[0].id;
      await mgr.handle({ type: 'amTicketLaunch', root: wt, id, agentName: '', model: '', start: false });
      const rec = loadState(wt).worktrees[0];
      expect(rec, host.posts.filter((p) => p.type === 'amError').map((p) => p.message).join(' | ')).toBeDefined();
      expect(path.resolve(rec.path).startsWith(path.resolve(wt, WORKTREES_DIRNAME))).toBe(true);
      // ...and the exclude it writes landed in the COMMON git dir, which is the
      // only `info/exclude` git reads for a linked worktree. (.origami/tickets/
      // is deliberately NOT excluded - a ticket file is meant to be committed -
      // so `git status` here still reports the dir, and cannot be the assertion.)
      expect(fs.readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8')).toContain('.origami/worktrees/');
      expect(fs.existsSync(path.join(wt, '.git', 'info'))).toBe(false); // never under the pointer FILE
    } finally { mgr.dispose(); }
  }, 60_000);

  it('after Make primary the SAME card writes its tickets and its folds at the new checkout', async () => {
    const { main, wt } = await makeRepoWithWorktree();
    const host = makeHost([wt]);
    const mgr = new AgentManager(host);
    try {
      await mgr.handle({ type: 'amRequestState' });
      await mgr.handle({ type: 'amMakePrimary', root: wt, path: main });

      // The registry says so, and ONLY on that entry.
      const doc = readRepoFile(repoFilePath())!;
      expect(doc.repos.find((r) => r.root === wt)?.primary).toBe(path.resolve(main));
      expect(primaryFor(wt)).toBe(path.resolve(main));
      expect(lastState(host)?.repos[0]).toMatchObject({ root: wt, primary: path.resolve(main) });

      // A ticket raised on that card now lives at the primary, not at the entry.
      await mgr.handle({ type: 'amTicketQuickAdd', root: wt, title: 'moved home' });
      expect(listTickets(main).map((t) => t.title ?? '')).toHaveLength(1);
      expect(fs.existsSync(ticketsDir(wt))).toBe(false);
      expect(lastState(host)?.repos[0].tickets).toHaveLength(1); // ...and the board reads it there

      // ...and so does the fold the launch provisions: under the PRIMARY's
      // .origami/worktrees/, branched from ITS head, recorded in ITS state file.
      const id = listTickets(main)[0].id;
      await mgr.handle({ type: 'amTicketLaunch', root: wt, id, agentName: '', model: '', start: false });
      const rec = loadState(main).worktrees[0];
      expect(rec).toBeDefined();
      // The prompt names the ENTRY's board name — what board_* tools resolve —
      // never the primary's folder name, which differs from it here.
      expect(rec.queuedTask?.prompt).toContain(`This ticket is on the "${path.basename(wt)}" Folds board.`);
      expect(rec.queuedTask?.prompt).not.toContain(`"${path.basename(main)}"`);
      expect(path.resolve(rec.path).startsWith(path.resolve(main, WORKTREES_DIRNAME))).toBe(true);
      expect(loadState(wt).worktrees).toHaveLength(0);
      expect(lastState(host)?.repos[0].tickets).toHaveLength(1);
    } finally { mgr.dispose(); }
  }, 60_000);

  it('a primary whose folder has been deleted degrades to the root, never a dead board', async () => {
    const { main, wt } = await makeRepoWithWorktree();
    const host = makeHost([main]);
    const mgr = new AgentManager(host);
    try {
      await mgr.handle({ type: 'amRequestState' });
      await mgr.handle({ type: 'amMakePrimary', root: main, path: wt });
      expect(primaryFor(main)).toBe(path.resolve(wt));
      fs.rmSync(wt, { recursive: true, force: true });
      expect(primaryFor(main)).toBe(main);
      await mgr.handle({ type: 'amTicketQuickAdd', root: main, title: 'back home' });
      expect(listTickets(main)).toHaveLength(1);
    } finally { mgr.dispose(); }
  }, 30_000);
});

describe('adopt-on-read (the engine registered a repo this window never saw)', () => {
  it('a board_register entry becomes a card on the next board request, and unregister sticks', async () => {
    const { main } = await makeRepoWithWorktree();
    const other = tempDir('origami-cards-other-');
    expect((await runGit(['init', '-b', 'main'], other)).ok).toBe(true);
    // The ENGINE writes repos.json; this window knows only `main`.
    fs.mkdirSync(path.dirname(repoFilePath()), { recursive: true });
    fs.writeFileSync(repoFilePath(), `${JSON.stringify({
      version: 1,
      repos: [{ root: other, name: path.basename(other), workspace: false, addedAt: 1, source: 'board_register' }],
    }, null, 2)}\n`);

    const host = makeHost([main]);
    const mgr = new AgentManager(host);
    try {
      await mgr.handle({ type: 'amRequestState' });
      expect(host.repos).toContain(other);                       // adopted onto the known list
      expect(lastState(host)?.repos.map((r) => r.root)).toContain(other); // ...and drawn
      // The engine's unknown field survived the sync the adoption triggered.
      expect((readRepoFile(repoFilePath())!.repos.find((r) => r.root === other) as Record<string, unknown>).source)
        .toBe('board_register');

      // Unregistering has to STICK: the merge rule preserves what the extension
      // does not compose, so without an explicit drop it would be re-adopted.
      await mgr.handle({ type: 'amRemoveRepo', root: other });
      expect(host.repos).not.toContain(other);
      await mgr.handle({ type: 'amRequestState' });
      expect(host.repos).not.toContain(other);
      expect(lastState(host)?.repos.map((r) => r.root)).not.toContain(other);
    } finally { mgr.dispose(); }
  }, 30_000);
});
