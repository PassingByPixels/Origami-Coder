// Folds board — "merged" read from GIT, not only from the board's own Apply.
// Real work in this repo is done in a HAND-CUT worktree on a lane branch and
// merged into the primary by hand; the board never saw it, so 103 of 111 merged
// branches showed a Merged column of 0. These tests run against REAL temp git
// repos with REAL merges: the assertions are ticket-file bytes and git's own
// branch list, never that a function was called.

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorktree, runGit } from '../../../src/dashboard/agentManager/worktrees';
import { loadState, saveState } from '../../../src/dashboard/agentManager/state';
import { reconcileMergedTickets } from '../../../src/dashboard/agentManager/ticketMerges';
import { ticketPath } from '../../../src/dashboard/agentManager/tickets';

const made: string[] = [];
afterAll(() => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
});

async function makeRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-tm-'));
  made.push(dir);
  expect((await runGit(['init', '-b', 'master'], dir)).ok).toBe(true);
  await runGit(['config', 'user.email', 't@origami.local'], dir);
  await runGit(['config', 'user.name', 'Origami'], dir);
  fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
  await runGit(['add', 'app.txt'], dir);
  expect((await runGit(['commit', '-m', 'seed'], dir)).ok).toBe(true);
  return dir;
}

/** A ticket file exactly as a quick-add writes one, plus a hand-added key this
 *  layer knows nothing about — a stamp that ate it would be silent data loss. */
function writeTicket(repo: string, id: string, status: string, branch = ''): string {
  const file = ticketPath(repo, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '---', `id: ${id}`, 'title: A thing to do', `status: ${status}`,
    'priority: normal', 'created: 2026-09-01T10:00:00Z', 'updated: 2026-09-01T10:00:00Z',
    `branch: ${branch || "''"}`, 'owner: jane_doe', '---', '',
    'Body prose.', '', '## Log', '', '- 2026-09-01T10:00:00Z folds: created via quick-add', '',
  ].join('\n'));
  return file;
}

/** Cut a branch off HEAD, commit one file on it, come back — optionally merging
 *  it by hand. No worktree and no record: the hand-cut lane the board never saw. */
async function landBranch(repo: string, branch: string, file: string, merge: boolean): Promise<void> {
  expect((await runGit(['checkout', '-b', branch], repo)).ok).toBe(true);
  fs.writeFileSync(path.join(repo, file), 'work\n');
  await runGit(['add', file], repo);
  expect((await runGit(['commit', '-m', `work on ${branch}`], repo)).ok).toBe(true);
  expect((await runGit(['checkout', 'master'], repo)).ok).toBe(true);
  if (merge) expect((await runGit(['merge', '--no-ff', '--no-edit', branch], repo)).ok).toBe(true);
}

