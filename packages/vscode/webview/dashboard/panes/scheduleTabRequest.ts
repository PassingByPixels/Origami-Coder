// scheduleTabRequest.ts — t-ru1qsp: the ONE-SHOT tab a legacy crons/loops deep
// link named, extracted from boardViews.ts (at its 105-line cap) so the
// Schedules fold did not have to raise it. A deep link's requested tab
// overrides the persisted default for the mount it was meant for, then
// clears itself — SchedulesPane calls consumeRequestedTab() once, on its own
// initial state, falling back to the persisted tab (scheduleTabGlobal.ts)
// when nothing is pending.
export type ScheduleTabId = 'crons' | 'loops';

let pendingTab: ScheduleTabId | undefined;

export function noteRequestedTab(tab: ScheduleTabId): void { pendingTab = tab; }

export function consumeRequestedTab(): ScheduleTabId | undefined {
  const t = pendingTab;
  pendingTab = undefined;
  return t;
}
