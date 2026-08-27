// Folds board — the extension-host ticket layer (contract §2/§3/§5). The ticket
// FILE is the truth, so these tests assert real bytes on a real temp dir: a
// rewrite that drops a hand-added frontmatter key, an acceptance count that
// disagrees with the checkboxes, or a fold delete that strands its ticket in
// "in progress" are all silent data loss, not a rendering bug.
//
// The lifecycle half runs the REAL AgentManager against a REAL git repo (the
// agentManager.test.ts pattern) with only ManagerHost faked — a launch that
// links a ticket to a fold and a delete that hands it back are the two edges
// that cannot be proved by unit-testing the store alone.

import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentManager, type ManagerHost, type Runtime } from '../../../src/dashboard/agentManager/manager';
import { runGit, sanitizeWorktreeName } from '../../../src/dashboard/agentManager/worktrees';
import { loadState } from '../../../src/dashboard/agentManager/state';
import {
  acceptance, activityLine, boardTickets, closeTicket, launchName, launchPrompt, listTickets,
  newTicketId, parseTicket, quickAdd, resetTicketWatch, scalar, serializeTicket, stampActivity,
  ticketPath, ticketRow, ticketsChanged, unlinkTicket,
} from '../../../src/dashboard/agentManager/tickets';
import { primaryFor, readRepoFile, repoFilePath, syncRepoFile, writeRepoFile } from '../../../src/dashboard/agentManager/repoFile';
import { adoptRoots, mergeRepoFile, primaryRoot, setPrimary } from '../../../src/dashboard/agentManager/repoMerge';

const made: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
});
beforeEach(() => { resetTicketWatch(); });

/** A ticket exactly as contract §2 draws it, plus TWO keys this layer knows
 *  nothing about — the whole point of the round-trip assertions below. */
const SAMPLE = [
  '---',
  'id: t-8k2fq1',
  'title: Scroll block needs a max-width',
  'status: todo',
  'priority: high',
  'labels: [ui, layout]',
  "assignee: ''",
  'created: 2026-08-06T10:00:00Z',
  'updated: 2026-08-06T10:00:00Z',
  "fold: ''",
  "branch: ''",
  'blocked-by: [t-aaa111]',
  'owner: passing',
  '---',
  '',
  'The scroll block runs edge to edge on a wide window.',
  '',
  '## Acceptance',
  '',
  '- [x] block never exceeds 720px',
  '- [ ] centred at every width',
  '- [ ] no horizontal scrollbar',
  '',
  '## Log',
  '',
  '- 2026-08-06T10:05:00Z passing: created via quick-add',
  '',
].join('\n');

/** A ticket written by the SLIM template (§12 item 5): only id/title/status/
 *  priority/created/updated + body — no labels/assignee/fold/branch line ever
 *  existed. `owner` is a hand-added key this layer has never heard of, the
 *  same role SAMPLE's `blocked-by`/`owner` play above. */
const MINIMAL = [
  '---',
  'id: t-min001',
  'title: Minimal ticket, no scaffolding',
  'status: todo',
  'priority: normal',
  'created: 2026-08-06T09:00:00Z',
  'updated: 2026-08-06T09:00:00Z',
  'owner: passing',
  '---',
  '',
  'Body prose only.',
  '',
  '## Acceptance',
  '',
  '- [x] one thing',
  '- [ ] another',
  '',
].join('\n');

