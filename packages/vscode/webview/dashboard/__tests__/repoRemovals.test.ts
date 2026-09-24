// Folds board: registry removals and re-points made OUTSIDE this window.
//
// The window's repo list lives in globalState and every sync merges it into
// ~/.origami/repos.json. Before repoRemovals.ts, an entry that the board MCP server's
// board_unregister (or a hand edit) removed from the file came straight back on the
// next sync (reproduced 2026-09-24 with the real syncRepoFile). Every test here runs
// on a temp home; the suite setup also points ORIGAMI_REPOS_HOME at a temp dir.

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { loadKnownRepos, saveKnownRepos, composeRepoList } from '../../../src/dashboard/agentManager/registry';
import { dropEntry, readRepoFile, repoFilePath, updateRepoFile, writeRepoFile } from '../../../src/dashboard/agentManager/repoFile';
import { mergeRepoFile, repointEntry, repoFileKey } from '../../../src/dashboard/agentManager/repoMerge';
import { SEEN_KEY, syncRegistry } from '../../../src/dashboard/agentManager/repoRemovals';
import { adoptForeign, handleRepoCardMessage, type RepoCardCtx } from '../../../src/dashboard/agentManager/repoCards';
import { runGit } from '../../../src/dashboard/agentManager/worktrees';
import { onRepointRepo } from '../../../src/dashboard/agentManager/repoRepoint';
import type { ManagerHost } from '../../../src/dashboard/agentManager/manager';
import type { RepoRegistryContext } from '../../../src/dashboard/agentManager/repoOps';

const made: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
function gitDir(prefix: string, tickets = true): string {
  const dir = tempDir(prefix);
  fs.mkdirSync(path.join(dir, '.git'));
  if (tickets) fs.mkdirSync(path.join(dir, '.origami', 'tickets'), { recursive: true });
  return dir;
}
afterAll(() => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
});

let home: string;
let priorHome: string | undefined;
beforeEach(() => {
  priorHome = process.env.ORIGAMI_REPOS_HOME;
  home = tempDir('origami-removals-home-');
  process.env.ORIGAMI_REPOS_HOME = home; // adoptForeign reads the default home
});
afterEach(() => { if (priorHome === undefined) delete process.env.ORIGAMI_REPOS_HOME; else process.env.ORIGAMI_REPOS_HOME = priorHome; });

function memento(): vscode.Memento {
  const data = new Map<string, unknown>();
  return {
    keys: () => [...data.keys()],
    get: (key: string, fallback?: unknown) => (data.has(key) ? data.get(key) : fallback),
    update: async (key: string, value: unknown) => { data.set(key, value); },
  } as unknown as vscode.Memento;
}

/** One VS Code window: its own globalState over the shared temp repos.json. */
function windowWith(known: string[]) {
  const m = memento();
  saveKnownRepos(m, known);
  return {
    m,
    known: () => loadKnownRepos(m),
    sync: () => syncRegistry(m, undefined, loadKnownRepos(m), undefined, home),
    /** What the panel's host.saveKnownRepos does. */
    save: (paths: string[]) => { saveKnownRepos(m, paths); syncRegistry(m, undefined, paths, undefined, home); },
  };
}

const roots = () => (readRepoFile(repoFilePath(home))?.repos ?? []).map((r) => r.root);
/** A writer outside this window (board_unregister, a hand edit) drops one entry. */
const removeOutside = (root: string) => updateRepoFile((doc) => dropEntry(doc, root), home);

describe('guard 1: an unreadable registry drops nothing', () => {
  const cases: Array<[string, (file: string) => void]> = [
    ['missing', (file) => fs.rmSync(file)],
    ['empty', (file) => fs.writeFileSync(file, '')],
    ['not JSON', (file) => fs.writeFileSync(file, '{ "version": 1, "repos": [ ')],
    ['no repos list', (file) => fs.writeFileSync(file, '{ "version": 1 }\n')],
  ];
  for (const [label, spoil] of cases) {
    it(`${label} file: every known root stays and the last-seen set is not replaced`, () => {
      const a = gitDir('origami-rm-a-');
      const b = gitDir('origami-rm-b-');
      const win = windowWith([a, b]);
      win.sync();
      const seen = win.m.get<string[]>(SEEN_KEY);
      expect(seen).toHaveLength(2);
      spoil(repoFilePath(home));
      win.sync();
      expect(win.known()).toEqual([a, b]);
      expect(win.m.get<string[]>(SEEN_KEY)).toEqual(seen);
    });
  }
});

