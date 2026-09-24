// scheduleTabGlobal.ts — t-ru1qsp: reads the Schedules view's persisted tab
// off the window global DashboardPanel injects on load (same pattern as
// chatDensityClass.ts's chatDensityCompactFromGlobal). Pure, so it is
// testable with no render.
export function scheduleTabFromGlobal(win: unknown): 'crons' | 'loops' {
  return (win as { __ORIGAMI_SCHEDULE_TAB__?: string } | undefined)?.__ORIGAMI_SCHEDULE_TAB__ === 'loops'
    ? 'loops'
    : 'crons';
}
