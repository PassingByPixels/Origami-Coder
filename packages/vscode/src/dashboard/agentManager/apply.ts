// Agent Manager - apply.ts (S4): the "Apply to main" promotion flow behind a
// Done card's diff view. A git worktree shares the main repo's object database,
// so a patch built from the worktree (baseSha..WORKING-TREE, uncommitted edits
// AND new untracked files - marked intent-to-add first, matching the board badge)
// can be `git apply --3way`'d straight into
// the main repo's WORKING TREE. This NEVER commits and NEVER stages: it patches
// the tree only (Kilo semantics - the user reviews + commits in their own tree).
// Preflight (`--check`) leaves the tree untouched on refusal; a forced apply on
// a real 3-way conflict leaves conflict markers for the user to resolve. Pure
// git ops (arg-array runGit, no shell) + a thin ApplyController the manager routes
// am* messages to. Deliberately vscode-free so it unit-tests on a real fixture.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGit, runGitStdout, runGitStdoutToFile, withRepoLock } from './worktrees';
import { markUntracked } from './pollers';
import { loadState, saveState, type WorktreeRecord } from './state';
import { stampFold } from './tickets';
import type { ManagerHost } from './manager';

// `oldPath` is set ONLY for a rename (numstat's `\0old\0new` shape): the compare
// screen's per-file diff needs BOTH sides (`-M -- old new`) or a lone new-side
// pathspec renders the whole file as freshly added, contradicting the rename-aware
// +/- count. Absent for every non-rename record.
export interface DiffFile { path: string; adds: number; dels: number; binary: boolean; oldPath?: string }
export interface ApplyOutcome { ok: boolean; conflicts: string[]; detail: string }

/**
 * Parse `git diff --numstat -z <base>` output. The -z form is NUL-terminated
 * and renames come as `adds\tdels\t\0<old>\0<new>\0` (the new path is shown);
 * a binary file is `-\t-\t<path>`. Untracked (new) files ARE in this output:
 * diffFiles marks them intent-to-add first (markUntracked), exactly as the
 * board's --shortstat badge does - the two stay consistent by construction.
 */
export function parseNumstatZ(raw: string): DiffFile[] {
  const tokens = (raw || '').split('\0');
  const out: DiffFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const parts = tok.split('\t');
    if (parts.length < 3) continue;
    const [a, d, p] = parts;
    const binary = a === '-' || d === '-';
    // A non-numeric adds/dels on a NON-binary record means the stdout stream was
    // contaminated (e.g. a stderr "LF will be replaced by CRLF" warning glued to
    // the first field). SKIP the record so contamination surfaces as a MISSING row,
    // never a silent wrong count (the old `|| 0` reported +0). A rename is always
    // `0\t0\t\0old\0new` - numeric fields - so this never eats a rename's advance.
    const numeric = /^\d+$/.test(a) && /^\d+$/.test(d);
    if (!binary && !numeric) continue;
    const adds = binary ? 0 : parseInt(a, 10);
    const dels = binary ? 0 : parseInt(d, 10);
    let filePath = p;
    let oldPath: string | undefined;
    if (p === '') { // rename: the two following NUL tokens are old, new
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      filePath = to ?? from ?? '';
      if (from && to && from !== to) oldPath = from; // real old->new pair for the -M per-file diff
      i += 2;
    }
    if (filePath) out.push({ path: filePath, adds, dels, binary, ...(oldPath ? { oldPath } : {}) });
  }
  return out;
}

/** The change set the board badge counts: baseSha..WORKING-TREE of the worktree,
 *  minus the engine's own artifacts. The `:(exclude).origami` pathspec drops the
 *  worktree-local `.origami/` tree - `.origami/plans/<ms>-<slug>.md` is written
 *  deterministically by the engine's permission-locked plan mode, so it is not a
 *  DELIVERABLE change and must never be listed (or, downstream, applied to main).
 *  Only that engine-owned prefix is excluded: MODEL-authored files (e.g. an
 *  agent's own generated scripts) have no reliable discriminator and stay in the
 *  set. Captured via runGitStdout so a core.autocrlf stderr warning can't corrupt
 *  the first record's count. */
export async function diffFiles(worktreePath: string, baseSha: string): Promise<DiffFile[]> {
  await markUntracked(worktreePath); // new files appear as add entries, like the badge
  const r = await runGitStdout(['diff', '--numstat', '-z', baseSha, '--', '.', ':(exclude).origami'], worktreePath);
  return r.ok ? parseNumstatZ(r.output) : [];
}

function tmpPatchPath(): string {
  return path.join(os.tmpdir(), `origami-apply-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.patch`);
}

/**
 * Build a binary-safe patch for the selected files (baseSha..working-tree) and
 * write it to a unique temp file; returns the path. `--binary` so images etc.
 * round-trip. The caller MUST delete the returned file (finally). Captured via
 * runGitStdoutToFile because runGit truncates/utf8-mangles a real patch.
 */
