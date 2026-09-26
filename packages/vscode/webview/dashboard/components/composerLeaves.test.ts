// The three composer leaves extracted for the round-2/3 composer port:
// hold-to-stop, the drop-depth counter and the gauge's digit columns.
// Each asserts the BEHAVIOUR the acceptance item names, not the shape of the
// implementation.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHold, HOLD_MS, TAP_MS } from './holdToStop';
import { columnOffsets, digitAt, placesOf } from './gaugeCounter';

afterEach(() => vi.useRealTimers());

describe('holdToStop — a click must not kill a running turn', () => {
  it('a short press does NOT stop, and reports the tap', () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const onTap = vi.fn();
    const hold = createHold({ onStop, onTap });
    hold.down(0);
    vi.advanceTimersByTime(120);
    hold.up(120);
    // Nothing else may fire it after the release either.
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onStop).not.toHaveBeenCalled();
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('a 600ms hold stops the turn, exactly once, and is not a tap', () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const onTap = vi.fn();
    const hold = createHold({ onStop, onTap });
    hold.down(0);
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(onStop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    // The release that follows a completed hold is not a tap.
    hold.up(HOLD_MS);
    expect(onTap).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('a release just under TAP_MS is a tap; just over it is neither', () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const hold = createHold({ onStop: vi.fn(), onTap });
    hold.down(0);
    hold.up(TAP_MS - 1);
    expect(onTap).toHaveBeenCalledTimes(1);
    hold.down(1000);
    hold.up(1000 + TAP_MS);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('the trailing pointerleave / lostpointercapture of one press is a no-op', () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const hold = createHold({ onStop: vi.fn(), onTap });
    hold.down(0);
    hold.up(50); // pointerup
    hold.up(50); // pointerleave, same press
    hold.up(50); // lostpointercapture, same press
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(hold.held()).toBe(false);
  });

  it('key repeat during a hold does not re-arm the timer', () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const hold = createHold({ onStop });
    hold.down(0);
    for (let t = 30; t < HOLD_MS; t += 30) hold.down(t);
    vi.advanceTimersByTime(HOLD_MS);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('dispose cancels a press in flight', () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const hold = createHold({ onStop });
    hold.down(0);
    hold.dispose();
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe('gaugeCounter — the digits take the short way round', () => {
  it('88 is two places reading 8 and 8', () => {
    expect(placesOf(88)).toBe(2);
    expect(digitAt(88, 0, 2)).toBe(8);
    expect(digitAt(88, 1, 2)).toBe(8);
    expect(placesOf(5)).toBe(1);
    expect(placesOf(100)).toBe(3);
    expect(digitAt(100, 0, 3)).toBe(1);
    expect(digitAt(100, 2, 3)).toBe(0);
  });

  it('the shown digit sits on the line and its neighbours flank it', () => {
    const o = columnOffsets(8, 22);
    expect(o[8]).toBe(0);
    expect(o[9]).toBe(22);
    expect(o[7]).toBe(-22);
  });

  it('a digit more than five steps away rolls backwards, not nine forwards', () => {
    // 9 -> 0 is one step up, not nine down.
    const o = columnOffsets(9, 22);
    expect(o[0]).toBe(22);
    expect(o[1]).toBe(44);
    // Five steps is not "past five" — it still rolls forward.
    expect(o[4]).toBe(110);
    // Six steps away is nearer the other way: 5 rolls DOWN four places, not up six.
    expect(o[5]).toBe(-88);
  });

  it('every column holds ten numbers, whatever the digit', () => {
    for (let d = 0; d <= 9; d++) {
      const o = columnOffsets(d, 10);
      expect(o).toHaveLength(10);
      expect(o[d]).toBe(0);
      expect(Math.max(...o)).toBeLessThanOrEqual(50);
      expect(Math.min(...o)).toBeGreaterThanOrEqual(-50);
    }
  });
});
