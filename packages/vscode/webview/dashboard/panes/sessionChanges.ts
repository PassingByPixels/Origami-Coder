// sessionChanges.ts — what this chat has changed on disk, rolled up from
// the transcript the pane already holds.
//
// Derived, never subscribed: counts are a pure function of the messages, so
// a reload rebuilds from the restored transcript instead of a live-subscribed
// total silently resetting to zero. A .ts leaf under webview/ cannot import
// from src/ (TS6059), so `Message` is chatMessage.ts's own webview type.

import type { Message } from './chatMessage';

export interface FileChange {
  /** The path exactly as the wire gave it (ACP `locations[0].path`) — the
   *  same string ToolCard hands `openAbsoluteFile`. */
  path: string;
  adds: number;
  dels: number;
  /** At least one contributing edit replaced NOTHING (empty `oldText`), i.e.
   *  the file was written into existence rather than modified. */
  created: boolean;
}

export interface SessionChanges {
  fileCount: number;
  adds: number;
  dels: number;
  /** One row per path, in first-touched order. */
  files: FileChange[];
  /** t-ucnp7t (plan F12): older pages of the chat are not loaded, so these counts cover the
   *  loaded part only. The pill says so rather than showing a silently low figure. */
  partial?: boolean;
}

/** Above this many LCS cells the table is skipped and the middles are
 *  reported as wholly replaced — only reachable by a diff whose changed
 *  region is thousands of lines both sides; a quadratic table would be worse. */
const LCS_CELL_CAP = 2_000_000;

function lcsLength(a: string[], b: string[]): number {
  let prev = new Int32Array(b.length + 1);
  let cur = new Int32Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      cur[j + 1] = a[i] === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]);
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[b.length];
}

/**
 * Real line adds/dels for one before/after pair. Not `newLines - oldLines`:
 * replacing two lines with two others is `+2 -2`, not the misleading `+0 -0`
 * a subtraction would show. Head and tail lines common to both are trimmed
 * first, then the remaining middle goes through an LCS table.
 */
export function countDiffLines(oldText: string, newText: string): { adds: number; dels: number } {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  // One side empty ⇒ pure insertion or pure deletion; no table needed.
  if (midA.length === 0 || midB.length === 0) return { adds: midB.length, dels: midA.length };
  const common = midA.length * midB.length > LCS_CELL_CAP ? 0 : lcsLength(midA, midB);
  return { adds: midB.length - common, dels: midA.length - common };
}

/** One raw before/after pair, path-first — the shape a SUB-AGENT's edits
 *  arrive in (subagentChanges.ts's `RawFileDiff`, posted per child since a
 *  child's own tool calls never land in this chat's own `messages`). */
export interface RawFileDiff { path: string; oldText: string; newText: string }

function foldDiff(byPath: Map<string, FileChange>, path: string, oldText: string, newText: string): void {
  const { adds, dels } = countDiffLines(oldText, newText);
  const created = oldText.length === 0;
  const seen = byPath.get(path);
  if (seen) {
    seen.adds += adds;
    seen.dels += dels;
    seen.created = seen.created || created;
  } else {
    byPath.set(path, { path, adds, dels, created });
  }
}

/**
 * Roll a transcript into the composer's running changes row. Counting is
 * churn, not net: two edits to one file sum, so added-then-removed lines
 * read as `+1 -1` — the only reading available from per-call diffs.
 *
 * t-j3qxbp — `subagentFiles` folds in every SUB-AGENT's own edits too (one
 * array per child, keyed by whatever the caller likes — only the values are
 * read), so the pill counts what the whole turn touched, not just the calls
 * this chat's own transcript happened to carry.
 */
export function aggregateSessionChanges(
  messages: readonly Message[],
  subagentFiles?: Readonly<Record<string, readonly RawFileDiff[]>>,
): SessionChanges {
  const byPath = new Map<string, FileChange>();
  for (const m of messages) {
    const diff = m.toolDiff;
    // A tool that only looked at a file (read, grep, list) carries a path but
    // no diff, and a `failed` call changed nothing either — skip both.
    if (!diff || m.toolStatus === 'failed') continue;
    const path = m.toolPath || diff.path;
    if (!path) continue;
    foldDiff(byPath, path, diff.oldText, diff.newText);
  }
  for (const files of Object.values(subagentFiles ?? {})) {
    for (const f of files) { if (f.path) foldDiff(byPath, f.path, f.oldText, f.newText); }
  }
  // A no-op edit (oldText === newText) moved no lines; drop it so "nothing
  // changed" resolves to fileCount 0 rather than a pill reading "+0 -0".
  const files = [...byPath.values()].filter((f) => f.adds > 0 || f.dels > 0);
  let adds = 0;
  let dels = 0;
  for (const f of files) { adds += f.adds; dels += f.dels; }
  return { fileCount: files.length, adds, dels, files };
}
