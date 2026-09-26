// engineTimeline.ts — t-xq22sx: the times (in minutes after you leave a chat)
// that the Settings › Engines chart draws. Pure, so the chart and its test
// read one rule set. Each rule mirrors the host code that acts:
//   idle   activityClass.ts nextClass: hidden and quiet for idleAfter.
//   trim   activityTracker.ts trimAt: idle + trimAfter, never within
//          NO_TRIM_AFTER_TURN_MS (2 min) of the last turn; then every retrim.
//   stop   parkPolicy.ts: quiet for parkAfter, whatever the provider cache life
//          (t-z6ytkw); untimed providers wait parkUntimedAfter, which
//          elasticWindow.ts never lets go below parkAfter. 0 = off.
//   warm   warmWake.ts (t-z6ytkw): with cache warming on, a warm due after the
//          stop wakes the chat, warms and stops it again (a short blip). The
//          engine warms at WARM_AT of the cache life, once per real request.
// Elastic off (activityTracker.ts disable) = no class change at all.

/** The shortest published cache life we draw for (Anthropic, 5 min). */
export const TIMED_CACHE_MINUTES = 5;
/** The cache lives drawn for warm blips: Anthropic's 5-minute and 1-hour forms. */
const WARM_CACHE_MINUTES = [TIMED_CACHE_MINUTES, 60];
/** Engine session/cache-warm.ts WARM_AT: a warm at 80% of the cache life. */
const WARM_AT = 0.8;
const NO_TRIM_AFTER_TURN_MINUTES = 2;

export interface EngineTimelineInput {
  enabled: boolean;
  idleAfterMinutes: number;
  trimAfterMinutes: number;
  retrimMinutes: number;
  parkAfterMinutes: number;
  parkUntimedAfterMinutes: number;
  /** The cache-warming setting (t-z6ytkw). Absent = off, its default since 0.4.184. */
  warming?: boolean;
}

export interface EngineTimeline {
  /** null = that step does not happen with these settings. */
  idleAt: number | null;
  trimAt: number | null;
  retrims: number[];
  parkTimedAt: number | null;
  parkUntimedAt: number | null;
  /** t-z6ytkw: minutes at which a parked chat is woken to warm its cache (timed provider only). */
  warmBlips: number[];
  /** The minutes the chart's axis covers. */
  span: number;
}

const MAX_RETRIM_MARKS = 12;

export function engineTimeline(s: EngineTimelineInput): EngineTimeline {
  if (!s.enabled) return { idleAt: null, trimAt: null, retrims: [], parkTimedAt: null, parkUntimedAt: null, warmBlips: [], span: 60 };
  const idleAt = s.idleAfterMinutes;
  const trimAt = Math.max(idleAt + s.trimAfterMinutes, NO_TRIM_AFTER_TURN_MINUTES);
  const parkOn = s.parkAfterMinutes > 0;
  const parkTimedAt = parkOn ? Math.max(s.parkAfterMinutes, idleAt) : null;
  const warmBlips = parkTimedAt === null || s.warming !== true ? [] : WARM_CACHE_MINUTES.map((m) => m * WARM_AT).filter((m) => m > parkTimedAt);
  const parkUntimedAt = parkOn ? Math.max(s.parkUntimedAfterMinutes, s.parkAfterMinutes, idleAt) : null;
  const end = parkUntimedAt ?? Math.max(trimAt + 2 * s.retrimMinutes, idleAt * 2, 30);
  const retrims: number[] = [];
  for (let t = trimAt + s.retrimMinutes; t < end && retrims.length < MAX_RETRIM_MARKS; t += s.retrimMinutes) retrims.push(t);
  return { idleAt, trimAt, retrims, parkTimedAt, parkUntimedAt, warmBlips, span: Math.ceil(Math.max(end, ...warmBlips) * 1.1) };
}