export async function buildPatch(worktreePath: string, baseSha: string, files: string[]): Promise<string> {
  // `files` only ever comes from the .origami-excluded diffFiles listing, so a
  // worktree-local .origami/ path can never reach this scoped patch - no exclude
  // pathspec is needed here (adding one would fight the explicit `-- <files>`).
  await markUntracked(worktreePath); // new files carry a proper creation patch
  const file = tmpPatchPath();
  const r = await runGitStdoutToFile(['diff', '--binary', baseSha, '--', ...files], worktreePath, file);
  if (!r.ok) { try { fs.unlinkSync(file); } catch { /* nothing to clean */ } throw new Error(`git diff failed: ${r.output}`); }
  return file;
}

/** Extract the failing/conflicting paths git names in an apply's output. */
export function parseConflicts(output: string): string[] {
  const set = new Set<string>();
  for (const line of (output || '').split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if ((m = /^error: patch failed: (.+?):\d+/.exec(line))) set.add(m[1]);
    else if ((m = /^error: (.+?): patch does not apply/.exec(line))) set.add(m[1]);
    else if ((m = /^error: (.+?): does not match index/.exec(line))) set.add(m[1]);
    else if ((m = /^error: (.+?): does not exist in index/.exec(line))) set.add(m[1]);
    else if ((m = /^error: (.+?): already exists in working directory/.exec(line))) set.add(m[1]);
    else if ((m = /^Applied patch to '(.+?)' with conflicts/.exec(line))) set.add(m[1]);
    else if ((m = /^U (.+)$/.exec(line))) set.add(m[1]);
  }
  return [...set];
}

/**
 * Dry run in the MAIN repo: `git apply --3way --check`. ok:true means the patch
 * applies (cleanly, or with a 3-way that `--check` deems appliable) and the tree
 * is UNTOUCHED. A dirty main tree is fine - `--check` accounts for it. On refusal
 * (e.g. the target no longer matches the index) it names the offending paths.
 */
export async function preflight(mainRoot: string, patchFile: string): Promise<ApplyOutcome> {
  const r = await runGit(['apply', '--3way', '--check', patchFile], mainRoot);
  return { ok: r.ok, conflicts: r.ok ? [] : parseConflicts(r.output), detail: r.output };
}

/**
 * True when the patch's changes are ALREADY present in the MAIN tree - a prior
 * apply left the same edit uncommitted (the "apply LICENSE twice" case). `git
 * apply --reverse --check` succeeds only if the patch can be UN-applied, i.e.
 * main already contains it, so it cleanly separates "already applied" (a calm
 * no-op) from a genuine divergence (different content on the same paths), which
 * the forward --check refuses identically. Read-only: --check never touches the
 * tree. Only meaningful on a forward-preflight REFUSAL - a clean forward check
 * means there was nothing already there.
 */
export async function alreadyApplied(mainRoot: string, patchFile: string): Promise<boolean> {
  const r = await runGit(['apply', '--reverse', '--check', patchFile], mainRoot);
  return r.ok;
}

/**
 * Apply the patch into the MAIN repo's working tree: `git apply --3way`. On a
 * real 3-way conflict git exits nonzero and leaves conflict markers in place -
 * we report the conflicting paths and DO NOT roll back (the user resolves them
 * in-editor). A clean apply is ok:true. Never commits.
 *
 * `--3way` writes through the index (it stages the applied paths). To honour the
 * Kilo semantic - the change lands in the working tree for the user to review +
 * commit themselves - we unstage ONLY the applied paths afterwards (`git reset
 * HEAD -- <files>`), never touching the user's unrelated staged work. The reset
 * is skipped on a pure refusal (nothing was applied), so a pre-staged file in
 * main is never silently unstaged.
 */
export async function applyPatch(mainRoot: string, patchFile: string, files: string[]): Promise<ApplyOutcome> {
  const r = await runGit(['apply', '--3way', patchFile], mainRoot);
  const conflicts = parseConflicts(r.output);
  const applied = r.ok || /with conflicts/.test(r.output); // clean, or markers written
  if (applied && files.length > 0) await runGit(['reset', '-q', 'HEAD', '--', ...files], mainRoot);
  return { ok: r.ok && conflicts.length === 0, conflicts, detail: r.output };
}

/** The manager's window into the owner for apply routing: the host, an actionRoot
 *  validator, the record lookup, and a busy/reopening guard. Built by AgentManager. */
export interface ApplyContext {
  host: ManagerHost;
  validateRoot(raw: unknown): string | undefined;
  record(root: string, id: string): WorktreeRecord | undefined;
  busy(id: string): boolean;
  /** Rebroadcast the board (a clean apply stamps `merged` on the record). */
  broadcast(): void;
  /** True only for a done-family record (idle/error/detached, or a working row
   *  whose engine session has died) - a live agent must NEVER be promoted to
   *  main mid-run: its worktree is still being written. */
  promotable(id: string): boolean;
}

