// How a worktree's git state READS, shared by the two surfaces that show it: the
// composer's branch pill and the Agent Manager's repo card. Pure — no DOM, no vscode
// api — so the wording and the clean/dirty rule are testable without a render.
//
// MIRROR of `WorktreeState` in src/dashboard/worktreeState.ts. tsconfig.webview pins
// rootDir to webview/, so a .ts leaf here cannot import from src/ even as a type
// (TS6059). `worktreeStateView.test.ts` reads both files and fails when the field
// lists drift apart.
//
// Every field is OPTIONAL ON THE WIRE. An engine or a host that never sends
// `worktreeState` leaves `worktreeStateOf` returning undefined, and both consumers
// render nothing at all — not a zeroed "clean" dot, which would be a claim nobody made.

export interface WorktreeStateView {
  dirty: number;
  ahead: number;
  behind: number;
  detached: boolean;
}

/** The mirrored field list the drift guard compares against the host's. */
export const WORKTREE_STATE_FIELDS = ['dirty', 'ahead', 'behind', 'detached'] as const;

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Read a `worktreeState` message's payload. undefined for anything that is not an
 *  object — the "no such field" case, which must render nothing rather than throw. */
export function worktreeStateOf(value: unknown): WorktreeStateView | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  return {
    dirty: count(v.dirty),
    ahead: count(v.ahead),
    behind: count(v.behind),
    detached: v.detached === true,
  };
}

/** Directory keys compare case-insensitively with separators and trailing slashes
 *  normalised: the host echoes back the string it was given, and a card asking with a
 *  backslash path must still match a pill asking with forward slashes. */
export function dirKey(dir: string | undefined): string {
  return (dir || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** A tree with nothing uncommitted is clean whatever its ahead/behind — those are the
 *  branch's position, not the working directory's. */
export function worktreeClean(s: WorktreeStateView): boolean {
  return s.dirty === 0;
}

/** The card's one-line counts: only the non-zero parts, so a clean synced tree reads
 *  as the empty string and the card stays as lean as it was. */
export function worktreeCounts(s: WorktreeStateView): string {
  const parts: string[] = [];
  if (s.dirty) parts.push(`${s.dirty}~`);
  if (s.ahead) parts.push(`↑${s.ahead}`);
  if (s.behind) parts.push(`↓${s.behind}`);
  if (s.detached) parts.push('detached');
  return parts.join(' ');
}

/** The pill's tooltip: words, not glyphs, because the dot alone says nothing. */
export function worktreeTip(s: WorktreeStateView): string {
  const parts: string[] = [];
  parts.push(s.dirty === 1 ? '1 change' : `${s.dirty} changes`);
  if (s.ahead) parts.push(`${s.ahead} ahead`);
  if (s.behind) parts.push(`${s.behind} behind`);
  if (s.detached) parts.push('detached HEAD');
  return parts.join(' · ');
}