describe('guard 2: the first run initialises the last-seen set and drops nothing', () => {
  it('a known root absent from the file on the first run is written, not dropped', () => {
    const a = gitDir('origami-rm-a-');
    const b = gitDir('origami-rm-b-');
    writeRepoFile(repoFilePath(home), { version: 1, repos: [{ root: a, name: 'a', workspace: false, addedAt: 1 }] });
    const win = windowWith([a, b]);
    expect(win.m.get(SEEN_KEY)).toBeUndefined();
    win.sync();
    expect(win.known()).toEqual([a, b]);
    expect(roots()).toEqual([a, b]);
    expect(win.m.get<string[]>(SEEN_KEY)?.sort()).toEqual([a, b].map((r) => repoFileKey(r)).sort());
  });
});

describe('guard 4: the last-seen set follows every sync', () => {
  it('a root this window added later, then removed outside, is dropped', () => {
    const a = gitDir('origami-rm-a-');
    const b = gitDir('origami-rm-b-');
    const win = windowWith([a]);
    win.sync();
    win.save([a, b]); // the window's own addition
    expect(roots()).toEqual([a, b]);
    win.sync();
    expect(win.known()).toEqual([a, b]); // its own addition is never read as removed
    removeOutside(b);
    win.sync();
    expect(win.known()).toEqual([a]);
    expect(roots()).toEqual([a]);
  });
});

describe('a removal outside the window sticks', () => {
  it('board_unregister: the next sync drops the root instead of writing it back', () => {
    const a = gitDir('origami-rm-a-');
    const b = gitDir('origami-rm-b-');
    const win = windowWith([a, b]);
    win.sync();
    removeOutside(b);
    win.sync();
    expect(win.known()).toEqual([a]);
    expect(roots()).toEqual([a]);
    // The folder itself is never touched.
    expect(fs.existsSync(path.join(b, '.origami', 'tickets'))).toBe(true);
  });

  it('the board request (adopt-on-read) applies it with no reload', () => {
    const a = gitDir('origami-rm-a-');
    const b = gitDir('origami-rm-b-');
    const win = windowWith([a, b]);
    win.sync();
    removeOutside(b);
    const host = { knownRepos: win.known, saveKnownRepos: win.save, repoRoot: () => undefined } as unknown as ManagerHost;
    adoptForeign(host);
    expect(win.known()).toEqual([a]);
    expect(roots()).toEqual([a]);
  });
});

describe('guard 5: two windows over one registry', () => {
  it('a removal made in window A is not undone by window B', () => {
    const a = gitDir('origami-rm-a-');
    const b = gitDir('origami-rm-b-');
    const winA = windowWith([a, b]);
    const winB = windowWith([a, b]);
    winA.sync();
    winB.sync();
    // Window A: Remove from board (what repoOps.onRemoveRepo does).
    winA.save([a]);
    removeOutside(b);
    // Window B syncs next with its stale list.
    winB.sync();
    expect(winB.known()).toEqual([a]);
    expect(roots()).toEqual([a]);
    winA.sync();
    winB.sync();
    expect(roots()).toEqual([a]);
  });
});

describe('guard 3: a re-point outside the window ends as ONE card for the new root', () => {
  it('old root dropped, new root adopted, the name the tool set is kept', () => {
    const old = gitDir('origami-rm-old-');
    const other = gitDir('origami-rm-other-');
    const win = windowWith([old, other]);
    win.sync();
    // board_repoint: same entry, new root; the folder moved.
    const moved = `${old}-moved`;
    made.push(moved);
    fs.renameSync(old, moved);
    const doc = readRepoFile(repoFilePath(home))!;
    writeRepoFile(repoFilePath(home), {
      version: 1,
      repos: doc.repos.map((r) => (r.root === old ? { ...r, root: moved, name: 'custom-name' } : r)),
    });
    const host = { knownRepos: win.known, saveKnownRepos: win.save, repoRoot: () => undefined } as unknown as ManagerHost;
    adoptForeign(host);
    expect(win.known()).toEqual([other, moved]);
    const after = readRepoFile(repoFilePath(home))!.repos;
    expect(after.map((r) => r.root).sort()).toEqual([moved, other].sort());
    expect(after.find((r) => r.root === moved)?.name).toBe('custom-name');
  });

  it('mergeRepoFile sets name only when the entry has none', () => {
    const prior = { version: 1 as const, repos: [
      { root: 'C:\\a', name: 'custom', workspace: false, addedAt: 1 },
      { root: 'C:\\b', workspace: false, addedAt: 2 } as unknown as { root: string; name: string; workspace: boolean; addedAt: number },
    ] };
    const merged = mergeRepoFile([
      { root: 'C:\\a', name: 'a', workspace: false },
      { root: 'C:\\b', name: 'b', workspace: false },
      { root: 'C:\\c', name: 'c', workspace: false },
    ], prior, 9);
    expect(merged.repos.map((r) => r.name)).toEqual(['custom', 'b', 'c']);
  });
});

