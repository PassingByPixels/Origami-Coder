// Chat slash-command helpers + the shared shell-gate runner. These pieces are
// independent of the (removed) contract-verify agent type that used to live
// beside them, and stay in use -
//   - runGate: run a shell command in a cwd, resolve pass/fail + output (the
//     worktree setup-script path uses it),
//   - the /loop scheduler helpers (parse/format an interval, the scheduled-run
//     prompt, the permanent-done token),
//   - the /compose coach prompt,
//   - agentBoundary / collectAgentTextSince: capture one turn's model text off a
//     session's message log (the /loop scheduler reads a run's reply this way).
// All PURE + testable; the only side-effecting piece is runGate's subprocess.

import { spawn, type ChildProcess } from 'node:child_process';

const GATE_TIMEOUT_MS = 60_000;
const GATE_OUTPUT_CAP = 4000;

// A gate is BROKEN when its COMMAND could not run on this platform (a bash
// builtin like `test`/`grep` under cmd.exe) - distinct from a command that RAN
// and exited non-zero. Classify from the run's ACTUAL failure shape, NEVER a
// blanket scan of stdout+stderr: a command that ran and failed routinely prints
// its own "ENOENT"/"command not found" text (a missing config file, a failed
// child spawn like `spawn geckodriver ENOENT`, a hand-rolled diagnostic), and
// keying on that text mislabels a FIXABLE failure as a platform-broken gate and
// aborts the fix loop. What is authoritative per platform:
//   - spawnFailed: the shell (cmd.exe / sh) itself could not be launched.
//   - win32: cmd.exe prints the effectively-unforgeable "is not recognized as an
//     internal or external command" for a missing command but exits 1 - the SAME
//     exit code as an ordinary failure (verified) - so this exact text is the
//     only signal, and a bare ENOENT/`command not found` from app output is not.
//   - POSIX: /bin/sh exits EXACTLY 127 for command-not-found (an ordinary failure
//     exits 1/2/...), so the exit code is authoritative and app text is ignored.
const WIN_NOT_FOUND_RE = /is not recognized as an internal or external command/i;
const SH_COMMAND_NOT_FOUND = 127;

/** Classify one finished gate run as a broken gate (its command was unavailable
 *  on this platform) vs a real, fixable failure, from its REAL shape - not an
 *  output-text scan. `win` defaults to the host but is injectable for tests. */
export function classifyBrokenGate(
  r: { passed?: boolean; code: number | null; output: string; spawnFailed?: boolean },
  win: boolean = process.platform === 'win32',
): boolean {
  if (r.passed) return false;
  if (r.spawnFailed) return true;
  if (win) return r.code !== 0 && WIN_NOT_FOUND_RE.test(r.output || '');
  return r.code === SH_COMMAND_NOT_FOUND;
}

/** Kill the whole process tree of a shell:true gate. `child.kill()` alone only
 *  reaps the shell (cmd.exe / sh); the grandchild that does the real work is
 *  orphaned. On Windows use taskkill /T; on POSIX the child is a group leader
 *  (spawned detached) so a negative-pid signal takes down the group. */
function killGateTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* already gone */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

/** The raw outcome of one gate execution. `code` is the process exit code (null
 *  on timeout or a spawn failure); `spawnFailed` is true when the shell itself
 *  could not be launched; `brokenGate` is the classified verdict (classifyBrokenGate). */
export interface GateRun {
  passed: boolean;
  output: string;
  timedOut: boolean;
  code: number | null;
  spawnFailed: boolean;
  brokenGate: boolean;
}

/**
 * Run a shell command in `cwd` and resolve (never reject) with pass/fail +
 * captured output + the REAL failure shape (exit code / spawn failure). Used by
 * the worktree setup-script path. `shell:true` runs the command string as given.
 */
