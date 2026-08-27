// cronLog.ts — how many times a cron has RUN and how the last run ENDED, read
// from the cron's own log file.
//
// The log is the audit trail, so it is also the truth. There is deliberately no
// counter in crons.json to compare it against: a second source would drift the
// moment a run is killed, a log is rotated by hand, or the record is edited in
// another clone, and then two numbers would disagree with nobody able to say
// which lied. One source, derived on read.
//
// THE ON-DISK SHAPE (cronLauncher.ts writes it; verified against the real log
// of \Origami\cms791dnuckui on this machine):
//
//     [start] demo heartbeat 30/07/2026  9:39:43.21
//     [cmd] "C:\...\origami.exe" run "..." --auto --dir "..."
//     ...arbitrary agent stdout+stderr, ANSI escapes and all...
//     [end] 30/07/2026  9:39:47.65 exit=0
//
// Three properties of that shape drive every decision below.
//
// 1. `[start]` IS ALWAYS AT A LINE START. It is the first write of a run, and
//    whatever preceded it in the file was an `echo`, which always terminates
//    with CRLF. So it can be anchored, and anchoring keeps a stray "[start]" in
//    the middle of some agent's output from inflating the count.
//
// 2. `[end]` IS NOT. It is echoed straight after the run's own redirected
//    output, and a program whose last write lacked a trailing newline leaves
//    the `[end]` record GLUED to the end of that line. Anchoring it would lose
//    the outcome of exactly the runs most worth knowing about. So `[end]` is
//    matched unanchored, leaning on `exit=<digits>` for specificity instead.
//
// 3. `%DATE%`/`%TIME%` ARE LOCALE-FORMATTED — this machine writes `30/07/2026`
//    and ` 9:39:43.21`, a US box writes `07/30/2026`, others prefix a weekday.
//    Parsing that back into a Date cannot be done portably, so this module does
//    not try: the timestamp comes from the file's mtime (which is written by the
//    `[end]` echo, so it IS the end of the last run), and the log text is used
//    only for the count and the exit code.

import * as fs from 'node:fs';

/**
 * How much of a log to read. A cron that has run every minute for a year has a
 * log far too big to slurp on every pane refresh, and `list()` refreshes often.
 * Beyond this we read only the TAIL, which makes the count a lower bound —
 * reported honestly via `runsExact` rather than passed off as a total.
 */
export const CRON_LOG_READ_CAP = 256 * 1024;

export type CronOutcome = 'ok' | 'failed' | 'incomplete';

export interface CronRunStats {
  /** `[start]` records seen. A LOWER BOUND when `runsExact` is false. */
  runs: number;
  /** False when the log was too big to read whole, so `runs` counts a tail. */
  runsExact: boolean;
  /**
   * How the most recent run ended, or null when the cron has never run.
   * `incomplete` = a `[start]` with no `[end]` after it: the run was killed, the
   * machine went down, or it is still going. That asymmetry is the launcher's
   * whole point (the start record is written before the work), so it is surfaced
   * rather than rounded to a failure — "we do not know" and "it failed" are
   * different facts.
   */
  lastOutcome: CronOutcome | null;
  /** Exit code of the last COMPLETED run; null if it never ran or never ended. */
  lastExitCode: number | null;
}

const NEVER_RAN: CronRunStats = { runs: 0, runsExact: true, lastOutcome: null, lastExitCode: null };

/** `[start]` at a line start — see (1). */
const START_LINE = /^\[start\] /gm;
/** `[end] … exit=N`, unanchored — see (2). */
const END_RECORD = /\[end\] .*?exit=(-?\d+)/g;
/**
 * The `[cmd]` echo, which quotes the cron's PROMPT verbatim. A prompt that
 * happens to contain the text of an end record would otherwise forge one —
 * and because `[cmd]` is emitted immediately after `[start]`, the forgery sits
 * after the start and would turn a genuinely killed run into a reported
 * outcome. `[cmd]` is always at a line start (the `[start]` echo before it ends
 * CRLF), so dropping those lines wholesale is exact, not heuristic.
 */
const CMD_LINE = /^\[cmd\] .*$/gm;

/**
 * Parse an already-read chunk of log text.
 *
 * `truncated` says the chunk is a tail rather than the whole file, which only
 * affects `runsExact` — the outcome is read from the END of the text either way,
 * and the end of a tail is the end of the file.
 */
export function parseCronLog(raw: string, truncated = false): CronRunStats {
  // Both scans below run over the SAME blanked text, so the start-vs-end
  // position comparison stays consistent. Blanked, not deleted: keeping the
  // line breaks means `[start]` line anchoring is unaffected.
  const text = raw.replace(CMD_LINE, '');
  const starts = text.match(START_LINE);
  const runs = starts ? starts.length : 0;

  // Walk to the LAST end record, keeping its offset so we can tell whether a
  // later [start] outranks it.
  END_RECORD.lastIndex = 0;
  let lastEndAt = -1;
  let lastExitCode: number | null = null;
  for (let m = END_RECORD.exec(text); m; m = END_RECORD.exec(text)) {
    lastEndAt = m.index;
    lastExitCode = Number(m[1]);
  }

  START_LINE.lastIndex = 0;
  let lastStartAt = -1;
  for (let m = START_LINE.exec(text); m; m = START_LINE.exec(text)) lastStartAt = m.index;

  if (runs === 0 && lastEndAt === -1) return { ...NEVER_RAN, runsExact: !truncated };

  // A start AFTER the last end means the newest run never wrote its end record.
  if (lastStartAt > lastEndAt) {
    return { runs, runsExact: !truncated, lastOutcome: 'incomplete', lastExitCode: null };
  }
  return {
    runs,
    runsExact: !truncated,
    lastOutcome: lastExitCode === 0 ? 'ok' : 'failed',
    lastExitCode,
  };
}

/** A cron's run stats plus when its log was last written (mtime, epoch ms). */
export interface CronLogRead extends CronRunStats {
  /** Null when the cron has produced no output at all (no log file). */
  lastOutputAt: number | null;
}

/**
 * Read a cron's log and derive its stats, bounded to the last
 * `CRON_LOG_READ_CAP` bytes. A missing log is the normal "never run yet" state,
 * not an error; an UNREADABLE log (permissions, a directory in its place) is
 * reported the same way rather than thrown, because one bad log must not take
 * the whole Crons pane down with it.
 */
export function readCronRunStats(logPath: string): CronLogRead {
  let fd: number | undefined;
  try {
    const size = fs.statSync(logPath).size;
    const mtime = fs.statSync(logPath).mtimeMs;
    if (size === 0) return { ...NEVER_RAN, lastOutputAt: mtime };

    const truncated = size > CRON_LOG_READ_CAP;
    const length = truncated ? CRON_LOG_READ_CAP : size;
    const buf = Buffer.allocUnsafe(length);
    fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buf, 0, length, size - length);

    let text = buf.toString('utf8');
    // A tail starts mid-line. Drop that fragment so every record we match is a
    // whole one — it can only cost us one [start], which keeps the count a
    // clean lower bound instead of a maybe-wrong exact.
    if (truncated) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return { ...parseCronLog(text, truncated), lastOutputAt: mtime };
  } catch {
    return { ...NEVER_RAN, lastOutputAt: null };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}
