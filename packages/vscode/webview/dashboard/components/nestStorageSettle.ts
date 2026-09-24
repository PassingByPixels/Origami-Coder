// nestStorageSettle.ts — the Storage card always settles (t-vbivj4).
//
// The card asked once and then waited for `nestStorageData` with no end: a
// lost or slow answer left "Measuring..." on screen for good. The host now
// bounds each engine call and posts the sums so far while the engine measures
// (src/dashboard/nestStorageMeasure.ts, about one post a second). This file is
// the card's own bound over all of that: silence this long after a request or
// a partial answer ends the measure with an error and a Retry button.

/** The host answers within its own 20 s bound; this catches an answer lost on the way. */
export const NO_ANSWER_MS = 45_000;
export const NO_ANSWER = 'No answer from the engine. The store was not measured.';

/** t-vb87lt: the Apply confirm. The artifact prune keeps the newest version of
 *  each artifact (engine ArtifactStore.pruneByWindow); another desk can then not
 *  pull an older version's files from this desk, so the confirm says so. */
export const RETAIN_NOTE =
  'This removes tool output, and the files of artifact versions, older than their windows. ' +
  'The newest version of each artifact keeps its files. Other desks cannot get the removed files from this desk. ' +
  'The other windows are saved for a later prune.';

/** The share measured, 0..1, of a PARTIAL `nestStorageData`; null for a final one. */
export function readProgress(msg: { partial?: unknown; stats?: unknown }): number | null {
  if (msg.partial !== true) return null;
  const p = (msg.stats as { progress?: unknown } | null)?.progress;
  return typeof p === 'number' && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
}

/** The header line while the card measures. */
export function measuringLabel(progress: number | null): string {
  return progress === null ? 'measuring this desk…' : `measuring this desk… ${Math.floor(progress * 100)}%`;
}

/** A timer that calls `onSilence` when `wait()` is not followed by `answered()`
 *  (or by another `wait()`) within `ms`. */
export function answerClock(onSilence: () => void, ms = NO_ANSWER_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    wait() {
      answered();
      timer = setTimeout(onSilence, ms);
    },
    answered,
  };
}
