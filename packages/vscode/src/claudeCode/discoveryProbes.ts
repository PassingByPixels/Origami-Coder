// discoveryProbes.ts — the candidate table discovery.ts walks: data plus one directory scan.
// Every candidate is built from the platform, the environment, or a machine-scoped setting — never
// from a file a repository carries. `origamicoder.claudeCode.path` is scope:"machine" for that
// reason (the foreign-agents def-origin lesson: a checked-in config naming the executable to spawn
// is arbitrary code execution).

/** The MACHINE-scoped override. Declared once here so package.json, the
 *  tooltip, the diagnostics and the cache-invalidation watcher cannot drift. */
export const CLAUDE_PATH_SETTING = 'origamicoder.claudeCode.path';

/** Where a candidate came from. The order of this list IS the probe order. */
export type ProbeSource =
  | 'setting' | 'path' | 'npm-global' | 'native-install' | 'vscode-extension' | 'system';

/** Probe order, and the human labels the tooltip and the diagnostics use. */
export const SOURCE_LABELS: ReadonlyArray<readonly [ProbeSource, string]> = [
  ['setting', 'origamicoder.claudeCode.path'],
  ['path', 'PATH'],
  ['npm-global', 'npm global'],
  ['native-install', 'native install'],
  ['vscode-extension', 'VS Code extension'],
  ['system', 'system install'],
];

export function sourceLabel(source: ProbeSource): string {
  return SOURCE_LABELS.find(([s]) => s === source)?.[1] ?? source;
}

export interface Candidate {
  source: ProbeSource;
  path: string;
  /**
   * True when cmd.exe must interpret the file (a .cmd/.bat shim): Node's spawn refuses a batch file
   *  without a shell since the CVE-2024-27980 fix.
   */
  shell: boolean;
}

type Env = Record<string, string | undefined>;

/**
 * win32 rows, in probe order after PATH. A row whose env variable is unset is dropped rather than
 *  half-expanded. `claude.ps1` is deliberately excluded — cmd.exe cannot execute it, and PowerShell
 *  is not the shell this extension spawns with.
 */
const WIN32_TABLE: ReadonlyArray<readonly [ProbeSource, string]> = [
  ['npm-global', '${APPDATA}\\npm\\claude.cmd'],
  ['native-install', '${USERPROFILE}\\.claude\\local\\claude.exe'],
  ['native-install', '${USERPROFILE}\\.claude\\local\\bin\\claude.exe'],
  ['native-install', '${USERPROFILE}\\.local\\bin\\claude.exe'],
];

/** win32 machine-wide installers (MSI, winget). LAST, after the extension's own
 *  copy, because they are the least likely to be the build the user is running. */
const WIN32_SYSTEM_TABLE: ReadonlyArray<readonly [ProbeSource, string]> = [
  ['system', '${LOCALAPPDATA}\\Programs\\claude\\claude.exe'],
  ['system', '${LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\claude.exe'],
  ['system', '${PROGRAMFILES}\\Claude\\claude.exe'],
];

/** darwin/linux rows. Homebrew's Apple-silicon prefix is separate from
 *  /usr/local because the two are different machines' idea of "installed". */
const POSIX_TABLE: ReadonlyArray<readonly [ProbeSource, string]> = [
  ['npm-global', '${HOME}/.npm-global/bin/claude'],
  ['npm-global', '/usr/local/bin/claude'],
  ['npm-global', '/opt/homebrew/bin/claude'],
  ['native-install', '${HOME}/.claude/local/claude'],
  ['native-install', '${HOME}/.claude/local/bin/claude'],
  ['native-install', '${HOME}/.local/bin/claude'],
];

/** Roots the Claude Code VS Code extension unpacks into. Insiders and the
 *  remote/server root are here because a work PC is exactly where the extension
 *  host is not the plain desktop one. */
const WIN32_EXT_ROOTS = [
  '${USERPROFILE}\\.vscode\\extensions',
  '${USERPROFILE}\\.vscode-insiders\\extensions',
  '${USERPROFILE}\\.vscode-server\\extensions',
];
const POSIX_EXT_ROOTS = [
  '${HOME}/.vscode/extensions',
  '${HOME}/.vscode-insiders/extensions',
  '${HOME}/.vscode-server/extensions',
];

/** Expand one template, or null when a variable it names is unset. */
export function expand(template: string, env: Env): string | null {
  let missing = false;
  const out = template.replace(/\$\{(\w+)\}/g, (_m, name: string) => {
    const v = env[name];
    if (!v) { missing = true; return ''; }
    return v;
  });
  return missing ? null : out;
}

/** `anthropic.claude-code-2.1.258-win32-x64` → [2,1,258]. */
const EXT_DIR = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/;

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0; const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The newest bundled binary the Claude Code extension has unpacked, or null.
 *
 * Sorted numerically per version segment, not as a string — a string sort would put 2.1.9 after
 *  2.1.258, and the extension keeps every version it has ever installed.
 */
export function extensionBinary(platform: string, env: Env, listDir: (dir: string) => string[]): string | null {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const exe = win ? 'claude.exe' : 'claude';
  let best: { v: number[]; path: string } | null = null;
  for (const template of win ? WIN32_EXT_ROOTS : POSIX_EXT_ROOTS) {
    const root = expand(template, env);
    if (root === null) continue;
    for (const name of listDir(root)) {
      const m = EXT_DIR.exec(name);
      if (!m) continue;
      const v = m[1]!.split('.').map((n) => Number(n) || 0);
      if (best && !newer(v, best.v)) continue;
      best = { v, path: [root, name, 'resources', 'native-binary', exe].join(sep) };
    }
  }
  return best?.path ?? null;
}

/** True for a shim cmd.exe has to interpret. */
export function needsShell(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}

/**
 * Every file candidate, in probe order: npm-global, native-install, vscode-extension, system. The
 *  `setting` and `path` sources are handled separately by discovery.ts, before these.
 */
export function fileCandidates(platform: string, env: Env, listDir: (dir: string) => string[]): Candidate[] {
  const out: Candidate[] = [];
  const push = (source: ProbeSource, path: string | null) => {
    if (path !== null) out.push({ source, path, shell: needsShell(path) });
  };
  const win = platform === 'win32';
  for (const [source, template] of win ? WIN32_TABLE : POSIX_TABLE) push(source, expand(template, env));
  push('vscode-extension', extensionBinary(platform, env, listDir));
  for (const [source, template] of win ? WIN32_SYSTEM_TABLE : []) push(source, expand(template, env));
  return out;
}
