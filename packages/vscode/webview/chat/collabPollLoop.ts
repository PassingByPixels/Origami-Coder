// The collab pane's poll CADENCE, extracted from CollabPane.svelte when that
// file reached its architecture cap.
//
// Two rules live here and nothing else does — no wire call, no Svelte, no DOM,
// so both are provable with fake timers alone:
//
//  1. RE-ARMED, never `setInterval`. A slow engine must not be able to stack
//     two polls on top of each other; the next delay is only scheduled once the
//     previous tick has been handed out.
//  2. TWO SPEEDS. Tight while an agent is working (a stream you are watching
//     move), loose once everything has settled — the same information at a
//     fraction of the round trips.
//
// Since the host gained its own slow watch (collabWatch.ts), this loop is an
// ACCELERATOR for the open tab rather than the only source of collab state.
// It stays faster than the host's on purpose: the tab you are looking at is
// the one place a four-second lag is felt.

export interface CollabPollLoop {
  /** (Re)start the loop at the cadence `busy` names. Called from the pane's
   *  `$effect`, so the rate changes the MOMENT an agent starts or stops rather
   *  than at the next tick — re-arming only from inside the callback would
   *  leave a run that began during an idle stretch invisible for up to a full
   *  idle interval. */
  arm(busy: boolean): void;
  /** Teardown. One place, so a closed tab cannot leak its loop. */
  stop(): void;
}

export const POLL_BUSY_MS = 1200;
export const POLL_IDLE_MS = 4000;

export function makeCollabPollLoop(tick: () => void, busyMs = POLL_BUSY_MS, idleMs = POLL_IDLE_MS): CollabPollLoop {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The cadence the CALLBACK re-arms at. Held rather than re-read because the
  // caller re-arms on every change of it anyway; a stale value can therefore
  // only survive until the pending timeout it already scheduled.
  let fast = false;
  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const arm = (busy: boolean) => {
    fast = busy;
    clear();
    timer = setTimeout(() => { tick(); arm(fast); }, busy ? busyMs : idleMs);
  };
  return { arm, stop: clear };
}
