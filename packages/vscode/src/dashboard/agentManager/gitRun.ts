// The git child-process layer: three ways to run git, sharing one Semaphore(3) and the same
// never-reject/timeout/output-cap hardening. runGit merges stdout+stderr;
// runGitStdoutToFile streams stdout byte-perfect to a file (binary patches); runGitStdout
// captures stdout separately from stderr, since a merged stream can glue a stderr warning
// onto stdout's first token and corrupt a parsed field (e.g. numstat). Deliberately
// vscode-free so the layer runs against a throwaway `git init` fixture in vitest.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_CAP = 20_000;

export interface GitResult { ok: boolean; code: number | null; output: string }

// Cap concurrent git child processes: pollers fan one stats call per worktree per tick, and
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

/** Run git with an arg array (never shell:true — paths/branch names must not pass through
 *  cmd.exe quoting). At most GIT_MAX_CONCURRENT children run at once. stdout+stderr are
 *  merged — don't use this where stdout is parsed; use runGitStdout instead. */
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

/** Run git capturing stdout only (utf8, capped), with stderr collected separately —
 *  immune to the stderr-glued-to-stdout contamination that corrupted numstat's first field.
 *  `maxOutput` caps captured stdout (default 20KB); a caller reading a larger blob must
 *  raise it or risk silent truncation below its own threshold. */
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

/** Run git streaming stdout straight to a file — runGit's utf8-decode+cap would
 *  truncate/corrupt a real binary patch. Stderr still captured. */
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
