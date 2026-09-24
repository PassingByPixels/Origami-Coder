// One git read of a working directory's state, shared by two consumers: the composer's
// branch pill and the Agent Manager's repo card. A leaf, not panel code, for the reason
// repoPicker.ts gives — the panel is at its cap and this has one job.
//
// ONE SOURCE, TWO CONSUMERS is the point of the throttle. Both surfaces ask for the same
// directory, independently, whenever they become visible. Running git twice for that would
// double the cost of every reveal, so a read inside WORKTREE_POLL_MS is answered from the
// last one. The second asker is still ANSWERED — a throttle that stayed silent would leave
// whichever surface asked second with no dot at all.
//
// Nothing here polls on a timer. The webview asks, so the reads stop when the webview is
// hidden without the host needing a visibility signal of its own.

import { runGitStdout } from './agentManager/worktrees';

export const WORKTREE_STATE_MESSAGE_TYPES = new Set(['requestWorktreeState']);

/** No repeat git read of the same directory inside this window. */
export const WORKTREE_POLL_MS = 5_000;

export interface WorktreeState {
  /** Entry lines in `status --porcelain=v2`: staged, unstaged, unmerged and untracked.
   *  Untracked counts — a directory full of new files is not clean. */
  dirty: number;
  ahead: number;
  behind: number;
  detached: boolean;
}

export interface WorktreeStateHost {
  post(message: Record<string, unknown>): void;
  /** Tests inject the porcelain text. Production omits it and git runs. */
  read?(dir: string): Promise<string | undefined>;
  /** Tests inject a clock to exercise the throttle without waiting. */
  now?(): number;
}

/** Parse `git status --porcelain=v2 --branch`.
 *
 *  Header lines are `# branch.head <name|(detached)>` and `# branch.ab +<n> -<n>`; `ab` is
 *  ABSENT with no upstream, which is not the same as zero — a branch nobody pushed yet reads
 *  as 0/0 rather than claiming to be behind. Entry lines are `1 `/`2 ` (changed, renamed),
 *  `u ` (unmerged) and `? ` (untracked); `! ` (ignored) is never counted and only appears
 *  under --ignored anyway. */
export function parseStatusV2(stdout: string): WorktreeState {
  const state: WorktreeState = { dirty: 0, ahead: 0, behind: 0, detached: false };
  for (const line of (stdout || '').split('\n')) {
    if (line.startsWith('# branch.head ')) {
      state.detached = line.slice('# branch.head '.length).trim() === '(detached)';
    } else if (line.startsWith('# branch.ab ')) {
      const ab = /\+(\d+)\s+-(\d+)/.exec(line);
      if (ab) {
        state.ahead = parseInt(ab[1], 10) || 0;
        state.behind = parseInt(ab[2], 10) || 0;
      }
    } else if (/^[12u?] /.test(line)) {
      state.dirty += 1;
    }
  }
  return state;
}

interface Cached { at: number; state: WorktreeState }

const cache = new Map<string, Cached>();

/** Drop the throttle memory. Tests only — two cases sharing a directory key would
 *  otherwise see each other's reads. */
export function resetWorktreeState(): void {
  cache.clear();
}

function key(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

async function readState(host: WorktreeStateHost, dir: string): Promise<string | undefined> {
  if (host.read) return host.read(dir);
  // runGitStdout, never runGit: a stderr warning merged into stdout would be counted
  // as an entry line and inflate `dirty`.
  const r = await runGitStdout(['status', '--porcelain=v2', '--branch'], dir);
  return r.ok ? r.output : undefined;
}

export async function handleWorktreeStateMessage(
  host: WorktreeStateHost,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  if (m.type !== 'requestWorktreeState') return;
  const dir = typeof m.root === 'string' ? m.root : '';
  if (!dir) return;

  const now = host.now ? host.now() : Date.now();
  const hit = cache.get(key(dir));
  if (hit && now - hit.at < WORKTREE_POLL_MS) {
    host.post({ type: 'worktreeState', root: dir, state: hit.state });
    return;
  }

  const stdout = await readState(host, dir);
  // A directory that is not a repository, or a git that failed: say nothing. The
  // consumers render no dot when no state ever arrives, which is the honest answer —
  // a zeroed state would claim the tree is clean.
  if (stdout === undefined) return;
  const state = parseStatusV2(stdout);
  cache.set(key(dir), { at: now, state });
  host.post({ type: 'worktreeState', root: dir, state });
}
