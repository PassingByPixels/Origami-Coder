// cronReconcile.ts — the PURE comparison between what `.origami/crons.json`
// intends and what the machine actually holds. Extracted from cronService.ts
// when the launcher-script work pushed it past its architecture cap.
//
// This module REPORTS and repairs nothing. Silently "fixing" drift would mean
// either deleting a task somebody created on purpose or re-creating one they
// removed on purpose — invisibly, which is how a scheduler loses trust for
// good. The pane shows both directions and lets a human decide.

import { taskNameFor } from './cronCommand';
import type { CronRecord } from './cronState';

export interface DriftReport {
  /** Enabled in crons.json, but no OS task registered — will NOT fire. */
  missingRegistration: Array<{ id: string; name: string; taskName: string }>;
  /** Registered with the OS, but not an enabled cron here — WILL fire anyway. */
  strayRegistration: Array<{ taskName: string; reason: 'disabled' | 'unknown' }>;
  /** Launcher scripts on disk with no cron behind them. Inert (nothing runs
   *  them), but reported so they never accumulate unseen; the next create or
   *  delete sweeps them. */
  orphanScripts: string[];
  /** Set when the OS could not be queried at all — drift is then UNKNOWN, which
   *  must never be presented as "clean". */
  error?: string;
}

export const noDrift = (): DriftReport => ({ missingRegistration: [], strayRegistration: [], orphanScripts: [] });

export function reconcileCrons(
  crons: readonly CronRecord[],
  registered: readonly string[],
  scriptIds: readonly string[] = [],
): DriftReport {
  const registeredSet = new Set(registered);
  const byTaskName = new Map(crons.map((c) => [taskNameFor(c.id), c]));
  const known = new Set(crons.map((c) => c.id));

  const missingRegistration = crons
    .filter((c) => c.enabled && !registeredSet.has(taskNameFor(c.id)))
    .map((c) => ({ id: c.id, name: c.name, taskName: taskNameFor(c.id) }));

  const strayRegistration = registered
    .filter((t) => {
      const cron = byTaskName.get(t);
      return cron === undefined || !cron.enabled;
    })
    .map((t) => ({ taskName: t, reason: byTaskName.has(t) ? ('disabled' as const) : ('unknown' as const) }));

  return { missingRegistration, strayRegistration, orphanScripts: scriptIds.filter((id) => !known.has(id)) };
}
