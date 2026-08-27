// Agent Manager - gitRun.ts (S6d): the git child-process layer, extracted from
// worktrees.ts (at its line cap) so the third capture variant could land beside
// its two siblings. Three ways to run git, all sharing ONE Semaphore(3) and the
// same never-reject / timeout / output-cap hardening:
//   - runGit             : utf8, stdout+stderr MERGED into one string (the caller
//                          reads git's human error text on failure).
//   - runGitStdoutToFile : stdout streamed byte-perfect to a file (binary patches;
//                          runGit's utf8-decode+cap would corrupt a real patch).
//   - runGitStdout       : stdout captured to a string, stderr collected SEPARATELY
//                          (S6d). The merged runGit glued git's per-file
//                          "LF will be replaced by CRLF" stderr warnings onto the
//                          FRONT of stdout's first token (stderr is unbuffered,
//                          piped stdout is block-buffered), so `parseInt` on a
//                          numstat's first adds field read the warning text and
//                          silently returned 0. Separated streams keep stdout pure.
//
// Deliberately vscode-free: plain child_process + fs so the whole layer runs
// against a throwaway `git init` fixture in vitest.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_CAP = 20_000;

export interface GitResult { ok: boolean; code: number | null; output: string }

// Cap concurrent git child processes (Kilo runs the same Semaphore(3) on its
// git/gh spawns): the pollers fan one stats call per worktree per tick, and
// unbounded spawns on Windows are slower than three at a time.
const GIT_MAX_CONCURRENT = 3;
let gitActive = 0;
const gitQueue: Array<() => void> = [];

function gitSlot(): Promise<void> {
  if (gitActive < GIT_MAX_CONCURRENT) {
    gitActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => gitQueue.push(() => { gitActive++; resolve(); }));
}

function gitSlotRelease(): void {
  gitActive--;
  const next = gitQueue.shift();
  if (next) next();
}

/**
 * Run git with an ARG ARRAY (never shell:true - worktree paths and branch
 * names must not pass through cmd.exe quoting). Same hardening shape as
 * runGate: never rejects, timeout, output cap. At most GIT_MAX_CONCURRENT
 * children run at once; excess calls queue. stdout+stderr are MERGED, so on
 * failure the caller sees git's error text - do NOT use this where stdout is
 * PARSED (numstat/rev-list): use runGitStdout so a stderr warning can't corrupt it.
 */
export async function runGit(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  await gitSlot();
  try {
    return await runGitNow(args, cwd, timeoutMs);
  } finally {
    gitSlotRelease();
  }
}

function runGitNow(args: string[], cwd: string, timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (r: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const append = (b: Buffer) => { if (out.length < GIT_OUTPUT_CAP) out += b.toString(); };
    const child = spawn('git', args, { cwd, windowsHide: true });
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, code: null, output: (out + '\n(git timed out)').trim() });
    }, timeoutMs);
    child.on('error', (e) => finish({ ok: false, code: null, output: `git spawn error: ${e.message}` }));
    child.on('close', (code) => finish({ ok: code === 0, code, output: out.trim() }));
  });
}

/**
 * Run git capturing stdout ONLY into a string (utf8, capped), with stderr
 * collected SEPARATELY (S6d). On success `output` is the clean stdout; on
 * failure `output` is stderr (git's error text). Use this for any command whose
 * stdout is PARSED - it is immune to the stderr-glued-to-stdout contamination
 * that corrupted numstat's first field under core.autocrlf. Shares the Semaphore(3).
 *
 * `maxOutput` caps the CAPTURED stdout (default GIT_OUTPUT_CAP = 20KB, fine for
 * numstat/rev-list). A caller reading a large blob (a per-file diff whose own
 * truncation check is well above 20KB) MUST raise it, or the transport silently
 * cuts the text mid-stream below the caller's threshold and it looks complete.
 */
export async function runGitStdout(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS, maxOutput = GIT_OUTPUT_CAP): Promise<GitResult> {
  await gitSlot();
  try {
    return await new Promise<GitResult>((resolve) => {
      let out = '';
      let err = '';
      let settled = false;
      const finish = (r: GitResult) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
      const child = spawn('git', args, { cwd, windowsHide: true });
      child.stdout?.on('data', (b: Buffer) => { if (out.length < maxOutput) out += b.toString(); });
      child.stderr?.on('data', (b: Buffer) => { if (err.length < GIT_OUTPUT_CAP) err += b.toString(); });
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ ok: false, code: null, output: (err + '\n(git timed out)').trim() });
      }, timeoutMs);
      child.on('error', (e) => finish({ ok: false, code: null, output: `git spawn error: ${e.message}` }));
      child.on('close', (code) => finish({ ok: code === 0, code, output: (code === 0 ? out : err).trim() }));
    });
  } finally {
    gitSlotRelease();
  }
}

/**
 * Run git streaming stdout straight to a file (never a JS string): runGit is
 * utf8-decoded AND capped, which truncates/corrupts a real `git diff --binary`
 * patch. Binary-perfect + uncapped; stderr still captured. Shares the Semaphore(3).
 */
export async function runGitStdoutToFile(args: string[], cwd: string, outFile: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  await gitSlot();
  let fd: number;
  try { fd = fs.openSync(outFile, 'w'); }
  catch (e) { gitSlotRelease(); return { ok: false, code: null, output: `open ${outFile} failed: ${e instanceof Error ? e.message : String(e)}` }; }
  try {
    return await new Promise<GitResult>((resolve) => {
      let err = '';
      const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', fd, 'pipe'] });
      child.stderr?.on('data', (b: Buffer) => { if (err.length < GIT_OUTPUT_CAP) err += b.toString(); });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: null, output: `git spawn error: ${e.message}` }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, output: err.trim() }); });
    });
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    gitSlotRelease();
  }
}
