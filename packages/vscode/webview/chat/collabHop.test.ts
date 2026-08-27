// collabHop — the budget's derived text. Two surfaces read the same pair of
// numbers now (the control strip's paused banner, the bar under the composer),
// so the rules live in one leaf and are pinned here rather than through either
// of them.
//
// The bugs worth catching are all the same shape: COALESCING a state that is
// not a number with one that is.
//
//   - `remaining: null` means the budget is OFF. Printed as "0" it says the
//     opposite — that the room is out of budget and about to stop.
//   - a cap of 0 means the breaker is DISABLED, and a cap of null means "use
//     the engine's". `cap || default` folds those two into one and quietly
//     re-arms a rail the user turned off.
//   - a budget that is OFF is not LOW. Nothing is running down, so the
//     emphasis state would be a warning about a countdown that is not running.

import { describe, expect, it } from 'vitest';
import { capText, HOP_LOW_AT, hopLow, hopText, suspendText } from './collabHop';

describe('collabHop — the cap SETTING is three sentences, never one with a number in it', () => {
  it('null is the engine default', () => {
    expect(capText(null)).toContain('default');
    expect(capText(undefined)).toContain('default');
  });

  it('0 is OFF, and says so in words rather than printing a zero', () => {
    expect(capText(0)).toContain('OFF');
    expect(capText(0)).not.toMatch(/\b0 agent/);
  });

  it('N is that cap, singular and plural', () => {
    expect(capText(12)).toBe('Loop breaker: 12 agent turns without you');
    expect(capText(1)).toBe('Loop breaker: 1 agent turn without you');
  });
});

describe('collabHop — what is LEFT of the budget', () => {
  it('reads as a fraction of what it started with', () => {
    expect(hopText({ remaining: 14, cap: 20 })).toBe('hops 14/20');
    expect(hopText({ remaining: 1, cap: 20 })).toBe('hops 1/20');
    expect(hopText({ remaining: 0, cap: 20 })).toBe('hops 0/20');
  });

  it('a budget that is OFF says so instead of counting down from nothing', () => {
    expect(hopText({ remaining: null, cap: 0 })).toBe('hop budget off');
    expect(hopText({ remaining: null, cap: null })).toBe('hop budget off');
  });

  // An older engine reports no hopState at all. A bar that printed one would be
  // inventing the entire figure, which is worse than showing nothing.
  it('no hopState prints NOTHING — an absent budget is not a budget of zero', () => {
    expect(hopText(undefined)).toBe('');
    expect(hopText(null)).toBe('');
  });

  // A count with no denominator is still a real fact; a denominator invented to
  // go with it is not.
  it('a count with no cap prints the count alone, never a made-up denominator', () => {
    expect(hopText({ remaining: 4 })).toBe('4 hops left');
    expect(hopText({ remaining: 1 })).toBe('1 hop left');
  });

  it('a non-numeric remaining is read as OFF, not as a rendered NaN', () => {
    expect(hopText({ remaining: 'lots', cap: 20 })).toBe('hop budget off');
    expect(hopText({ remaining: Number.NaN, cap: 20 })).toBe('hop budget off');
  });
});

describe('collabHop — the low state', () => {
  it('lights at the threshold and stays lit below it', () => {
    expect(hopLow({ remaining: HOP_LOW_AT + 1, cap: 20 })).toBe(false);
    expect(hopLow({ remaining: HOP_LOW_AT, cap: 20 })).toBe(true);
    expect(hopLow({ remaining: 0, cap: 20 })).toBe(true);
  });

  it('a budget that is OFF is never low — nothing is running down', () => {
    expect(hopLow({ remaining: null, cap: 0 })).toBe(false);
  });

  it('...and neither is an absent one', () => {
    expect(hopLow(undefined)).toBe(false);
    expect(hopLow(null)).toBe(false);
  });
});

describe('collabHop — why the room is paused', () => {
  it('names the hop budget ONLY when the engine reported one that is spent', () => {
    expect(suspendText({ remaining: 0, cap: 20 })).toContain('hop budget spent');
  });

  // An older build never sends hopState, and must keep the sentence it earned
  // rather than being handed a hop count nobody reported.
  it('keeps the loop-breaker wording with no hopState, and with one still in credit', () => {
    expect(suspendText(undefined)).toContain('hit the loop breaker');
    expect(suspendText(undefined)).not.toContain('hop budget');
    expect(suspendText({ remaining: 5, cap: 20 })).toContain('hit the loop breaker');
    // A budget that is OFF cannot have been spent, so it keeps it too.
    expect(suspendText({ remaining: null, cap: 0 })).toContain('hit the loop breaker');
  });
});