function seedTicket(repoRoot: string, id: string, text: string): string {
  const file = ticketPath(repoRoot, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

describe('ticket file — parse/serialize round-trip', () => {
  it('serializes back to the exact original bytes', () => {
    const t = parseTicket(SAMPLE, 'C:/x/.origami/tickets/t-8k2fq1.md');
    expect(t.malformed).toBe(false);
    expect(t.id).toBe('t-8k2fq1');
    expect(serializeTicket(t)).toBe(SAMPLE);
  });

  it('a lifecycle write keeps UNKNOWN frontmatter keys and the whole body', () => {
    const repo = tempDir('origami-tix-rt-');
    seedTicket(repo, 't-8k2fq1', SAMPLE);
    unlinkTicket(repo, 't-8k2fq1', 'fold deleted before it was applied', Date.parse('2026-08-07T09:00:00Z'));
    const after = fs.readFileSync(ticketPath(repo, 't-8k2fq1'), 'utf8');
    const t = parseTicket(after, ticketPath(repo, 't-8k2fq1'));
    // The two keys this layer has never heard of survive verbatim...
    expect(scalar(t.fm, 'blocked-by')).toBe('[t-aaa111]');
    expect(scalar(t.fm, 'owner')).toBe('passing');
    // ...as do the body's prose and its acceptance boxes...
    expect(t.body).toContain('The scroll block runs edge to edge on a wide window.');
    expect(acceptance(t.body)).toEqual({ done: 1, total: 3 });
    // ...while the fields the stamp owns really moved.
    expect(scalar(t.fm, 'status')).toBe('todo');
    expect(scalar(t.fm, 'fold')).toBe('');
    expect(scalar(t.fm, 'updated')).toBe('2026-08-07T09:00:00.000Z');
    expect(after).toContain('folds: fold deleted before it was applied');
    // The new log line lands INSIDE the existing Log section, under the old one.
    const lines = after.split('\n');
    expect(lines.indexOf('## Log')).toBeLessThan(lines.findIndex((l) => l.includes('fold deleted')));
  });

  it('acceptance counts only the Acceptance section, and stops at the next heading', () => {
    expect(acceptance(SAMPLE)).toEqual({ done: 1, total: 3 });
    expect(acceptance('## Acceptance\n\n- [x] one\n\n## Log\n\n- [ ] not a criterion\n')).toEqual({ done: 1, total: 1 });
    expect(acceptance('no sections here\n- [ ] loose box\n')).toEqual({ done: 0, total: 0 });
  });
});

describe('ticket file — minimal-format template (§12 item 5)', () => {
  it('parses, defaults every omitted key, and counts a body-only Acceptance section', () => {
    const t = parseTicket(MINIMAL, 'C:/x/.origami/tickets/t-min001.md');
    expect(t.malformed).toBe(false); // id + title present is all malformed requires
    expect(scalar(t.fm, 'owner')).toBe('passing'); // the hand-added key still reads
    const row = ticketRow(t);
    expect(row).toMatchObject({
      id: 't-min001', title: 'Minimal ticket, no scaffolding', status: 'todo',
      priority: 'normal', labels: [], assignee: '', fold: '', branch: '',
    });
    expect(row.acceptance).toEqual({ done: 1, total: 2 });
  });

  it('the launch prompt composes from a minimal ticket with no dependency on the omitted lines', () => {
    const t = parseTicket(MINIMAL, 'C:/x/t-min001.md');
    const p = launchPrompt(t);
    expect(p.startsWith('Minimal ticket, no scaffolding')).toBe(true);
    expect(p).toContain('Body prose only.');
    expect(p).toContain('- [ ] another');
    expect(p).toContain('board_update');
    // No repo name given, no repo line: the prompt never GUESSES which board it is on.
    expect(p).not.toContain('Folds board.');
  });
});

describe('ticket file — hostile and hand-edited input', () => {
  it('a CRLF hand edit parses, keeps every field, and normalizes to LF on rewrite', () => {
    const repo = tempDir('origami-tix-crlf-');
    seedTicket(repo, 't-8k2fq1', SAMPLE.replace(/\n/g, '\r\n'));
    const before = boardTickets(repo)[0];
    expect(before).toMatchObject({ id: 't-8k2fq1', status: 'todo', priority: 'high' });
    expect(before.acceptance).toEqual({ done: 1, total: 3 });
    unlinkTicket(repo, 't-8k2fq1', 'normalised');
    const after = fs.readFileSync(ticketPath(repo, 't-8k2fq1'), 'utf8');
    expect(after).not.toContain('\r');
    expect(after).toContain('owner: passing');
    expect(acceptance(after)).toEqual({ done: 1, total: 3 });
  });

  it('an id with path separators can never reach a file outside the tickets dir', () => {
    const repo = tempDir('origami-tix-esc-');
    const outside = path.join(repo, 'secret.md');
    fs.writeFileSync(outside, '---\nid: secret\ntitle: nope\n---\n');
    seedTicket(repo, 't-8k2fq1', SAMPLE);
    for (const bad of ['../secret', '..\\secret', '../../etc/passwd', 'sub/t-8k2fq1', '']) {
      closeTicket(repo, bad);           // a stamp must not rewrite it...
      unlinkTicket(repo, bad, 'nope');  // ...on any of the mutation paths
    }
    expect(fs.readFileSync(outside, 'utf8')).toBe('---\nid: secret\ntitle: nope\n---\n');
    expect(boardTickets(repo)[0].status).toBe('todo'); // the real ticket is untouched too
  });
});

describe('ticket file — malformed', () => {
  it('surfaces a warning row and REFUSES to rewrite the file', () => {
    const repo = tempDir('origami-tix-bad-');
    const junk = 'this file has no frontmatter at all\n';
    seedTicket(repo, 't-broken', junk);
    const rows = boardTickets(repo);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 't-broken', malformed: true });
    closeTicket(repo, 't-broken');
    expect(fs.readFileSync(ticketPath(repo, 't-broken'), 'utf8')).toBe(junk);
  });
});

