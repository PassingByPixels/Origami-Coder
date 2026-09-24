// nestStorageMeasure.ts — the Storage card's measure, host half (t-vbivj4).
//
// The card used to wait on ONE `nest_storage` call with no bound. On the
// owner's 15 GB store that call held the engine for 44-52 s (store copy), and
// nothing on this side would ever give up, so a lost or slow answer left the
// card on "Measuring..." for good.
//
// Now the engine measures in ranges and answers a `waitMs` request with the
// sums so far (`done: false`, `progress` 0..1). This loop asks again until the
// measure is done, hands each partial answer to `onPartial`, and bounds every
// wait: the card always ends in sizes or in an error it can retry.
// `answerWithin` is the bound, for any other engine call of the card.

import type { NestStorageResult } from './nestContract';

/** How long the engine holds one request before it answers with partial sums. */
export const POLL_WAIT_MS = 1_000;
/** One request with no answer in this time is a lost answer. */
export const ANSWER_MS = 20_000;
/** The whole measure; the owner-size store copy takes 5.5 s. */
export const MEASURE_MS = 10 * 60_000;

/** t-vb87lt: a dry run (what a Keep choice frees) reads every old tool part. */
export const DRY_RUN_MS = 60_000;
/** An Apply rewrites those parts; it can take minutes on a large store. */
export const APPLY_MS = 10 * 60_000;

export const noAnswer =(ms: number) => `The engine did not answer in ${Math.round(ms / 1000)} s. Try again.`;
export const TOO_LONG = 'The measure did not end in 10 minutes. Try again.';

/** `work`, or a rejection with `noAnswer(ms)` when it takes longer than `ms`. */
export function answerWithin<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(noAnswer(ms))), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

type Call = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The final `nest_storage` result. An older engine ignores `waitMs` and
 *  answers once, with no `done`: that answer is final too. */
export async function measureStorage(
  call: Call,
  onPartial: (partial: NestStorageResult) => void,
  now: () => number = Date.now,
): Promise<NestStorageResult> {
  const started = now();
  for (;;) {
    const stats = (await answerWithin(call('nest_storage', { waitMs: POLL_WAIT_MS }), ANSWER_MS)) as unknown as NestStorageResult;
    if (stats.done !== false) return stats;
    if (now() - started > MEASURE_MS) throw new Error(TOO_LONG);
    onPartial(stats);
  }
}
