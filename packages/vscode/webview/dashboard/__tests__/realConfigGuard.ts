// A test may NEVER write the developer's own global origami config.
//
// On 2026-08-15 at 21:30:26 one did, and took 42 ms to do it five times. The
// config-structural slice was mid-TDD: the writers in firstFold.ts still
// resolved `path.join(os.homedir(), '.config', ...)` — the F5 defect the slice
// was written to remove — while configWriters.test.ts already pointed
// XDG_CONFIG_HOME at a temp dir and seeded its fixture there. So the test's own
// helpers wrote the temp dir and the writers UNDER TEST wrote the real one. The
// gap between them IS the defect the failing test was measuring, which is why
// the leak arrived with the test rather than despite it. The real file lost
// provider.vllm's name, its baseURL and all ten of its models
// (removeProviderConfig, then writeModelConfig recreating a bare block), gained
// a provider `x`, and had `model` re-pointed four times.
//
// Per-test XDG is not the defence, and this file does not rest on it:
//   - the writers honour XDG_CONFIG_HOME only while the path code is correct,
//     and it was the path code being wrong that caused this;
//   - three suites deliberately `delete process.env.XDG_CONFIG_HOME` to pin the
//     ~/.config branch, and keep it in a temp dir by mocking node:os. A mock
//     that fails to apply hands the real home straight back.
//
// So the defence is the module mock below. It intercepts at fs itself, matches
// on the RESOLVED PATH, and does not care which of the above went wrong. It is
// prevention, not detection: it throws before calling through, so the byte
// never reaches the disk. vi.mock rather than monkey-patching because a
// namespace import (`import * as fs from 'node:fs'` — what every writer in
// src/dashboard uses) cannot be patched from outside; measured, not assumed.
//
// The mtime check in afterEach is the second line, for the write paths a module
// mock cannot reach: an externalized dependency, a child process, a native
// addon. It can only report, which is exactly why it is not the first.

import { afterEach, vi } from 'vitest';

/** Resolved through `process.getBuiltinModule` (Node >= 22.3), which returns the
 *  genuine builtin whatever the module graph has been told to believe — so this
 *  is the developer's REAL home even inside the suites that mock node:os away.
 *  A plain `import * as os` would not do: this file mocks node:fs below, and a
 *  setup file's own imports resolve through the same mocked registry. */
const { REAL_CONFIG_DIR, REAL_CONFIG_FILE, REAL_REPOS_FILE } = vi.hoisted(() => {
  const os = process.getBuiltinModule('os');
  const path = process.getBuiltinModule('path');
  const dir = path.resolve(os.homedir(), '.config', 'origami');
  return {
    REAL_CONFIG_DIR: dir,
    REAL_CONFIG_FILE: path.join(dir, 'origami.json'),
    // The board's SHARED repo registry. Guarded as a file rather than by
    // guarding all of ~/.origami, which also holds sessions, settings.toml and
    // spend.json - surfaces this rule was never written about. A PREFIX match,
    // so the atomic write's `repos.json.tmp-<pid>` sibling is caught too: the
    // rename that would publish it is refused either way, and a stray tmp file
    // in the developer's own home is still litter nobody asked for.
    REAL_REPOS_FILE: path.resolve(os.homedir(), '.origami', 'repos.json'),
  };
});

const realFs = process.getBuiltinModule('fs');
const realPath = process.getBuiltinModule('path');
const realOs = process.getBuiltinModule('os');

/** The one directory every test in this package is forbidden to write. */
export function guardedDir(): string {
  return REAL_CONFIG_DIR;
}

/** True when `target` is the guarded directory or anything under it. String,
 *  Buffer and file: URL targets are all resolved; a numeric fd is not a path,
 *  and is left alone. */
