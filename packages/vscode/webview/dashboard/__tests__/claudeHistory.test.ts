// claudeHistory.test.ts — Claude Code's own past chats: finding them, refusing
// the ones that are not ours to offer, and continuing a picked one (t-463pb6).
//
// EVERY FIXTURE IS A REAL FILE IN A REAL TEMP DIRECTORY. The thing under test
// is a streaming read of a foreign file format; a mocked fs would assert that
// this module calls the functions this module calls, which is worth nothing.
// The real `~/.claude` is never touched: `root` is injected in every call, and
// no test in this file ever lets it default to the home directory.
//
// The directory names below are built by `sanitisedByTheCli`, a SECOND
// implementation of the CLI's rule written from the evidence in
// claudeHistory.ts's header. It is deliberately not `projectKey`: a test that
// normalised both sides with the function under test would pass however wrong
// that function was.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openClaudeHistoryChat, scanClaudeHistoryReport, userText } from '../../../src/dashboard/claudeHistory';
import { claudeProjectsRoot, projectKey } from '../../../src/dashboard/claudeProjects';
import {
  __resetClaudeCodeForTests, handleClaudeCodeMessage, type ClaudeCodeHost,
} from '../../../src/dashboard/claudeCodeManager';
import { RESUME_RUN, type ResumeStore } from '../../../src/dashboard/claudeCodeResume';
import type { SpawnChild } from '../../../src/claudeCode/driver';
import { FakeChild } from './claudeCodeFakeChild';

/** The CLI's own rule, from the evidence: separators, colon and space each
 *  become '-', and nothing else changes. */
function sanitisedByTheCli(cwd: string): string {
  return cwd.replace(/[\\/: ]/g, '-');
}

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-cc-hist-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A transcript directory for one workspace folder, named the way the CLI
 *  names it. Returns the directory path. */
function projectDir(folder: string): string {
  const dir = path.join(root, sanitisedByTheCli(folder));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(dir: string, name: string, lines: unknown[], mtime?: Date): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

const userLine = (sessionId: string, content: unknown) => ({ type: 'user', sessionId, isSidechain: false, message: { role: 'user', content } });
const assistantLine = (sessionId: string, id: string, usage: Record<string, number>, model = 'claude-sonnet-5') => ({
  type: 'assistant', sessionId, isSidechain: false,
  message: { role: 'assistant', id, model, usage },
});

const USAGE_A = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 };
const USAGE_B = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** The rows the popup gets. `scanClaudeHistoryReport` is the ONE entry point —
 *  the old `scanClaudeHistory` wrapper existed only for these tests. */
const rowsOf = async (opts: Parameters<typeof scanClaudeHistoryReport>[0]) => (await scanClaudeHistoryReport(opts)).rows;

// --- the scan -------------------------------------------------------------

