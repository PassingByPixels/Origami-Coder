// cronLog — how many times a cron ran and how the last run ended, read from the
// cron's own log. The log is an audit trail written by a batch file at 3am with
// nobody watching, so these tests are built from the REAL on-disk shape (taken
// verbatim from \Origami\cms791dnuckui's log on Passing's machine) rather than
// an idealised one: locale-formatted dates, ANSI escapes, CRLF, and arbitrary
// agent stdout dumped between the markers.
//
// The bug each test exists to catch is named in its comment. The expensive ones
// are the asymmetries: a run that started and never ended, and an [end] record
// glued to the tail of output that lacked a trailing newline.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CRON_LOG_READ_CAP, parseCronLog, readCronRunStats } from '../../../src/dashboard/crons/cronLog';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-cronlog-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const logAt = (name: string, text: string) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
};

/** One complete run, in the exact shape cronLauncher.ts emits (CRLF, the
 *  locale's DD/MM/YYYY date, the leading-space single-digit hour, the trailing
 *  space before the line break) plus a slab of agent output with ANSI in it. */
const run = (exit: number, time = ' 9:39:43.21') =>
  `[start] demo heartbeat 30/07/2026 ${time} \r\n`
  + `[cmd] "C:\\Users\\dev\\.origami\\bin\\origami.exe" run "do the thing" --auto --dir "C:\\ws" \r\n`
  + `\u001b[0m\r\n> build \u00b7 laguna-s-2.1-nvfp4\r\n`
  + `\u001b[93m\u001b[1m! \u001b[0mpermission requested: external_directory; auto-rejecting\r\n`
  + `[end] 30/07/2026  9:39:47.65 exit=${exit} \r\n`;

/** The same, but killed: the start record is written, the end record never is. */
const startedNeverEnded = () =>
  `[start] demo heartbeat 30/07/2026 10:00:00.00 \r\n`
  + `[cmd] "origami.exe" run "do the thing" --auto \r\n`
  + `working on it...\r\n`;

describe('cronLog — the run count comes from the log and nowhere else', () => {
  it('counts one [start] per run and reads the LAST run outcome', () => {
    const s = parseCronLog(run(0) + run(0) + run(0));
    expect(s.runs).toBe(3);
    expect(s.runsExact).toBe(true);
    expect(s.lastOutcome).toBe('ok');
    expect(s.lastExitCode).toBe(0);
  });

  it('reports the LAST run, not the worst — a green run after a red one is green', () => {
    // The bug: summarising the whole history into one status, so a cron that
    // failed once in March reads FAILED forever and nobody trusts the column.
    const s = parseCronLog(run(1) + run(0));
    expect(s.runs).toBe(2);
    expect(s.lastOutcome).toBe('ok');
  });

  it('a non-zero exit is failed, and the code itself survives for the row note', () => {
    const s = parseCronLog(run(0) + run(1));
    expect(s.lastOutcome).toBe('failed');
    expect(s.lastExitCode).toBe(1);
  });

  it('a negative exit code (a Windows crash code) parses rather than being dropped', () => {
    const s = parseCronLog(run(-1073741819));
    expect(s.lastOutcome).toBe('failed');
    expect(s.lastExitCode).toBe(-1073741819);
  });
});

describe('cronLog — [start] with no [end] is its own state, not a failure', () => {
  it('a killed or still-running last run reports incomplete with NO exit code', () => {
    // THE asymmetry the launcher is built around: [start] is written before the
    // work, [end] after it, so a start with no end is the only visible trace of
    // a run that was killed, or that is happening right now. Rounding it to
    // "failed" invents an outcome nobody observed; rounding it to "ok" is worse.
    const s = parseCronLog(run(0) + startedNeverEnded());
    expect(s.runs).toBe(2);
    expect(s.lastOutcome).toBe('incomplete');
    expect(s.lastExitCode).toBeNull();
  });

  it('an incomplete run STILL counts as a run — it did start', () => {
    expect(parseCronLog(startedNeverEnded()).runs).toBe(1);
  });

  it('a completed run AFTER an incomplete one clears the incomplete state', () => {
    // Position, not arithmetic: counting starts-vs-ends would still read
    // "incomplete" here because the totals stay unbalanced forever.
    const s = parseCronLog(startedNeverEnded() + run(0));
    expect(s.runs).toBe(2);
    expect(s.lastOutcome).toBe('ok');
  });
});

