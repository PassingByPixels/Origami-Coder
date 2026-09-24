// REPO-SCOPED auto-approve: narrows the old behaviour (auto-allow every ask from a
// background agent) to asks whose filesystem paths all resolve inside the session's repo
// root, which covers both the worktree and the parent-repo asks the old behaviour existed
// for. An out-of-repo ask is auto-DENIED with a transcript note so the model adapts and the
// run never hangs.

import path from 'node:path';
import { decidePermission, pickAllowOption, autoApproveNote, type PermOption } from './permissions';

/** The handler's decision: forward to the webview unchanged, or answer host-side
 *  with `optionId` (+ an optional transcript `note`). */
export interface PermDecision {
  action: 'auto-allow' | 'auto-deny' | 'forward';
  optionId?: string;
  note?: string;
}

// rawInput keys that carry a filesystem path/pattern to scope; `url`/`command` are excluded
// (not paths, and a command string can't be reliably scoped), so those asks keep the old
// behaviour.
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

/** Ascend a session cwd to the repo root that owns it: cut at the `.origami/worktrees/`
 *  marker; a plain in-repo cwd is its own root. */
export function repoRootFromCwd(cwd: string): string {
  const norm = (cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.toLowerCase().indexOf('/.origami/worktrees/');
  return idx >= 0 ? norm.slice(0, idx) : norm;
}

/** Resolve `p` against the session cwd, collapsing `.`/`..` to a real absolute path — this
 *  closes traversal escapes (a relative `..\..\x`, or an absolute path that merely prefixes
 *  the root) before the inside-repo test. */
export function resolvePermPath(cwd: string, p: string, win = process.platform === 'win32'): string {
  return (win ? path.win32 : path.posix).resolve(cwd, p);
}

/** Is `target` the repo root or strictly beneath it? Windows: case-insensitive +
 *  separator-normalised, with a prefix boundary so a sibling repo isn't misread as inside. */
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

/** The reject-family option for an out-of-scope ask (reject_once, else reject_always, else
 *  null — the caller forwards rather than inventing a denial). */
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

/** The full auto-approve decision for one ask: only a background agent session with the
 *  toggle ON is answered host-side. Every resolved path must be inside the repo root to
 *  ALLOW; any outside resolves to DENY. A missing allow/reject option forwards unchanged —
 *  never invent consent or a denial. */
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