describe('scanClaudeHistoryReport — what a transcript directory yields', () => {
  const FOLDER = 'C:\\ws\\alpha';

  function seedAlpha(): void {
    const dir = projectDir(FOLDER);
    // A GOOD one. The first line is a queue-operation (no message at all), the
    // first USER turn is a bare tool_result — both must be stepped over — and
    // the assistant turn is written three times, once per content block, all
    // carrying the same cumulative usage under one message id.
    write(dir, 'aaa.jsonl', [
      { type: 'queue-operation', sessionId: 'sess-aaa', operation: 'enqueue' },
      userLine('sess-aaa', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      userLine('sess-aaa', [{ type: 'text', text: '  Rewrite the terrain shader   so it stops banding  ' }]),
      assistantLine('sess-aaa', 'msg_1', USAGE_A),
      assistantLine('sess-aaa', 'msg_1', USAGE_A),
      assistantLine('sess-aaa', 'msg_1', USAGE_A),
      assistantLine('sess-aaa', 'msg_2', USAGE_B, 'claude-fable-5-1'),
    ], new Date('2026-09-08T10:00:00Z'));
    // A GOOD one with a plain string user turn.
    write(dir, 'bbb.jsonl', [
      userLine('sess-bbb', 'Ship the release notes'),
      assistantLine('sess-bbb', 'msg_9', USAGE_B),
    ], new Date('2026-09-09T10:00:00Z'));
    // A SUB-AGENT's file: same folder, same shape, not a chat anyone opened.
    write(dir, 'side.jsonl', [
      { type: 'user', sessionId: 'sess-side', isSidechain: true, message: { role: 'user', content: 'Search the repo' } },
      assistantLine('sess-side', 'msg_s', USAGE_A),
    ], new Date('2026-09-09T11:00:00Z'));
    // NO USER TURN — a session that never got a prompt has no title and no chat.
    write(dir, 'none.jsonl', [
      { type: 'queue-operation', sessionId: 'sess-none', operation: 'enqueue' },
      assistantLine('sess-none', 'msg_n', USAGE_A),
    ], new Date('2026-09-09T12:00:00Z'));
  }

  it('lists the two real chats, newest first, and skips the sidechain and the turnless file', async () => {
    seedAlpha();
    const rows = await rowsOf({ root, folders: [FOLDER] });

    expect(rows.map((r) => r.sessionId)).toEqual(['sess-bbb', 'sess-aaa']);
    expect(rows.map((r) => r.kind)).toEqual(['claude', 'claude']);
    expect(rows.map((r) => r.folder)).toEqual(['alpha', 'alpha']);
    expect(rows.map((r) => r.cwd)).toEqual([FOLDER, FOLDER]);
    expect(rows[1].title).toBe('Rewrite the terrain shader so it stops banding');
    expect(rows[1].updatedAt).toBe('2026-09-08T10:00:00.000Z');
    expect(rows[0].title).toBe('Ship the release notes');
  });

  it('counts one assistant turn per message id, not per content block', async () => {
    seedAlpha();
    const [, aaa] = await rowsOf({ root, folders: [FOLDER] });

    // Three records for msg_1 + one for msg_2 = TWO turns and ONE copy of each
    // usage figure. Summing per record would say 4 turns and 31 input tokens.
    expect(aaa.turns).toBe(2);
    expect(aaa.tokensIn).toBe(11);
    expect(aaa.tokensOut).toBe(6);
    expect(aaa.cacheRead).toBe(7);
    expect(aaa.cacheWrite).toBe(3);
    expect(aaa.partial).toBe(false);
    expect(aaa.model).toBe('claude-fable-5-1');
  });

  it('trims a long first line to 80 characters', async () => {
    const dir = projectDir(FOLDER);
    write(dir, 'long.jsonl', [userLine('sess-long', 'x'.repeat(300))]);
    const [row] = await rowsOf({ root, folders: [FOLDER] });

    expect(row.title).toHaveLength(80);
  });

  it('reads one directory per open folder and nothing else in the root', async () => {
    seedAlpha();
    const other = projectDir('C:\\ws\\beta');
    write(other, 'ccc.jsonl', [userLine('sess-ccc', 'Beta work'), assistantLine('sess-ccc', 'm', USAGE_B)]);
    const rows = await rowsOf({ root, folders: [FOLDER] });

    expect(rows.map((r) => r.sessionId)).not.toContain('sess-ccc');
  });

  it('answers empty rather than throwing when there is no ~/.claude/projects at all', async () => {
    await expect(rowsOf({ root: path.join(root, 'nope'), folders: [FOLDER] })).resolves.toEqual([]);
  });

  it('lists nothing when no folder is open — the guard, not an empty directory', async () => {
    seedAlpha();
    await expect(rowsOf({ root, folders: [] })).resolves.toEqual([]);
  });

  it('survives a torn last line and a file that is not JSON at all', async () => {
    const dir = projectDir(FOLDER);
    fs.writeFileSync(path.join(dir, 'torn.jsonl'), `${JSON.stringify(userLine('sess-torn', 'Half a file'))}\n{"type":"assist`, 'utf8');
    fs.writeFileSync(path.join(dir, 'junk.jsonl'), 'not json at all\n', 'utf8');
    const rows = await rowsOf({ root, folders: [FOLDER] });

    expect(rows.map((r) => r.sessionId)).toEqual(['sess-torn']);
  });

  it('keeps a multi-byte character whole across the 64 KB read boundary', async () => {
    const dir = projectDir(FOLDER);
    // Pad past the chunk size with assistant records, then the user turn: the
    // title is decoded from bytes that certainly straddle a chunk edge.
    const filler = Array.from({ length: 900 }, (_, i) => assistantLine('sess-utf', `m${i}`, USAGE_B));
    write(dir, 'utf.jsonl', [...filler, userLine('sess-utf', 'Zeekapitein — schildpad 🐢 in de mist')]);
    const [row] = await rowsOf({ root, folders: [FOLDER], maxBytesPerFile: 16 * 1024 * 1024 });

    expect(row.title).toBe('Zeekapitein — schildpad 🐢 in de mist');
    expect(row.title).not.toContain('\uFFFD');
  });
});

// --- the guard ------------------------------------------------------------

describe('the folder guard — a transcript directory that maps to no open folder', () => {
  it('is not listed, even though the files are perfectly good', async () => {
    const closed = 'C:\\ws\\not-open';
    write(projectDir(closed), 'x.jsonl', [userLine('sess-closed', 'Old work'), assistantLine('sess-closed', 'm', USAGE_A)]);
    const open = 'C:\\ws\\open';
    write(projectDir(open), 'y.jsonl', [userLine('sess-open', 'Current work'), assistantLine('sess-open', 'm', USAGE_A)]);

    const rows = await rowsOf({ root, folders: [open] });

    expect(rows.map((r) => r.sessionId)).toEqual(['sess-open']);
  });

  it('matches a folder whose case or dot-spelling differs from the directory name', () => {
    // Windows paths are case-insensitive, and no sample proved what the CLI
    // does with a '.' in a segment — both sides fold, so a worktree matches
    // whichever way the CLI spelled it.
    expect(projectKey('C:\\Repos\\origami-coder.wt\\lane')).toBe(projectKey('c--Repos-origami-coder-wt-lane'));
    expect(projectKey('c:\\Users\\A\\Downloads\\Origami UAT')).toBe(projectKey('C--Users-A-Downloads-Origami-UAT'));
    expect(projectKey('C:\\ws\\alpha')).not.toBe(projectKey('C--ws-beta'));
  });

  // The root is claudeProjects.ts's now, and takes an ENVIRONMENT rather than a
  // home: Claude Code's own `CLAUDE_CONFIG_DIR` moves the whole `.claude` tree,
  // and a build that only knew about `~` looked in the wrong place (t-5nmtva).
  it('puts the projects directory under the config dir it is given', () => {
    const cfg = path.join('C:', 'cfg');
    expect(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: cfg })).toBe(path.join(cfg, 'projects'));
    expect(claudeProjectsRoot({})).toBe(path.join(os.homedir(), '.claude', 'projects'));
  });
});