describe('repointEntry', () => {
  const prior = { version: 1 as const, repos: [
    { root: 'C:\\a', name: 'a', workspace: false, addedAt: 1, primary: 'C:\\a\\wt', displayName: 'A', note: 'x' },
    { root: 'C:\\b', name: 'b', workspace: false, addedAt: 2 },
  ] };

  it('changes root in place, keeps every other key and entry', () => {
    const out = repointEntry(prior, 'C:\\a', 'D:\\a', false);
    expect(Object.keys(out.repos[0])).toEqual(Object.keys(prior.repos[0]));
    expect(out.repos[0]).toEqual({ ...prior.repos[0], root: 'D:\\a' });
    expect(out.repos[1]).toBe(prior.repos[1]);
  });

  it('drops primary when asked, and an unknown root is a no-op', () => {
    expect(repointEntry(prior, 'C:\\a', 'D:\\a', true).repos[0].primary).toBeUndefined();
    expect(repointEntry(prior, 'C:\\zz', 'D:\\zz', true).repos).toEqual(prior.repos);
  });
});

describe('Edit path (amRepointRepo)', () => {
  function setup(pick: string | undefined, opts: { workspace?: string } = {}) {
    const old = gitDir('origami-rp-old-');
    const other = gitDir('origami-rp-other-');
    const win = windowWith([old, other]);
    win.sync();
    let names: Record<string, string> = { [old]: 'Pretty' };
    const posts: Array<Record<string, unknown>> = [];
    const host = {
      repoRoot: () => opts.workspace,
      knownRepos: win.known,
      saveKnownRepos: win.save,
      pickRepoFolder: async () => pick,
      repoDisplayNames: () => names,
      saveRepoDisplayNames: (n: Record<string, string>) => { names = n; syncRegistry(win.m, undefined, win.known(), n, home); },
      post: (msg: object) => { posts.push(msg as Record<string, unknown>); },
    } as unknown as ManagerHost;
    const ctx: RepoRegistryContext = {
      host, runtime: new Map(), busy: new Set(), reconciled: new Set(), missingSeen: new Set(),
      composed: () => composeRepoList(opts.workspace, win.known()),
      ensureReconciled: async () => undefined, schedulePoll: () => undefined, broadcast: () => undefined,
      mapRunning: () => false,
    };
    return { old, other, win, ctx, posts, names: () => names, before: fs.readFileSync(repoFilePath(home), 'utf8') };
  }
  const errors = (posts: Array<Record<string, unknown>>) => posts.filter((p) => p.type === 'amError').map((p) => String(p.message));

  it('a picked folder that is not a git repo root is refused and nothing changes', async () => {
    const plain = tempDir('origami-rp-plain-');
    const s = setup(plain);
    await onRepointRepo(s.ctx, s.old);
    expect(errors(s.posts)[0]).toMatch(/^Not a git repository root: /);
    expect(s.win.known()).toEqual([s.old, s.other]);
    expect(fs.readFileSync(repoFilePath(home), 'utf8')).toBe(s.before);
  });

  it('a git root with no tickets folder is refused', async () => {
    const s = setup(gitDir('origami-rp-empty-', false));
    await onRepointRepo(s.ctx, s.old);
    expect(errors(s.posts)[0]).toMatch(/^No tickets folder in /);
    expect(fs.readFileSync(repoFilePath(home), 'utf8')).toBe(s.before);
  });

  it('a root already on the board is refused', async () => {
    const s = setup(undefined);
    (s.ctx.host as unknown as { pickRepoFolder: () => Promise<string> }).pickRepoFolder = async () => s.other;
    await onRepointRepo(s.ctx, s.old);
    expect(errors(s.posts)[0]).toMatch(/^Already on the board: /);
    expect(fs.readFileSync(repoFilePath(home), 'utf8')).toBe(s.before);
  });

  it('a cancelled picker changes nothing', async () => {
    const s = setup(undefined);
    await onRepointRepo(s.ctx, s.old);
    expect(s.posts).toEqual([]);
    expect(fs.readFileSync(repoFilePath(home), 'utf8')).toBe(s.before);
  });

  it('the workspace repo is refused', async () => {
    const ws = gitDir('origami-rp-ws-');
    const s = setup(gitDir('origami-rp-new-'), { workspace: ws });
    await onRepointRepo(s.ctx, ws);
    expect(errors(s.posts)[0]).toMatch(/this window/i);
  });

  it('a moved repo: one entry with the new root, same name, same label, files untouched', async () => {
    const s0 = setup(undefined);
    const moved = `${s0.old}-moved`;
    made.push(moved);
    fs.renameSync(s0.old, moved);
    (s0.ctx.host as unknown as { pickRepoFolder: () => Promise<string> }).pickRepoFolder = async () => moved;
    const before = readRepoFile(repoFilePath(home))!.repos.find((r) => r.root === s0.old)!;
    await onRepointRepo(s0.ctx, s0.old);
    expect(errors(s0.posts)).toEqual([]);
    expect(s0.win.known()).toEqual([moved, s0.other]);
    const after = readRepoFile(repoFilePath(home))!.repos;
    expect(after.map((r) => r.root)).toEqual([moved, s0.other]);
    expect(after[0]).toMatchObject({ name: before.name, addedAt: before.addedAt, displayName: 'Pretty' });
    expect(s0.names()).toEqual({ [moved]: 'Pretty' });
    expect(fs.existsSync(path.join(moved, '.origami', 'tickets'))).toBe(true);
  });
});