export function runGate(command: string, cwd: string, timeoutMs = GATE_TIMEOUT_MS): Promise<GateRun> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const snapshot = () => (out.length > GATE_OUTPUT_CAP ? out.slice(0, GATE_OUTPUT_CAP) + '\n...(truncated)' : out).trim();
    // Build the full result: passed + the broken-gate verdict classified from the
    // REAL shape (exit code / spawnFailed / platform), never an output-text scan.
    const mk = (p: { output: string; timedOut: boolean; code: number | null; spawnFailed: boolean }): GateRun => {
      const passed = !p.spawnFailed && !p.timedOut && p.code === 0;
      return { passed, output: p.output, timedOut: p.timedOut, code: p.code, spawnFailed: p.spawnFailed,
        brokenGate: classifyBrokenGate({ passed, code: p.code, output: p.output, spawnFailed: p.spawnFailed }) };
    };
    // Resolve exactly once. On timeout we resolve HERE rather than waiting for
    // `close` - with shell:true the killed shell's grandchild can hold the stdio
    // pipes open, so `close` may lag well past the deadline (or never fire).
    const finish = (p: { output: string; timedOut: boolean; code: number | null; spawnFailed: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(mk(p));
    };
    const append = (b: Buffer) => { if (out.length < GATE_OUTPUT_CAP) out += b.toString(); };
    let child: ChildProcess;
    try {
      // detached on POSIX makes the child its own process-group leader so the
      // whole tree can be killed on timeout; on Windows taskkill /T handles it.
      child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      resolve(mk({ output: `spawn error: ${e instanceof Error ? e.message : String(e)}`, timedOut: false, code: null, spawnFailed: true }));
      return;
    }
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      killGateTree(child);
      finish({ output: snapshot() || '(no output before timeout)', timedOut: true, code: null, spawnFailed: false });
    }, timeoutMs);
    child.on('error', (e) => finish({ output: `spawn error: ${e.message}`, timedOut: false, code: null, spawnFailed: true }));
    child.on('close', (code) => finish({ output: snapshot() || `(exit ${code ?? 'null'})`, timedOut: false, code: code ?? null, spawnFailed: false }));
  });
}

// --- Loop mode (/loop) — a time-interval SCHEDULER --------------------------
//
// Claude-faithful: `/loop <interval> <prompt>` re-runs a prompt ON A TIMER (NOT
// until a condition). For recurring maintenance that never "completes": watch
// CI, triage a backlog, shepherd PRs. It runs until the user stops it, or a run
// reports the task is PERMANENTLY done (LOOP-DONE). The schedule is persisted
// (agentManager/loopPersistence.ts, keyed by the engine session id) so it
// survives a window reload: DashboardPanel re-arms it once its session is
// restored, scheduling the next run a full interval out rather than firing
// immediately.

export const LOOP_DONE_TOKEN = 'LOOP-DONE';

const STOP_ALIASES = new Set(['stop', 'off', 'clear', 'cancel', 'none']);
const LOOP_MIN_INTERVAL_MS = 10_000;
const LOOP_MAX_INTERVAL_MS = 24 * 3_600_000; // setTimeout overflows past ~24.8 days -> cap well under

