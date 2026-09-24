// discoveryNode.ts — the impure half of discovery: the filesystem, the child process, and the one
// setting read. Split from discovery.ts so the probe rules stay testable with no fs and no spawn.

import { CLAUDE_PATH_SETTING } from './discoveryProbes';
import type { DiscoveryDeps } from './discovery';

type Fail = { ok: false; error: string };

function reasonOf(err: NodeJS.ErrnoException & { killed?: boolean }): string {
  if (err.killed) return 'timed out after 5s';
  const code = err.code ? String(err.code) : '';
  const first = String(err.message ?? '').split('\n')[0]!.trim();
  return (code ? `${code}: ` : '') + first.slice(0, 140);
}

/**
 * `<binary> --version`.
 *
 * A .cmd/.bat shim must go through the shell: Node refuses to spawn a batch file directly since the
 *  CVE-2024-27980 fix (EINVAL), which would otherwise break an npm -g install on Windows. The path
 *  is quoted because `%APPDATA%` can contain a space.
 */
function runVersion(binary: string, shell: boolean): Promise<{ ok: true; stdout: string } | Fail> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cp = require('node:child_process') as typeof import('node:child_process');
  const opts = { timeout: 5_000, windowsHide: true } as const;
  return new Promise((resolve) => {
    const done = (err: unknown, stdout: string) =>
      resolve(err ? { ok: false, error: reasonOf(err as NodeJS.ErrnoException) } : { ok: true, stdout });
    try {
      if (shell) cp.exec(`"${binary}" --version`, opts, (e, out) => done(e, String(out)));
      else cp.execFile(binary, ['--version'], opts, (e, out) => done(e, String(out)));
    } catch (e) {
      resolve({ ok: false, error: reasonOf(e as NodeJS.ErrnoException) });
    }
  });
}

/**
 * `origamicoder.claudeCode.path`, or '' when unset or unreachable.
 *
 * Declared `"scope": "machine"` in package.json, so VS Code refuses to read it from a workspace or
 *  folder settings file — a repository cannot name the executable this extension spawns.
 */
export function settingValue(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode') as typeof import('vscode');
    return vscode.workspace.getConfiguration().get<string>(CLAUDE_PATH_SETTING) ?? '';
  } catch { return ''; }
}

/** The real deps. One function, so every impure line this feature has is here. */
export function nodeDiscoveryDeps(): DiscoveryDeps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const win = process.platform === 'win32';
  return {
    platform: process.platform,
    env: process.env,
    setting: settingValue,
    stat: (p) => {
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) return 'other';
        // No exec bit on Windows; on POSIX a file nobody may run is not a
        // candidate, and saying so is more useful than "missing".
        return win || (st.mode & 0o111) !== 0 ? 'file' : 'other';
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : 'other';
      }
    },
    listDir: (dir) => { try { return fs.readdirSync(dir); } catch { return []; } },
    realpath: (p) => { try { return fs.realpathSync.native(p); } catch { return p; } },
    version: runVersion,
    which: async () => {
      const cmd = win ? 'where' : 'which';
      const out = await runVersionless(cmd, 'claude');
      if (!out.ok) return { hits: [], detail: `${cmd} claude → ${out.error}` };
      const hits = out.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      return { hits, detail: hits.length ? `${cmd} claude → ${hits.length} hit(s)` : `${cmd} claude → no output` };
    },
  };
}

/** `where claude` / `which claude`. Same shape as runVersion, different args. */
function runVersionless(cmd: string, arg: string): Promise<{ ok: true; stdout: string } | Fail> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cp = require('node:child_process') as typeof import('node:child_process');
  return new Promise((resolve) => {
    try {
      cp.execFile(cmd, [arg], { timeout: 5_000, windowsHide: true }, (err, stdout) =>
        resolve(err ? { ok: false, error: reasonOf(err as NodeJS.ErrnoException) } : { ok: true, stdout: String(stdout) }));
    } catch (e) { resolve({ ok: false, error: reasonOf(e as NodeJS.ErrnoException) }); }
  });
}
