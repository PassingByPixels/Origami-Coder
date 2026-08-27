// Agent Manager S2 - worktree layer + registry. The naming/parsing/reconcile
// pieces are pure table tests; the lifecycle (create / collide / remove /
// exclude / mutex) runs against a REAL throwaway `git init` repo in the OS
// temp dir - pass/fail comes from actual git behaviour, not a mock of it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  sanitizeWorktreeName,
  parseWorktreeList,
  ownWorktrees,
  ensureExcluded,
  resolveGitDir,
  createWorktree,
  listWorktrees,
  removeWorktree,
  runGit,
  runGitStdout,
  WORKTREES_DIRNAME,
} from '../../../src/dashboard/agentManager/worktrees';
import {
  loadState,
  saveState,
  reconcile,
  emptyState,
  newWorktreeRecordId,
  STATE_FILENAME,
  type WorktreeRecord,
} from '../../../src/dashboard/agentManager/state';
import {
  parseNumstatZ,
  parseConflicts,
  diffFiles,
  buildPatch,
  preflight,
  applyPatch,
  alreadyApplied,
} from '../../../src/dashboard/agentManager/apply';
import { readWorktreeStats } from '../../../src/dashboard/agentManager/pollers';
import { fileDiffs } from '../../../src/dashboard/agentManager/raceCompare';

describe('sanitizeWorktreeName', () => {
  it('slugs typical input and rejects git-ref-hostile shapes', () => {
    expect(sanitizeWorktreeName('Fix Login Bug')).toBe('fix-login-bug');
    expect(sanitizeWorktreeName('  weird//name!!  ')).toBe('weird-name');
    expect(sanitizeWorktreeName('a..b')).toBe('a.b');
    expect(sanitizeWorktreeName('thing.lock')).toBe('thing');
    expect(sanitizeWorktreeName('---')).toBe('agent');
    expect(sanitizeWorktreeName('')).toBe('agent');
  });

  it('the length cap cannot expose a trailing dot (invalid ref ending)', () => {
    // 40th char lands exactly on the '.' -> must be trimmed after slicing
    const name = 'a'.repeat(39) + '.suffix';
    const out = sanitizeWorktreeName(name);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('.')).toBe(false);
    expect(out.endsWith('-')).toBe(false);
  });
});

describe('parseWorktreeList', () => {
  it('parses porcelain output including detached and branch entries', () => {
    const porcelain = [
      'worktree C:/repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree C:/repo/.origami/worktrees/fix-1',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/origami/fix-1',
      '',
      'worktree C:/elsewhere/detached-wt',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
    ].join('\n');
    const entries = parseWorktreeList(porcelain);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ path: 'C:/repo', branch: 'main' });
    expect(entries[1]).toMatchObject({ branch: 'origami/fix-1' });
    expect(entries[2].branch).toBeUndefined();

    const ours = ownWorktrees(entries, 'C:/repo');
    expect(ours).toHaveLength(1);
    expect(ours[0].branch).toBe('origami/fix-1');
  });
});

describe('registry state (load/save/reconcile)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-am-state-'));
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ } });

  const record = (over: Partial<WorktreeRecord>): WorktreeRecord => ({
    id: newWorktreeRecordId(),
    name: 'x',
    branch: 'origami/x',
    path: path.join(dir, WORKTREES_DIRNAME, 'x'),
    baseSha: 'abc',
    createdAt: 1,
    sessions: [],
    ...over,
  });

  it('missing file loads as empty; save/load round-trips', () => {
    expect(loadState(dir)).toEqual(emptyState());
    const st = emptyState();
    st.worktrees.push(record({ name: 'kept' }));
    saveState(dir, st);
    expect(loadState(dir).worktrees[0].name).toBe('kept');
  });

  it('a corrupt file is backed up and treated as empty, never clobbered silently', () => {
    const file = path.join(dir, STATE_FILENAME);
    fs.writeFileSync(file, '{ not json !!!');
    expect(loadState(dir)).toEqual(emptyState());
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('corrupt'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('reconcile drops records whose worktree is gone and adopts unrecorded worktrees as orphans', () => {
    const livePath = path.join(dir, WORKTREES_DIRNAME, 'alive');
    const strayPath = path.join(dir, WORKTREES_DIRNAME, 'stray');
    const st = emptyState();
    st.worktrees.push(record({ name: 'alive', path: livePath }));
    st.worktrees.push(record({ name: 'dead', path: path.join(dir, WORKTREES_DIRNAME, 'dead') }));
    const live = [
      { path: livePath, head: 'aaa', branch: 'origami/alive' },
      { path: strayPath, head: 'bbb', branch: 'origami/stray' },
      { path: dir, head: 'ccc', branch: 'main' }, // primary tree - never ours
    ];
    const r = reconcile(st, live, dir, 42);
    expect(r.stale.map((x) => x.name)).toEqual(['dead']);
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0]).toMatchObject({ name: 'stray', branch: 'origami/stray', orphan: true, baseSha: 'bbb' });
    expect(r.state.worktrees.map((x) => x.name).sort()).toEqual(['alive', 'stray']);
  });
});

