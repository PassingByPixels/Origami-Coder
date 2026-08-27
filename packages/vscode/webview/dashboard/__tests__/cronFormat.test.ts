// cronFormat — the Crons table's derived text.
//
// The rules that matter are the PRECEDENCE ones. A row that is disabled, or
// registered nowhere, will not fire next time; saying OK because its last run
// happened to succeed is the reassuring lie the drift report exists to stop.

import { describe, it, expect } from 'vitest';
import { cronStatus, lastRunText, relativeWhen, runsText, statusLabel, statusNote } from '../panes/cronFormat';

// A fixed local-time anchor so "today"/"tomorrow" are deterministic wherever
// this runs: 2026-07-30 14:00 LOCAL.
const NOW = new Date(2026, 6, 30, 14, 0, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 6, d, h, m, 0).getTime();

const rowOf = (over: Partial<Parameters<typeof cronStatus>[0]> = {}) =>
  ({ id: 'c1', enabled: true, lastOutcome: null, lastExitCode: null, ...over });

describe('cronFormat — relative time', () => {
  it('says today / tomorrow / yesterday with the clock time', () => {
    expect(relativeWhen(at(30, 9, 11), NOW)).toBe('today 09:11');
    expect(relativeWhen(at(31, 9, 0), NOW)).toBe('tomorrow 09:00');
    expect(relativeWhen(at(29, 22, 30), NOW)).toBe('yesterday 22:30');
  });

  it('uses CALENDAR days, not 24-hour arithmetic', () => {
    // The bug: (then - now)/86400000. At 14:00 today, 23:59 today is 0.4 days
    // away and 00:30 tomorrow is 0.44 — arithmetic calls both "today", so a run
    // scheduled after midnight is announced as happening today.
    expect(relativeWhen(at(30, 23, 59), NOW)).toBe('today 23:59');
    expect(relativeWhen(at(31, 0, 30), NOW)).toBe('tomorrow 00:30');
  });

  it('falls back to a date once relative wording stops helping', () => {
    expect(relativeWhen(at(28, 9, 0), NOW)).toBe('28 Jul 09:00');
    expect(relativeWhen(new Date(2027, 0, 3, 9, 0).getTime(), NOW)).toBe('3 Jan 2027 09:00');
  });

  it('prints nothing at all for an absent time rather than "Invalid Date"', () => {
    expect(relativeWhen(null, NOW)).toBe('');
    expect(relativeWhen(undefined, NOW)).toBe('');
    expect(relativeWhen(Number.NaN, NOW)).toBe('');
  });
});

describe('cronFormat — status precedence', () => {
  const noDrift = new Set<string>();

  it('a healthy cron that last exited 0 is OK', () => {
    expect(cronStatus(rowOf({ lastOutcome: 'ok', lastExitCode: 0 }), noDrift)).toBe('ok');
  });

  it('DISABLED outranks a successful last run — it is not going to fire', () => {
    expect(cronStatus(rowOf({ enabled: false, lastOutcome: 'ok' }), noDrift)).toBe('disabled');
  });

  it('DRIFT outranks a successful last run — it is registered nowhere', () => {
    // THE bug this ordering prevents: a green OK beside a job that was never
    // registered with the scheduler, so nobody looks at it again.
    expect(cronStatus(rowOf({ lastOutcome: 'ok' }), new Set(['c1']))).toBe('drift');
  });

  it('drift on a DIFFERENT cron does not colour this one', () => {
    expect(cronStatus(rowOf({ lastOutcome: 'ok' }), new Set(['other']))).toBe('ok');
  });

  it('a start with no end is RUNNING, distinct from FAILED', () => {
    expect(cronStatus(rowOf({ lastOutcome: 'incomplete' }), noDrift)).toBe('running');
    expect(cronStatus(rowOf({ lastOutcome: 'failed', lastExitCode: 1 }), noDrift)).toBe('failed');
  });

  it('never having run is its own state, not a failure', () => {
    expect(cronStatus(rowOf(), noDrift)).toBe('never');
    expect(statusLabel('never')).toBe('NEVER RUN');
  });
});

describe('cronFormat — the note a bad row owes the reader', () => {
  it('a failed row names the exit code and points at the log', () => {
    const note = statusNote('failed', rowOf({ lastOutcome: 'failed', lastExitCode: 3 }));
    expect(note).toContain('3');
    expect(note).toContain('log');
  });

  it('a drift row says plainly that it will not fire', () => {
    expect(statusNote('drift', rowOf())).toContain('will not fire');
  });

  it('an incomplete row offers BOTH readings rather than picking one', () => {
    // We genuinely cannot tell a still-running job from a killed one; claiming
    // either would be inventing an observation.
    const note = statusNote('running', rowOf({ lastOutcome: 'incomplete' }));
    expect(note).toContain('still running');
    expect(note).toContain('killed');
  });

  it('a healthy row says nothing — no note is the reward for working', () => {
    expect(statusNote('ok', rowOf())).toBe('');
    expect(statusNote('never', rowOf())).toBe('');
  });
});

describe('cronFormat — the cells', () => {
  it('LAST RUN carries when AND how it went', () => {
    expect(lastRunText(at(30, 9, 11), 'ok', NOW)).toBe('today 09:11 · ok');
    expect(lastRunText(at(30, 9, 11), 'failed', NOW)).toBe('today 09:11 · failed');
  });

  it('an incomplete last run says it left no end record, not "ok"', () => {
    expect(lastRunText(at(30, 9, 11), 'incomplete', NOW)).toBe('today 09:11 · no end record');
  });

  it('a never-run cron leaves LAST RUN blank (the status column already says it)', () => {
    expect(lastRunText(null, null, NOW)).toBe('');
    expect(lastRunText(at(30, 9, 11), null, NOW)).toBe('');
  });

  it('a tail-read count is shown as a floor, never as a total', () => {
    expect(runsText(12, true)).toBe('12');
    expect(runsText(12, false)).toBe('12+');
  });
});
