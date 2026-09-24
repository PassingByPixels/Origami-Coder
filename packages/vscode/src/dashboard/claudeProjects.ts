// claudeProjects.ts — WHERE a workspace's Claude Code transcripts are, as
// ONE answer shared by History, the Labyrinth, resume and discovery.
//
// The directory name on disk is written by the CLI, not computed here: it
// has been seen to fold `_` to `-` and lower-case a drive letter
// inconsistently, so this SCANS the root and compares folded keys rather
// than building a name.
//
// THE FOLDED KEY IS FOR DISCOVERY ONLY. It is lossy on purpose — `Foo_Bar`
// and `Foo-Bar` share one key — so it may only ever WIDEN a search. Anything
// deciding identity or permission (which directory is really this workspace's,
// whether a picked folder is one the user has open) compares resolved PATHS
// through `samePath`/`pathUnder`, never the key.
// `CLAUDE_CONFIG_DIR` overrides the root when set.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordedCwd } from './claudeRecordedCwd';

/** The comparable form of a workspace path OR a transcript directory name.
 *  DISCOVERY ONLY — see the header. */
export function projectKey(value: string): string {
  return (value ?? '').replace(/[\\/:. _]/g, '-').toLowerCase();
}

/** Separators and trailing slashes normalised, case folded. */
function fold(value: string): string {
  return (value ?? '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** The path as the filesystem itself spells it — real casing, links and `..`
 *  resolved. A path that does not exist cannot be resolved, so it comes back
 *  as written and the string compare above is the answer.
 *
 *  A MIRROR of @origami/core's `FSUtil.normalizePath`, not an import: that
 *  package is unresolvable from this one and pulls in `effect` (the same
 *  reason configShape.ts mirrors the config schema). */
function resolvedPath(value: string): string {
  try {
    return fs.realpathSync.native(path.resolve(value));
  } catch {
    return value;
  }
}

/** Two spellings of ONE directory. Compared as written first, then resolved —
 *  resolving is what a string compare alone cannot do. This is the compare
 *  every identity and permission check uses; `projectKey` is not. */
export function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return fold(a) === fold(b) || fold(resolvedPath(a)) === fold(resolvedPath(b));
}

/** True when `child` names `parent` itself or a directory inside it. The
 *  tie-break needs this: a Claude session routinely records a cwd that is a
 *  SUB-FOLDER of the workspace it belongs to, and an exact compare would call
 *  the right directory a stranger. */
export function pathUnder(parent: string, child: string): boolean {
  if (samePath(parent, child)) return true;
  const inside = (p: string, c: string) => !!p && !!c && fold(c).startsWith(`${fold(p)}\\`);
  return inside(parent, child) || inside(resolvedPath(parent), resolvedPath(child));
}

/** The user's home, `USERPROFILE`/`HOME` when the OS cannot say. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const home = os.homedir();
    if (home) return home;
  } catch { /* no passwd entry / no HOME — the environment still may know */ }
  return env.USERPROFILE || env.HOME || '';
}

/** `CLAUDE_CONFIG_DIR` if set, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.CLAUDE_CONFIG_DIR ?? '').trim();
  return override || path.join(homeDir(env), '.claude');
}

/** Where Claude Code keeps the transcript directories. */
export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(claudeConfigDir(env), 'projects');
}

/** One transcript directory as the scan sees it. */
export interface ProjectDir {
  name: string;
  path: string;
  key: string;
}

/** Every directory in the projects root. Never throws: a missing root is an
 *  empty list, which every caller already has to be able to draw. */
export async function listProjectDirs(root: string): Promise<ProjectDir[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(root, e.name), key: projectKey(e.name) }));
}

/** One transcript file, with the mtime the listing already paid for. */
export interface TranscriptFile {
  path: string;
  mtimeMs: number;
}

/** Every transcript in one project directory, newest by mtime first. Stat'ed
 *  ONCE and concurrently; the caller slices to the count it wants rather than
 *  asking this to list the directory again for a shorter answer. */
export async function newestTranscripts(dir: string, maxFiles = Number.POSITIVE_INFINITY): Promise<TranscriptFile[]> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.jsonl'));
  } catch {
    return [];
  }
  const stated = await Promise.all(names.map(async (name): Promise<TranscriptFile | null> => {
    const full = path.join(dir, name);
    try {
      const st = await fs.promises.stat(full);
      return st.isFile() ? { path: full, mtimeMs: st.mtimeMs } : null;
    } catch {
      return null; // vanished between readdir and stat — not a row, and not an error
    }
  }));
  const files = stated.filter((f): f is TranscriptFile => f !== null);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, Math.max(0, maxFiles));
}

/** One matching transcript directory and the transcripts the match already
 *  listed — so no caller reads the same directory a second time. */
export interface ProjectDirMatch {
  dir: string;
  /** Newest by mtime first. */
  files: TranscriptFile[];
}

/**
 * The transcript directories that belong to one workspace folder, best first.
 *
 * The folded key finds CANDIDATES; a recorded `cwd` decides between them. A
 * candidate is CONFIRMED when a cwd it recorded is the workspace or a folder
 * inside it, REFUTED when a cwd it recorded names somewhere else, and SILENT
 * when none of its transcripts says. Confirmed first, then silent: a silent
 * candidate is never dropped for a confirmed sibling, because dropping it
 * would lose a real conversation in exchange for looking decisive. Only a
 * REFUTED candidate goes — it is the only one provably not this workspace's.
 */
export async function matchProjectDirs(
  root: string,
  cwd: string,
  known?: readonly ProjectDir[],
): Promise<ProjectDirMatch[]> {
  const key = projectKey(cwd);
  if (!key) return [];
  const hits = (known ?? await listProjectDirs(root)).filter((d) => d.key === key);
  if (hits.length === 0) return [];
  const ranked = await Promise.all(hits.map(async (hit) => {
    const files = await newestTranscripts(hit.path);
    // ONE candidate needs no tie-break, and reading a 257 MB directory's
    // newest transcript to confirm what nothing disputes is a cost for nothing.
    const says = hits.length > 1 ? await recordedCwd(files) : '';
    return { dir: hit.path, files, rank: !says ? 1 : pathUnder(cwd, says) ? 0 : 2 };
  }));
  return ranked
    .filter((r) => r.rank < 2)
    .sort((a, b) => a.rank - b.rank || (b.files[0]?.mtimeMs ?? 0) - (a.files[0]?.mtimeMs ?? 0))
    .map(({ dir, files }) => ({ dir, files }));
}