export class ApplyController {
  constructor(private readonly ctx: ApplyContext) {}

  /** Route amDiffFiles / amOpenFileDiff / amApply. Root/id validated exactly as
   *  AgentManager's scoped actions (validateRoot posts amError + returns undefined). */
  async handle(m: { type?: string; [k: string]: unknown }): Promise<void> {
    const root = this.ctx.validateRoot(m.root);
    if (!root) return; // validateRoot already surfaced amError
    const id = String(m.id ?? '');
    const rec = this.ctx.record(root, id);
    if (!rec) return; // card vanished; the pane collapses it on the next amState
    switch (m.type) {
      case 'amDiffFiles': {
        const files = await diffFiles(rec.path, rec.baseSha);
        this.ctx.host.post({ type: 'amDiffFiles', id, files });
        return;
      }
      case 'amOpenFileDiff': {
        const rel = String(m.path ?? '');
        if (rel) this.ctx.host.openFileDiff(rec.path, rec.baseSha, rel, path.join(rec.path, rel), rel);
        return;
      }
      case 'amApply': {
        await this.apply(root, rec, id, Array.isArray(m.files) ? m.files.map(String) : [], m.force === true);
        return;
      }
    }
  }

  private async apply(root: string, rec: WorktreeRecord, id: string, files: string[], force: boolean): Promise<void> {
    const { host } = this.ctx;
    // Every refusal posts amApplyResult (not just amError) so the pane's
    // "Applying…" button always resets - an unanswered post freezes it forever.
    const refuse = (error: string) => host.post({ type: 'amApplyResult', id, ok: false, conflicts: [], error });
    if (!this.ctx.promotable(id)) { refuse('This agent is still running — apply is available once it finishes.'); return; }
    if (this.ctx.busy(id)) { refuse('This agent is busy — try again in a moment.'); return; }
    if (files.length === 0) { host.post({ type: 'amApplyResult', id, ok: false, conflicts: [] }); return; }
    // buildPatch is INSIDE the try so a throw (e.g. the worktree vanished) posts
    // a result instead of rejecting uncaught and hanging the pane.
    let patchFile: string | undefined;
    try {
      patchFile = await buildPatch(rec.path, rec.baseSha, files);
      const pf = patchFile;
      // Serialize every mutating apply on THIS main repo through the same
      // per-repo mutex the worktree lifecycle uses, so two concurrent Applies
      // cannot race .git/index.lock (which git reports as a `fatal:` none of
      // parseConflicts matches - silently misread as "nothing to apply").
      const res = await withRepoLock(root, async () => {
        if (!force) {
          const pre = await preflight(root, pf);
          // --check refused: the tree is untouched (exactly what --check is for).
          // A reverse --check tells apart "already applied" (main already holds
          // these exact changes, e.g. an earlier apply left them uncommitted)
          // from a real divergence - both refuse the forward check identically.
          if (!pre.ok) return { refused: true, already: await alreadyApplied(root, pf), outcome: pre };
        }
        return { refused: false, already: false, outcome: await applyPatch(root, pf, files) };
      });
      if (res.refused) {
        // Already present: a calm no-op, never a conflict (no "Apply anyway").
        if (res.already) { host.post({ type: 'amApplyResult', id, ok: false, conflicts: [], alreadyApplied: true }); return; }
        // A genuine divergence: name the paths + flag it so the pane can explain.
        host.post({ type: 'amApplyResult', id, ok: false, conflicts: res.outcome.conflicts, diverged: true }); return;
      }
      const out = res.outcome;
      if (out.ok) {
        host.info(`Applied ${files.length} file(s) to ${path.basename(root)} — review & commit in your own tree.`);
        // Retire the card to the Merged section: stamp `merged` via a FRESH
        // load-mutate-save (never the stale `rec` param) so a concurrent write is
        // not clobbered. Only a clean apply reaches here, so a forced/conflicted
        // apply never stamps merged.
        const state = loadState(root);
        const fresh = state.worktrees.find((r) => r.id === id);
        if (fresh) { fresh.merged = { at: Date.now() }; saveState(root, state); }
        // Same gate as `merged` itself: ONLY a clean apply retires the ticket to
        // Merged - a forced or conflicted apply left work behind, so it does not.
        stampFold(root, id, 'merged', `applied ${files.length} file(s) to ${path.basename(root)}`);
        this.ctx.broadcast();
        host.post({ type: 'amApplyResult', id, ok: true });
      } else {
        // Conflict markers were written (a forced apply, or a committed divergence
        // that --check let through) - open them for the user to resolve.
        host.openConflicted(out.conflicts.map((p) => path.join(root, p)));
        host.post({ type: 'amApplyResult', id, ok: false, conflicts: out.conflicts });
      }
    } catch (e) {
      refuse(`Could not build the change set: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (patchFile) { try { fs.unlinkSync(patchFile); } catch { /* best effort */ } }
    }
  }
}
