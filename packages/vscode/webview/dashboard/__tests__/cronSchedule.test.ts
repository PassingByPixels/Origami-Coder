// cronSchedule — what a cron is ALLOWED to be. The bug these tests exist to
// catch is the worst one a scheduler has: a schedule accepted, translated
// approximately, and fired at a time nobody asked for. Every "reject" case
// below is a shape Task Scheduler cannot express faithfully, so the only
// correct behaviour is a refusal with a reason — never a silent re-reading.

import { describe, it, expect } from 'vitest';
import { nextRun, parseCronExpression, parseSchedule, scheduleFlags, scheduleLabel } from '../../../src/dashboard/crons/cronSchedule';

const ok = (r: ReturnType<typeof parseSchedule>) => {
  if (!r.ok) throw new Error(`expected accept, got reject: ${r.reason}`);
  return r.schedule;
};

describe('cronSchedule — the four expressible shapes are accepted exactly', () => {
  it('daily keeps its 24-hour time', () => {
    expect(ok(parseSchedule({ kind: 'daily', time: '09:30' }))).toEqual({ kind: 'daily', time: '09:30' });
  });

  it('weekly normalises its day set to MON..SUN order, so the same set always yields the same task', () => {
    // Typed out of order and with a duplicate — the registered /D list must
    // still be stable, or an "edit" that changed nothing would rewrite the task.
    const s = ok(parseSchedule({ kind: 'weekly', days: ['FRI', 'MON', 'FRI'], time: '07:00' }));
    expect(s).toEqual({ kind: 'weekly', days: ['MON', 'FRI'], time: '07:00' });
  });

  it('hourly and minutely keep their interval', () => {
    expect(ok(parseSchedule({ kind: 'hourly', every: 3 }))).toEqual({ kind: 'hourly', every: 3 });
    expect(ok(parseSchedule({ kind: 'minutely', every: 15 }))).toEqual({ kind: 'minutely', every: 15 });
  });
});

