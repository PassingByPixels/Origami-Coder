// claudeProjects.test.ts — WHICH transcript directory belongs to a workspace
// (t-5nmtva), and what the resolver is allowed to conclude from it (t-5yejvo).
// The bug this file exists for: a work laptop with the workspace
// `C:\Users\jane_doe\Downloads\Test_Rig` found no Claude Code sessions,
// against an address whose `_` had become `-` and whose drive letter had been
// lower-cased. Both spellings are real on disk, so both must match.
//
// EVERY FIXTURE IS A REAL DIRECTORY IN A REAL TEMP ROOT, and the root is
// injected in every call — no test here may reach the user's own `~/.claude`.
// The directory names are written out LITERALLY rather than built by a helper:
// a helper would be a second copy of the rule under test, and the whole defect
// is that a computed name was trusted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claudeConfigDir, claudeProjectsRoot, homeDir, listProjectDirs, matchProjectDirs,
  pathUnder, projectKey, samePath,
} from '../../../src/dashboard/claudeProjects';
import { recordedCwd } from '../../../src/dashboard/claudeRecordedCwd';
import { scanClaudeHistoryReport } from '../../../src/dashboard/claudeHistory';

const WORKSPACE = 'C:\\Users\\jane_doe\\Downloads\\Test_Rig';
/** As the CLI writes it when it keeps `_` and the drive's case. */
const KEPT = 'C--Users-jane_doe-Downloads-Test_Rig';
/** As the laptop's address read: `_` folded, drive lower-cased. */
const FOLDED = 'c--users-jane-doe-downloads-test-rig';
/** A REAL other workspace that folds to the very same key. */
const NEIGHBOUR = 'C:\\Users\\jane_doe\\Downloads\\Test-Rig';
/** The reader's chunk size, restated: a test that imported it could not tell a
 *  boundary bug from a constant that moved. */
const CHUNK = 64 * 1024;

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-cc-proj-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A transcript directory holding one file whose records report `cwd`. */
function dirWith(name: string, cwd: string | null, mtime?: Date, session = 's1'): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const lines: unknown[] = [
    // A REAL transcript's first line is often a summary with no cwd — the
    // reader must keep looking rather than give up on record one.
    { type: 'summary', summary: 'a chat' },
    { type: 'user', sessionId: session, ...(cwd ? { cwd } : {}), message: { role: 'user', content: 'hello there' } },
  ];
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return dir;
}

const dirsOf = (matches: Array<{ dir: string }>): string[] => matches.map((m) => m.dir);

describe('the key folds every character the CLI has been seen to differ on', () => {
  it('folds `_` and `-` together, and compares case-insensitively', () => {
    expect(projectKey(WORKSPACE)).toBe(projectKey(KEPT));
    expect(projectKey(WORKSPACE)).toBe(projectKey(FOLDED));
  });

  it('folds a dot and a space too — a worktree folder and a spaced one', () => {
    expect(projectKey('C:\\Repos\\origami-coder.wt\\lane')).toBe(projectKey('C--Repos-origami-coder-wt-lane'));
    expect(projectKey('c:\\Users\\dev\\Downloads\\Origami UAT')).toBe(projectKey('c--Users-dev-Downloads-Origami-UAT'));
  });

  it('still tells two genuinely different workspaces apart', () => {
    expect(projectKey('C:\\ws\\alpha')).not.toBe(projectKey('C:\\ws\\beta'));
  });
});