describe('quick-add', () => {
  it('lands a raw idea in Triage with a parseable t- id', () => {
    const repo = tempDir('origami-tix-add-');
    const id = quickAdd(repo, 'Scroll block needs a max-width');
    expect(id).toMatch(/^t-[0-9a-z]{6}$/);
    const rows = boardTickets(repo);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id, title: 'Scroll block needs a max-width', status: 'triage',
      priority: 'normal', assignee: '', fold: '', branch: '',
    });
    expect(rows[0].acceptance).toEqual({ done: 0, total: 0 }); // no acceptance yet -> triage, not todo
    expect(rows[0].malformed).toBeUndefined();
    expect(newTicketId(0)).not.toBe(newTicketId(0)); // the 2 random chars keep same-ms ids apart
    // Slim template (§12 item 5): the row's defaults above come from the PARSER,
    // not from blank lines quick-add pre-writes - none of these keys is on disk.
    const raw = fs.readFileSync(ticketPath(repo, id), 'utf8');
    expect(raw).not.toContain('labels:');
    expect(raw).not.toContain('assignee:');
    expect(raw).not.toContain('fold:');
    expect(raw).not.toContain('branch:');
  });

  it('writes the tasks field as the ticket BODY, and a title-only add is unchanged', () => {
    const repo = tempDir('origami-tix-body-');
    const body = 'Cap the block at 720px.\n\n- the hero row too\n- and the footer';
    const withBody = quickAdd(repo, 'Scroll block needs a max-width', body);
    const titleOnly = quickAdd(repo, 'Just the idea');

    const t = parseTicket(fs.readFileSync(ticketPath(repo, withBody), 'utf8'), ticketPath(repo, withBody));
    expect(t.malformed).toBe(false);
    expect(t.body).toContain('Cap the block at 720px.');
    expect(t.body).toContain('- and the footer'); // the multiline textarea rides verbatim
    // The body sits ABOVE the Log section, so the first stamp appends under the
    // log rather than in the middle of what the user typed.
    const text = fs.readFileSync(ticketPath(repo, withBody), 'utf8');
    expect(text.indexOf('Cap the block at 720px.')).toBeLessThan(text.indexOf('## Log'));
    expect(acceptance(t.body)).toEqual({ done: 0, total: 0 }); // tasks are not acceptance -> still Triage
    expect(boardTickets(repo).find((r) => r.id === withBody)?.status).toBe('triage');
    // An empty body leaves the file byte-identical to what quick-add always wrote:
    // exactly the six slim keys, in order, then straight to Log with no prose gap.
    const plain = fs.readFileSync(ticketPath(repo, titleOnly), 'utf8');
    expect(plain).toMatch(/^---\nid: .+\ntitle: .+\nstatus: triage\npriority: normal\ncreated: .+\nupdated: .+\n---\n\n## Log\n/);
  });

  it('closeTicket hides it without deleting the file', () => {
    const repo = tempDir('origami-tix-close-');
    const id = quickAdd(repo, 'Nope');
    closeTicket(repo, id);
    expect(boardTickets(repo)[0].status).toBe('closed');
    expect(fs.existsSync(ticketPath(repo, id))).toBe(true);
  });
});