describe('cronSchedule — untranslatable schedules are REJECTED, never mangled', () => {
  it('rejects "every 24 hours": schtasks /SC HOURLY caps at 23, and re-reading it as daily would invent a fire time', () => {
    const r = parseSchedule({ kind: 'hourly', every: 24 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('24');
    // The give-away that we did NOT quietly convert it:
    expect(r.reason).toMatch(/daily/i);
  });

  it('rejects an out-of-range minute interval rather than clamping it', () => {
    const r = parseSchedule({ kind: 'minutely', every: 5000 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('1439');
  });

  it('rejects a non-whole or zero interval', () => {
    expect(parseSchedule({ kind: 'hourly', every: 0 }).ok).toBe(false);
    expect(parseSchedule({ kind: 'hourly', every: 2.5 }).ok).toBe(false);
    expect(parseSchedule({ kind: 'minutely', every: -3 }).ok).toBe(false);
  });

  it('rejects a malformed or 12-hour time instead of guessing AM/PM', () => {
    expect(parseSchedule({ kind: 'daily', time: '9:30' }).ok).toBe(false);
    expect(parseSchedule({ kind: 'daily', time: '25:00' }).ok).toBe(false);
    expect(parseSchedule({ kind: 'daily', time: '09:30 PM' }).ok).toBe(false);
    expect(parseSchedule({ kind: 'daily', time: '' }).ok).toBe(false);
  });

  it('rejects weekly with no days, or an unknown day name', () => {
    expect(parseSchedule({ kind: 'weekly', days: [], time: '07:00' }).ok).toBe(false);
    expect(parseSchedule({ kind: 'weekly', days: ['FUNDAY'], time: '07:00' }).ok).toBe(false);
  });

  it('rejects an unknown kind, a non-object, and null', () => {
    expect(parseSchedule({ kind: 'yearly' }).ok).toBe(false);
    expect(parseSchedule('daily').ok).toBe(false);
    expect(parseSchedule(null).ok).toBe(false);
    expect(parseSchedule(undefined).ok).toBe(false);
  });
});

describe('cronSchedule — a cron EXPRESSION is only accepted when it round-trips', () => {
  it('accepts the four expressible forms, translating to our own shapes', () => {
    expect(ok(parseCronExpression('30 9 * * *'))).toEqual({ kind: 'daily', time: '09:30' });
    expect(ok(parseCronExpression('0 7 * * MON,WED'))).toEqual({ kind: 'weekly', days: ['MON', 'WED'], time: '07:00' });
    expect(ok(parseCronExpression('0 */4 * * *'))).toEqual({ kind: 'hourly', every: 4 });
    expect(ok(parseCronExpression('*/15 * * * *'))).toEqual({ kind: 'minutely', every: 15 });
  });

  it('numeric weekday fields map the same way, including 0 and 7 as Sunday', () => {
    expect(ok(parseCronExpression('0 6 * * 1'))).toEqual({ kind: 'weekly', days: ['MON'], time: '06:00' });
    expect(ok(parseCronExpression('0 6 * * 0'))).toEqual({ kind: 'weekly', days: ['SUN'], time: '06:00' });
    expect(ok(parseCronExpression('0 6 * * 7'))).toEqual({ kind: 'weekly', days: ['SUN'], time: '06:00' });
  });

  it('REJECTS a weekday RANGE rather than expanding it — the classic "0 9 * * 1-5"', () => {
    // Expanding 1-5 would be a guess about intent that happens to be right
    // often enough to hide the times it is wrong.
    const r = parseCronExpression('0 9 * * 1-5');
    expect(r.ok).toBe(false);
  });

  it('REJECTS day-of-month, month, seconds fields and @-shorthands', () => {
    expect(parseCronExpression('0 9 1 * *').ok).toBe(false);      // day-of-month
    expect(parseCronExpression('0 9 * 6 *').ok).toBe(false);      // month
    expect(parseCronExpression('0 0 9 * * *').ok).toBe(false);    // 6 fields
    expect(parseCronExpression('@daily').ok).toBe(false);
    expect(parseCronExpression('').ok).toBe(false);
  });

  it('REJECTS an offset hourly step (Task Scheduler cannot express "every 4h at :20")', () => {
    expect(parseCronExpression('20 */4 * * *').ok).toBe(false);
  });

  it('an expression whose translated form is out of range is rejected by the SAME bound', () => {
    // */90 minutes round-trips into minutely{90} which is fine; */1500 is not.
    expect(parseCronExpression('*/90 * * * *').ok).toBe(true);
    expect(parseCronExpression('*/1500 * * * *').ok).toBe(false);
    // "every 24 hours" written as cron must hit the same refusal as the object form.
    expect(parseCronExpression('0 */24 * * *').ok).toBe(false);
  });

  it('parseSchedule delegates { kind: "cron" } through the same translator', () => {
    expect(ok(parseSchedule({ kind: 'cron', expr: '30 9 * * *' }))).toEqual({ kind: 'daily', time: '09:30' });
    expect(parseSchedule({ kind: 'cron', expr: '0 9 * * 1-5' }).ok).toBe(false);
    expect(parseSchedule({ kind: 'cron' }).ok).toBe(false);
  });
});

describe('cronSchedule — schtasks flag mapping', () => {
  it('maps each shape onto its /SC mode verbatim', () => {
    expect(scheduleFlags({ kind: 'daily', time: '09:30' })).toEqual(['/SC', 'DAILY', '/ST', '09:30']);
    expect(scheduleFlags({ kind: 'weekly', days: ['MON', 'WED'], time: '07:00' })).toEqual(['/SC', 'WEEKLY', '/D', 'MON,WED', '/ST', '07:00']);
    expect(scheduleFlags({ kind: 'hourly', every: 4 })).toEqual(['/SC', 'HOURLY', '/MO', '4']);
    expect(scheduleFlags({ kind: 'minutely', every: 15 })).toEqual(['/SC', 'MINUTE', '/MO', '15']);
  });

  it('labels read as plain English, singular where it matters', () => {
    expect(scheduleLabel({ kind: 'daily', time: '09:30' })).toBe('daily at 09:30');
    expect(scheduleLabel({ kind: 'hourly', every: 1 })).toBe('every hour');
    expect(scheduleLabel({ kind: 'hourly', every: 4 })).toBe('every 4 hours');
    expect(scheduleLabel({ kind: 'minutely', every: 1 })).toBe('every minute');
  });
});

describe('cronSchedule — nextRun tells the truth or says nothing', () => {
  it('daily rolls to tomorrow once today has passed', () => {
    const from = new Date(2026, 6, 29, 10, 0, 0);
    expect(nextRun({ kind: 'daily', time: '09:30' }, from)).toEqual(new Date(2026, 6, 30, 9, 30, 0, 0));
    expect(nextRun({ kind: 'daily', time: '11:30' }, from)).toEqual(new Date(2026, 6, 29, 11, 30, 0, 0));
  });

  it('daily at exactly now rolls forward — never returns a time already gone', () => {
    const from = new Date(2026, 6, 29, 9, 30, 0);
    expect(nextRun({ kind: 'daily', time: '09:30' }, from)).toEqual(new Date(2026, 6, 30, 9, 30, 0, 0));
  });

  it('weekly finds the next listed weekday', () => {
    // 2026-07-29 is a Wednesday.
    const from = new Date(2026, 6, 29, 10, 0, 0);
    expect(nextRun({ kind: 'weekly', days: ['FRI'], time: '07:00' }, from)).toEqual(new Date(2026, 6, 31, 7, 0, 0, 0));
    // Today still counts when the time has not passed yet.
    expect(nextRun({ kind: 'weekly', days: ['WED'], time: '18:00' }, from)).toEqual(new Date(2026, 6, 29, 18, 0, 0, 0));
    // ...and does not when it has.
    expect(nextRun({ kind: 'weekly', days: ['WED'], time: '08:00' }, from)).toEqual(new Date(2026, 7, 5, 8, 0, 0, 0));
  });

  it('an interval cron with NO registration anchor returns null instead of guessing', () => {
    // Task Scheduler counts an interval from when the task was registered, so
    // without that anchor any number we printed would be invented.
    expect(nextRun({ kind: 'hourly', every: 4 }, new Date(2026, 6, 29, 10, 0, 0))).toBeNull();
    expect(nextRun({ kind: 'minutely', every: 15 }, new Date(2026, 6, 29, 10, 0, 0))).toBeNull();
  });

  it('an interval cron steps forward from its anchor, strictly into the future', () => {
    const anchor = new Date(2026, 6, 29, 8, 0, 0).getTime();
    const from = new Date(2026, 6, 29, 10, 0, 0);
    // Anchored 08:00, every 4h -> 12:00 is next at 10:00.
    expect(nextRun({ kind: 'hourly', every: 4 }, from, anchor)).toEqual(new Date(2026, 6, 29, 12, 0, 0, 0));
    // Landing exactly on a boundary must advance, not return "now".
    const onBoundary = new Date(2026, 6, 29, 12, 0, 0);
    expect(nextRun({ kind: 'hourly', every: 4 }, onBoundary, anchor)).toEqual(new Date(2026, 6, 29, 16, 0, 0, 0));
  });
});