describe('worktree lifecycle (real git fixture)', () => {
  let repo: string;

  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-am-git-'));
    expect((await runGit(['init', '-b', 'main'], repo)).ok).toBe(true);
    await runGit(['config', 'user.email', 'uat@origami.local'], repo);
    await runGit(['config', 'user.name', 'Origami UAT'], repo);
    fs.writeFileSync(path.join(repo, 'hello.txt'), 'hello\n');
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=copied\n');
    expect((await runGit(['add', 'hello.txt'], repo)).ok).toBe(true);
    expect((await runGit(['commit', '-m', 'seed'], repo)).ok).toBe(true);
  }, 30_000);

  afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* temp dir - OS sweeps it */ } });

  it('creates a worktree on origami/<name> from the dereferenced base, copies .env, and lists it', async () => {
    const created = await createWorktree(repo, 'First Try');
    expect(created.name).toBe('first-try');
    expect(created.branch).toBe('origami/first-try');
    expect(fs.existsSync(path.join(created.path, 'hello.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(created.path, '.env'), 'utf8')).toContain('SECRET=copied');
    // branch points at the seed commit, no upstream tracking
    const head = await runGit(['rev-parse', 'HEAD'], repo);
    expect(created.baseSha).toBe(head.output.trim());
    const upstream = await runGit(['rev-parse', '--abbrev-ref', 'origami/first-try@{upstream}'], repo);
    expect(upstream.ok).toBe(false);
    const ours = ownWorktrees(await listWorktrees(repo), repo);
    expect(ours.map((e) => e.branch)).toContain('origami/first-try');
  }, 30_000);

  it('collides to -2 when the name is taken', async () => {
    const second = await createWorktree(repo, 'first try');
    expect(second.name).toBe('first-try-2');
    expect(second.branch).toBe('origami/first-try-2');
  }, 30_000);

  it('excludes our dir + state file from git status (idempotently)', async () => {
    ensureExcluded(repo);
    ensureExcluded(repo);
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/\.origami\/worktrees\//g)).toHaveLength(1);
    expect(exclude.match(/\.origami\/agent-manager\.json/g)).toHaveLength(1);
    // the primary tree's status must not see the worktrees created above
    const status = await runGit(['status', '--porcelain'], repo);
    expect(status.output).not.toContain('.origami');
  }, 30_000);

  it('removes a worktree but keeps the branch (the safety net) unless told otherwise', async () => {
    const wt = await createWorktree(repo, 'removable');
    const gone = await removeWorktree(repo, wt.path);
    expect(gone.ok).toBe(true);
    expect(fs.existsSync(wt.path)).toBe(false);
    expect((await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/origami/removable'], repo)).ok).toBe(true);

    const wt2 = await createWorktree(repo, 'removable-all');
    const gone2 = await removeWorktree(repo, wt2.path, { deleteBranch: wt2.branch });
    expect(gone2.ok).toBe(true);
    expect((await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${wt2.branch}`], repo)).ok).toBe(false);
  }, 30_000);

  it('serializes concurrent creates on one repo (no index.lock race)', async () => {
    const [a, b] = await Promise.all([
      createWorktree(repo, 'race'),
      createWorktree(repo, 'race'),
    ]);
    expect([a.name, b.name].sort()).toEqual(['race', 'race-2']);
    expect(fs.existsSync(a.path)).toBe(true);
    expect(fs.existsSync(b.path)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// S4 apply-to-main: numstat/conflict parsing (pure) + the git ops against real
// throwaway repos+worktrees. A worktree shares the main repo's object DB, so a
// patch built from the worktree applies straight into the main working tree.
// ---------------------------------------------------------------------------

describe('parseNumstatZ (pure)', () => {
  const NUL = '\0';
  const TAB = '\t';
  it('parses modified / added / deleted / binary / rename records', () => {
    // Exactly the -z shapes observed from real git: `adds\tdels\tpath\0`,
    // binary `-\t-\tpath\0`, rename `adds\tdels\t\0old\0new\0`.
    const raw =
      `3${TAB}1${TAB}mod.txt${NUL}` +           // modified
      `5${TAB}0${TAB}added.txt${NUL}` +         // added (all inserts)
      `0${TAB}4${TAB}gone.txt${NUL}` +          // deleted (all deletes)
      `-${TAB}-${TAB}img.bin${NUL}` +           // binary
      `0${TAB}0${TAB}${NUL}old.txt${NUL}new.txt${NUL}`; // rename -> new path
    expect(parseNumstatZ(raw)).toEqual([
      { path: 'mod.txt', adds: 3, dels: 1, binary: false },
      { path: 'added.txt', adds: 5, dels: 0, binary: false },
      { path: 'gone.txt', adds: 0, dels: 4, binary: false },
      { path: 'img.bin', adds: 0, dels: 0, binary: true },
      { path: 'new.txt', adds: 0, dels: 0, binary: false, oldPath: 'old.txt' }, // rename surfaces its old side
    ]);
  });
  it('an empty diff yields no files', () => {
    expect(parseNumstatZ('')).toEqual([]);
  });
});

describe('parseConflicts (pure)', () => {
  it('extracts the paths git names across its failure shapes', () => {
    const out = [
      "error: patch failed: src/a.ts:3",
      "error: src/b.ts: does not match index",
      "Applied patch to 'src/c.ts' with conflicts.",
      "U src/c.ts",
      "error: src/d.ts: patch does not apply",
    ].join('\n');
    expect(parseConflicts(out).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  });
});

describe('apply-to-main (real git fixtures)', () => {
  const made: string[] = [];
  afterAll(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } });

  async function freshRepoWt(seed: Record<string, string | Buffer>): Promise<{ repo: string; wt: string; baseSha: string }> {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-apply-'));
    made.push(repo);
    await runGit(['init', '-b', 'main'], repo);
    await runGit(['config', 'user.email', 't@origami.local'], repo);
    await runGit(['config', 'user.name', 'Origami'], repo);
    await runGit(['config', 'core.autocrlf', 'false'], repo);
    for (const [f, c] of Object.entries(seed)) fs.writeFileSync(path.join(repo, f), c as never);
    await runGit(['add', '-A'], repo);
    expect((await runGit(['commit', '-m', 'seed'], repo)).ok).toBe(true);
    const created = await createWorktree(repo, 'apply-wt');
    return { repo, wt: created.path, baseSha: created.baseSha };
  }
  const commitCount = async (repo: string) => (await runGit(['rev-list', '--count', 'HEAD'], repo)).output.trim();
  const stagedNames = async (repo: string) => (await runGit(['diff', '--cached', '--name-only'], repo)).output.trim();

  it('(a1) numstat parse across modified/added/deleted/binary from real git', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({
      'mod.txt': 'a\nb\nc\n', 'gone.txt': 'x\n', 'img.bin': Buffer.from('PNG\x00\x01\x02bin\x00', 'binary'),
    });
    // Commit the changes IN the worktree so baseSha..working-tree covers add/delete too.
    fs.writeFileSync(path.join(wt, 'mod.txt'), 'a\nB2\nc\nd\n'); // +2 -1
    fs.writeFileSync(path.join(wt, 'added.txt'), 'new\n');
    fs.rmSync(path.join(wt, 'gone.txt'));
    fs.writeFileSync(path.join(wt, 'img.bin'), Buffer.from('PNG\x00\x09\x08changed\x00\x00', 'binary'));
    await runGit(['add', '-A'], wt);
    await runGit(['commit', '-m', 'work'], wt);
    const files = await diffFiles(wt, baseSha);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by['mod.txt']).toMatchObject({ adds: 2, dels: 1, binary: false });
    expect(by['added.txt']).toMatchObject({ dels: 0, binary: false });
    expect(by['added.txt'].adds).toBeGreaterThan(0);
    expect(by['gone.txt']).toMatchObject({ adds: 0, binary: false });
    expect(by['gone.txt'].dels).toBeGreaterThan(0);
    expect(by['img.bin'].binary).toBe(true);
    void repo;
  }, 30_000);

  it('(a2) roundtrip: an uncommitted worktree edit applies to main, nothing committed/staged, worktree untouched', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'f.txt': 'l1\nl2\nl3\n' });
    fs.writeFileSync(path.join(wt, 'f.txt'), 'l1\nAGENT\nl3\n'); // uncommitted
    const before = await commitCount(repo);
    const patch = await buildPatch(wt, baseSha, ['f.txt']);
    try {
      expect((await preflight(repo, patch)).ok).toBe(true);
      const res = await applyPatch(repo, patch, ['f.txt']);
      expect(res.ok).toBe(true);
      expect(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8')).toBe('l1\nAGENT\nl3\n'); // main == worktree
      expect(await commitCount(repo)).toBe(before);   // nothing committed
      expect(await stagedNames(repo)).toBe('');        // nothing staged
      expect(fs.readFileSync(path.join(wt, 'f.txt'), 'utf8')).toBe('l1\nAGENT\nl3\n'); // worktree untouched
    } finally { fs.unlinkSync(patch); }
    expect(fs.existsSync(patch)).toBe(false);
  }, 30_000);

  it('(a3) selective: applying only one of two changed files leaves the other absent from main', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'one.txt': '1\n', 'two.txt': '2\n' });
    fs.writeFileSync(path.join(wt, 'one.txt'), 'ONE\n');
    fs.writeFileSync(path.join(wt, 'two.txt'), 'TWO\n');
    const patch = await buildPatch(wt, baseSha, ['one.txt']); // only one.txt
    try {
      expect((await applyPatch(repo, patch, ['one.txt'])).ok).toBe(true);
      expect(fs.readFileSync(path.join(repo, 'one.txt'), 'utf8')).toBe('ONE\n');
      expect(fs.readFileSync(path.join(repo, 'two.txt'), 'utf8')).toBe('2\n'); // untouched
    } finally { fs.unlinkSync(patch); }
  }, 30_000);

  it('(a4) conflict: an uncommitted main edit on the same lines makes preflight refuse; main tree byte-identical after', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'f.txt': 'l1\nl2\nl3\n' });
    fs.writeFileSync(path.join(wt, 'f.txt'), 'l1\nAGENT\nl3\n');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'l1\nHUMAN\nl3\n'); // main diverges, uncommitted
    const patch = await buildPatch(wt, baseSha, ['f.txt']);
    try {
      const pre = await preflight(repo, patch);
      expect(pre.ok).toBe(false);
      expect(pre.conflicts).toContain('f.txt');
      expect(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8')).toBe('l1\nHUMAN\nl3\n'); // --check wrote nothing
    } finally { fs.unlinkSync(patch); }
  }, 30_000);

  it('(a5) force: applying over a committed same-line divergence leaves 3-way markers and reports the path', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'f.txt': 'l1\nl2\nl3\n' });
    fs.writeFileSync(path.join(wt, 'f.txt'), 'l1\nAGENT\nl3\n');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'l1\nHUMAN\nl3\n');
    await runGit(['commit', '-am', 'human edit'], repo); // committed divergence
    const patch = await buildPatch(wt, baseSha, ['f.txt']);
    try {
      const res = await applyPatch(repo, patch, ['f.txt']);
      expect(res.ok).toBe(false);
      expect(res.conflicts).toContain('f.txt');
      const after = fs.readFileSync(path.join(repo, 'f.txt'), 'utf8');
      expect(after).toContain('<<<<<<<');
      expect(after).toContain('AGENT');
      expect(after).toContain('HUMAN');
    } finally { fs.unlinkSync(patch); }
  }, 30_000);

  it('(a6) binary file round-trips via --binary', async () => {
    const original = Buffer.from('IMG\x00\x01\x02\x03orig\x00\x00', 'binary');
    const changed = Buffer.from('IMG\x00\x09\x08\x07new\x00bytes\x00\x00', 'binary');
    const { repo, wt, baseSha } = await freshRepoWt({ 'pic.bin': original });
    fs.writeFileSync(path.join(wt, 'pic.bin'), changed);
    const patch = await buildPatch(wt, baseSha, ['pic.bin']);
    try {
      expect((await applyPatch(repo, patch, ['pic.bin'])).ok).toBe(true);
      expect(fs.readFileSync(path.join(repo, 'pic.bin')).equals(changed)).toBe(true); // byte-identical
    } finally { fs.unlinkSync(patch); }
  }, 30_000);

  // -------------------------------------------------------------------------
  // S4.2: untracked (new) files. markUntracked (git add -A --intent-to-add,
  // run inside readWorktreeStats/diffFiles/buildPatch) makes new files visible
  // to `git diff` as creations, so the badge, the file list, and the patch all
  // include them - the LICENSE-file UAT (created file, empty diff, unmergeable).
  // -------------------------------------------------------------------------

  it('(n1) an untracked new file counts toward the badge and appears in diffFiles', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'seed.txt': 's\n' });
    fs.writeFileSync(path.join(wt, 'new.txt'), 'a\nb\nc\n'); // 3 new lines, untracked
    const stats = await readWorktreeStats(wt, baseSha);
    expect(stats.adds).toBe(3); // new-file lines counted in the badge
    expect(stats.dels).toBe(0);
    const files = await diffFiles(wt, baseSha);
    expect(files.find((f) => f.path === 'new.txt')).toMatchObject({ adds: 3, dels: 0, binary: false });
    void repo;
  }, 30_000);

  it('(n2) a new file applies into main left UNTRACKED, nothing staged/committed, worktree intact', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'seed.txt': 's\n' });
    fs.writeFileSync(path.join(wt, 'LICENSE'), 'MIT\ncopyright\n'); // brand-new, untracked
    const before = await commitCount(repo);
    const patch = await buildPatch(wt, baseSha, ['LICENSE']);
    try {
      expect((await preflight(repo, patch)).ok).toBe(true);
      expect((await applyPatch(repo, patch, ['LICENSE'])).ok).toBe(true);
      expect(fs.readFileSync(path.join(repo, 'LICENSE'), 'utf8')).toBe('MIT\ncopyright\n'); // exists in main
      expect(await commitCount(repo)).toBe(before);                       // nothing committed
      expect(await stagedNames(repo)).toBe('');                            // nothing staged
      const status = (await runGit(['status', '--porcelain', '--', 'LICENSE'], repo)).output.trim();
      expect(status).toBe('?? LICENSE');                                   // left UNTRACKED in main
      expect(fs.readFileSync(path.join(wt, 'LICENSE'), 'utf8')).toBe('MIT\ncopyright\n'); // worktree untouched
    } finally { fs.unlinkSync(patch); }
  }, 30_000);

  it('(n3) a new file whose name already exists in main with DIFFERENT content is refused at PREFLIGHT', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'seed.txt': 's\n' });
    fs.writeFileSync(path.join(wt, 'LICENSE'), 'AGENT VERSION\n');
    fs.writeFileSync(path.join(repo, 'LICENSE'), 'HUMAN VERSION\n'); // untracked in main, clashing
    const patch = await buildPatch(wt, baseSha, ['LICENSE']);
    try {
      const pre = await preflight(repo, patch);
      expect(pre.ok).toBe(false);                          // real git refuses at --check
      expect(pre.conflicts).toContain('LICENSE');
      expect(await alreadyApplied(repo, patch)).toBe(false); // content differs -> not already applied
    } finally { fs.unlinkSync(patch); }
  }, 30_000);

  it('(n4) a .gitignore\'d untracked file is neither counted nor listed', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'seed.txt': 's\n', '.gitignore': 'ignored.log\n' });
    fs.writeFileSync(path.join(wt, 'ignored.log'), 'noise\nnoise\n'); // ignored, untracked
    const stats = await readWorktreeStats(wt, baseSha);
    expect(stats.adds).toBe(0);                                        // intent-to-add respects .gitignore
    const files = await diffFiles(wt, baseSha);
    expect(files.some((f) => f.path === 'ignored.log')).toBe(false);
    void repo;
  }, 30_000);

  it('(n5) mixed set: modified tracked + new file both list; applying only the new file excludes the tracked change', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'tracked.txt': 'orig\n' });
    fs.writeFileSync(path.join(wt, 'tracked.txt'), 'MODIFIED\n'); // modify a tracked file
    fs.writeFileSync(path.join(wt, 'fresh.txt'), 'brand new\n');  // add a new untracked file
    const files = await diffFiles(wt, baseSha);
    expect(files.map((f) => f.path).sort()).toEqual(['fresh.txt', 'tracked.txt']); // both listed
    const patch = await buildPatch(wt, baseSha, ['fresh.txt']); // select ONLY the new file
    try {
      expect((await applyPatch(repo, patch, ['fresh.txt'])).ok).toBe(true);
      expect(fs.readFileSync(path.join(repo, 'fresh.txt'), 'utf8')).toBe('brand new\n');
      expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('orig\n'); // tracked change NOT in main
    } finally { fs.unlinkSync(patch); }
  }, 30_000);

  it('(n6) re-applying a new file already present (uncommitted) in main -> preflight refuses, alreadyApplied is true, tree untouched', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'seed.txt': 's\n' });
    fs.writeFileSync(path.join(wt, 'LICENSE'), 'MIT\ncopyright\n');
    const patch = await buildPatch(wt, baseSha, ['LICENSE']);
    try {
      expect((await applyPatch(repo, patch, ['LICENSE'])).ok).toBe(true); // first apply lands it untracked
      const pre = await preflight(repo, patch);                           // the same patch again
      expect(pre.ok).toBe(false);                                         // forward --check refuses (already there)
      expect(await alreadyApplied(repo, patch)).toBe(true);               // reverse --check passes -> already applied
      expect(fs.readFileSync(path.join(repo, 'LICENSE'), 'utf8')).toBe('MIT\ncopyright\n'); // --check wrote nothing
    } finally { fs.unlinkSync(patch); }
  }, 30_000);

  it('(n7) a genuinely divergent main edit is NOT alreadyApplied and still reports conflicts (a4 intact)', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'f.txt': 'l1\nl2\nl3\n' });
    fs.writeFileSync(path.join(wt, 'f.txt'), 'l1\nAGENT\nl3\n');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'l1\nHUMAN\nl3\n'); // main diverges, uncommitted
    const patch = await buildPatch(wt, baseSha, ['f.txt']);
    try {
      const pre = await preflight(repo, patch);
      expect(pre.ok).toBe(false);
      expect(pre.conflicts).toContain('f.txt');             // conflicts non-empty
      expect(await alreadyApplied(repo, patch)).toBe(false); // reverse --check fails -> genuine divergence
    } finally { fs.unlinkSync(patch); }
  }, 30_000);

  // -------------------------------------------------------------------------
  // S6d: the engine's own .origami/ artifacts (plan mode writes
  // .origami/plans/<ms>-<slug>.md) are NOT deliverable changes and must be
  // excluded from the change set everywhere it is computed - the listing AND the
  // badge stats. MODEL-authored files (an agent's own generated scripts) have
  // no reliable discriminator and stay in.
  // -------------------------------------------------------------------------

  it('(x1) .origami/ engine artifacts are excluded from diffFiles + the badge; model-authored check*.bat is not', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'seed.txt': 's\n' });
    fs.mkdirSync(path.join(wt, '.origami', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.origami', 'plans', 'x.md'), 'plan body\nmore\n'); // engine artifact (2 lines)
    fs.writeFileSync(path.join(wt, 'app.txt'), 'real work\n');                          // deliverable (1 line)
    fs.writeFileSync(path.join(wt, 'check_gate.bat'), 'echo gate\n');                    // model-authored (1 line)
    const paths = (await diffFiles(wt, baseSha)).map((f) => f.path).sort();
    expect(paths).toContain('app.txt');
    expect(paths).toContain('check_gate.bat');                        // model file NOT filtered
    expect(paths.some((p) => p.startsWith('.origami/'))).toBe(false);  // engine artifact excluded
    const stats = await readWorktreeStats(wt, baseSha);
    expect(stats.adds).toBe(2); // app.txt (1) + check_gate.bat (1); the 2 .origami lines excluded
    expect(stats.dels).toBe(0);
    void repo;
  }, 30_000);

  it('(x2) a plan-only run (only .origami/plans/*) shows NO deliverable changes on the card', async () => {
    const { repo, wt, baseSha } = await freshRepoWt({ 'seed.txt': 's\n' });
    fs.mkdirSync(path.join(wt, '.origami', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.origami', 'plans', 'y.md'), 'the plan\n');
    expect(await diffFiles(wt, baseSha)).toEqual([]); // 'no changes' — its plan stays readable via Chat
    const stats = await readWorktreeStats(wt, baseSha);
    expect(stats.adds).toBe(0);
    expect(stats.dels).toBe(0);
    void repo;
  }, 30_000);

  // -------------------------------------------------------------------------
  // S6d compare-screen defects: fileDiffs (the per-sibling per-file diff TEXT
  // the compare tab renders) must (a) NOT silently cut a normal-sized file diff
  // at the transport's 20KB stdout cap, and (b) render a renamed file as a
  // rename hunk that AGREES with its rename-aware +/- header, not a whole-file add.
  // -------------------------------------------------------------------------

  it('(rd1) fileDiffs captures a large (>20KB) file diff IN FULL, not silently cut at the transport cap', async () => {
    const { wt, baseSha } = await freshRepoWt({ 'big.txt': '' });
    // ~2000 lines * ~45 chars = ~90KB of real unified-diff text: a normal refactor
    // /generated-file change that sits BETWEEN the 20KB transport default and the
    // 200KB per-file cap. The bug returned ~20-28KB with truncated:false — an
    // incomplete diff that looked whole (the last lines simply gone).
    const body = Array.from({ length: 2000 }, (_, i) => `line ${String(i).padStart(5, '0')} padding text to add bytes here`).join('\n') + '\n';
    fs.writeFileSync(path.join(wt, 'big.txt'), body);
    const big = (await fileDiffs(wt, baseSha)).find((f) => f.path === 'big.txt')!;
    expect(big).toBeDefined();
    expect(big.text.length).toBeGreaterThan(50_000);  // well past the old 20KB cap
    expect(big.text).toContain('line 01999');          // the LAST line survived -> whole diff came through
    expect(big.truncated).toBe(false);                 // under 200KB -> not flagged
  }, 30_000);

  it('(rd2) fileDiffs flags a >200KB file diff as truncated (the honest notice the 20KB cap hid)', async () => {
    const { wt, baseSha } = await freshRepoWt({ 'huge.txt': '' });
    // >200KB of added text -> over PER_FILE_TEXT_CAP. The bug made `full` always
    // <=20KB, so `full.length > 200_000` was ALWAYS false: a genuinely oversized
    // diff showed as complete. Now it captures up to the cap and flags truncation.
    const body = Array.from({ length: 6000 }, (_, i) => `line ${i} sufficiently long padding to push the total well over two hundred kilobytes of diff text`).join('\n') + '\n';
    fs.writeFileSync(path.join(wt, 'huge.txt'), body);
    const huge = (await fileDiffs(wt, baseSha)).find((f) => f.path === 'huge.txt')!;
    expect(huge.truncated).toBe(true);
    expect(huge.text.length).toBeLessThanOrEqual(200_000);
    expect(huge.text.length).toBeGreaterThan(150_000); // captured up to the cap, not the old 20KB
  }, 30_000);

  it('(rd3) fileDiffs renders a renamed file as a rename hunk matching its +/- header, not a whole-file add', async () => {
    const { wt, baseSha } = await freshRepoWt({ 'old.txt': 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n' });
    // Real agent flow: rename on disk + append ONE line. numstat rename-detects ->
    // header is +1/-0. The TEXT must agree (rename hunk + the single appended line),
    // NOT all 13 lines as freshly added — the exact contradiction Passing saw.
    fs.rmSync(path.join(wt, 'old.txt'));
    fs.writeFileSync(path.join(wt, 'new.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13appended\n');
    const rec = (await fileDiffs(wt, baseSha)).find((f) => f.path === 'new.txt')!;
    expect(rec).toBeDefined();
    expect(rec.adds).toBe(1);                          // rename-aware header: one appended line
    expect(rec.dels).toBe(0);
    expect(rec.text).toContain('rename from old.txt'); // the TEXT agrees it is a rename
    expect(rec.text).toContain('rename to new.txt');
    expect(rec.text).toContain('+l13appended');        // the one real change
    expect(rec.text).not.toContain('+l5');             // an unchanged line is context, never an add
  }, 30_000);

  // -------------------------------------------------------------------------
  // S6d: the counts bug. Under core.autocrlf=true git prints per-file
  // "LF will be replaced by CRLF" warnings to STDERR; the merged runGit glued
  // them onto the front of stdout's first numstat token, so parseInt read the
  // warning text and the adds field silently became 0. runGitStdout separates
  // the streams; parseNumstatZ now SKIPS a non-numeric record instead of zeroing it.
  // -------------------------------------------------------------------------

  it('(cb1) runGitStdout yields clean numstat under real core.autocrlf stderr warnings (old merged path was contaminated)', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-crlf-'));
    made.push(repo);
    await runGit(['init', '-b', 'main'], repo);
    await runGit(['config', 'user.email', 't@origami.local'], repo);
    await runGit(['config', 'user.name', 'Origami'], repo);
    await runGit(['config', 'core.autocrlf', 'true'], repo); // the real UAT condition
    fs.writeFileSync(path.join(repo, 'app.txt'), 'a\nb\nc\n'); // LF endings
    await runGit(['add', 'app.txt'], repo);
    await runGit(['commit', '-m', 'seed'], repo);
    const base = (await runGit(['rev-parse', 'HEAD'], repo)).output.trim();
    fs.writeFileSync(path.join(repo, 'app.txt'), 'a\nB2\nc\nd\ne\n'); // b->B2, +d, +e = +3 -1 (autocrlf warns)

    // The OLD merged path: git's stderr warning is glued into the same string.
    const merged = await runGit(['diff', '--numstat', '-z', base], repo);
    // Only assert the red-check when this box actually emits the warning (it does
    // under autocrlf=true + an LF file, verified on Win git); skip otherwise.
    if (/warning:/i.test(merged.output)) {
      const oldParsed = parseNumstatZ(merged.output).find((f) => f.path === 'app.txt');
      expect(oldParsed).toBeUndefined(); // contaminated first field -> record skipped (was silently +0)
    }
    // The NEW plumbing: stdout only, so the numstat is pristine and the count survives.
    const clean = await runGitStdout(['diff', '--numstat', '-z', base], repo);
    expect(/warning:/i.test(clean.output)).toBe(false);
    const f = parseNumstatZ(clean.output).find((x) => x.path === 'app.txt');
    expect(f).toMatchObject({ adds: 3, dels: 1, binary: false }); // the real count survives
  }, 30_000);

  it('(cb2) parseNumstatZ SKIPS a stderr-contaminated record but keeps the clean ones (missing row, never a wrong number)', () => {
    const NUL = '\0', TAB = '\t';
    // A warning glued to the front of the first record's adds field, then a clean record.
    const contaminated =
      `warning: in the working copy of 'app.txt', LF will be replaced by CRLF\n25${TAB}4${TAB}app.txt${NUL}` +
      `3${TAB}1${TAB}ok.txt${NUL}`;
    const parsed = parseNumstatZ(contaminated);
    // app.txt's adds field is non-numeric -> the record is DROPPED (not reported as +0).
    expect(parsed.find((f) => f.path === 'app.txt')).toBeUndefined();
    // The uncontaminated record is unaffected.
    expect(parsed.find((f) => f.path === 'ok.txt')).toMatchObject({ adds: 3, dels: 1, binary: false });
    // A rename (numeric 0/0) is NOT mistaken for contamination.
    expect(parseNumstatZ(`0${TAB}0${TAB}${NUL}old.txt${NUL}new.txt${NUL}`)).toEqual([
      { path: 'new.txt', adds: 0, dels: 0, binary: false, oldPath: 'old.txt' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// ensureExcluded against a LINKED WORKTREE (.git is a FILE, not a directory)
// ---------------------------------------------------------------------------
// A registered repo may itself BE a linked worktree — Origami Coder is developed
// that way (origami-coder.wt/<branch>). Its `.git` is a one-line `gitdir: <path>`
// FILE, so `mkdir <root>/.git/info` cannot work: the parent is a file. The fix
// resolves the real git dir, then follows its `commondir` — verified below,
// writing the per-worktree gitdir's info/exclude does NOT suppress git status,
// because git maps `info/` onto the COMMON dir for every linked worktree.
describe('ensureExcluded on a linked worktree (.git as a file)', () => {
  let main: string;
  let wt: string;

  beforeAll(async () => {
    main = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-am-link-'));
    expect((await runGit(['init', '-b', 'main'], main)).ok).toBe(true);
    await runGit(['config', 'user.email', 'uat@origami.local'], main);
    await runGit(['config', 'user.name', 'Origami UAT'], main);
    fs.writeFileSync(path.join(main, 'hello.txt'), 'hello\n');
    expect((await runGit(['add', 'hello.txt'], main)).ok).toBe(true);
    expect((await runGit(['commit', '-m', 'seed'], main)).ok).toBe(true);
    wt = path.join(main, 'sibling');
    expect((await runGit(['worktree', 'add', '-b', 'linked', wt], main)).ok).toBe(true);
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true); // the precondition
  }, 30_000);

  afterAll(() => { try { fs.rmSync(main, { recursive: true, force: true }); } catch { /* temp */ } });

  it('writes the exclude lines where git actually reads them, and git status obeys them', async () => {
    // Untracked worktree spoil the linked checkout would otherwise report.
    fs.mkdirSync(path.join(wt, '.origami', 'worktrees'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.origami', 'worktrees', 'placeholder'), 'x\n');
    expect((await runGit(['status', '--porcelain'], wt)).output).toContain('.origami');

    ensureExcluded(wt); // must not throw on a .git FILE
    ensureExcluded(wt); // idempotent

    // The OBSERVABLE requirement: the linked worktree's status no longer sees it.
    expect((await runGit(['status', '--porcelain'], wt)).output).not.toContain('.origami');
    const exclude = fs.readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/\.origami\/worktrees\//g)).toHaveLength(1); // written once, not twice
  }, 30_000);

  it('resolveGitDir returns the dir itself for a normal clone and the COMMON dir for a linked worktree', () => {
    expect(path.resolve(resolveGitDir(main))).toBe(path.resolve(path.join(main, '.git')));
    expect(path.resolve(resolveGitDir(wt))).toBe(path.resolve(path.join(main, '.git')));
    // An unreadable / non-git dir degrades to <root>/.git rather than throwing.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-am-plain-'));
    expect(path.resolve(resolveGitDir(plain))).toBe(path.resolve(path.join(plain, '.git')));
    fs.rmSync(plain, { recursive: true, force: true });
  });

  it('a RELATIVE gitdir pointer (the submodule shape) resolves against the root', () => {
    const host = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-am-rel-'));
    fs.mkdirSync(path.join(host, 'modules', 'sub', 'info'), { recursive: true });
    fs.mkdirSync(path.join(host, 'sub'));
    fs.writeFileSync(path.join(host, 'sub', '.git'), 'gitdir: ../modules/sub\n');
    expect(path.resolve(resolveGitDir(path.join(host, 'sub'))))
      .toBe(path.resolve(path.join(host, 'modules', 'sub')));
    ensureExcluded(path.join(host, 'sub'));
    expect(fs.readFileSync(path.join(host, 'modules', 'sub', 'info', 'exclude'), 'utf8'))
      .toContain('.origami/worktrees/');
    fs.rmSync(host, { recursive: true, force: true });
  });
});