describe('launch naming + prompt', () => {
  it('puts the id FIRST so the 40-char sanitize cap eats the slug tail, never the id', () => {
    const long = 'a scroll block that never exceeds seven hundred and twenty pixels wide';
    const raw = launchName('t-8k2fq1', long);
    expect(raw).toBe('t-8k2fq1-a-scroll-block-that-never-ex');
    // The claim that matters: the REAL worktree sanitizer (40-char cap) still
    // leaves the id whole, so the fold's dir/branch name links back to the ticket.
    expect(sanitizeWorktreeName(raw).startsWith('t-8k2fq1-')).toBe(true);
    expect(sanitizeWorktreeName(`${raw}-4`).startsWith('t-8k2fq1-')).toBe(true); // race sibling suffix
    expect(launchName('t-8k2fq1', 'Max width!')).toBe('t-8k2fq1-max-width');
  });

  it('the prompt carries the title, the body and the acceptance list verbatim', () => {
    const t = parseTicket(SAMPLE, 'C:/x/t-8k2fq1.md');
    const p = launchPrompt(t);
    expect(p.startsWith('Scroll block needs a max-width')).toBe(true);
    expect(p).toContain('- [x] block never exceeds 720px');
    expect(p).toContain('- [ ] no horizontal scrollbar');
    expect(p).toContain('board_update');
    expect(p).toContain('t-8k2fq1');
  });

  it('names the repo the ticket belongs to, on its own line right after the title', () => {
    // A fold session's cwd is a worktree named after the TICKET, so without this
    // line the agent has to infer which board its board_update lands on.
    const p = launchPrompt(parseTicket(SAMPLE, 'C:/x/t-8k2fq1.md'), 'origami-coder');
    expect(p.split('\n\n')[0]).toBe('Scroll block needs a max-width');
    expect(p.split('\n\n')[1]).toBe('This ticket is on the "origami-coder" Folds board.');
    // ...and it is an ADDITION: everything the prompt already carried is intact.
    expect(p).toContain('- [x] block never exceeds 720px');
    expect(p).toContain('board_update');
  });
});

describe('ticket-dir change detection (the 5s poll)', () => {
  it('reports the first look, then only real CONTENT changes', () => {
    const repo = tempDir('origami-tix-hash-');
    expect(ticketsChanged(repo)).toBe(true);   // first look: paint the board
    expect(ticketsChanged(repo)).toBe(false);
    const id = quickAdd(repo, 'One');
    expect(ticketsChanged(repo)).toBe(true);
    expect(ticketsChanged(repo)).toBe(false);
    // Same byte COUNT, different bytes, same millisecond: an mtime/size check
    // would miss this; the board must not.
    const file = ticketPath(repo, id);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: triage', 'status: closed'));
    expect(ticketsChanged(repo)).toBe(true);
  });
});

describe('live activity line', () => {
  it('collapses whitespace and clamps to 120, head for a title and tail for a thought', () => {
    expect(activityLine('  Read \n  foo.ts ')).toBe('Read foo.ts');
    const long = 'x'.repeat(300);
    expect(activityLine(long).length).toBe(120);
    expect(activityLine(long, 'tail').length).toBe(120);
    expect(activityLine(`start ${'y'.repeat(300)} end`, 'tail').endsWith('end')).toBe(true);
    expect(activityLine(`start ${'y'.repeat(300)} end`).startsWith('start ')).toBe(true);
  });

  it('stamps the fold that owns the session, no-ops any other, and throttles the broadcast', () => {
    const runtime = new Map<string, Runtime>([
      ['w-a', { state: 'working', sessionId: 's-a' }],
      ['w-b', { state: 'working', sessionId: 's-b' }],
    ]);
    expect(stampActivity(runtime, 's-a', 'Read foo.ts', 10_000)).toBe(true);
    expect(runtime.get('w-a')?.activity).toBe('Read foo.ts');
    expect(runtime.get('w-b')?.activity).toBeUndefined();
    // Inside the 2s window: NO broadcast, but the value is still current.
    expect(stampActivity(runtime, 's-a', 'Write bar.ts', 10_500)).toBe(false);
    expect(runtime.get('w-a')?.activity).toBe('Write bar.ts');
    expect(stampActivity(runtime, 's-a', 'Run tests', 13_000)).toBe(true);
    // A session the manager does not own (the user's own chat) never lands.
    expect(stampActivity(runtime, 's-unknown', 'Read secret.ts', 20_000)).toBe(false);
    expect([...runtime.values()].some((r) => r.activity === 'Read secret.ts')).toBe(false);
  });
});

