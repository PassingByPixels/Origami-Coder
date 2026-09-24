// subagentWarn — the amber dot at 80% of the sub-agent time limit.
//
// The bug it exists to prevent is a sub-agent dying silently at its ceiling
// with four hours of work in it. The rules that matter are all boundaries, and
// none of them are reachable by waiting: the clock is a parameter.
import { describe, expect, it } from 'vitest';
import { limitMs, limitWarning, WARN_FRACTION } from '../panes/subagentWarn';

const FOUR_HOURS = 4 * 3_600_000;

describe('limitMs — hours from the host, milliseconds for the rule', () => {
  it('converts a usable setting', () => {
    expect(limitMs(4)).toBe(FOUR_HOURS);
    expect(limitMs(0.5)).toBe(1_800_000);
  });

  it('reports 0 for anything unusable, which turns the warning OFF', () => {
    // A webview inventing a ceiling would amber rows the engine is perfectly
    // happy with — the setting is the only honest source.
    expect(limitMs(undefined)).toBe(0);
    expect(limitMs(0)).toBe(0);
    expect(limitMs(-1)).toBe(0);
    expect(limitMs(Number.NaN)).toBe(0);
  });
});

describe('limitWarning — the 80% boundary', () => {
  it('says nothing one millisecond BEFORE the threshold', () => {
    expect(limitWarning(FOUR_HOURS * WARN_FRACTION - 1, false, FOUR_HOURS)).toBe('');
  });

  it('warns exactly AT the threshold, naming the limit and the time left', () => {
    // 80% of four hours is 3h 12m, so 48 minutes remain.
    expect(limitWarning(FOUR_HOURS * WARN_FRACTION, false, FOUR_HOURS))
      .toBe('Approaching the 4 h sub-agent time limit — about 48m 00s left');
  });

  it('changes its wording once the ceiling is PAST, rather than counting down past zero', () => {
    expect(limitWarning(FOUR_HOURS, false, FOUR_HOURS))
      .toBe('Past the 4 h sub-agent time limit — the engine may stop it at any moment');
    expect(limitWarning(FOUR_HOURS + 60_000, false, FOUR_HOURS))
      .toBe('Past the 4 h sub-agent time limit — the engine may stop it at any moment');
  });

  it('names a sub-hour limit in minutes rather than as "0.5 h"', () => {
    expect(limitWarning(1_750_000, false, 1_800_000)).toContain('the 30 min sub-agent time limit');
  });

  it('never warns on a SETTLED row, however long it ran', () => {
    // A finished child cannot be killed by the ceiling, and a long one that
    // finished is exactly the row nobody needs chasing.
    expect(limitWarning(FOUR_HOURS * 2, true, FOUR_HOURS)).toBe('');
  });

  it('never warns on an UNKNOWN age — amber on a clock nobody trusts is a false alarm', () => {
    // `0` is subagentTiming.ts's "nobody timed this".
    expect(limitWarning(0, false, FOUR_HOURS)).toBe('');
  });

  it('never warns when the host reported no usable ceiling', () => {
    expect(limitWarning(FOUR_HOURS * 10, false, 0)).toBe('');
  });
});
