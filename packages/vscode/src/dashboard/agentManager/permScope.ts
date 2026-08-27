// Agent Manager - permScope.ts (S6e): REPO-SCOPED auto-approve. S5.2 auto-allowed
// EVERY permission ask from a background agent (kind:'agent') with the toggle ON,
// so a background agent run waved through writes into the OS Temp dir and the
// user's Python Scripts dir. This narrows the auto-approve to
// asks whose filesystem paths all resolve INSIDE the session's repo root (the
// worktree lives under <repoRoot>/.origami/worktrees/<x>, so the repo-root prefix
// covers both the worktree AND the parent-repo asks S5.2 existed for). An
// out-of-repo ask is auto-DENIED with the reject option + a transcript note so the
// model adapts and the run never hangs. Pure + vscode-free so the whole decision
// unit-tests; the DashboardPanel handler only threads session.cwd + the ask through.

import path from 'node:path';
import { decidePermission, pickAllowOption, autoApproveNote, type PermOption } from './permissions';

/** The handler's decision: forward to the webview unchanged, or answer host-side
 *  with `optionId` (+ an optional transcript `note`). */
export interface PermDecision {
  action: 'auto-allow' | 'auto-deny' | 'forward';
  optionId?: string;
  note?: string;
}

// rawInput keys that carry a FILESYSTEM path/pattern to scope. `url` and `command`
// are deliberately excluded - they are not paths, and a command string cannot be
// reliably scoped; an ask with no path target scopes as vacuously in-repo (today's
// allow), so command/url asks keep their S5.2 behaviour.
const PATH_KEYS = ['filepath', 'path', 'file', 'parentDir', 'directory', 'pattern'];

/** Every filesystem path/pattern the ask carries (ACP file locations + the
 *  path-ish rawInput keys). */
export function collectPermPaths(
  locations: ReadonlyArray<{ path?: string }> | undefined,
  rawInput: unknown,
): string[] {
  const out: string[] = [];
  for (const l of locations ?? []) {
    if (l && typeof l.path === 'string' && l.path.trim()) out.push(l.path);
  }
  if (rawInput && typeof rawInput === 'object') {
    const r = rawInput as Record<string, unknown>;
    for (const k of PATH_KEYS) {
      const v = r[k];
      if (typeof v === 'string' && v.trim()) out.push(v);
    }
  }
  return out;
}

/** Ascend a session cwd to the repo root that owns it: an agent runs in the
 *  worktree <repoRoot>/.origami/worktrees/<x>, so cut at that marker; a session
 *  with no worktree marker (a plain in-repo cwd) IS its own root. Returns a
 *  forward-slash path with no trailing slash. */
export function repoRootFromCwd(cwd: string): string {
  const norm = (cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.toLowerCase().indexOf('/.origami/worktrees/');
  return idx >= 0 ? norm.slice(0, idx) : norm;
}

/** Resolve `p` (relative OR absolute) against the session `cwd`, COLLAPSING
 *  `.`/`..` to a real absolute path - this closes the traversal escapes (a
 *  relative `..\..\x`, or an absolute path with embedded `..` that merely
 *  PREFIXES the root) before the inside-repo test. win32/posix per `win`; the
 *  base cwd is absolute in practice, so this never consults the process cwd. */
export function resolvePermPath(cwd: string, p: string, win = process.platform === 'win32'): string {
  return (win ? path.win32 : path.posix).resolve(cwd, p);
}

/** Is `target` the repo root or strictly beneath it? Windows semantics on win32:
 *  case-insensitive + separator-normalised, with a prefix BOUNDARY so `C:/repo2`
 *  is NOT inside `C:/repo` (only `C:/repo` itself or `C:/repo/...`). `win`
 *  defaults to the host platform but is injectable so the matrix tests are
 *  deterministic on any OS. */
export function isPathInside(root: string, target: string, win = process.platform === 'win32'): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return win ? s.toLowerCase() : s;
  };
  const r = norm(root);
  const t = norm(target);
  if (!r) return false;
  return t === r || t.startsWith(r + '/');
}

/** The reject-family option to answer an out-of-scope ask with (reject_once,
 *  else reject_always, else null -> the caller forwards rather than inventing a
 *  denial). Mirror of pickAllowOption. */
export function pickRejectOption(options: ReadonlyArray<PermOption>): string | null {
  const reject = options.find((o) => o.kind === 'reject_once')
    ?? options.find((o) => o.kind === 'reject_always')
    ?? options.find((o) => o.kind.startsWith('reject'));
  return reject ? reject.optionId : null;
}

/** The transcript note echoed when an out-of-repo ask is auto-denied. */
export function autoDenyNote(detail: string): string {
  const d = detail.trim();
  return d ? `⚙ auto-denied out-of-repo permission: ${d}` : '⚙ auto-denied out-of-repo permission';
}

/**
 * The full auto-approve decision for one permission ask. Only a background agent
 * session with the toggle ON is answered host-side (decidePermission); everything
 * else forwards. Of those: every path in the ask is RESOLVED against the session
 * cwd (collapsing `.`/`..`) and, if EVERY resolved path is inside the repo root ->
 * ALLOW; if ANY resolves outside -> DENY. A missing allow/reject option forwards
 * unchanged (never invent consent or a denial on a surface that offers neither).
 */
export function decideAgentPermission(
  kind: 'chat' | 'agent' | undefined,
  autoApprove: boolean,
  cwd: string,
  options: ReadonlyArray<PermOption>,
  locations: ReadonlyArray<{ path?: string }> | undefined,
  rawInput: unknown,
  detail: string,
  win = process.platform === 'win32',
): PermDecision {
  if (decidePermission(kind, autoApprove) !== 'auto-allow') return { action: 'forward' };
  const root = repoRootFromCwd(cwd);
  // Resolve EVERY path against cwd (collapsing `..`) before the inside-repo test.
  const outOfRepo = collectPermPaths(locations, rawInput)
    .some((p) => !isPathInside(root, resolvePermPath(cwd, p, win), win));
  if (outOfRepo) {
    const rejectId = pickRejectOption(options);
    return rejectId !== null ? { action: 'auto-deny', optionId: rejectId, note: autoDenyNote(detail) } : { action: 'forward' };
  }
  const allowId = pickAllowOption(options);
  return allowId !== null ? { action: 'auto-allow', optionId: allowId, note: autoApproveNote(detail) } : { action: 'forward' };
}