describe('repos.json (contract §3)', () => {
  it('composes workspace + known and writes the shape atomically', () => {
    const home = tempDir('origami-home-');
    const ws = tempDir('origami-repo-ws-');
    const other = tempDir('origami-repo-b-');
    for (const r of [ws, other]) fs.mkdirSync(path.join(r, '.git'), { recursive: true });

    syncRepoFile(ws, [other], home);
    const file = repoFilePath(home);
    const doc = readRepoFile(file);
    expect(doc?.version).toBe(1);
    expect(doc?.repos.map((r) => ({ root: r.root, name: r.name, workspace: r.workspace }))).toEqual([
      { root: ws, name: path.basename(ws), workspace: true },
      { root: other, name: path.basename(other), workspace: false },
    ]);
    expect(doc?.repos.every((r) => r.addedAt > 0)).toBe(true);
    // Atomic write leaves no tmp file behind for a reader to trip over.
    expect(fs.readdirSync(path.join(home, '.origami')).filter((f) => f.includes('.tmp-'))).toEqual([]);

    // A rewrite must not re-date a repo that was already registered.
    const firstAdded = doc?.repos[1].addedAt ?? 0;
    const third = tempDir('origami-repo-c-');
    fs.mkdirSync(path.join(third, '.git'), { recursive: true });
    syncRepoFile(ws, [other, third], home);
    const doc2 = readRepoFile(file);
    expect(doc2?.repos).toHaveLength(3);
    expect(doc2?.repos[1].addedAt).toBe(firstAdded);
  });

  it('a missing home entry is not an error and a corrupt file is replaced, never merged', () => {
    expect(readRepoFile(path.join(tempDir('origami-home-empty-'), 'nope.json'))).toBeUndefined();
    expect(mergeRepoFile([], undefined, 5).repos).toEqual([]);
    expect(mergeRepoFile([{ root: 'C:\\a', name: 'a', workspace: false }], undefined, 5))
      .toEqual({ version: 1, repos: [{ root: 'C:\\a', name: 'a', workspace: false, addedAt: 5 }] });
  });

  it('a displayName override rides into the written file keyed by root, and is omitted when unset', () => {
    // 4th positional arg — `home` (3rd) must keep working with it OMITTED, the
    // existing call above relies on that.
    expect(mergeRepoFile([{ root: 'C:\\a', name: 'a', workspace: false }], undefined, 5, { 'C:\\a': 'Pretty A' }))
      .toEqual({ version: 1, repos: [{ root: 'C:\\a', name: 'a', workspace: false, addedAt: 5, displayName: 'Pretty A' }] });

    const home = tempDir('origami-home-disp-');
    const ws = tempDir('origami-repo-ws2-');
    const other = tempDir('origami-repo-b2-');
    for (const r of [ws, other]) fs.mkdirSync(path.join(r, '.git'), { recursive: true });
    syncRepoFile(ws, [other], home, { [other]: 'Pretty B' });
    const doc = readRepoFile(repoFilePath(home));
    expect(doc?.repos.find((r) => r.root === other)?.displayName).toBe('Pretty B');
    expect(doc?.repos.find((r) => r.root === ws)?.displayName).toBeUndefined(); // no override -> key absent
  });
});