/** Parse a human interval like "30m", "1h", "45s" into ms, or null if unparseable. */
export function parseInterval(tok: string): number | null {
  const m = /^(\d+)\s*([a-z]+)$/i.exec((tok || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = m[2].toLowerCase();
  if (['s', 'sec', 'secs', 'second', 'seconds'].includes(u)) return n * 1000;
  if (['m', 'min', 'mins', 'minute', 'minutes'].includes(u)) return n * 60_000;
  if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(u)) return n * 3_600_000;
  return null;
}

/** Render an interval back to a compact human string ("30m", "2h", "45s"). */
export function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

export type LoopCommand =
  | { action: 'start'; intervalMs: number; prompt: string }
  | { action: 'stop' }
  | { action: 'usage' };

/** Parse the /loop args: "<interval> <prompt>" | "stop"/aliases | usage. */
export function parseLoopCommand(args: string): LoopCommand {
  const trimmed = (args || '').trim();
  if (!trimmed) return { action: 'usage' };
  const words = trimmed.split(/\s+/);
  // Stop ONLY when the whole argument is a stop alias, so a prompt that merely
  // begins with "cancel"/"clear" cannot silently kill an active loop.
  if (words.length === 1 && STOP_ALIASES.has(words[0].toLowerCase())) return { action: 'stop' };
  // Interval = a leading "<n><unit>" OR "<n> <unit>" (e.g. "30m" or "10 minutes");
  // everything after it is the prompt.
  const m = /^(\d+\s*[a-z]+)\s+(.+)$/is.exec(trimmed);
  if (m) {
    const intervalMs = parseInterval(m[1]);
    const prompt = m[2].trim();
    if (intervalMs !== null && prompt) {
      return { action: 'start', intervalMs: Math.min(LOOP_MAX_INTERVAL_MS, Math.max(LOOP_MIN_INTERVAL_MS, intervalMs)), prompt };
    }
  }
  return { action: 'usage' };
}

/** The prompt run each scheduled cycle. */
export function buildScheduledRunPrompt(task: string): string {
  return [
    'This is a SCHEDULED recurring run of an ongoing task - it repeats on a timer, so',
    'treat it as "do the next cycle of this now", not "finish it once". Do what is',
    'needed this cycle. If there is nothing to do right now, say so briefly and stop.',
    `If the task is PERMANENTLY complete and should never run again, end your reply with`,
    `the exact token ${LOOP_DONE_TOKEN} on its own line.`,
    '',
    'Task:',
    task,
  ].join('\n');
}

// Fire ONLY on a line that IS the token (optionally wrapped in markdown emphasis, a
// bullet, or trailing punctuation) - never on an inline or negated mention like
// "I won't write LOOP-DONE yet". Case-insensitive like the file's other parsers.
const LOOP_DONE_LINE_RE = new RegExp(`^[\\s>*_-]*${LOOP_DONE_TOKEN}[\\s*_.!]*$`, 'i');

export function parseLoopDone(text: string): boolean {
  return (text || '').split(/\r?\n/).some((line) => LOOP_DONE_LINE_RE.test(line));
}

// --- Compose coach (/compose) -----------------------------------------------
//
// Helps the user shape a /loop (recurring maintenance, no clean done) - or tells
// them it is neither (a one-shot prompt, or too vague to act on) - and drafts a
// ready-to-paste command. Prompt-only; runs as one guided turn.

export function buildComposePrompt(description: string): string {
  const task = (description || '').trim();
  const head = [
    'You are the COMPOSE COACH. Help the user turn a task into the right autonomous',
    'command - or tell them plainly that it is neither. Be concise and decisive.',
    '',
    'LOOP (a scheduler) - use for RECURRING maintenance that never "completes":',
    'watching CI, triaging a backlog on a cadence, shepherding PRs. `/loop <interval>',
    '<prompt>` (e.g. `/loop 30m check for newly failing tests`) re-runs the prompt ON',
    'A TIMER until the user stops it; it does NOT converge on a condition. A loop is a',
    'clock: never use one to "keep fixing until it is right" - that is convergent work',
    'you drive with an ordinary prompt and iterate on yourself, not a loop.',
    '',
    'NEITHER - a one-shot task (just prompt normally, no loop) OR something too vague',
    'to act on (make it concrete first).',
  ];
  const tail = task
    ? [
        'Do this:',
        '1. Classify the task below as LOOP or NEITHER, with a one-line why.',
        '2. If LOOP: write a ready-to-paste `/loop <interval> <task>` (pick a sensible',
        '   cadence, e.g. 30m) naming the recurring task and what each run should check.',
        '3. If NEITHER: say so plainly, and either reshape it into a loop or tell them to',
        '   just ask normally.',
        '',
        'Task to compose:',
        task,
      ]
    : [
        'The user has NOT described a task yet. Ask them, briefly and directly, what they',
        'are trying to get done and whether it recurs on a cadence - then stop and',
        'wait for their reply. Do not invent a task.',
      ];
  return [...head, '', ...tail].join('\n');
}

// --- Capturing one turn's agent text off the message log --------------------
//
// The shell reads a turn's model text from session.messageLog, where the ACP
// handler APPENDS an agent chunk onto the previous entry when it is already
// kind:'agent'. So a turn that follows a work turn (which usually ends on agent
// text) does NOT create a new entry - its text merges into the trailing one. A
// plain "entries added since length N" read therefore misses the whole turn.
// Snapshot the boundary BEFORE the turn (length + trailing agent entry's text
// length), then collect the appended tail PLUS any genuinely new agent entries.

export interface LogEntry { kind: string; text: string }
export interface TextBoundary { len: number; tailIdx: number; tailLen: number }

export function agentBoundary(log: LogEntry[]): TextBoundary {
  const len = log.length;
  const tail = len > 0 ? log[len - 1] : undefined;
  return { len, tailIdx: len - 1, tailLen: tail && tail.kind === 'agent' ? tail.text.length : -1 };
}

export function collectAgentTextSince(log: LogEntry[], b: TextBoundary): string {
  const parts: string[] = [];
  if (b.tailLen >= 0) {
    const e = log[b.tailIdx];
    if (e && e.kind === 'agent' && e.text.length > b.tailLen) parts.push(e.text.slice(b.tailLen));
  }
  for (let i = b.len; i < log.length; i++) {
    if (log[i].kind === 'agent') parts.push(log[i].text);
  }
  return parts.join('\n').trim();
}