// The key may only ever WIDEN a search. Every identity and permission answer
// comes from these two, and a folded collision must not survive either.
describe('samePath / pathUnder — the compare that decides identity', () => {
  it('samePath does NOT fold `_` into `-`, however the separators are spelled', () => {
    expect(samePath('C:\\ws\\a_b', 'c:/ws/A_B\\')).toBe(true);
    expect(samePath('C:\\ws\\a_b', 'C:\\ws\\a-b')).toBe(false);
    expect(samePath('', 'C:\\ws\\a')).toBe(false);
  });

  it('samePath answers on the REAL directory, whatever case the caller typed', () => {
    // A path that exists is resolved, so a spelling neither string-equal nor
    // guessable still compares equal — the reason this is not `===`.
    const real = fs.mkdtempSync(path.join(root, 'Case-'));
    expect(samePath(real, real.toUpperCase())).toBe(true);
    expect(samePath(real, path.join(real, '..', path.basename(real)))).toBe(true);
  });

  it('pathUnder accepts the folder itself and anything inside it, and nothing else', () => {
    expect(pathUnder('C:\\ws\\alpha', 'C:\\ws\\alpha')).toBe(true);
    expect(pathUnder('C:\\ws\\alpha', 'C:\\ws\\alpha\\packages\\vscode')).toBe(true);
    expect(pathUnder('C:\\ws\\alpha', 'c:/ws/alpha/src')).toBe(true);
    // A SIBLING that merely starts with the same characters is not inside it.
    expect(pathUnder('C:\\ws\\alpha', 'C:\\ws\\alphabet')).toBe(false);
    expect(pathUnder('C:\\ws\\alpha', 'C:\\ws')).toBe(false);
    expect(pathUnder('C:\\ws\\a_b', 'C:\\ws\\a-b\\src')).toBe(false);
  });
});

describe('matchProjectDirs — the folder on disk, whatever the CLI called it', () => {
  it('matches the directory that KEPT the underscore and the drive case', async () => {
    const dir = dirWith(KEPT, WORKSPACE);
    expect(dirsOf(await matchProjectDirs(root, WORKSPACE))).toEqual([dir]);
  });

  it('matches the directory that FOLDED it and lower-cased the drive', async () => {
    const dir = dirWith(FOLDED, WORKSPACE);
    expect(dirsOf(await matchProjectDirs(root, WORKSPACE))).toEqual([dir]);
  });

  it('hands back the transcripts it already listed, so no caller lists them again', async () => {
    const dir = dirWith(KEPT, WORKSPACE);
    const [match] = await matchProjectDirs(root, WORKSPACE);
    expect(match.files.map((f) => f.path)).toEqual([path.join(dir, 's1.jsonl')]);
    expect(match.files[0].mtimeMs).toBeGreaterThan(0);
  });

  it('two folders, one key: a cwd naming somewhere ELSE refutes that candidate', async () => {
    // The decoy is NEWER, so an mtime-only rule would return it.
    dirWith(FOLDED, NEIGHBOUR, new Date('2026-09-10T12:00:00Z'));
    const mine = dirWith(KEPT, WORKSPACE, new Date('2026-09-01T12:00:00Z'));
    expect(dirsOf(await matchProjectDirs(root, WORKSPACE))).toEqual([mine]);
  });

  // The header has always said a session's cwd can be a SUB-FOLDER of the
  // workspace. An equality-only tie-break called that directory a stranger, so
  // the one candidate that WAS ours lost to a decoy nothing had confirmed.
  it('a cwd that is a sub-folder of the workspace CONFIRMS the candidate', async () => {
    const mine = dirWith(KEPT, `${WORKSPACE}\\packages\\vscode`, new Date('2026-09-01T12:00:00Z'));
    dirWith(FOLDED, NEIGHBOUR, new Date('2026-09-10T12:00:00Z'));
    expect(dirsOf(await matchProjectDirs(root, WORKSPACE))).toEqual([mine]);
  });

  it('partial confirmation KEEPS the unconfirmed candidate, confirmed first', async () => {
    // One directory says it is ours; the other says nothing at all. Dropping
    // the silent one to look decisive would lose every chat in it.
    const silent = dirWith(FOLDED, null, new Date('2026-09-10T12:00:00Z'));
    const mine = dirWith(KEPT, WORKSPACE, new Date('2026-09-01T12:00:00Z'));
    expect(dirsOf(await matchProjectDirs(root, WORKSPACE))).toEqual([mine, silent]);
  });

  it('two folders and NO cwd record: both stay, newest first — never a guess that drops a chat', async () => {
    const older = dirWith(KEPT, null, new Date('2026-09-01T12:00:00Z'));
    const newer = dirWith(FOLDED, null, new Date('2026-09-10T12:00:00Z'));
    expect(dirsOf(await matchProjectDirs(root, WORKSPACE))).toEqual([newer, older]);
  });

  it('a missing root is an empty answer, not a throw', async () => {
    const gone = path.join(root, 'no-such-root');
    await expect(matchProjectDirs(gone, WORKSPACE)).resolves.toEqual([]);
    await expect(listProjectDirs(gone)).resolves.toEqual([]);
  });

  it('a root full of OTHER workspaces matches nothing', async () => {
    dirWith('C--ws-alpha', 'C:\\ws\\alpha');
    dirWith('C--ws-beta', 'C:\\ws\\beta');
    expect(await matchProjectDirs(root, WORKSPACE)).toEqual([]);
    expect(await listProjectDirs(root)).toHaveLength(2);
  });

  it('no folder to look for reads nothing', async () => {
    dirWith(KEPT, WORKSPACE);
    expect(await matchProjectDirs(root, '')).toEqual([]);
  });
});