const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('reconcileMergedTickets (real git)', () => {
  it('(t1) a hand-cut lane branch merged into master stamps its ticket merged, once', async () => {
    const repo = await makeRepo();
    const file = writeTicket(repo, 't-ab12cd', 'todo');
    await landBranch(repo, 'lane/t-ab12cd-thing', 'thing.txt', true);

    expect(await reconcileMergedTickets(repo)).toBe(true);
    const after = read(file);
    expect(after).toContain('status: merged');
    expect(after).toContain('branch: lane/t-ab12cd-thing');
    expect(after).toContain('merged into master (seen by the board)'); // the Log line
    expect(after).toContain('owner: jane_doe');                         // unknown key survived

    // The 5s poll runs this forever: a second pass must not rewrite the file.
    expect(await reconcileMergedTickets(repo)).toBe(false);
    expect(read(file)).toBe(after);
  }, 30_000);

  it('(t2) the same branch NOT merged leaves the ticket alone', async () => {
    const repo = await makeRepo();
    const file = writeTicket(repo, 't-ab12cd', 'todo');
    const before = read(file);
    await landBranch(repo, 'lane/t-ab12cd-thing', 'thing.txt', false);
    expect(await reconcileMergedTickets(repo)).toBe(false);
    expect(read(file)).toBe(before);
  }, 30_000);

  it('(t3) a closed ticket whose branch merged stays closed (never resurrected)', async () => {
    const repo = await makeRepo();
    const file = writeTicket(repo, 't-cl0sed', 'closed');
    const before = read(file);
    await landBranch(repo, 'lane/t-cl0sed-done', 'done.txt', true);
    expect(await reconcileMergedTickets(repo)).toBe(false);
    expect(read(file)).toBe(before);
  }, 30_000);

  it('(t4) an explicit `branch:` with no id in its name is stamped from the frontmatter', async () => {
    const repo = await makeRepo();
    const file = writeTicket(repo, 't-xy99zz', 'in_progress', 'feature/x');
    await landBranch(repo, 'feature/x', 'x.txt', true);
    expect(await reconcileMergedTickets(repo)).toBe(true);
    const after = read(file);
    expect(after).toContain('status: merged');
    expect(after).toContain('branch: feature/x');
  }, 30_000);

  it('(t5) a detached primary changes nothing and does not throw', async () => {
    const repo = await makeRepo();
    const file = writeTicket(repo, 't-ab12cd', 'todo');
    await landBranch(repo, 'lane/t-ab12cd-thing', 'thing.txt', true);
    const head = (await runGit(['rev-parse', 'HEAD'], repo)).output.trim();
    expect((await runGit(['checkout', '--detach', head], repo)).ok).toBe(true);
    const before = read(file);
    expect(await reconcileMergedTickets(repo)).toBe(false);
    expect(read(file)).toBe(before);
  }, 30_000);

  it('(t6) a FOLD record whose origami/ branch was merged by hand: record + ticket both stamped', async () => {
    const repo = await makeRepo();
    const file = writeTicket(repo, 't-f01dee', 'in_progress');
    const created = await createWorktree(repo, 't-f01dee-fold');
    fs.writeFileSync(path.join(created.path, 'fold.txt'), 'from the fold\n');
    await runGit(['add', 'fold.txt'], created.path);
    expect((await runGit(['commit', '-m', 'fold work'], created.path)).ok).toBe(true);
    const st = loadState(repo);
    st.worktrees.push({
      id: 'w-f6', name: created.name, branch: created.branch, path: created.path,
      baseSha: created.baseSha, createdAt: Date.now(), sessions: [], ticketId: 't-f01dee',
    });
    saveState(repo, st);
    // The human merges the fold's branch themselves — the board's Apply never ran.
    expect((await runGit(['merge', '--no-ff', '--no-edit', created.branch], repo)).ok).toBe(true);

    expect(await reconcileMergedTickets(repo)).toBe(true);
    expect(loadState(repo).worktrees.find((r) => r.id === 'w-f6')!.merged).toEqual({ at: expect.any(Number) });
    const after = read(file);
    expect(after).toContain('status: merged');
    expect(after).toContain(`branch: ${created.branch}`);
    expect(after).toContain('merged into master by hand');
    expect(after).toContain('fold: w-f6');
    // Idempotent through the record path too.
    expect(await reconcileMergedTickets(repo)).toBe(false);
    expect(read(file)).toBe(after);
  }, 30_000);
  it('(t7) a fold that has produced NOTHING is not "merged" just because its branch was cut from HEAD', async () => {
    // `git branch --merged HEAD` lists a freshly cut branch (its tip IS an
    // ancestor of HEAD), so the naive read stamps a still-running fold merged the
    // first time the 5s poll fires. Nothing has landed until the branch has a
    // commit of its own past the base it was cut from.
    const repo = await makeRepo();
    const file = writeTicket(repo, 't-l1vef0', 'in_progress');
    const created = await createWorktree(repo, 't-l1vef0-fold'); // no commit in it
    const st = loadState(repo);
    st.worktrees.push({
      id: 'w-live', name: created.name, branch: created.branch, path: created.path,
      baseSha: created.baseSha, createdAt: Date.now(), sessions: [], ticketId: 't-l1vef0',
    });
    saveState(repo, st);
    const before = read(file);
    expect(await reconcileMergedTickets(repo)).toBe(false);
    expect(read(file)).toBe(before);                                            // ticket untouched
    expect(loadState(repo).worktrees.find((r) => r.id === 'w-live')!.merged).toBeUndefined();
  }, 30_000);

  it('(t8) a hand-cut lane is stamped when it LANDS, never when it is merely cut from master', async () => {
    // The desk flow: create the ticket, then
    // `git worktree add -b lane/t-<id>-<slug> ../<slug> master`. That branch's
    // tip IS master's tip, so `git branch --merged HEAD` lists it from birth —
    // and it has no record and no baseSha, so the fold rule cannot save it.
    const repo = await makeRepo();
    const file = writeTicket(repo, 't-l4ne00', 'todo');
    const before = read(file);
    const lane = path.join(path.dirname(repo), `${path.basename(repo)}-lane`);
    made.push(lane);
    expect((await runGit(['worktree', 'add', '-b', 'lane/t-l4ne00-thing', lane, 'master'], repo)).ok).toBe(true);

    // 1. Freshly cut, no work: nothing has landed.
    expect(await reconcileMergedTickets(repo)).toBe(false);
    expect(read(file)).toBe(before);

    // 2. master moves on. The lane pointer is now an OLDER ancestor of HEAD —
    //    still on the first-parent chain, still nothing landed.
    fs.writeFileSync(path.join(repo, 'app.txt'), 'v2\n');
    expect((await runGit(['commit', '-am', 'master moves on'], repo)).ok).toBe(true);
    expect(await reconcileMergedTickets(repo)).toBe(false);
    expect(read(file)).toBe(before);

    // 3. Real work on the lane, merged --no-ff: the tip is now OFF the
    //    first-parent chain, which is what landing looks like.
    fs.writeFileSync(path.join(lane, 'lane.txt'), 'lane work\n');
    await runGit(['add', 'lane.txt'], lane);
    expect((await runGit(['commit', '-m', 'lane work'], lane)).ok).toBe(true);
    expect((await runGit(['merge', '--no-ff', '--no-edit', 'lane/t-l4ne00-thing'], repo)).ok).toBe(true);
    expect(await reconcileMergedTickets(repo)).toBe(true);
    const after = read(file);
    expect(after).toContain('status: merged');
    expect(after).toContain('branch: lane/t-l4ne00-thing');
  }, 30_000);

  it('(t9) a lane landed by FAST-FORWARD is not stamped — the documented limitation', async () => {
    const repo = await makeRepo();
    const file = writeTicket(repo, 't-ff0001', 'todo');
    const before = read(file);
    await landBranch(repo, 'lane/t-ff0001-thing', 'ff.txt', false); // committed, not merged
    expect((await runGit(['merge', '--ff-only', 'lane/t-ff0001-thing'], repo)).ok).toBe(true);
    // The work IS in master, but the lane tip is master's tip — on the
    // first-parent chain, byte-identical to a pointer that never moved. The
    // poller cannot tell them apart, so it declines rather than guess.
    expect(await reconcileMergedTickets(repo)).toBe(false);
    expect(read(file)).toBe(before);
  }, 30_000);
});
