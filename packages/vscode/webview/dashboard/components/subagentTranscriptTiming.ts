// subagentTranscriptTiming.ts — the two clocks behind SubagentTranscriptView:
// the running-child poll, and the reply deadline (t-tydjkm).
//
// The deadline exists because the panel draws "Loading transcript…" until a
// reply for its child arrives, and nothing else ever ended that wait. A reply
// that was dropped on the way (the 0.4.169 solo-view filter in deltaFanout.ts
// did exactly that) or an engine that never answers left the panel loading for
// ever. After REPLY_MS the panel says so, and a late reply still draws.

/** Poll cadence for a running child (a live wire would re-project per token). */
export const POLL_MS = 4000;

/** How long one request may go unanswered before the panel says so. A small
 *  child reads in milliseconds; this is far above a slow store read. */
export const REPLY_MS = 20_000;

export const NO_ANSWER = `No answer after ${REPLY_MS / 1000} s. Press ↻ to try again.`;

/** One timer per panel: `arm` on every request (a re-arm replaces the old one),
 *  `clear` on any reply for this child and on unmount. */
export function replyDeadline(onLate: () => void, ms = REPLY_MS): { arm(): void; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    arm() {
      clearTimeout(timer);
      timer = setTimeout(onLate, ms);
    },
    clear() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