// The cwd record is read through the same chunked StringDecoder pass the
// transcript readers use. A single blind 256 KB `toString()` got both of these
// wrong: it split multi-byte characters, and it never reached past a first
// record bigger than the budget.
describe('recordedCwd — reading the tie-break record safely', () => {
  function fileAt(name: string, body: Buffer): Array<{ path: string; mtimeMs: number }> {
    const file = path.join(root, name);
    fs.writeFileSync(file, body);
    return [{ path: file, mtimeMs: fs.statSync(file).mtimeMs }];
  }

  it('keeps a multi-byte character whole across the 64 KB read boundary', () => {
    const cwd = 'C:\\ws\\Zeekapitein—mist';
    const line2 = Buffer.from(`${JSON.stringify({ type: 'user', sessionId: 's1', cwd })}\n`, 'utf8');
    // Place the em dash's FIRST byte on the last byte of the first read, so its
    // remaining two bytes land in the next one.
    const dashAt = line2.indexOf(Buffer.from('—', 'utf8'));
    const want = CHUNK - 1 - dashAt;
    const empty = Buffer.byteLength(`${JSON.stringify({ type: 'summary', pad: '' })}\n`);
    const line1 = Buffer.from(`${JSON.stringify({ type: 'summary', pad: 'a'.repeat(want - empty) })}\n`, 'utf8');
    expect(line1.length).toBe(want); // the fixture itself, before it proves anything

    const files = fileAt('straddle.jsonl', Buffer.concat([line1, line2]));
    return expect(recordedCwd(files)).resolves.toBe(cwd);
  });

  it('finds a cwd that sits AFTER a record larger than the old 256 KB budget', async () => {
    const first = `${JSON.stringify({ type: 'summary', pad: 'a'.repeat(300 * 1024) })}\n`;
    const second = `${JSON.stringify({ type: 'user', sessionId: 's1', cwd: WORKSPACE })}\n`;
    const files = fileAt('oversized.jsonl', Buffer.from(first + second, 'utf8'));
    await expect(recordedCwd(files)).resolves.toBe(WORKSPACE);
  });

  it('asks the next transcript when the newest one records no cwd', async () => {
    const quiet = path.join(root, 'quiet.jsonl');
    fs.writeFileSync(quiet, `${JSON.stringify({ type: 'user', sessionId: 's0' })}\n`, 'utf8');
    const files = [{ path: quiet, mtimeMs: 2 }, ...fileAt('speaks.jsonl', Buffer.from(`${JSON.stringify({ cwd: WORKSPACE })}\n`, 'utf8'))];
    await expect(recordedCwd(files)).resolves.toBe(WORKSPACE);
  });

  it('a directory with no transcripts, and one with nothing but junk, both say nothing', async () => {
    await expect(recordedCwd([])).resolves.toBe('');
    await expect(recordedCwd(fileAt('junk.jsonl', Buffer.from('not json at all\n', 'utf8')))).resolves.toBe('');
  });
});

describe('the root — CLAUDE_CONFIG_DIR is Claude Code\'s own override', () => {
  it('wins over the home directory', () => {
    const dir = path.join(root, 'elsewhere');
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: dir })).toBe(dir);
    expect(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: dir })).toBe(path.join(dir, 'projects'));
  });

  it('unset (or blank) falls back to ~/.claude', () => {
    expect(claudeProjectsRoot({})).toBe(path.join(os.homedir(), '.claude', 'projects'));
    expect(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: '   ' })).toBe(path.join(os.homedir(), '.claude', 'projects'));
  });

  it('the home is the OS\'s, with USERPROFILE only as a fallback', () => {
    expect(homeDir({ USERPROFILE: 'D:\\never' })).toBe(os.homedir());
  });
});