export function isGuarded(target: unknown): boolean {
  let p: string;
  if (typeof target === 'string') p = target;
  else if (Buffer.isBuffer(target)) p = target.toString('utf8');
  else if (target instanceof URL && target.protocol === 'file:') {
    p = decodeURIComponent(target.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  } else return false;
  // Windows compares case-insensitively; the separator keeps a sibling whose
  // name merely starts with the guarded one (~/.config/origami-tickets) out.
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const resolved = fold(realPath.resolve(p));
  const dir = fold(REAL_CONFIG_DIR);
  if (resolved === dir || resolved.startsWith(dir + realPath.sep)) return true;
  return resolved.startsWith(fold(REAL_REPOS_FILE)); // the file itself + its .tmp- sibling
}

/** The red a leaking test gets. Names the operation and the path, because the
 *  useful question after this fires is "which writer, pointed where". */
export function assertNotGuarded(op: string, target: unknown): void {
  if (!isGuarded(target)) return;
  throw new Error(
    `TEST LEAK: fs.${op} targeted the real user config at ${String(target)}. `
    + `Tests must never write ${REAL_CONFIG_DIR} — point XDG_CONFIG_HOME at a temp dir `
    + `(configWriters.test.ts) or mock the writer. Nothing was written.`,
  );
}

// --- what gets wrapped ----------------------------------------------------
// Argument positions differ per call, so each name carries the indexes that
// hold a path. rename and copyFile carry two: a rename OUT of the guarded dir
// destroys the file just as thoroughly as a write into it.

// The fd-taking calls (writeSync, ftruncateSync, fchmodSync…) are deliberately
// absent: an fd for a file in the guarded dir can only come from open/openSync
// with a write flag, which is refused below, so there is no path to them.

const PATH_ARGS: Record<string, number[]> = {
  writeFileSync: [0], appendFileSync: [0], truncateSync: [0],
  renameSync: [0, 1], copyFileSync: [0, 1], unlinkSync: [0], rmSync: [0],
  rmdirSync: [0], mkdirSync: [0], openSync: [0], createWriteStream: [0],
  cpSync: [1], chmodSync: [0], utimesSync: [0], symlinkSync: [1],
  writeFile: [0], appendFile: [0], truncate: [0], rename: [0, 1],
  copyFile: [0, 1], unlink: [0], rm: [0], rmdir: [0], open: [0], mkdir: [0],
  cp: [1], chmod: [0], utimes: [0], symlink: [1],
};

/** `open`/`openSync` are the READ path too, so only write-intent flags count. */
function writesOnOpen(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;            // defaults to 'r'
  if (typeof flags === 'number') return (flags & 0o3) !== 0 || (flags & 0o100) !== 0;
  if (typeof flags !== 'string') return false;
  return /[wa+]/.test(flags);
}

type AnyFn = (...args: unknown[]) => unknown;
export const GUARD_MARK = '__origamiRealConfigGuard';

function wrap(name: string, indexes: number[], original: AnyFn): AnyFn {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (name === 'openSync' || name === 'open') {
      if (writesOnOpen(args[1])) assertNotGuarded(name, args[0]);
    } else if (name === 'mkdirSync' || name === 'mkdir') {
      // A recursive mkdir of a directory that already exists is a no-op, and
      // failing it would be noise. Only a mkdir that would CREATE counts.
      if (!realFs.existsSync(String(args[0]))) assertNotGuarded(name, args[0]);
    } else {
      for (const i of indexes) assertNotGuarded(name, args[i]);
    }
    return original.apply(this, args);
  };
  Object.defineProperty(wrapped, GUARD_MARK, { value: true });
  Object.defineProperty(wrapped, 'name', { value: name });
  return wrapped;
}

/** Wrap every write call in a module namespace, leaving everything else — the
 *  readers, the classes, the constants — exactly as it was. */
function guardModule(actual: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...actual };
  for (const [name, indexes] of Object.entries(PATH_ARGS)) {
    const fn = out[name];
    if (typeof fn === 'function' && !(fn as Record<string, unknown>)[GUARD_MARK]) {
      out[name] = wrap(name, indexes, fn as AnyFn);
    }
  }
  return out;
}

/** node:fs and fs are the same module under two specifiers, and vitest keys the
 *  registry by specifier — so both are declared. `promises` is wrapped inside
 *  the same pass, and fs/promises separately, because a future writer reaching
 *  for the async API must hit the same wall. */
function fsMock(actual: Record<string, unknown>): Record<string, unknown> {
  const out = guardModule(actual);
  const promises = actual.promises as Record<string, unknown> | undefined;
  if (promises) out.promises = guardModule(promises);
  out.default = { ...out };
  return out;
}

vi.mock('node:fs', async (importOriginal) => fsMock(await importOriginal()));
vi.mock('fs', async (importOriginal) => fsMock(await importOriginal()));
vi.mock('node:fs/promises', async (importOriginal) => {
  const out = guardModule(await importOriginal<Record<string, unknown>>());
  out.default = { ...out };
  return out;
});
vi.mock('fs/promises', async (importOriginal) => {
  const out = guardModule(await importOriginal<Record<string, unknown>>());
  out.default = { ...out };
  return out;
});

// --- XDG, so the CORRECT code has a temp dir to land in -------------------
// The second defence, not the first: it only helps while the path helper is
// right. One dir per process, reused by the files that share a worker, left in
// the OS temp dir rather than removed — a suite that fails mid-run should still
// have its artefacts.
const XDG_PREFIX = realPath.join(realOs.tmpdir(), 'origami-vitest-xdg-');
if (!process.env.XDG_CONFIG_HOME?.startsWith(XDG_PREFIX)) {
  const dir = `${XDG_PREFIX}${process.pid}`;
  realFs.mkdirSync(dir, { recursive: true });
  process.env.XDG_CONFIG_HOME = dir;
}

// Same second defence for the board's shared repo registry: repoFile.ts reads
// ORIGAMI_REPOS_HOME before the real home, so a suite that drives the manager
// (which resolves a repo's primary checkout on every broadcast) lands in a temp
// dir instead of the developer's own ~/.origami/repos.json.
const REPOS_PREFIX = realPath.join(realOs.tmpdir(), 'origami-vitest-repos-');
if (!process.env.ORIGAMI_REPOS_HOME?.startsWith(REPOS_PREFIX)) {
  const dir = `${REPOS_PREFIX}${process.pid}`;
  realFs.mkdirSync(dir, { recursive: true });
  process.env.ORIGAMI_REPOS_HOME = dir;
}

// --- backstop -------------------------------------------------------------
// Reports what the mock could not prevent. One stat per test.

function stamp(): string {
  try {
    const s = realFs.statSync(REAL_CONFIG_FILE);
    return `${s.size}@${s.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

const AT_START = stamp();

afterEach(() => {
  const now = stamp();
  if (now !== AT_START) {
    throw new Error(
      `TEST LEAK (past the fs mock): ${REAL_CONFIG_FILE} changed during this test `
      + `(${AT_START} -> ${now}). Something wrote the real user config through a path this `
      + `guard does not intercept.`,
    );
  }
});
