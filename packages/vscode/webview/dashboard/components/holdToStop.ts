// HOLD-TO-STOP — the wire behind the composer's one action control.
//
// Send and Stop are the same button (CHANGES.md round 2, change 25). At rest
// a click sends. While a turn runs a CLICK DOES NOTHING and a HOLD stops the
// turn: a stray click on a control that has just moved under the pointer must
// not kill a running turn.
//
// HOLD_MS is 600, not the reference's 2000 — two seconds to stop a runaway
// turn is a punishment, not a guard, and 600ms still rejects a click (a click
// is under TAP_MS). The owner's call, recorded in CHANGES.md as a deviation.
//
// Pure of the DOM on purpose: this file owns WHEN a stop fires, the component
// owns what it looks like while it fills.

export const HOLD_MS = 600;
/** Under this and the press was a click, not a hold — the caller says so. */
export const TAP_MS = 250;

export interface Hold {
  /** Pointer/key went down. `now` is the caller's clock (performance.now). */
  down(now: number): void;
  /** Released, cancelled, left the button, or lost capture — all the same. */
  up(now: number): void;
  /** True between a down and its release. */
  held(): boolean;
  /** Drop the pending timer (component teardown). */
  dispose(): void;
}

export interface HoldOptions {
  /** The hold completed: stop the turn. */
  onStop: () => void;
  /** Released too early to count as a hold — say so rather than doing nothing. */
  onTap?: () => void;
  holdMs?: number;
}

/**
 * One press at a time. A second `down` while holding is ignored (key repeat
 * fires one every ~30ms and each would arm its own timer), and an `up` with
 * no press behind it is a no-op — `pointerleave` and `lostpointercapture`
 * both arrive after an ordinary `pointerup` on the same press.
 */
export function createHold({ onStop, onTap, holdMs = HOLD_MS }: HoldOptions): Hold {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start = 0;
  return {
    down(now: number) {
      if (timer) return;
      start = now;
      timer = setTimeout(() => {
        timer = null;
        onStop();
      }, holdMs);
    },
    up(now: number) {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      if (now - start < TAP_MS) onTap?.();
    },
    held() {
      return timer !== null;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
