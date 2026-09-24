// The shape the Crons pane renders — one row, plus the payload carrying a list of them. Type-only.

import type { CronSchedule } from './cronSchedule';
import type { CronOutcome } from './cronLog';
import type { InvalidCron } from './cronState';
import type { DriftReport } from './cronReconcile';

/** One cron as the pane renders it — record plus everything derived. */
export interface CronRow {
  id: string;
  name: string;
  prompt: string;
  schedule: CronSchedule;
  scheduleLabel: string;
  agent?: string;
  model?: string;
  enabled: boolean;
  taskName: string;
  logPath: string;
  /** The generated launcher, so the pane can say exactly what the task runs. */
  scriptPath: string;
  /** ISO string, or null when an interval cron has no registration anchor. */
  nextRunAt: string | null;
  /** When the log was last written — the honest "it ran" signal without a second round of OS
   *  queries. Null when it never produced output. */
  lastOutputAt: number | null;
  /** Runs counted from the log itself (cronLog.ts) — the audit trail is the
   *  only counter, so this can never drift from what actually happened. */
  runs: number;
  /** False when the log was too big to read whole and `runs` is a lower bound. */
  runsExact: boolean;
  /** How the last run ended; null when it has never run. */
  lastOutcome: CronOutcome | null;
  lastExitCode: number | null;
}


export interface CronsPayload {
  /** Absolute workspace root every cron here runs against (`--dir`). The pane
   *  shows it per row: these fire unattended and auto-approved, so WHERE they
   *  can write is part of what a job does. */
  workspace: string;
  crons: CronRow[];
  invalid: InvalidCron[];
  drift: DriftReport;
  backendAvailable: boolean;
  backendReason?: string;
  recovered: boolean;
  backupPath?: string;
}
