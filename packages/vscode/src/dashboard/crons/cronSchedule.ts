// cronSchedule.ts — the schedule shapes a cron may take, and their translation to Windows Task
// Scheduler flags.
// Only the four shapes that map 1:1 onto a `schtasks /SC` mode are supported; everything else is
// rejected with a reason, since a schedule that silently fires at the wrong time is worse than one
// we refused.

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** JS Date.getDay() is Sun=0; WEEKDAYS is Mon-first. */
const DAY_INDEX: Record<Weekday, number> = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 0 };

export type CronSchedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: Weekday[]; time: string }
  | { kind: 'hourly'; every: number }
  | { kind: 'minutely'; every: number };

export type ScheduleResult = { ok: true; schedule: CronSchedule } | { ok: false; reason: string };

const HOURLY_MAX = 23;      // schtasks /SC HOURLY /MO
const MINUTELY_MAX = 1439;  // schtasks /SC MINUTE /MO

function isWeekday(v: unknown): v is Weekday {
  return typeof v === 'string' && (WEEKDAYS as readonly string[]).includes(v);
}

/** 'HH:MM', 24-hour, zero-padded — the only form `/ST` accepts unambiguously. */
export function isValidTime(t: unknown): t is string {
  if (typeof t !== 'string') return false;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  return m !== null;
}

function wholeNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v) ? v : null;
}

/**
 * Validate an untrusted schedule (pane form or a hand-edited crons.json). `{ kind: 'cron', expr }`
 *  is delegated to parseCronExpression, so a pasted expression must survive our translator or be
 *  refused.
 */
export function parseSchedule(input: unknown): ScheduleResult {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'schedule must be an object' };
  const s = input as Record<string, unknown>;

  switch (s.kind) {
    case 'daily':
      if (!isValidTime(s.time)) return { ok: false, reason: `daily needs a "HH:MM" 24-hour time, got ${JSON.stringify(s.time)}` };
      return { ok: true, schedule: { kind: 'daily', time: s.time } };

    case 'weekly': {
      if (!isValidTime(s.time)) return { ok: false, reason: `weekly needs a "HH:MM" 24-hour time, got ${JSON.stringify(s.time)}` };
      if (!Array.isArray(s.days) || s.days.length === 0) return { ok: false, reason: 'weekly needs at least one weekday' };
      const bad = s.days.find((d) => !isWeekday(d));
      if (bad !== undefined) return { ok: false, reason: `unknown weekday ${JSON.stringify(bad)} — use ${WEEKDAYS.join('/')}` };
      // Dedupe but keep MON..SUN order, so the same set always yields the same
      // /D list (and therefore the same task definition) however it was typed.
      const days = WEEKDAYS.filter((d) => (s.days as Weekday[]).includes(d));
      return { ok: true, schedule: { kind: 'weekly', days, time: s.time } };
    }

    case 'hourly': {
      const n = wholeNumber(s.every);
      if (n === null || n < 1) return { ok: false, reason: `hourly needs a whole number of hours >= 1, got ${JSON.stringify(s.every)}` };
      if (n > HOURLY_MAX) {
        return { ok: false, reason: `every ${n} hours cannot be scheduled — Windows Task Scheduler caps an hourly task at ${HOURLY_MAX}. Use a daily schedule with an explicit time instead.` };
      }
      return { ok: true, schedule: { kind: 'hourly', every: n } };
    }

    case 'minutely': {
      const n = wholeNumber(s.every);
      if (n === null || n < 1) return { ok: false, reason: `minutely needs a whole number of minutes >= 1, got ${JSON.stringify(s.every)}` };
      if (n > MINUTELY_MAX) {
        return { ok: false, reason: `every ${n} minutes cannot be scheduled — Windows Task Scheduler caps a by-the-minute task at ${MINUTELY_MAX}.` };
      }
      return { ok: true, schedule: { kind: 'minutely', every: n } };
    }

    case 'cron':
      return typeof s.expr === 'string'
        ? parseCronExpression(s.expr)
        : { ok: false, reason: 'cron needs an "expr" string' };

    default:
      return { ok: false, reason: `unknown schedule kind ${JSON.stringify(s.kind)} — use daily / weekly / hourly / minutely` };
  }
}

/**
 * A five-field cron expression, accepted only where it round-trips exactly onto one of our four
 *  shapes. Ranges, lists, step-within-range, day-of-month and month fields are all refused, since
 *  Task Scheduler has no faithful equivalent.
 */