describe('scanClaudeHistoryReport — the rows AND what the scan looked for', () => {
  it('lists the workspace\'s chats from a folded folder name, and reports the scan', async () => {
    dirWith(FOLDED, WORKSPACE);
    const { rows, scan } = await scanClaudeHistoryReport({ root, folders: [WORKSPACE] });
    expect(rows.map((r) => r.title)).toEqual(['hello there']);
    expect(rows[0].cwd).toBe(WORKSPACE);
    expect(rows[0].folder).toBe('Test_Rig');
    expect(scan).toEqual({ root, seen: 1, keys: [projectKey(WORKSPACE)] });
  });

  it('finds nothing when the root is missing, and still says what it read', async () => {
    const gone = path.join(root, 'no-such-root');
    const { rows, scan } = await scanClaudeHistoryReport({ root: gone, folders: [WORKSPACE] });
    expect(rows).toEqual([]);
    expect(scan).toEqual({ root: gone, seen: 0, keys: [projectKey(WORKSPACE)] });
  });

  // The defect the folded-key dedup caused: `Test_Rig` and `Test-Rig` are
  // two REAL workspaces that share one key. Deduping the OPEN FOLDERS by that
  // key meant the second one was never scanned at all — every chat in it
  // vanished from the popup, while the scan line still claimed it was looked for.
  it('two open folders that share a folded key are BOTH scanned, and each gets its own rows', async () => {
    dirWith(KEPT, WORKSPACE, undefined, 'sess-underscore');
    dirWith(FOLDED, NEIGHBOUR, undefined, 'sess-hyphen');

    const { rows, scan } = await scanClaudeHistoryReport({ root, folders: [WORKSPACE, NEIGHBOUR] });

    expect(rows.map((r) => r.sessionId).sort()).toEqual(['sess-hyphen', 'sess-underscore']);
    expect(rows.map((r) => r.cwd).sort()).toEqual([NEIGHBOUR, WORKSPACE].sort());
    expect(scan).toEqual({ root, seen: 2, keys: [projectKey(WORKSPACE), projectKey(NEIGHBOUR)] });
  });

  it('two open folders that share a folded key AND one directory list that session ONCE', async () => {
    dirWith(KEPT, null);
    const { rows } = await scanClaudeHistoryReport({ root, folders: [WORKSPACE, NEIGHBOUR] });
    expect(rows).toHaveLength(1);
  });
});

// One popup open used to readdir+stat the same directory up to three times
// (the match, the cwd tie-break, then the scan's own listing) and stat its
// files one after another. The listing is made once and threaded through.
describe('the cost of one popup open', () => {
  it('reads each directory ONCE and stats its transcripts concurrently', async () => {
    const dir = dirWith(KEPT, WORKSPACE);
    for (const name of ['s2', 's3', 's4']) {
      fs.writeFileSync(path.join(dir, `${name}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: name, message: { role: 'user', content: name } })}\n`, 'utf8');
    }
    const realReaddir = fs.promises.readdir;
    const realStat = fs.promises.stat;
    const listed: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    vi.spyOn(fs.promises, 'readdir').mockImplementation(((p: never, o: never) => {
      listed.push(String(p));
      return realReaddir(p, o);
    }) as typeof fs.promises.readdir);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: never) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        return await realStat(p);
      } finally {
        inFlight -= 1;
      }
    }) as typeof fs.promises.stat);

    const { rows } = await scanClaudeHistoryReport({ root, folders: [WORKSPACE] });

    expect(rows).toHaveLength(4); // the work was really done, not skipped
    expect(listed).toEqual([root, dir]); // the root once, the directory once
    expect(peakInFlight).toBeGreaterThan(1); // serial stats would never overlap
  });

  it('does no filesystem work at all when no folder is open', async () => {
    dirWith(KEPT, WORKSPACE);
    const readdir = vi.spyOn(fs.promises, 'readdir');

    const { rows, scan } = await scanClaudeHistoryReport({ root, folders: [] });

    expect(rows).toEqual([]);
    expect(scan).toEqual({ root, seen: 0, keys: [] });
    expect(readdir).not.toHaveBeenCalled();
  });
});
