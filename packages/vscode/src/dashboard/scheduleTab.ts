// scheduleTab.ts — t-ru1qsp: the Schedules view's last-picked tab (Crons or
// Loops), persisted PER WINDOW via workspaceState. Same shape as
// chatDensity.ts / collabsSection.ts's open flag: absent = the default
// (Crons, the first tab), stored only when it differs, so an untouched
// workspace never gains a workspaceState entry for a tab nobody switched.
import type { Memento } from 'vscode';

/** Which Schedules tab is open. Absent = Crons (the default, and the first tab). */
export const SCHEDULE_TAB_KEY = 'origamicoder.scheduleTab';

export const SCHEDULE_TAB_MESSAGE_TYPES = new Set(['setScheduleTab']);

export interface ScheduleTabHost {
  workspaceState(): Memento;
}

export type ScheduleTabId = 'crons' | 'loops';

/** Read the stored tab. Only an exact stored 'loops' reads as Loops. */
export function scheduleTab(host: ScheduleTabHost): ScheduleTabId {
  return host.workspaceState().get<string>(SCHEDULE_TAB_KEY) === 'loops' ? 'loops' : 'crons';
}

/** Stored only when Loops is picked; Crons clears the key rather than writing
 *  it, on the same reasoning as chatDensity.ts's Comfortable default. */
export function handleScheduleTabMessage(
  host: ScheduleTabHost,
  m: { type?: string; tab?: unknown },
): void {
  if (m.type !== 'setScheduleTab') return;
  const loops = m.tab === 'loops';
  void host.workspaceState().update(SCHEDULE_TAB_KEY, loops ? 'loops' : undefined);
}
