// planUsageParse — the api/oauth/usage body, read two ways. Pure: nothing here touches a token, a
// disk or a network.

import { windowLabel, type RateLimitPill } from './usagePill';
import { windowLengthMs } from './planWindowLength';

interface Lane {
  readonly key: string;
  readonly pct: number;
  readonly resetsAt: number;
}

export function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * ISO-8601 timestamp → epoch ms, or 0. `rate_limit_event` answers in epoch seconds; both end up as
 *  the same milliseconds so the picker's countdown does not need to know which read filled it.
 */
export function resetsAtMs(v: unknown): number {
  if (typeof v !== 'string' || !v) return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/**
 * Every named window in the body that reported a utilisation. The lane key is the field name, which
 *  `windowLabel` already knows how to write, so the two readings cannot be worded differently.
 */
function lanesOf(body: Record<string, unknown>): Lane[] {
  const out: Lane[] = [];
  for (const [key, value] of Object.entries(body)) {
    const entry = rec(value);
    if (!entry) continue;
    const pct = entry.utilization;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) continue;
    out.push({ key, pct: Math.max(0, Math.min(100, Math.round(pct))), resetsAt: resetsAtMs(entry.resets_at) });
  }
  return out;
}

/** One lane, as the glide path wants it: a labelled window with an end. */
export interface PlanWindow {
  readonly label: string;
  readonly pct: number;
  readonly resetsAt: number;
  /** The length the rate-limit TYPE states — `five_hour` is five hours. */
  readonly lengthMs?: number;
}

/** Every lane in the body, not only the tightest one — the glide path plots each window against its
 *  own reset, so sampling only the tightest lane would leave the weekly series empty for most of a
 *  plan's life. A lane with no future `resets_at` is dropped: without a window end there is no
 *  length to plot against. */
export function planWindowsOf(body: unknown, now: number): PlanWindow[] {
  const root = rec(body);
  if (!root) return [];
  return lanesOf(root)
    .filter((lane) => lane.resetsAt > now)
    .map((lane) => {
      const lengthMs = windowLengthMs(lane.key);
      return {
        label: windowLabel(lane.key),
        pct: lane.pct,
        resetsAt: lane.resetsAt,
        ...(lengthMs !== undefined ? { lengthMs } : {}),
      };
    });
}

/**
 * The body → the pill, or null.
 *
 * The tightest lane wins, not the first: an account at 4% of its week and 22% of its five-hour
 *  session is constrained by the session, which is the same choice the CLI makes for
 *  `rate_limit_event`.
 */
export function planPillOf(body: unknown, now: number): RateLimitPill | null {
  const root = rec(body);
  if (!root) return null;
  const lanes = lanesOf(root);
  if (lanes.length === 0) return null;
  let top = lanes[0];
  for (const lane of lanes) if (lane.pct > top.pct) top = lane;
  const win = windowLabel(top.key);
  const title = [
    `Claude subscription — ${top.pct}% of your ${win} limit used.`,
    'This chat runs on your plan, so there is no per-turn charge to show.',
    top.resetsAt > now ? `Resets ${new Date(top.resetsAt).toLocaleString()}.` : '',
  ].filter(Boolean).join(' ');
  // Every lane with a FUTURE reset, not only the tightest — the tooltip's source. Same filter
  // planWindowsOf applies: a lane with no future resets_at (a private-beta key still at 0%, or a
  // stale reading) has nothing to plot a countdown against, so it is dropped rather than shown as
  // "resets unknown".
  const windows = lanes
    .filter((lane) => lane.resetsAt > now)
    .map((lane) => ({ label: windowLabel(lane.key), pct: lane.pct, resetsAt: lane.resetsAt }));
  // `status: 'account'` marks the source, not one of the CLI's own status words — an account read
  // must never trigger the transcript line `rateLimitPosts` writes on a status change; it is a
  // badge refresh, not news.
  return { status: 'account', window: win, pct: top.pct, resetsAt: top.resetsAt, title, windows };
}
