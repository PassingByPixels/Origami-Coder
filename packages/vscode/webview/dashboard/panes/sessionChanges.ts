// sessionChanges.ts — what THIS chat has changed on disk, rolled up from the
// transcript the pane already holds.
//
// DERIVED, never subscribed. The counts are a pure function of the messages,
// so a webview reload rebuilds them from the restored transcript. A running
// total kept in a live event subscription would silently reset to zero on
// every reload while the chat above it still showed the edits it counted.
//
// A .ts leaf under webview/ deliberately: it may not import from src/ (TS6059,
// rootDir: "webview") and it does not — `Message` is chatMessage.ts's own
// webview-side declaration, not a host type.

import type { Message } from './chatMessage';

export interface FileChange {
  /** The path exactly as the wire gave it (ACP `locations[0].path`) — the same
   *  string ToolCard hands `openAbsoluteFile`, so a click here opens what a
   *  click on the tool card opens. */
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
}

/** Above this many LCS cells (after the head/tail trim below) the table is
 *  skipped and the middles are reported as wholly replaced. Only a diff whose
 *  changed REGION is thousands of lines on both sides can reach it, and a
 *  quadratic table on the composer's render path is a worse answer than a
 *  slightly pessimistic one. */
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
 * Real line adds/dels for one before/after pair.
 *
 * NOT `newLines - oldLines`: replacing two lines with two others is `+2 −2`,
 * and the subtraction calls it `+0 −0` — the single most misleading number
 * this row could show. Common head and tail lines are trimmed first (cheap,
 * and it is what keeps a one-line edit in a 4000-line file cheap), then the
 * remaining middles go through an LCS table, which is what makes a pure
 * insertion cost adds only.
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

/**
 * Roll a transcript up into the composer's running changes row.
 *
 * Counting is CHURN, not net: two edits to one file sum, so a line added and
 * then removed again reads as `+1 −1`. That is the honest reading of "what
 * this session did", and the only one available from per-call diffs — the
 * webview never sees the file's original state, only each edit's own region.
 */
export function aggregateSessionChanges(messages: readonly Message[]): SessionChanges {
  const byPath = new Map<string, FileChange>();
  for (const m of messages) {
    const diff = m.toolDiff;
    // A tool that only LOOKED at a file (read, grep, list) carries a path and
    // no diff — it changed nothing and must not appear here. Nor did a call
    // the engine reported `failed`, whatever content came back with it.
    if (!diff || m.toolStatus === 'failed') continue;
    const path = m.toolPath || diff.path;
    if (!path) continue;
    const { adds, dels } = countDiffLines(diff.oldText, diff.newText);
    const created = diff.oldText.length === 0;
    const seen = byPath.get(path);
    if (seen) {
      seen.adds += adds;
      seen.dels += dels;
      seen.created = seen.created || created;
    } else {
      byPath.set(path, { path, adds, dels, created });
    }
  }
  // A no-op edit (oldText === newText) moved no lines, and a row reading
  // "1 file +0 −0" is a bug report waiting to happen. Drop it — which is also
  // what makes "nothing changed" resolve to fileCount 0 rather than to a pill
  // with nothing in it.
  const files = [...byPath.values()].filter((f) => f.adds > 0 || f.dels > 0);
  let adds = 0;
  let dels = 0;
  for (const f of files) { adds += f.adds; dels += f.dels; }
  return { fileCount: files.length, adds, dels, files };
}
