// schedulerBackend.ts — the ONE seam between cron bookkeeping and the operating
// system. Everything above this file (cronService, the pane) is platform-free
// and runs against a fake in tests; only `windowsBackend` ever executes a
// process, and nothing in the test suite constructs it.
//
// schtasks is invoked through execFile with an ARGUMENT ARRAY and no shell, so
// Node owns the OS-level quoting of the task name and the `/TR` value. Building
// a single string and handing it to a shell would put the user's prompt through
// a second, unmodelled round of quoting — the exact class of bug cronCommand.ts
// exists to prevent.
//
// PLATFORM: Windows (this file) and macOS (launchdBackend.ts). Anything else
// gets `unavailableBackend`, which reports that plainly and refuses every
// mutation. No backend may HALF-register — a cron whose file record claims a
// task that was never created is worse than an honest refusal, because
// reconcile would then report drift forever.

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import type { CronSchedule } from './cronSchedule';
import { parseQueriedTaskNames, schtasksCreateArgs, schtasksDeleteArgs, schtasksFolderQueryArgs, schtasksQueryAllArgs, schtasksRunArgs } from './cronCommand';
import { launchdBackend } from './launchdBackend';

export interface RegisterRequest {
  taskName: string;
  schedule: CronSchedule;
  /** Full `/TR` value from buildRunCommand. */
  command: string;
}

export type BackendResult = { ok: true } | { ok: false; error: string };
export type QueryResult = { ok: true; taskNames: string[] } | { ok: false; error: string };

export interface SchedulerBackend {
  /** False => this platform has no OS cron support; the pane says so. */
  readonly available: boolean;
  /** Why it is unavailable, for the pane. Absent when available. */
  readonly unavailableReason?: string;
  register(req: RegisterRequest): Promise<BackendResult>;
  unregister(taskName: string): Promise<BackendResult>;
  runNow(taskName: string): Promise<BackendResult>;
  query(): Promise<QueryResult>;
}

/** Unsupported platform: refuse everything, register nothing, explain once. */
export function unavailableBackend(platform: string = os.platform()): SchedulerBackend {
  const reason = `OS-level crons run on Windows (Task Scheduler) and macOS (launchd) — not on this platform (${platform}). Schedules can be edited and stay in .origami/crons.json, but nothing is registered with the system scheduler, so they will not fire.`;
  const refuse = async (): Promise<BackendResult> => ({ ok: false, error: reason });
  return {
    available: false,
    unavailableReason: reason,
    register: refuse,
    unregister: refuse,
    runNow: refuse,
    query: async () => ({ ok: false, error: reason }),
  };
}

export type SchtasksRun = (args: string[]) => Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;

const realRun: SchtasksRun = (args) =>
  new Promise((resolve) => {
    execFile('schtasks', args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message || '').trim();
        resolve({ ok: false, error: detail || 'schtasks failed' });
        return;
      }
      resolve({ ok: true, stdout: stdout ?? '' });
    });
  });

/**
 * The real Windows backend. `run` is injectable so the query logic below can be
 * driven against a simulated schtasks in tests; the default talks to the real
 * one, and the extension host is the only caller that lets it.
 */
export function windowsBackend(run: SchtasksRun = realRun): SchedulerBackend {
  return {
    available: true,
    async register(req) {
      const res = await run(schtasksCreateArgs(req.taskName, req.schedule, req.command));
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },
    async unregister(taskName) {
      const res = await run(schtasksDeleteArgs(taskName));
      // Deleting something already gone IS the desired end state. This is an
      // idempotent delete, not the error-swallowing that query must never do.
      if (!res.ok && /cannot find|does not exist/i.test(res.error)) return { ok: true };
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },
    async runNow(taskName) {
      const res = await run(schtasksRunArgs(taskName));
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },
    /**
     * Two-step, because ONE step cannot be both fast and honest.
     *
     * The folder query is ~25ms but 404s identically whether the folder is
     * absent or the query genuinely failed. Treating that 404 as "no tasks
     * registered" — which this code used to do — makes every correctly
     * registered cron report as missing, forever, and the drift report cries
     * wolf on a perfectly healthy machine.
     *
     * So a folder-query failure is never interpreted: it falls through to the
     * enumerate form (~520ms), which succeeds whether or not our folder exists.
     * If THAT fails, the query really did fail and we say so rather than
     * guessing. The slow path only runs when there are no crons yet, where the
     * extra half-second costs nothing.
     */
    async query() {
      const folder = await run(schtasksFolderQueryArgs());
      if (folder.ok) return { ok: true, taskNames: parseQueriedTaskNames(folder.stdout) };

      const all = await run(schtasksQueryAllArgs());
      if (all.ok) return { ok: true, taskNames: parseQueriedTaskNames(all.stdout) };
      return { ok: false, error: all.error };
    },
  };
}

/** Windows and macOS get their real schedulers; the rest, the honest refusal. */
export function defaultBackend(platform: string = os.platform()): SchedulerBackend {
  if (platform === 'win32') return windowsBackend();
  if (platform === 'darwin') return launchdBackend();
  return unavailableBackend(platform);
}
