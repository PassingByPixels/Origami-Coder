// The server side of a race group's Compare surface: full editor-tab screen of real
// side-by-side diffs between two siblings, file-by-file (fileDiffs reuses the
// .origami-excluded diffFiles listing); handleCrossDiff resolves the on-disk paths for a
// native A-vs-B diff. Read-only, no busy guard — a still-working sibling is a legitimate
// compare target.

import * as path from 'node:path';
import { diffFiles } from './apply';
import { runGitStdout } from './worktrees';
import type { WorktreeRecord } from './state';
import type { ManagerHost } from './host';

/** Per-sibling per-file diff for the compare screen: numstat's change stats plus the
 *  unified-diff text, capped so a giant file can't flood the webview. */
export interface RaceFileDiff { path: string; adds: number; dels: number; binary: boolean; text: string; truncated: boolean }

const PER_FILE_TEXT_CAP = 200_000; // ~200KB of unified-diff text per file

/** The narrow window the compare handlers drive the owner through: the host,
 *  the same actionRoot validator the scoped actions use, and the record lookup. */
export interface RaceCompareContext {
  host: ManagerHost;
  validateRoot(raw: unknown): string | undefined;
  record(root: string, id: string): WorktreeRecord | undefined;
}

/** One sibling's per-file unified diffs, reusing the .origami-excluded diffFiles listing;
 *  each file's text is capped, with `truncated` driving an honest notice. */
export async function fileDiffs(worktreePath: string, baseSha: string): Promise<RaceFileDiff[]> {
  const files = await diffFiles(worktreePath, baseSha);
  const out: RaceFileDiff[] = [];
  for (const f of files) {
    if (f.binary) { out.push({ path: f.path, adds: f.adds, dels: f.dels, binary: true, text: '', truncated: false }); continue; }
    // Rename-aware + honest cap: fetch text the same way numstat detected renames (-M + both
    // paths), and capture above the truncation threshold so a >200KB diff is flagged, not
    // silently cut.
    const args = f.oldPath ? ['diff', '-M', baseSha, '--', f.oldPath, f.path] : ['diff', baseSha, '--', f.path];
    const r = await runGitStdout(args, worktreePath, undefined, PER_FILE_TEXT_CAP + 1);
    const full = r.ok ? r.output : '';
    const truncated = full.length > PER_FILE_TEXT_CAP;
    out.push({ path: f.path, adds: f.adds, dels: f.dels, binary: false, text: truncated ? full.slice(0, PER_FILE_TEXT_CAP) : full, truncated });
  }
  return out;
}

/** amRaceFileDiffs: each sibling's per-file diffs, posted keyed by id; a vanished/invalid id
 *  maps to []. Root validated exactly as every scoped action. */
export async function handleRaceFileDiffs(
  ctx: RaceCompareContext,
  m: { type?: string; [k: string]: unknown },
): Promise<void> {
  const root = ctx.validateRoot(m.root);
  if (!root) return; // validateRoot already surfaced amError
  const ids = (Array.isArray(m.ids) ? m.ids : []).map(String);
  const diffs: Record<string, RaceFileDiff[]> = {};
  for (const id of ids) {
    const rec = ctx.record(root, id);
    diffs[id] = rec ? await fileDiffs(rec.path, rec.baseSha) : [];
  }
  ctx.host.post({ type: 'amRaceFileDiffs', ids, diffs });
}

/** amCrossDiff: a native A-vs-B diff of the same file in two siblings' worktrees (both real
 *  files, no content provider). A missing record/empty path is a quiet no-op. */
export function handleCrossDiff(
  ctx: RaceCompareContext,
  m: { type?: string; [k: string]: unknown },
): void {
  const root = ctx.validateRoot(m.root);
  if (!root) return;
  const ids = (Array.isArray(m.ids) ? m.ids : []).map(String);
  const rel = String(m.path ?? '');
  if (!rel || ids.length < 2) return;
  const a = ctx.record(root, ids[0]);
  const b = ctx.record(root, ids[1]);
  if (!a || !b) return;
  ctx.host.openCrossDiff(path.join(a.path, rel), path.join(b.path, rel), `${rel}: ${a.name} vs ${b.name}`);
}