describe('cronLog — the records are found in real, messy output', () => {
  it('reads an [end] GLUED to output that had no trailing newline', () => {
    // The real bug: `origami run` whose last write lacks a newline leaves the
    // launcher's echo appended to that line. Anchoring [end] to a line start
    // would silently lose the outcome of exactly those runs — and they are the
    // interesting ones, because odd output usually means something went wrong.
    const glued = `[start] job 30/07/2026  9:00:00.00 \r\n`
      + `[cmd] "origami.exe" run "x" --auto \r\n`
      + `Error: something went sideways[end] 30/07/2026  9:00:09.00 exit=2 \r\n`;
    const s = parseCronLog(glued);
    expect(s.runs).toBe(1);
    expect(s.lastOutcome).toBe('failed');
    expect(s.lastExitCode).toBe(2);
  });

  it('does NOT count a "[start]" that appears mid-line inside agent output', () => {
    // A cron whose prompt makes the agent echo text containing the marker must
    // not inflate its own run count. [start] is always at a line start (the
    // preceding write is an echo, which ends CRLF), so anchoring is safe.
    const noisy = `[start] job 30/07/2026  9:00:00.00 \r\n`
      + `[cmd] "origami.exe" run "x" --auto \r\n`
      + `the log begins with [start] job and then continues\r\n`
      + `[end] 30/07/2026  9:00:09.00 exit=0 \r\n`;
    expect(parseCronLog(noisy).runs).toBe(1);
  });

  it('an [end] with no exit code at all is not mistaken for a completed run', () => {
    const truncatedEnd = `[start] job 30/07/2026  9:00:00.00 \r\n[end] 30/07/2026  9:00:09.00\r\n`;
    expect(parseCronLog(truncatedEnd).lastOutcome).toBe('incomplete');
  });
});

describe('cronLog — reading the file', () => {
  it('a log that does not exist is "never run", not an error', () => {
    const s = readCronRunStats(path.join(dir, 'nope.log'));
    expect(s).toEqual({ runs: 0, runsExact: true, lastOutcome: null, lastExitCode: null, lastOutputAt: null });
  });

  it('an EMPTY log (created but never written to) is also never-run, and still reports its mtime', () => {
    const p = logAt('empty.log', '');
    const s = readCronRunStats(p);
    expect(s.runs).toBe(0);
    expect(s.lastOutcome).toBeNull();
    expect(s.lastOutputAt).toBeCloseTo(fs.statSync(p).mtimeMs, -2);
  });

  it('a real log round-trips through the file reader with an exact count', () => {
    const p = logAt('real.log', run(0) + run(1));
    const s = readCronRunStats(p);
    expect(s.runs).toBe(2);
    expect(s.runsExact).toBe(true);
    expect(s.lastOutcome).toBe('failed');
  });

  it('a HUGE log is read from the tail only, and says its count is a floor', () => {
    // The bug: slurping an unbounded file on every pane refresh. The honest
    // consequence is that the count becomes a lower bound — which must be
    // REPORTED (runsExact:false -> the pane prints "12+"), never passed off as
    // a total, and the last outcome must still be right because the end of a
    // tail is the end of the file.
    const one = run(0);
    const copies = Math.ceil((CRON_LOG_READ_CAP * 2) / one.length);
    const p = logAt('huge.log', one.repeat(copies) + run(1));
    const s = readCronRunStats(p);
    expect(fs.statSync(p).size).toBeGreaterThan(CRON_LOG_READ_CAP);
    expect(s.runsExact).toBe(false);
    expect(s.runs).toBeGreaterThan(0);
    expect(s.runs).toBeLessThan(copies + 1);
    expect(s.lastOutcome).toBe('failed');
    expect(s.lastExitCode).toBe(1);
  });

  it('a log path that is a DIRECTORY degrades to never-run instead of throwing', () => {
    // One unreadable log must not take the whole Crons pane down with it.
    const sub = path.join(dir, 'a-directory.log');
    fs.mkdirSync(sub);
    expect(readCronRunStats(sub).lastOutcome).toBeNull();
  });
});

describe('cronLog — the [cmd] echo cannot forge a record', () => {
  it('a PROMPT containing an end record does not fake an outcome for a killed run', () => {
    // The launcher echoes the prompt verbatim on the [cmd] line. A cron whose
    // prompt mentions "[end] ... exit=0" would otherwise write a forged end
    // record straight after every [start] — turning a run that was killed into
    // a confidently reported success.
    const evil = `[start] sneaky 30/07/2026  9:00:00.00 \r\n`
      + `[cmd] "origami.exe" run "grep the logs for [end] 30/07/2026 exit=0 lines" --auto \r\n`
      + `working...\r\n`;
    const s = parseCronLog(evil);
    expect(s.runs).toBe(1);
    expect(s.lastOutcome).toBe('incomplete');
    expect(s.lastExitCode).toBeNull();
  });

  it('the same prompt still reports the REAL outcome when the run does finish', () => {
    const evil = `[start] sneaky 30/07/2026  9:00:00.00 \r\n`
      + `[cmd] "origami.exe" run "grep for [end] 30/07/2026 exit=0" --auto \r\n`
      + `done\r\n[end] 30/07/2026  9:00:09.00 exit=5 \r\n`;
    const s = parseCronLog(evil);
    expect(s.lastOutcome).toBe('failed');
    expect(s.lastExitCode).toBe(5);
  });
});