/** The panel's host over one window: every write of known roots or labels syncs, as in
 *  DashboardPanel. */
function boardHost(win: ReturnType<typeof windowWith>, labels: Record<string, string> = {}) {
  let names = { ...labels };
  const posts: Array<Record<string, unknown>> = [];
  const host = {
    repoRoot: () => undefined,
    knownRepos: win.known,
    saveKnownRepos: (paths: string[]) => { saveKnownRepos(win.m, paths); syncRegistry(win.m, undefined, paths, names, home); },
    repoDisplayNames: () => names,
    saveRepoDisplayNames: (n: Record<string, string>) => { names = { ...n }; syncRegistry(win.m, undefined, win.known(), names, home); },
    post: (msg: object) => { posts.push(msg as Record<string, unknown>); },
  } as unknown as ManagerHost;
  return { host, posts, names: () => names };
}

describe('every extension write of repos.json respects an outside removal', () => {
  it('Make Primary after an outside removal does not write the removed entry back', async () => {
    const main = tempDir('origami-rm-main-');
    expect((await runGit(['init', '-b', 'main'], main)).ok).toBe(true);
    await runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'seed'], main);
    const wt = path.join(main, 'wt');
    expect((await runGit(['worktree', 'add', '-b', 'side', wt], main)).ok).toBe(true);
    const b = gitDir('origami-rm-b-');
    const win = windowWith([main, b]);
    win.sync();
    removeOutside(b);
    const { host, posts } = boardHost(win);
    const ctx: RepoCardCtx = { host, validateRoot: (raw) => String(raw), broadcast: () => undefined };
    await handleRepoCardMessage(ctx, { type: 'amMakePrimary', root: main, path: wt });
    expect(posts.filter((p) => p.type === 'amError')).toEqual([]);
    expect(roots()).toEqual([main]);
    expect(win.known()).toEqual([main]);
    expect(readRepoFile(repoFilePath(home))!.repos[0].primary).toBe(path.resolve(wt));
  }, 30_000);

  it('an edit of an unreadable file writes nothing (an empty list would read as "all removed")', () => {
    const file = repoFilePath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "version": 1, "repos": [ ');
    updateRepoFile((doc) => dropEntry(doc, 'C:\\x'), home);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "version": 1, "repos": [ ');
  });
});

describe('fields another writer set survive adoption', () => {
  it('an adopted repo keeps its board label, name, primary and unknown keys, and the board shows the label', () => {
    const a = gitDir('origami-rm-a-');
    const f = gitDir('origami-rm-foreign-');
    const win = windowWith([a]);
    const { host, names } = boardHost(win);
    host.saveKnownRepos([a]);
    const doc = readRepoFile(repoFilePath(home))!;
    const foreign = { root: f, name: 'fancy', workspace: false, addedAt: 5, displayName: 'Fancy Label', primary: path.join(f, 'wt'), source: 'board_register' };
    writeRepoFile(repoFilePath(home), { version: 1, repos: [...doc.repos, foreign] });
    adoptForeign(host);
    expect(win.known()).toEqual([a, f]);
    expect(readRepoFile(repoFilePath(home))!.repos.find((r) => r.root === f)).toEqual(foreign);
    expect(names()[f]).toBe('Fancy Label');
  });
});
