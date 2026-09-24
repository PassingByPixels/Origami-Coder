// The repo's optional worktree setup script, and the command that runs it. The runner order
// is a per-platform decision, not a fixed list: a repo carrying only
// `.origami/setup-script.ps1`/.cmd on Windows would pick the Windows script on a Mac too and
// hand it to `/bin/sh`, which can't run either, silently skipping a `.sh` sibling sitting
// right beside it. Off Windows the sh script wins, a lone .ps1 falls back to `pwsh`, and
// .cmd is never offered (no cmd.exe to run it).

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

/** Quote a path for the shell that will actually read it (`shell: true` means cmd.exe on
 *  Windows, /bin/sh elsewhere). Double quotes keep `$`/backtick literal under cmd but expand
 *  them under sh, so a repo path containing one would resolve to a nonexistent path; single
 *  quotes under sh expand nothing. */
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