// --- the byte budget ------------------------------------------------------

describe('a transcript too large to read whole', () => {
  const FOLDER = 'C:\\ws\\big';
  const LINES = 100_000;

  beforeEach(async () => {
    const dir = projectDir(FOLDER);
    const out = fs.createWriteStream(path.join(dir, 'huge.jsonl'));
    out.write(`${JSON.stringify(userLine('sess-huge', 'A very long night shift'))}\n`);
    for (let i = 0; i < LINES; i++) {
      out.write(`${JSON.stringify(assistantLine('sess-huge', `m${i}`, USAGE_B))}\n`);
    }
    // AWAITED: a stream still flushing is a file the scan reads as empty, which
    // fails as "no rows" and reads like a bug in the scan.
    await new Promise<void>((resolve, reject) => { out.on('close', resolve); out.on('error', reject); out.end(); });
  });

  it('stops at the byte budget and says so, instead of loading 100k lines', async () => {
    const [row] = await rowsOf({ root, folders: [FOLDER], maxBytesPerFile: 32 * 1024 });

    // The title is at the top, so it is still found…
    expect(row.title).toBe('A very long night shift');
    // …but only a slice of the turns was counted, and the row admits it. If the
    // reader had slurped the file, turns would be LINES and partial false.
    expect(row.partial).toBe(true);
    expect(row.turns).toBeGreaterThan(0);
    expect(row.turns).toBeLessThan(LINES / 10);
  });

  it('totals the whole file when the budget allows it', async () => {
    const [row] = await rowsOf({ root, folders: [FOLDER], maxBytesPerFile: 64 * 1024 * 1024 });

    expect(row.partial).toBe(false);
    expect(row.turns).toBe(LINES);
    expect(row.tokensOut).toBe(LINES);
  });

  it('reads at most maxFilesPerFolder transcripts, newest first', async () => {
    const dir = projectDir('C:\\ws\\many');
    for (let i = 0; i < 5; i++) {
      write(dir, `s${i}.jsonl`, [userLine(`sess-${i}`, `Chat ${i}`)], new Date(Date.UTC(2026, 0, i + 1)));
    }
    const rows = await rowsOf({ root, folders: ['C:\\ws\\many'], maxFilesPerFolder: 2 });

    expect(rows.map((r) => r.sessionId)).toEqual(['sess-4', 'sess-3']);
  });
});

