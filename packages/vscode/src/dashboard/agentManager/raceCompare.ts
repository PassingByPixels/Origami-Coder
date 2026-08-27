// Agent Manager - raceCompare.ts (S6c/S6d): the server side of a race group's
// Compare surface, which S6d moved from an in-column numbers table to a full
// editor-tab screen of REAL side-by-side diffs. Two siblings of ONE race group
// are compared file-by-file: fileDiffs composes each selected sibling's per-file
// UNIFIED DIFF TEXT (baseSha..working-tree, reusing the .origami-excluded diffFiles
// listing) so the screen renders two aligned columns of actual hunks; handleCrossDiff
// resolves the two on-disk worktree paths for a native A-vs-B diff. Read-only over
// git (no promotable/busy guard: a still-working sibling is a legitimate compare
// target). Host-driven + vscode-free so it unit-tests on real fixtures, like apply.ts.

import * as path from 'node:path';
import { diffFiles } from './apply';
import { runGitStdout } from './worktrees';
import type { WorktreeRecord } from './state';
import type { ManagerHost } from './host';

/** Per-sibling, per-file diff sent to the compare screen: the change stats
 *  (from the badge's numstat) plus the file's unified-diff TEXT for the column,
 *  capped so a giant file can't flood the webview. Binary files carry no text. */
export interface RaceFileDiff { path: string; adds: number; dels: number; binary: boolean; text: string; truncated: boolean }

const PER_FILE_TEXT_CAP = 200_000; // ~200KB of unified-diff text per file

/** The narrow window the compare handlers drive the owner through: the host,
 *  the same actionRoot validator the scoped actions use, and the record lookup. */
export interface RaceCompareContext {
  host: ManagerHost;
  validateRoot(raw: unknown): string | undefined;
  record(root: string, id: string): WorktreeRecord | undefined;
}

/**
 * One sibling's per-file unified diffs for the compare screen. Reuses the
 * .origami-excluded diffFiles listing (so the engine's plan artifacts never
 * appear), then pulls each non-binary file's rename-aware unified diff (`-M` +
 * old&new paths) via the stdout-only capture, raised to the per-file cap. Each
 * file's text is capped; `truncated` drives an honest notice in the column.
 */
export async function fileDiffs(worktreePath: string, baseSha: string): Promise<RaceFileDiff[]> {
  const files = await diffFiles(worktreePath, baseSha);
  const out: RaceFileDiff[] = [];
  for (const f of files) {
    if (f.binary) { out.push({ path: f.path, adds: f.adds, dels: f.dels, binary: true, text: '', truncated: false }); continue; }
    // Rename-aware + honest cap. numstat rename-detected already (so f.adds/f.dels
    // is rename-aware); fetch the TEXT the SAME way - `-M` + BOTH old & new paths -
    // or a lone new-side pathspec shows the whole file as an add, contradicting the
    // header. Capture cap = PER_FILE_TEXT_CAP+1 (> the truncation threshold) so a
    // >200KB diff is flagged, not silently cut at runGitStdout's 20KB default.
    const args = f.oldPath ? ['diff', '-M', baseSha, '--', f.oldPath, f.path] : ['diff', baseSha, '--', f.path];
    const r = await runGitStdout(args, worktreePath, undefined, PER_FILE_TEXT_CAP + 1);
    const full = r.ok ? r.output : '';
    const truncated = full.length > PER_FILE_TEXT_CAP;
    out.push({ path: f.path, adds: f.adds, dels: f.dels, binary: false, text: truncated ? full.slice(0, PER_FILE_TEXT_CAP) : full, truncated });
  }
  return out;
}

/**
 * amRaceFileDiffs {root, ids:[a,b]} -> each sibling's per-file unified diffs,
 * posted back keyed by id so the screen builds the file union + renders both
 * columns. A vanished/invalid sibling id maps to [] (its column reads "not
 * touched"). Root validated exactly as every scoped action.
 */
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

/**
 * amCrossDiff {root, ids:[a,b], path} -> a native A-vs-B diff of the SAME file in
 * the two siblings' worktrees (both real on-disk files - no content provider). A
 * missing record / empty path is a quiet no-op (the panel only enables this when
 * both siblings touched the file).
 */
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