// ---------------------------------------------------------------------------
// repos.json is a SHARED file (the engine's board_register writes it too)
// ---------------------------------------------------------------------------
// The old composeRepoFile REBUILT repos[] from the extension's own known list,
// so anything it did not know about — a foreign entry, a hand-added key, a
// primary pointer — was silently dropped on the next sync. The merge rule: key
// by root (case-insensitively on Windows), change only the entries this
// operation touches, and carry every other entry AND every unknown field
// through verbatim.
describe('repos.json — the MERGE model (a shared file, not an extension mirror)', () => {
  const entry = (root: string, name = path.basename(root)) => ({ root, name, workspace: false });

  it('a foreign entry the extension has never seen survives a sync, with its unknown fields', () => {
    const prior = {
      version: 1 as const,
      repos: [
        { root: 'C:\\known', name: 'known', workspace: false, addedAt: 1, note: 'hand added' },
        { root: 'C:\\foreign', name: 'foreign', workspace: false, addedAt: 2, source: 'board_register' },
      ],
    };
    const merged = mergeRepoFile([entry('C:\\known')], prior, 99);
    expect(merged.repos.map((r) => r.root)).toEqual(['C:\\known', 'C:\\foreign']);
    // The foreign entry rides through BYTE-identical, unknown key included.
    expect(merged.repos[1]).toEqual(prior.repos[1]);
    // ...and a hand-added key on an entry the extension DOES rewrite survives too.
    expect((merged.repos[0] as Record<string, unknown>).note).toBe('hand added');
    expect(merged.repos[0].addedAt).toBe(1); // never re-dated
  });

  it('primary survives a sync that never mentions it; displayName survives an OMITTED overlay', () => {
    const prior = {
      version: 1 as const,
      repos: [{ root: 'C:\\a', name: 'a', workspace: false, addedAt: 1, primary: 'C:\\a\\main', displayName: 'Pretty A' }],
    };
    // 4th arg omitted: the extension is not speaking about display names at all.
    const kept = mergeRepoFile([entry('C:\\a')], prior, 99);
    expect(kept.repos[0]).toMatchObject({ primary: 'C:\\a\\main', displayName: 'Pretty A' });
    // An overlay that OMITS this root is the extension clearing the override —
    // primary is not the extension's to clear, so it still rides through.
    const cleared = mergeRepoFile([entry('C:\\a')], prior, 99, {});
    expect(cleared.repos[0].displayName).toBeUndefined();
    expect(cleared.repos[0].primary).toBe('C:\\a\\main');
  });

  it('keys case-insensitively on Windows, so a differently-cased root is ONE entry', () => {
    const prior = { version: 1 as const, repos: [{ root: 'C:\\Repos\\App', name: 'App', workspace: false, addedAt: 7, primary: 'C:\\Repos\\App\\wt' }] };
    const merged = mergeRepoFile([entry(process.platform === 'win32' ? 'c:\\repos\\app' : 'C:\\Repos\\App', 'App')], prior, 99);
    expect(merged.repos).toHaveLength(1);
    expect(merged.repos[0].addedAt).toBe(7);
    expect(merged.repos[0].primary).toBe('C:\\Repos\\App\\wt');
  });

  it('setPrimary writes ONE entry and leaves every other entry and field untouched', () => {
    const prior = {
      version: 1 as const,
      repos: [
        { root: 'C:\\a', name: 'a', workspace: false, addedAt: 1, note: 'keep' },
        { root: 'C:\\b', name: 'b', workspace: false, addedAt: 2 },
      ],
    };
    const out = setPrimary(prior, 'C:\\a', 'C:\\a\\wt\\feature');
    expect(out.repos[0]).toEqual({ root: 'C:\\a', name: 'a', workspace: false, addedAt: 1, note: 'keep', primary: 'C:\\a\\wt\\feature' });
    expect(out.repos[1]).toEqual(prior.repos[1]);
    // Pointing primary back at the root itself DROPS the field (absent = root).
    expect(setPrimary(out, 'C:\\a', 'C:\\a').repos[0].primary).toBeUndefined();
    // An unknown root is a no-op, never a new entry.
    expect(setPrimary(prior, 'C:\\nope', 'C:\\nope\\x').repos).toEqual(prior.repos);
  });

  it('primaryRoot falls back to the entry root when primary is absent or empty', () => {
    expect(primaryRoot({ root: 'C:\\a', name: 'a', workspace: false, addedAt: 0 })).toBe('C:\\a');
    expect(primaryRoot({ root: 'C:\\a', name: 'a', workspace: false, addedAt: 0, primary: '' })).toBe('C:\\a');
    expect(primaryRoot({ root: 'C:\\a', name: 'a', workspace: false, addedAt: 0, primary: 'C:\\a\\wt' })).toBe('C:\\a\\wt');
  });

  it('adoptRoots returns the file entries the extension does not know, and nothing else', () => {
    const prior = {
      version: 1 as const,
      repos: [
        { root: 'C:\\ws', name: 'ws', workspace: true, addedAt: 1 },
        { root: 'C:\\known', name: 'known', workspace: false, addedAt: 2 },
        { root: 'C:\\fresh', name: 'fresh', workspace: false, addedAt: 3 },
      ],
    };
    expect(adoptRoots(prior, ['C:\\known'], 'C:\\ws')).toEqual(['C:\\fresh']);
    // Already adopted: nothing to do (so the caller never rewrites the Memento).
    expect(adoptRoots(prior, ['C:\\known', 'C:\\fresh'], 'C:\\ws')).toEqual([]);
    // The workspace repo leads the composed list on its own; when it is NOT this
    // window's workspace it is an ordinary foreign entry and IS adopted.
    expect(adoptRoots(prior, ['C:\\known', 'C:\\fresh'], undefined)).toEqual(['C:\\ws']);
    expect(adoptRoots(undefined, ['C:\\known'], 'C:\\ws')).toEqual([]); // no file, nothing to adopt
  });

  it('a real sync preserves a foreign entry on disk and primaryFor reads it back', () => {
    const home = tempDir('origami-home-merge-');
    const mine = tempDir('origami-repo-mine-');
    const theirs = tempDir('origami-repo-theirs-');
    const wt = path.join(mine, 'wt');
    for (const r of [mine, theirs]) fs.mkdirSync(path.join(r, '.git'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });

    syncRepoFile(undefined, [mine], home);
    // The ENGINE writes an entry of its own + a primary on ours (board_register).
    const doc = readRepoFile(repoFilePath(home))!;
    doc.repos.push({ root: theirs, name: path.basename(theirs), workspace: false, addedAt: 5 });
    writeRepoFile(repoFilePath(home), setPrimary(doc, mine, wt));

    // The extension syncs again, knowing nothing about either.
    syncRepoFile(undefined, [mine], home);
    const after = readRepoFile(repoFilePath(home))!;
    expect(after.repos.map((r) => r.root).sort()).toEqual([mine, theirs].sort());
    expect(after.repos.find((r) => r.root === mine)?.primary).toBe(wt);
    expect(primaryFor(mine, home)).toBe(wt);
    // A primary whose folder is gone degrades to the root, never a dead board.
    fs.rmSync(wt, { recursive: true, force: true });
    expect(primaryFor(mine, home)).toBe(mine);
    expect(primaryFor(theirs, home)).toBe(theirs); // no primary set at all
  });
});