describe('userText — what counts as something a human said', () => {
  it('takes a string, joins text parts, and ignores a tool_result-only turn', () => {
    expect(userText('plain')).toBe('plain');
    expect(userText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }])).toBe('one two');
    expect(userText([{ type: 'tool_result', content: 'stdout' }])).toBe('');
    expect(userText(undefined)).toBe('');
    expect(userText({ type: 'text' })).toBe('');
  });
});

// --- the pick -------------------------------------------------------------
//
// The seam that matters is the ORDER: bindCell reads the resume map once, while
// it builds the driver. So these assert the ARG VECTOR the child would be
// spawned with, not that a function was called — a resume entry written a tick
// too late produces a spawn with no --resume at all, and only the argv shows it.

describe('opening a picked Claude history row', () => {
  const FOLDER = 'C:\\ws\\alpha';
  const OTHER = 'C:\\ws\\beta';
  const SESSION = 'c6bab4a9-9d8a-4bf1-855d-9d7e146f884a';
  const CLI = { binary: 'C:\\claude.exe', version: '2.1.198', source: 'native-install' as const };

  interface Seam {
    host: ClaudeCodeHost;
    posts: Array<Record<string, unknown>>;
    logs: string[];
    store: { value: ResumeStore | undefined };
    created: string[];
    spawns: Array<{ args: readonly string[]; cwd: string }>;
  }

  function seam(folders: string[] = [OTHER, FOLDER]): Seam {
    const posts: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const store: { value: ResumeStore | undefined } = { value: undefined };
    const created: string[] = [];
    const spawns: Array<{ args: readonly string[]; cwd: string }> = [];
    const spawn: SpawnChild = (_command, args, opts) => {
      spawns.push({ args, cwd: opts.cwd });
      return new FakeChild();
    };
    const host: ClaudeCodeHost = {
      post: (m) => posts.push(m),
      cwd: OTHER, // the PANEL's folder — deliberately not the picked one
      folders: () => folders,
      read: () => store.value,
      write: (next) => { store.value = next; },
      log: (l) => logs.push(l),
      createCell: async () => { const id = `session-${created.length + 1}`; created.push(id); return id; },
      redispatch: () => undefined,
      cli: async () => CLI,
      spawn,
    };
    return { host, posts, logs, store, created, spawns };
  }

  beforeEach(() => __resetClaudeCodeForTests());
  afterEach(() => __resetClaudeCodeForTests());

  it('binds a new cell to the picked session, in the picked folder, before the first spawn', async () => {
    const s = seam();
    const id = await openClaudeHistoryChat(s.host, CLI, 'claude-code/sonnet', {
      claudeSessionId: SESSION, cwd: FOLDER, title: 'Rewrite the terrain shader',
    });

    expect(id).toBe('session-1');
    // The entry the driver will read, keyed by CELL and guarded by folder+run.
    expect(s.store.value).toEqual({ 'session-1': { cwd: FOLDER, session: SESSION, run: RESUME_RUN } });
    expect(s.posts).toContainEqual({ type: 'sessionTitle', sessionId: 'session-1', title: 'Rewrite the terrain shader' });

    // The child is spawned lazily, on the first prompt. THIS is the assertion
    // the ordering rule exists for.
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'carry on', sessionId: 'session-1' });

    expect(s.spawns).toHaveLength(1);
    expect(s.spawns[0].args).toContain('--resume');
    expect(s.spawns[0].args[s.spawns[0].args.indexOf('--resume') + 1]).toBe(SESSION);
    expect(s.spawns[0].cwd).toBe(FOLDER);
  });

  it('is reached by the openClaudeHistory message the popup posts', async () => {
    const s = seam();
    await handleClaudeCodeMessage(s.host, {
      type: 'openClaudeHistory', claudeSessionId: SESSION, cwd: FOLDER, title: 'Old chat',
    });
    await handleClaudeCodeMessage(s.host, { type: 'send', text: 'go', sessionId: 'session-1' });

    expect(s.spawns[0].args).toContain('--resume');
    expect(s.spawns[0].cwd).toBe(FOLDER);
  });

  it('refuses a folder that is not open — no cell, no entry, and it says why', async () => {
    const s = seam();
    const id = await openClaudeHistoryChat(s.host, CLI, 'claude-code/sonnet', {
      claudeSessionId: SESSION, cwd: 'C:\\somewhere\\else', title: 'Not ours',
    });

    expect(id).toBeUndefined();
    expect(s.created).toEqual([]);
    expect(s.store.value).toBeUndefined();
    expect(s.logs.join('\n')).toContain('not an open workspace folder');
  });

  // t-5yejvo. The guard used to compare FOLDED KEYS, and folding is lossy by
  // design: `Foo_Bar` and `Foo-Bar` are one key. A webview that supplied the
  // spelling the user does NOT have open therefore passed the check, and the
  // cell was bound — and spawned — in a directory nobody opened. The key finds
  // candidate directories; it may never answer "is this folder ours".
  it('refuses a folder that only shares a FOLDED KEY with an open one', async () => {
    const s = seam(['C:\\Repos\\Foo_Bar']);
    const id = await openClaudeHistoryChat(s.host, CLI, 'claude-code/sonnet', {
      claudeSessionId: SESSION, cwd: 'C:\\Repos\\Foo-Bar', title: 'Nearly ours',
    });

    expect(id).toBeUndefined();
    expect(s.created).toEqual([]);
    expect(s.store.value).toBeUndefined();
    expect(s.logs.join('\n')).toContain('not an open workspace folder');
  });

  it('still accepts the open folder itself, however the separators are spelled', async () => {
    const s = seam(['C:\\Repos\\Foo_Bar']);
    const id = await openClaudeHistoryChat(s.host, CLI, 'claude-code/sonnet', {
      claudeSessionId: SESSION, cwd: 'c:/Repos/Foo_Bar', title: 'Ours',
    });

    expect(id).toBe('session-1');
    expect(s.store.value).toEqual({ 'session-1': { cwd: 'c:/Repos/Foo_Bar', session: SESSION, run: RESUME_RUN } });
  });

  it('refuses a pick with no session id rather than opening a fresh chat that looks resumed', async () => {
    const s = seam();
    await openClaudeHistoryChat(s.host, CLI, 'claude-code/sonnet', { claudeSessionId: '', cwd: FOLDER, title: 'x' });

    expect(s.created).toEqual([]);
  });

  it('reports the missing CLI instead of creating a cell nothing can drive', async () => {
    const s = seam();
    const id = await openClaudeHistoryChat(s.host, null, 'claude-code/sonnet', { claudeSessionId: SESSION, cwd: FOLDER, title: 'x' });

    expect(id).toBeUndefined();
    expect(s.created).toEqual([]);
    expect(s.posts.some((p) => p.type === 'error' && String(p.message).includes('Claude Code was not found'))).toBe(true);
  });
});
