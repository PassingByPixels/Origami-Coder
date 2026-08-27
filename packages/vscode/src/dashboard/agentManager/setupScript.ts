// The repo's optional worktree setup script, and the command that runs it.
//
// EXTRACTED from run.ts (299/300, no room) when the runner order stopped being one
// fixed list and became a per-platform DECISION. The rule is small but it is a
// rule, and it is easier to assert on a leaf than on a branch buried in the create
// lifecycle.
//
// WHY THE ORDER IS NOT FIXED. A repo checked in on Windows carries
// `.origami/setup-script.ps1` (or `.cmd`). Searched Windows-first on a Mac, one of
// those wins, and `runGate` hands it to `/bin/sh` — which can run neither — while
// the `.sh` sibling sitting right beside it is never reached. The failure is
// non-fatal (run.ts records a setupNote and carries on), which is exactly what
// makes it worth fixing: the worktree is provisioned unprepared and the note blames
// the script rather than the platform. So off Windows the sh script wins, a lone
// .ps1 falls back to PowerShell Core (`pwsh` — the only PowerShell there is off
// Windows), and .cmd is never offered at all: there is no cmd.exe to run it.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Script file -> runner, most preferred first, for ONE platform. */
function runners(platform: string): ReadonlyArray<readonly [string, string]> {
  if (platform === 'win32') {
    return [
      ['setup-script.ps1', 'powershell -NoProfile -ExecutionPolicy Bypass -File'],
      ['setup-script.cmd', 'cmd /c'],
      ['setup-script.sh', 'sh'],
    ];
  }
  return [
    ['setup-script.sh', 'sh'],
    ['setup-script.ps1', 'pwsh -NoProfile -File'],
  ];
}

/**
 * Quote a path for the shell that will actually read it. `runGate` runs the command
 * with `shell: true`, so it is parsed by cmd.exe on Windows and by /bin/sh
 * elsewhere. Double quotes keep a `$` or a backtick literal under cmd but EXPAND
 * them under sh, so a repo living in a directory named with one would be pointed at
 * a path that does not exist. Inside single quotes sh expands nothing; the only
 * escape needed is the quote itself, reopened the usual `'\''` way.
 */
export function shellQuote(p: string, platform: string): string {
  if (platform === 'win32') return `"${p}"`;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Find the repo's optional worktree setup script (Kilo's .kilo/setup-script). */
export function findSetupScript(
  repoRoot: string,
  platform: string = process.platform,
): { command: string; label: string } | undefined {
  for (const [file, runner] of runners(platform)) {
    const p = path.join(repoRoot, '.origami', file);
    if (fs.existsSync(p)) return { command: `${runner} ${shellQuote(p, platform)}`, label: file };
  }
  return undefined;
}