// ---------------------------------------------------------------------------
// Lifecycle: the real manager, a real git repo, a faked ManagerHost
// ---------------------------------------------------------------------------

interface FakeHost extends ManagerHost {
  posts: Array<Record<string, unknown>>;
  opened: string[];
}

function makeHost(repo: string): FakeHost {
  const host: FakeHost = {
    posts: [], opened: [],
    repoRoot: () => repo,
    knownRepos: () => [],
    saveKnownRepos: () => undefined,
    pickRepoFolder: async () => undefined,
    repoDisplayNames: () => ({}),
    saveRepoDisplayNames: () => undefined,
    autoApprove: () => true,
    setAutoApprove: () => undefined,
    createAgentSession: async () => 'session-1',
    promptSession: async () => 'end_turn',
    cancelSession: async () => undefined,
    closeSession: () => undefined,
    sessionAlive: () => false,
    openChat: () => undefined,
    post: (msg) => { host.posts.push(msg as Record<string, unknown>); },
    openTerminal: () => undefined,
    setSessionModel: async () => undefined,
    agentModes: () => null,
    setSessionAgentMode: async () => undefined,
    agentTypes: () => [],
    saveAgentTypes: () => undefined,
    // Reads as already-installed so the constructor never touches the real agent dir.
    archetypeMarker: () => ({ get: () => true, set: () => undefined }),
    harvestAnySessionModes: () => null,
    openCrossDiff: () => undefined,
    engineSessionId: () => undefined,
    reopenAgentSession: async () => 'session-2',
    openFileDiff: () => undefined,
    info: () => undefined,
    openConflicted: () => undefined,
    openFile: (p) => { host.opened.push(p); },
  };
  return host;
}

async function makeGitRepo(): Promise<string> {
  const dir = tempDir('origami-tix-repo-');
  expect((await runGit(['init', '-b', 'main'], dir)).ok).toBe(true);
  await runGit(['config', 'user.email', 'uat@origami.local'], dir);
  await runGit(['config', 'user.name', 'Origami UAT'], dir);
  fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
  await runGit(['add', 'app.txt'], dir);
  expect((await runGit(['commit', '-m', 'seed'], dir)).ok).toBe(true);
  return dir;
}

const lastState = (host: FakeHost) =>
  [...host.posts].reverse().find((p) => p.type === 'amState') as unknown as
    { repos: Array<{ root: string; rows: Array<Record<string, unknown>>; tickets: Array<Record<string, unknown>> }> } | undefined;