export function parseCronExpression(expr: string): ScheduleResult {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) {
    return { ok: false, reason: `"${expr}" is not a 5-field cron expression (minute hour day month weekday)` };
  }
  const [min, hour, dom, mon, dow] = f;
  const unsupported = `"${expr}" has no faithful Task Scheduler equivalent — use daily / weekly / every N hours / every N minutes instead`;

  // Day-of-month and month must be wildcards; we model neither.
  if (dom !== '*' || mon !== '*') return { ok: false, reason: unsupported };

  // */N * * * *  -> every N minutes
  const minStep = /^\*\/(\d{1,4})$/.exec(min);
  if (minStep && hour === '*' && dow === '*') {
    return parseSchedule({ kind: 'minutely', every: Number(minStep[1]) });
  }

  // M */N * * *  -> every N hours (only on the hour we can honour: minute 0)
  const hourStep = /^\*\/(\d{1,3})$/.exec(hour);
  if (hourStep && dow === '*') {
    if (min !== '0') return { ok: false, reason: `"${expr}" offsets an hourly step by ${min} minutes, which Task Scheduler cannot express — use minute 0` };
    return parseSchedule({ kind: 'hourly', every: Number(hourStep[1]) });
  }

  // M H * * *  (daily)  |  M H * * <days>  (weekly)
  const fixedMin = /^([0-5]?\d)$/.exec(min);
  const fixedHour = /^([01]?\d|2[0-3])$/.exec(hour);
  if (!fixedMin || !fixedHour) return { ok: false, reason: unsupported };
  const time = `${fixedHour[1].padStart(2, '0')}:${fixedMin[1].padStart(2, '0')}`;

  if (dow === '*') return parseSchedule({ kind: 'daily', time });

  // Explicit comma list of single day numbers/names only — a RANGE (1-5) is
  // refused rather than expanded, so we never silently invent days.
  const CRON_DOW: Record<string, Weekday> = {
    '0': 'SUN', '7': 'SUN', '1': 'MON', '2': 'TUE', '3': 'WED', '4': 'THU', '5': 'FRI', '6': 'SAT',
    SUN: 'SUN', MON: 'MON', TUE: 'TUE', WED: 'WED', THU: 'THU', FRI: 'FRI', SAT: 'SAT',
  };
  const days: Weekday[] = [];
  for (const part of dow.split(',')) {
    const d = CRON_DOW[part.trim().toUpperCase()];
    if (!d) return { ok: false, reason: unsupported };
    days.push(d);
  }
  return parseSchedule({ kind: 'weekly', days, time });
}

/**
 * The `schtasks` schedule flags for a VALIDATED schedule. Split out from the
 * full argv (cronCommand.ts) so the mapping can be asserted on its own.
 */
export function scheduleFlags(schedule: CronSchedule): string[] {
  switch (schedule.kind) {
    case 'daily': return ['/SC', 'DAILY', '/ST', schedule.time];
    case 'weekly': return ['/SC', 'WEEKLY', '/D', schedule.days.join(','), '/ST', schedule.time];
    case 'hourly': return ['/SC', 'HOURLY', '/MO', String(schedule.every)];
    case 'minutely': return ['/SC', 'MINUTE', '/MO', String(schedule.every)];
  }
}

/** Plain-English label for the pane — never used for scheduling decisions. */
export function scheduleLabel(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'daily': return `daily at ${schedule.time}`;
    case 'weekly': return `${schedule.days.join(', ')} at ${schedule.time}`;
    case 'hourly': return schedule.every === 1 ? 'every hour' : `every ${schedule.every} hours`;
    case 'minutely': return schedule.every === 1 ? 'every minute' : `every ${schedule.every} minutes`;
  }
}

/**
 * The next local-time firing, or null when not knowable. daily/weekly are absolute and computed
 *  exactly; an interval schedule has no absolute anchor of its own — Task Scheduler counts from
 *  registration — so it needs `anchor` (lastSyncedAt) or returns null rather than a guess.
 */
export function nextRun(schedule: CronSchedule, from: Date, anchor?: number): Date | null {
  if (schedule.kind === 'hourly' || schedule.kind === 'minutely') {
    if (anchor === undefined || !Number.isFinite(anchor)) return null;
    const stepMs = schedule.kind === 'hourly' ? schedule.every * 3_600_000 : schedule.every * 60_000;
    const elapsed = from.getTime() - anchor;
    // Whole steps since the anchor, then one more — strictly in the future even
    // when `from` lands exactly on a boundary.
    const steps = elapsed < 0 ? 0 : Math.floor(elapsed / stepMs) + 1;
    return new Date(anchor + steps * stepMs);
  }

  const [hh, mm] = schedule.time.split(':').map(Number);
  const candidate = new Date(from);
  candidate.setHours(hh, mm, 0, 0);

  if (schedule.kind === 'daily') {
    if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  const wanted = new Set(schedule.days.map((d) => DAY_INDEX[d]));
  for (let i = 0; i < 8; i++) {
    const day = new Date(candidate);
    day.setDate(candidate.getDate() + i);
    if (wanted.has(day.getDay()) && day.getTime() > from.getTime()) return day;
  }
  return null;
}
