// sessionLogStreamDrop.ts (t-q90gj9) — the stream-drop write, split out of sessionLog.ts so that
// file stays under its cap. Same log, same entry shape; only the append/collapse rule lives here.

import type { StreamDropNotice } from '../acpStreamDrop';
import type { SessionMessage } from './sessionLog';

/**
 * A dropped stream, appended as its own entry.
 *
 * COLLAPSED onto the previous one when it continues the same ladder: the engine
 * sends a notice per attempt, and a run of five drops must restore as ONE card
 * counting up, not five stacked cards — the blob this feature exists to undo.
 * A `stopped` notice always lands on the card it closes.
 */
export function logStreamDrop(log: SessionMessage[], notice: StreamDropNotice): void {
  const last = log[log.length - 1];
  if (last?.kind === 'streamDrop' && last.streamDrop && notice.attempt >= last.streamDrop.attempt) {
    last.streamDrop = notice;
    return;
  }
  log.push({ kind: 'streamDrop', text: '', timestamp: Date.now(), streamDrop: notice });
}

