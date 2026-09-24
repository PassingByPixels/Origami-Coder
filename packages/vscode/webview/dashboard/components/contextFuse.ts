// contextFuse.ts — t-okz748: the compact-button state machine, as a pure leaf.
// The big compaction confirm popup is gone. The context gauge pill IS the
// button now: one click arms a timed fuse (the cancel window), a second click
// during the fuse cancels it, and letting it burn out fires compaction — the
// same `compactContext` post the popup used to send on "Confirm". Modelled on
// the FuseButton pattern (react-bits-free, Micro/FuseButton): idle -> armed
// -> (cancel -> idle) | (burn -> idle).

export type FusePhase = 'idle' | 'armed';

/** How long the fuse burns before it commits, in ms. */
export const FUSE_MS = 4000;

/** Click (or Enter/Space) on the gauge. Idle arms it; armed cancels it. */
export function toggleFuse(phase: FusePhase): FusePhase {
  return phase === 'idle' ? 'armed' : 'idle';
}

/** Click handler: toggles the phase, (re)arms/clears the fire timer, and
 *  returns the new phase for the caller's own $state. Cancelling always
 *  clears any pending timer first, so a burn can never double-fire. */
export function clickFuse(
  phase: FusePhase,
  timer: ReturnType<typeof setTimeout> | null,
  onBurn: () => void,
): { phase: FusePhase; timer: ReturnType<typeof setTimeout> | null } {
  if (timer) clearTimeout(timer);
  const next = toggleFuse(phase);
  return { phase: next, timer: next === 'armed' ? setTimeout(onBurn, FUSE_MS) : null };
}
