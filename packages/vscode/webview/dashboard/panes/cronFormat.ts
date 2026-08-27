// cronFormat.ts — the Crons table's derived text: when a run is/was, what state
// a row is in, and the one-line explanation a bad row owes the reader.
//
// Pure (no DOM, no clock of its own — `now` is always passed in) so every rule
// below is testable without rendering, and so the table component stays markup.

export type CronOutcome = 'ok' | 'failed' | 'incomplete';

/** A row's overall state, worst-first in the order they are decided below. */
export type CronStatus = 'disabled' | 'drift' | 'failed' | 'running' | 'ok' | 'never';

export interface CronStatusInput {
  id: string;
  enabled: boolean;
  lastOutcome: CronOutcome | null;
  lastExitCode: number | null;
}

const DAY_MS = 86_400_000;

/** Calendar days between two instants in LOCAL time — not `(a-b)/DAY_MS`, which
 *  calls 23:59 and 00:01 the same day whenever they straddle midnight. */
function dayDelta(then: number, now: number): number {
  const d = (ms: number) => { const x = new Date(ms); return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()); };
  return Math.round((d(then) - d(now)) / DAY_MS);
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * "today 09:11" / "tomorrow 09:00" / "yesterday 22:30", falling back to a dated
 * form once relative wording stops being useful. Relative only pays for the days
 * either side of now; "in 34 days" is a worse answer than the date.
 */
export function relativeWhen(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const delta = dayDelta(ms, now);
  const t = clock(ms);
  if (delta === 0) return `today ${t}`;
  if (delta === 1) return `tomorrow ${t}`;
  if (delta === -1) return `yesterday ${t}`;
  const d = new Date(ms);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${month}${year} ${t}`;
}

/**
 * The row's state.
 *
 * DISABLED and DRIFT outrank the last outcome deliberately: both mean the cron
 * will not fire NEXT time, which matters more than how it fired last time. A
 * green OK on a job that is no longer registered is precisely the reassuring
 * lie the drift report exists to prevent.
 */
export function cronStatus(row: CronStatusInput, driftIds: ReadonlySet<string>): CronStatus {
  if (!row.enabled) return 'disabled';
  if (driftIds.has(row.id)) return 'drift';
  if (row.lastOutcome === 'failed') return 'failed';
  if (row.lastOutcome === 'incomplete') return 'running';
  if (row.lastOutcome === 'ok') return 'ok';
  return 'never';
}

/** The word shown beside the status dot. */
export function statusLabel(s: CronStatus): string {
  switch (s) {
    case 'disabled': return 'DISABLED';
    case 'drift': return 'NOT REGISTERED';
    case 'failed': return 'FAILED';
    case 'running': return 'RUNNING';
    case 'ok': return 'OK';
    case 'never': return 'NEVER RUN';
  }
}

/**
 * The short italic line a bad row carries under its name, or '' when the row
 * owes no explanation. Every string here names the NEXT ACTION or the concrete
 * fact — never a restatement of the status word, which is already on screen.
 */
export function statusNote(s: CronStatus, row: CronStatusInput): string {
  switch (s) {
    case 'drift':
      return 'in crons.json but not registered with the system scheduler — it will not fire';
    case 'failed':
      return `last run exited ${row.lastExitCode ?? '?'} — open the log for the error`;
    case 'running':
      return 'started but never recorded an end — still running, or killed before it finished';
    default:
      return '';
  }
}

/** "today 09:11 · ok" — the LAST RUN cell. Empty when it has never run, which
 *  the NEVER RUN status already says; repeating it here would be noise. */
export function lastRunText(lastOutputAt: number | null, outcome: CronOutcome | null, now: number): string {
  if (lastOutputAt === null || outcome === null) return '';
  const word = outcome === 'ok' ? 'ok' : outcome === 'failed' ? 'failed' : 'no end record';
  return `${relativeWhen(lastOutputAt, now)} · ${word}`;
}

/** The RUNS cell — a tail-read count is a floor, and says so rather than
 *  presenting a lower bound as a total. */
export function runsText(runs: number, runsExact: boolean): string {
  return runsExact ? String(runs) : `${runs}+`;
}
