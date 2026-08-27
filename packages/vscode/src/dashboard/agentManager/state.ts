// Agent Manager - state.ts (S2): the persistent run registry, Kilo-shaped
// (.kilo/agent-manager.json -> .origami/agent-manager.json). One JSON document
// per repo holding the worktree records; sessions attach to records in S3
// (worktrees and sessions are orthogonal - many sessions may visit one
// worktree). Writes are atomic (tmp + rename), a corrupt file is backed up
// rather than clobbered, and boot reconciliation treats `git worktree list`
// as ground truth - the registry can never strand disk state, and disk state
// found without a record becomes a visible orphan instead of a leak.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ownWorktrees, type WorktreeListEntry } from './worktrees';

export const STATE_FILENAME = path.join('.origami', 'agent-manager.json');

export interface WorktreeRecord {
  id: string;            // "w<base36-ts><rand>" - short, stable
  name: string;          // sanitized display/dir name (worktree dir basename)
  branch: string;        // "origami/<name>"
  path: string;          // absolute worktree directory
  baseSha: string;       // commit the branch started from
  createdAt: number;
  /** ACP session ids that have driven this worktree (filled from S3 on). */
  sessions: string[];
  /** Set by reconciliation when the record was synthesized from a worktree on
   *  disk that had no record (e.g. a crashed window's leftovers). */
  orphan?: boolean;
  /** A task queued against this worktree but not yet run (amCreate start:false).
   *  Present => the record is 'queued' until amStart provisions a session, pins
   *  the effective model and clears this field. `model` is the RAW per-task pick
   *  ('' when none) - the repo default is resolved at start time, so a later
   *  default change still applies. Survives boot reconciliation unchanged. */
  queuedTask?: { prompt: string; agentName: string; model: string };
  /** Set when a run reached idle (runCreate/runStart), so a completed agent
   *  stays visibly done across a window reload (seeded idle, not detached).
   *  Cleared when runStart begins a fresh start (a restarted agent isn't done).
   *  Survives boot reconciliation unchanged. */
  done?: { stopReason: string; at: number };
  /** Stamped by a CLEAN apply-to-main: the card retires to the Merged section
   *  instead of sitting re-appliable in Done. Cleared when a new start supersedes
   *  it (a restarted agent's old apply no longer describes it). A forced/conflicted
   *  apply never stamps it. Survives boot reconciliation unchanged. */
  merged?: { at: number };
  /** Engine-store session UUID (AcpClient.currentSessionId) of the record's most
   *  recent session, written at create-/queued-start alongside `sessions.push`.
   *  Unlike the UI ids in `sessions` (ephemeral, per-window) this survives a
   *  reload, so a Done card can loadSession-reopen its transcript after the
   *  engine child is gone. Survives boot reconciliation unchanged. */
  engineSessionId?: string;
  /** Display agent name of the record's most recent run, written at create-/
   *  queued-start alongside `sessions.push`/`engineSessionId`. `queuedTask` holds
   *  its own agentName while queued, but a completed/errored run has none left,
   *  so Chat-on-Done reads this to label the reopened session with the agent that
   *  produced the transcript (else a reload would mislabel it with the global
   *  default). Survives boot reconciliation unchanged. */
  agentName?: string;
  /** Fan-out race grouping (S5): siblings created by one runFanout share this
   *  id, so the board clusters them under a race header. Absent/'' = a
   *  standalone agent. Survives boot reconciliation unchanged (kept records are
   *  carried through verbatim). */
  groupId?: string;
  /** Folds board: the ticket this fold was launched from. The LINK lives on the
   *  record (the ticket file holds the reverse pointer), so the run lifecycle can
   *  stamp the ticket without threading an id through every call. Survives boot
   *  reconciliation unchanged, exactly like groupId. */
  ticketId?: string;
}

export interface AgentManagerState {
  version: 1;
  worktrees: WorktreeRecord[];
  /** The repo's default model pin ("<provider>/<model>") a fresh agent inherits
   *  when a task names none. Absent/'' = fall back to the engine default. */
  defaultModel?: string;
}

export const emptyState = (): AgentManagerState => ({ version: 1, worktrees: [] });

export function newWorktreeRecordId(now = Date.now()): string {
  return `w${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Read the registry. A missing file is an empty registry; an unreadable or
 * shape-invalid file is backed up beside itself (never deleted - it may hold
 * a recoverable record) and treated as empty.
 */
export function loadState(repoRoot: string): AgentManagerState {
  const file = path.join(repoRoot, STATE_FILENAME);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return emptyState(); }
  try {
    const parsed = JSON.parse(raw) as AgentManagerState;
    if (parsed?.version !== 1 || !Array.isArray(parsed.worktrees)) throw new Error('bad shape');
    return parsed;
  } catch {
    try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    return emptyState();
  }
}

/** Atomic write: tmp file + rename, so a crash mid-write can't half-eat the
 *  registry. Creates .origami/ on first save. */
export function saveState(repoRoot: string, state: AgentManagerState): void {
  const file = path.join(repoRoot, STATE_FILENAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Boot reconciliation (pure - `git worktree list` output in, verdict out)
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  state: AgentManagerState;
  /** Records whose worktree directory no longer exists (dropped from state). */
  stale: WorktreeRecord[];
  /** Worktrees found on disk under our root with no record (added, flagged). */
  orphans: WorktreeRecord[];
}

/**
 * Reconcile the registry against the actual worktree list. Git is ground
 * truth: a record without a live worktree is stale (the work, if any, still
 * lives on its branch - the record just no longer points at anything); a live
 * worktree under .origami/worktrees/ without a record is adopted as an orphan
 * so the user can inspect or delete it from the UI instead of it leaking.
 */
export function reconcile(
  state: AgentManagerState,
  liveWorktrees: WorktreeListEntry[],
  repoRoot: string,
  now = Date.now(),
): ReconcileResult {
  const ours = ownWorktrees(liveWorktrees, repoRoot);
  const liveByPath = new Map(ours.map((e) => [path.resolve(e.path).toLowerCase(), e]));

  const kept: WorktreeRecord[] = [];
  const stale: WorktreeRecord[] = [];
  for (const rec of state.worktrees) {
    if (liveByPath.has(path.resolve(rec.path).toLowerCase())) kept.push(rec);
    else stale.push(rec);
  }

  const recorded = new Set(kept.map((r) => path.resolve(r.path).toLowerCase()));
  const orphans: WorktreeRecord[] = [];
  for (const e of ours) {
    const key = path.resolve(e.path).toLowerCase();
    if (recorded.has(key)) continue;
    orphans.push({
      id: newWorktreeRecordId(now),
      name: path.basename(e.path),
      branch: e.branch ?? '',
      path: e.path,
      baseSha: e.head,
      createdAt: now,
      sessions: [],
      orphan: true,
    });
  }

  // Carry the repo-level default model through reconciliation (undefined is
  // dropped by JSON.stringify) - else a boot reconcile would wipe the pin.
  return { state: { version: 1, worktrees: [...kept, ...orphans], defaultModel: state.defaultModel }, stale, orphans };
}
