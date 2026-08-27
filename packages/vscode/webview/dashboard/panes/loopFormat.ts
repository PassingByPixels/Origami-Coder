// loopFormat.ts — the Loops card's derived text: how long until the next run,
// and how the last one ended. Pure (no DOM, no clock of its own — `now` is
// always passed in), the same shape cronFormat.ts takes, so every rule below
// is testable without rendering.
//
// A loop's interval is SHORT (minutes), so a countdown beats the wall-clock
// wording crons use — "tomorrow 09:00" is the right answer for a daily task
// and a useless one for something firing in ninety seconds.

export type LoopOutcome = 'ok' | 'failed';

/** "1h 5m" / "2m 30s" / "45s" — at most two units, largest first, because the
 *  third is noise at every scale a loop actually runs at. Sub-second rounds up
 *  to 1s rather than showing "0s", which reads as stopped. */
export function countdown(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/**
 * The NEXT RUN line for a loop whose timer is armed.
 *
 * `null`/`undefined` returns '' — there is no armed timer, so there is no next
 * instant to report, and the card says why in words instead. A time already in
 * the past means the timer is due and the callback simply has not been
 * dispatched yet, which is "due now", never a negative countdown.
 */
export function nextRunText(nextRunAt: number | null | undefined, now: number): string {
  if (nextRunAt === null || nextRunAt === undefined || !Number.isFinite(nextRunAt)) return '';
  return nextRunAt <= now ? 'due now' : `in ${countdown(nextRunAt - now)}`;
}

/**
 * The card's one-sentence statement of what this loop's future actually is.
 *
 * Each branch says exactly what IS true, never a hopeful summary. The headless
 * case is the one that would otherwise be silently wrong in both directions:
 * showing a chat identity that no longer exists, or implying the loop stopped
 * when it is still firing every interval.
 */
export function loopStateText(live: boolean, persistent: boolean, headless: boolean): string {
  if (!live) {
    return persistent
      ? 'Persistent, but its engine session could not be reopened — nothing is scheduled. Resume it by opening the chat, or cancel it.'
      : 'Its chat could not be restored — reopen the chat to resume it, or cancel it.';
  }
  if (headless) return 'No chat open — still scheduled, and will keep running while VS Code is open.';
  return persistent ? 'Keeps running if you close this chat.' : 'Stops when this chat closes.';
}

/** "12s ago · ok" — the LAST RUN line. Empty unless BOTH halves are real: a
 *  time with no outcome (or the reverse) is half a record, and rendering it
 *  would invent the missing half. */
export function lastRunText(lastRunAt: number | null | undefined, outcome: LoopOutcome | null | undefined, now: number): string {
  if (lastRunAt === null || lastRunAt === undefined || !Number.isFinite(lastRunAt)) return '';
  if (outcome !== 'ok' && outcome !== 'failed') return '';
  const ago = lastRunAt >= now ? 'just now' : `${countdown(now - lastRunAt)} ago`;
  return `${ago} · ${outcome}`;
}