describe('fold lifecycle stamps a ticket (real git, faked host)', () => {
  it('queued launch -> pending + linked; delete un-merged -> back to todo, unlinked', async () => {
    const repo = await makeGitRepo();
    const id = 't-8k2fq1';
    seedTicket(repo, id, SAMPLE);
    const host = makeHost(repo);
    const mgr = new AgentManager(host);
    try {
      await mgr.handle({ type: 'amRequestState' });
      // Queue the launch (start:false) so no session machinery is involved: the
      // worktree, the record and the ticket stamp are all that is under test.
      await mgr.handle({ type: 'amTicketLaunch', root: repo, id, agentName: '', model: '', start: false });

      const rec = loadState(repo).worktrees[0];
      expect(rec).toBeDefined();
      expect(rec.ticketId).toBe(id);
      expect(rec.name.startsWith(id)).toBe(true); // id-first naming survived sanitizeWorktreeName
      // The prompt the fold will be driven with names its repo, so the session
      // knows which board to report back to without guessing.
      expect(rec.queuedTask?.prompt).toContain(`This ticket is on the "${path.basename(repo)}" Folds board.`);

      const t1 = listTickets(repo)[0];
      expect(scalar(t1.fm, 'status')).toBe('pending');
      expect(scalar(t1.fm, 'fold')).toBe(rec.id);
      expect(scalar(t1.fm, 'branch')).toBe(rec.branch);
      expect(scalar(t1.fm, 'owner')).toBe('passing'); // unknown key survived the stamp

      const board = lastState(host)?.repos.find((r) => r.root === repo);
      expect(board?.tickets).toHaveLength(1);
      expect(board?.tickets[0]).toMatchObject({ id, status: 'pending', fold: rec.id });
      expect(board?.rows[0]).toMatchObject({
        id: rec.id, ticketId: id, ticketTitle: 'Scroll block needs a max-width', activity: '',
      });

      // Delete the fold BEFORE anything was applied: the work still has to happen.
      await mgr.handle({ type: 'amDelete', root: repo, id: rec.id });
      expect(loadState(repo).worktrees).toHaveLength(0);
      const t2 = listTickets(repo)[0];
      expect(scalar(t2.fm, 'status')).toBe('todo');
      expect(scalar(t2.fm, 'fold')).toBe('');
      expect(scalar(t2.fm, 'branch')).toBe('');
      expect(acceptance(t2.body)).toEqual({ done: 1, total: 3 }); // the brief is intact for the next fold
      expect(t2.body).toContain('fold deleted before it was applied');
    } finally {
      mgr.dispose();
    }
  }, 60_000);

  it('a minimal-format ticket gets fold+branch INSERTED after updated, in order, and owner keeps its place', async () => {
    const repo = await makeGitRepo();
    const id = 't-min001';
    seedTicket(repo, id, MINIMAL);
    const host = makeHost(repo);
    const mgr = new AgentManager(host);
    try {
      await mgr.handle({ type: 'amRequestState' });
      await mgr.handle({ type: 'amTicketLaunch', root: repo, id, agentName: '', model: '', start: false });

      const rec = loadState(repo).worktrees[0];
      const raw = fs.readFileSync(ticketPath(repo, id), 'utf8');
      const t1 = parseTicket(raw, ticketPath(repo, id));
      // fold/branch were never on disk (§12 item 5) - they land right after
      // updated, in the template's own order, and the hand-added `owner` line
      // that was ALREADY there keeps its place rather than being displaced.
      expect(t1.fm.map((l) => l.key).filter(Boolean)).toEqual(
        ['id', 'title', 'status', 'priority', 'created', 'updated', 'owner', 'fold', 'branch'],
      );
      expect(scalar(t1.fm, 'fold')).toBe(rec.id);
      expect(scalar(t1.fm, 'branch')).toBe(rec.branch);
      expect(scalar(t1.fm, 'owner')).toBe('passing');
      expect(raw).not.toContain('labels:');
      expect(raw).not.toContain('assignee:');
    } finally {
      mgr.dispose();
    }
  }, 60_000);

  it('amTicketOpen opens the ticket FILE, and a bad id is an amError not a throw', async () => {
    const repo = await makeGitRepo();
    seedTicket(repo, 't-8k2fq1', SAMPLE);
    const host = makeHost(repo);
    const mgr = new AgentManager(host);
    try {
      await mgr.handle({ type: 'amTicketOpen', root: repo, id: 't-8k2fq1' });
      expect(host.opened).toEqual([ticketPath(repo, 't-8k2fq1')]);
      await mgr.handle({ type: 'amTicketOpen', root: repo, id: 't-nope' });
      expect(host.posts.some((p) => p.type === 'amError')).toBe(true);
      // Quick-add through the manager reaches the same repo's tickets dir, and
      // the form's second field lands as the ticket body (contract §11 item 2).
      await mgr.handle({ type: 'amTicketQuickAdd', root: repo, title: 'From the board', body: 'ship the thing' });
      expect(boardTickets(repo).map((r) => r.title)).toContain('From the board');
      const added = listTickets(repo).find((t) => scalar(t.fm, 'title') === 'From the board');
      expect(added?.body).toContain('ship the thing');
      // A title-only quick-add still creates (empty body = the old behaviour).
      await mgr.handle({ type: 'amTicketQuickAdd', root: repo, title: 'No tasks given' });
      expect(boardTickets(repo).map((r) => r.title)).toContain('No tasks given');
    } finally {
      mgr.dispose();
    }
  }, 60_000);
});
