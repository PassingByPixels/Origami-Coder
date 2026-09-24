// SwipeRow's maths. jsdom has NO layout engine, so a test that dragged a real
// row and read a transform would be asserting nothing — these prove the
// numbers instead, against the react-bits reference's own stated behaviour
// (Mock-Redesign/CHANGES.md change 2 lists the constants and the verified
// values this file pins). The DOM side is SwipeRowDom.test.ts; see that file's
// header for why neither is called swipeRow.test.ts.
import { describe, expect, it } from 'vitest';
import {
  SWIPE_ACTION_W, SWIPE_FLICK, commitPoint, decideOpen, locks, mapExtent, project, rubber,
  settleEase, velocity,
} from './swipeRow';

describe('swipeRow — how far the row travels', () => {
  it('tracks the finger exactly up to the action width', () => {
    expect(mapExtent(0, 360)).toBe(0);
    expect(mapExtent(40, 360)).toBe(40);
    expect(mapExtent(SWIPE_ACTION_W, 360)).toBe(SWIPE_ACTION_W);
  });

  it('resists past the action width instead of tracking one-to-one', () => {
    // A pull beyond the panel must move LESS than the finger, or the row would
    // open as fast as it is dragged and the commit point would be an accident.
    const pulled = mapExtent(SWIPE_ACTION_W + 100, 360);
    expect(pulled).toBeGreaterThan(SWIPE_ACTION_W);
    expect(pulled).toBeLessThan(SWIPE_ACTION_W + 100);
  });

  it('is an asymptote, not a wall: an unbounded pull converges', () => {
    // rubber() tends to `dim` as the overshoot grows, so the travel is capped
    // at commitPoint + the row width however hard the row is pulled. The point
    // is that it CONVERGES — a linear map would let a long drag throw the row
    // arbitrarily far off screen.
    const cap = commitPoint(360) + 360;
    expect(mapExtent(100_000, 360)).toBeLessThan(cap);
    expect(mapExtent(200_000, 360) - mapExtent(100_000, 360)).toBeLessThan(2);
  });

  it('rubber-bands a pull the wrong way, so the row cannot be dragged open rightwards', () => {
    expect(mapExtent(-200, 360)).toBeLessThan(0);
    expect(mapExtent(-200, 360)).toBeGreaterThan(-200);
    expect(rubber(-200, 360)).toBeCloseTo(mapExtent(-200, 360), 10);
  });
});

describe('swipeRow — when a swipe becomes a delete', () => {
  it('commits at 60% of a wide row', () => {
    expect(commitPoint(400)).toBe(240);
  });

  it('never commits closer than one and a half action widths on a narrow row', () => {
    // 60% of 180 is 108, which is barely past the revealed panel: on a narrow
    // sidebar that would delete a chat the user only meant to open.
    expect(commitPoint(180)).toBe(SWIPE_ACTION_W * 1.5);
  });
});

describe('swipeRow — what a release decides', () => {
  it('a slow release past halfway opens', () => {
    expect(decideOpen(SWIPE_ACTION_W / 2 + 1, 0)).toBe(true);
    expect(decideOpen(SWIPE_ACTION_W / 2 - 1, 0)).toBe(false);
  });

  it('a flick decides by DIRECTION, even from a few pixels', () => {
    expect(decideOpen(4, SWIPE_FLICK)).toBe(true);
    // And the other way: nearly open, flicked shut, must close.
    expect(decideOpen(SWIPE_ACTION_W - 2, -SWIPE_FLICK)).toBe(false);
  });

  it('a slow release short of halfway still opens if the momentum would carry it', () => {
    expect(decideOpen(20, 100)).toBe(true);
    expect(project(100)).toBeGreaterThan(SWIPE_ACTION_W / 2 - 20);
  });

  it('reads velocity from the drag samples in px/s, and 0 from too few', () => {
    expect(velocity([[0, 0], [100, 50]])).toBeCloseTo(500, 6);
    expect(velocity([[0, 0]])).toBe(0);
    expect(velocity([])).toBe(0);
  });
});

describe('swipeRow — the gesture lock', () => {
  it('ignores a vertical drag, so scrolling the chat list never opens a row', () => {
    expect(locks(6, 40)).toBe(false);
    expect(locks(30, 60)).toBe(false);
  });

  it('locks once the horizontal passes the hysteresis AND beats the vertical', () => {
    expect(locks(12, 4)).toBe(true);
    expect(locks(-12, 4)).toBe(true);
    expect(locks(9, 0)).toBe(false);
  });
});

describe('swipeRow — the settle', () => {
  it('overshoots on a flick and not otherwise', () => {
    expect(settleEase(SWIPE_FLICK, false)).toContain('400ms');
    expect(settleEase(0, false)).toContain('300ms');
  });

  it('reduced motion never overshoots, whatever the flick', () => {
    expect(settleEase(900, true)).toBe('200ms cubic-bezier(0.23, 1, 0.32, 1)');
  });
});
