// cronFiles.ts — the on-disk side of a cron: its launcher script, its log
// directory, and keeping both out of git. Extracted from cronService.ts when
// the launcher-script work would have pushed it past its architecture cap.
//
// Both generated directories carry their own `.gitignore` rather than relying
// on `.git/info/exclude`: the exclude file is per-clone and shared across
// worktrees, so it would help exactly one machine and leave every other user
// with untracked noise. `.origami/crons.json` sits OUTSIDE both directories and
// stays tracked, which is the entire point of the feature.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CRON_LOG_DIR, CRON_SCRIPT_DIR, cronScriptPath } from './cronCommand';

/** `*` alone would ignore the ignore-file too, leaving it untracked and so NOT
 *  travelling with the repo — which defeats the point. The negation is what
 *  makes the rule self-carrying. */
const IGNORE_BODY = '*\n!.gitignore\n';

/**
 * Create a generated directory and give it a self-carrying .gitignore.
 * Never clobbers an existing one: a user may have widened or narrowed the rules
 * on purpose, and silently rewriting them is not ours to do.
 */
export function ensureIgnoredDir(repoRoot: string, relDir: string): void {
  const dir = path.join(repoRoot, relDir);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, IGNORE_BODY);
}

/** Both generated directories, ready for a run. Best-effort: a genuinely
 *  unwritable path surfaces when the task itself tries to write its log. */
export function ensureCronDirs(repoRoot: string): void {
  try {
    ensureIgnoredDir(repoRoot, CRON_LOG_DIR);
    ensureIgnoredDir(repoRoot, CRON_SCRIPT_DIR);
  } catch {
    /* reported by the failing run, not swallowed silently forever */
  }
}

/** Write (or rewrite) a cron's launcher. Always a full overwrite — the script
 *  is generated, so the file on disk must never lag the record. */
export function writeLauncher(repoRoot: string, id: string, body: string): void {
  ensureIgnoredDir(repoRoot, CRON_SCRIPT_DIR);
  fs.writeFileSync(cronScriptPath(repoRoot, id), body);
}

/** Remove a cron's launcher. A missing file is the desired end state. Both
 *  extensions go: a workspace that has lived on two OSes may hold a stale
 *  launcher from the other one, and pruning must not orphan it. */
export function removeLauncher(repoRoot: string, id: string): void {
  for (const platform of ['win32', 'darwin']) {
    try {
      fs.unlinkSync(cronScriptPath(repoRoot, id, platform));
    } catch {
      /* already gone */
    }
  }
}

/** Every cron id that currently has a launcher script on disk (.cmd or .sh). */
export function launcherIds(repoRoot: string): string[] {
  try {
    const ids = fs
      .readdirSync(path.join(repoRoot, CRON_SCRIPT_DIR))
      .map((f) => /^(.+)\.(cmd|sh)$/i.exec(f)?.[1])
      .filter((id): id is string => !!id);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * Delete launcher scripts with no cron behind them, returning what went.
 * Called at explicit mutation points (never during a plain read), so the pane
 * cannot delete a user's files just by being opened. Without this, a cron
 * removed by hand-editing crons.json would leave its .cmd behind forever.
 */
export function pruneOrphanLaunchers(repoRoot: string, keepIds: readonly string[]): string[] {
  const keep = new Set(keepIds);
  const pruned: string[] = [];
  for (const id of launcherIds(repoRoot)) {
    if (keep.has(id)) continue;
    removeLauncher(repoRoot, id);
    pruned.push(id);
  }
  return pruned;
}
