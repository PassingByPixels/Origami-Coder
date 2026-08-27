// chatScroll — the follow-the-stream predicate.
//
// Two failure modes, opposite directions, and both were live before this:
// too strict and a user who never touched the wheel gets unstuck by sub-pixel
// rounding (so the transcript stops following and looks frozen); too loose and
// a user who scrolled up a line gets yanked back down mid-read.

import { describe, expect, it } from 'vitest';
import { STICK_THRESHOLD_PX, isNearBottom } from './chatScroll';

// A scroller 1000px of content in a 400px window: bottom is scrollTop 600.
const H = 1000, V = 400, BOTTOM = H - V;

describe('chatScroll — is the transcript following?', () => {
  it('exactly at the bottom is stuck', () => {
    expect(isNearBottom(BOTTOM, H, V)).toBe(true);
  });

  it('a few pixels short of the bottom is STILL stuck', () => {
    // Content grows under the scroller while a turn streams and a smooth scroll
    // settles a hair out; an exact test would unstick a passive reader.
    expect(isNearBottom(BOTTOM - 1, H, V)).toBe(true);
    expect(isNearBottom(BOTTOM - STICK_THRESHOLD_PX, H, V)).toBe(true);
  });

  it('one pixel past the threshold is a deliberate scroll — not stuck', () => {
    expect(isNearBottom(BOTTOM - STICK_THRESHOLD_PX - 1, H, V)).toBe(false);
  });

  it('scrolled well up is not stuck', () => {
    expect(isNearBottom(0, H, V)).toBe(false);
    expect(isNearBottom(120, H, V)).toBe(false);
  });

  it('content SHORTER than the window is stuck by definition', () => {
    // An empty or one-line chat has scrollTop 0 and no scrollable range. If
    // that read as "scrolled away", the very first reply would never scroll in.
    expect(isNearBottom(0, 200, 400)).toBe(true);
    expect(isNearBottom(0, 400, 400)).toBe(true);
  });

  it('an over-scroll (elastic / rounding overshoot) is stuck, not unstuck', () => {
    expect(isNearBottom(BOTTOM + 12, H, V)).toBe(true);
  });

  it('the threshold is under one message row, so one line of scroll registers', () => {
    // The number is load-bearing: too big and scrolling up a line does nothing.
    expect(STICK_THRESHOLD_PX).toBeGreaterThan(0);
    expect(STICK_THRESHOLD_PX).toBeLessThan(60);
  });
});
