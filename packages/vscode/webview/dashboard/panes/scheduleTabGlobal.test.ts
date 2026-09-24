import { describe, expect, it } from 'vitest';
import { scheduleTabFromGlobal } from './scheduleTabGlobal';

describe('scheduleTabFromGlobal (t-ru1qsp)', () => {
  it('is loops only on an exact "loops"', () => {
    expect(scheduleTabFromGlobal({ __ORIGAMI_SCHEDULE_TAB__: 'loops' })).toBe('loops');
  });
  it('defaults to crons when absent', () => {
    expect(scheduleTabFromGlobal({})).toBe('crons');
  });
  it('defaults to crons for a stale/unknown value', () => {
    expect(scheduleTabFromGlobal({ __ORIGAMI_SCHEDULE_TAB__: 'somethingElse' })).toBe('crons');
  });
  it('does not throw on an undefined window-like value', () => {
    expect(scheduleTabFromGlobal(undefined)).toBe('crons');
  });
});
