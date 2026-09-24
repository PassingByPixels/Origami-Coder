// cronLog.ts — how many times a cron has run and how the last run ended, read from the cron's own
// log file. The log is the audit trail and the only source of truth; a second counter would drift
// the moment a run is killed or a log is edited by hand.
// Three properties of the on-disk shape drive the parsing: `[start]` is always at a line start and
// can be anchored; `[end]` is not (it can glue to the run's own last, newline-less output) and is
// matched unanchored on `exit=<digits>` instead; `%DATE%`/`%TIME%` are locale-formatted and are not
// parsed back into a Date — the timestamp comes from the file's mtime instead.

import * as fs from 'node:fs';

/**
 * How much of a log to read. Beyond this cap only the tail is read, making the count a lower bound,
 *  reported honestly via `runsExact` rather than passed off as a total.
 */
export const CRON_LOG_READ_CAP = 256 * 1024;

export type CronOutcome = 'ok' | 'failed' | 'incomplete';

export interface CronRunStats {
  /** `[start]` records seen. A LOWER BOUND when `runsExact` is false. */
  runs: number;
  /** False when the log was too big to read whole, so `runs` counts a tail. */
  runsExact: boolean;
  /**
   * How the most recent run ended, or null when the cron has never run. `incomplete` means a
   *  `[start]` with no `[end]` after it — killed, crashed, or still running — surfaced rather than
   *  rounded to a failure, since "we do not know" and "it failed" are different facts.
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
 * The `[cmd]` echo, which quotes the cron's prompt verbatim. Dropped wholesale before matching,
 *  since a prompt containing end-record-like text would otherwise forge an outcome.
 */
const CMD_LINE = /^\[cmd\] .*$/gm;

/**
 * Parse an already-read chunk of log text. `truncated` only affects `runsExact` — the outcome is
 *  read from the end of the text either way.
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
 * Read a cron's log and derive its stats, bounded to `CRON_LOG_READ_CAP` bytes. A missing log means
 *  "never run"; an unreadable one is reported the same way rather than thrown, so one bad log
 *  cannot take the whole pane down.
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
