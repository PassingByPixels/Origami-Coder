// cronService.ts — cron bookkeeping over an injected SchedulerBackend. No
// vscode import and no process spawning of its own, so every path here is
// exercised against a FAKE backend in tests (the real schtasks backend is
// constructed only by the extension host).
//
// The invariant this file exists to hold: NOTHING registers itself. A cron
// becomes an OS task only when created or enabled, and stops being one when
// disabled or deleted. The file is written only AFTER the backend agreed, so a
// record can never claim a registration that does not exist.
//
// Drift is REPORTED in both directions and repaired in neither — the rule and
// its reasoning live in cronReconcile.ts, which this file re-exports so the
// panel keeps one import site.
//
// The launcher script (cronLauncher.ts) is written before registration and
// removed with it, so the disk and the OS can never disagree about what a cron
// runs.

import { nextRun, parseSchedule, scheduleLabel, type CronSchedule } from './cronSchedule';
import { readCronRunStats, type CronOutcome } from './cronLog';
import { cronLogPath, cronLogRelPath, cronScriptPath, cronScriptRelPath, promptHazard, runInvocation, taskNameFor, type RunCommandSpec } from './cronCommand';
import { buildLauncherScript, taskCommand, trLengthError } from './cronLauncher';
import { ensureCronDirs, launcherIds, pruneOrphanLaunchers, removeLauncher, writeLauncher } from './cronFiles';
import { loadCrons, newCronId, saveCrons, type CronRecord, type InvalidCron } from './cronState';
import { noDrift, reconcileCrons, type DriftReport } from './cronReconcile';
import type { CronRow, CronsPayload } from './cronRow';
import type { SchedulerBackend } from './schedulerBackend';

export interface CronServiceDeps {
  repoRoot: string;
  backend: SchedulerBackend;
  /** acpClient.resolveOrigamiBinary, injected so tests need no real binary. */
  resolveBinary: () => string;
  now?: () => number;
}

export interface CronDraft {
  name: string;
  prompt: string;
  schedule: unknown;
  agent?: string;
  model?: string;
}

export type { CronRow, CronsPayload } from './cronRow';
export { reconcileCrons, type DriftReport };

export type OpResult = { ok: true } | { ok: false; error: string };

export class CronService {
  private readonly deps: CronServiceDeps;
  private readonly now: () => number;

  constructor(deps: CronServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  private read(): ReturnType<typeof loadCrons> {
    return loadCrons(this.deps.repoRoot);
  }

  private specFor(cron: CronRecord): RunCommandSpec {
    return {
      binary: this.deps.resolveBinary(),
      name: cron.name,
      prompt: cron.prompt,
      workspace: this.deps.repoRoot,
      agent: cron.agent,
      model: cron.model,
      logPath: cronLogPath(this.deps.repoRoot, cron.id),
    };
  }

  /**
   * Write the cron's launcher script and return the `/TR` value pointing at it,
   * or an error if the path is too long for schtasks to accept. The length is
   * checked BEFORE the script is written, so a refusal leaves nothing behind.
   */
  private installLauncher(cron: CronRecord): { ok: true; command: string } | { ok: false; error: string } {
    const script = cronScriptPath(this.deps.repoRoot, cron.id);
    const tooLong = trLengthError(script);
    if (tooLong) return { ok: false, error: tooLong };
    ensureCronDirs(this.deps.repoRoot);
    writeLauncher(this.deps.repoRoot, cron.id, buildLauncherScript(this.specFor(cron)));
    return { ok: true, command: taskCommand(script) };
  }

  private toRow(cron: CronRecord): CronRow {
    // Runs + last outcome come from the LOG, not from a counter here — see
    // cronLog.ts for why a second source would be a liability, not a backup.
    const log = readCronRunStats(cronLogPath(this.deps.repoRoot, cron.id));
    const next = cron.enabled ? nextRun(cron.schedule, new Date(this.now()), cron.lastSyncedAt) : null;
    return {
      id: cron.id,
      name: cron.name,
      prompt: cron.prompt,
      schedule: cron.schedule,
      scheduleLabel: scheduleLabel(cron.schedule),
      agent: cron.agent,
      model: cron.model,
      enabled: cron.enabled,
      taskName: taskNameFor(cron.id),
      logPath: cronLogRelPath(cron.id),
      scriptPath: cronScriptRelPath(cron.id),
      nextRunAt: next ? next.toISOString() : null,
      lastOutputAt: log.lastOutputAt,
      runs: log.runs,
      runsExact: log.runsExact,
      lastOutcome: log.lastOutcome,
      lastExitCode: log.lastExitCode,
    };
  }

  /** Everything the pane needs, including a fresh drift check. */
  async list(): Promise<CronsPayload> {
    const { crons, invalid, recovered, backupPath } = this.read();
    const scripts = launcherIds(this.deps.repoRoot);
    let drift: DriftReport = noDrift();
    if (this.deps.backend.available) {
      const q = await this.deps.backend.query();
      drift = q.ok
        ? reconcileCrons(crons, q.taskNames, scripts)
        : { ...noDrift(), error: q.error };
    }
    return {
      workspace: this.deps.repoRoot,
      crons: crons.map((c) => this.toRow(c)),
      invalid,
      drift,
      backendAvailable: this.deps.backend.available,
      backendReason: this.deps.backend.unavailableReason,
      recovered,
      backupPath,
    };
  }

  /**
   * Validate a draft without touching disk or the OS — drives the pane's form.
   *
   * MODEL IS REQUIRED, and it is the only field here whose absence costs money
   * rather than failing. `runInvocation` omits `--model` when it is unset
   * (cronCommand.ts), and the engine then resolves it from the MACHINE-WIDE
   * recent-models file (Provider.defaultModel in engine/src/provider/
   * provider.ts) — so an unpinned job adopts whatever model was last used in
   * any chat on this computer, unattended, at whatever that costs. Refused
   * HERE rather than only in the form, so a stale webview cannot create one.
   */
  static validate(draft: CronDraft): { ok: true; schedule: CronSchedule } | { ok: false; error: string } {
    if (typeof draft.name !== 'string' || draft.name.trim() === '') return { ok: false, error: 'name is required' };
    if (typeof draft.prompt !== 'string') return { ok: false, error: 'prompt is required' };
    if (typeof draft.model !== 'string' || draft.model.trim() === '')
      return { ok: false, error: 'model is required — an unpinned cron runs on whatever model was used last on this machine, not on a workspace default' };
    const hazard = promptHazard(draft.prompt);
    if (hazard) return { ok: false, error: hazard };
    const sched = parseSchedule(draft.schedule);
    if (!sched.ok) return { ok: false, error: sched.reason };
    return { ok: true, schedule: sched.schedule };
  }

  async create(draft: CronDraft): Promise<OpResult> {
    const valid = CronService.validate(draft);
    if (!valid.ok) return valid;
    if (!this.deps.backend.available) return { ok: false, error: this.deps.backend.unavailableReason ?? 'scheduler unavailable' };

    const { crons } = this.read();
    const cron: CronRecord = {
      id: newCronId(this.now()),
      name: draft.name.trim(),
      prompt: draft.prompt,
      schedule: valid.schedule,
      enabled: true,
      createdAt: this.now(),
      ...(draft.agent ? { agent: draft.agent } : {}),
      ...(draft.model ? { model: draft.model } : {}),
    };

    const launcher = this.installLauncher(cron);
    if (!launcher.ok) return launcher;

    const reg = await this.deps.backend.register({
      taskName: taskNameFor(cron.id),
      schedule: cron.schedule,
      command: launcher.command,
    });
    // Registration failed => write NOTHING and take the launcher back out, so
    // neither the file nor the disk claims a task that does not exist.
    if (!reg.ok) {
      removeLauncher(this.deps.repoRoot, cron.id);
      return reg;
    }

    cron.taskName = taskNameFor(cron.id);
    cron.lastSyncedAt = this.now();
    const next = [...crons, cron];
    saveCrons(this.deps.repoRoot, next);
    // Sweep launchers with no cron behind them (e.g. a record deleted by hand).
    pruneOrphanLaunchers(this.deps.repoRoot, next.map((c) => c.id));
    return { ok: true };
  }

  async update(id: string, draft: CronDraft): Promise<OpResult> {
    const valid = CronService.validate(draft);
    if (!valid.ok) return valid;
    const { crons } = this.read();
    const existing = crons.find((c) => c.id === id);
    if (!existing) return { ok: false, error: `no cron ${id}` };

    const next: CronRecord = {
      ...existing,
      name: draft.name.trim(),
      prompt: draft.prompt,
      schedule: valid.schedule,
      agent: draft.agent || undefined,
      model: draft.model || undefined,
    };

    if (next.enabled) {
      if (!this.deps.backend.available) return { ok: false, error: this.deps.backend.unavailableReason ?? 'scheduler unavailable' };
      // The launcher is regenerated so the script on disk can never lag the
      // record — an edited prompt that kept running the old text would be
      // invisible until someone read the log.
      const launcher = this.installLauncher(next);
      if (!launcher.ok) return launcher;
      const reg = await this.deps.backend.register({
        taskName: taskNameFor(next.id),
        schedule: next.schedule,
        command: launcher.command,
      });
      if (!reg.ok) return reg;
      next.taskName = taskNameFor(next.id);
      next.lastSyncedAt = this.now();
    }
    saveCrons(this.deps.repoRoot, crons.map((c) => (c.id === id ? next : c)));
    return { ok: true };
  }

  async setEnabled(id: string, enabled: boolean): Promise<OpResult> {
    const { crons } = this.read();
    const existing = crons.find((c) => c.id === id);
    if (!existing) return { ok: false, error: `no cron ${id}` };
    if (!this.deps.backend.available) return { ok: false, error: this.deps.backend.unavailableReason ?? 'scheduler unavailable' };

    const next: CronRecord = { ...existing, enabled };
    if (enabled) {
      const launcher = this.installLauncher(next);
      if (!launcher.ok) return launcher;
      const reg = await this.deps.backend.register({
        taskName: taskNameFor(id),
        schedule: next.schedule,
        command: launcher.command,
      });
      if (!reg.ok) return reg;
      next.taskName = taskNameFor(id);
      next.lastSyncedAt = this.now();
    } else {
      const un = await this.deps.backend.unregister(taskNameFor(id));
      if (!un.ok) return un;
      // A disabled cron leaves no launcher behind — nothing dormant on disk
      // that a stray task could still point at.
      removeLauncher(this.deps.repoRoot, id);
      delete next.taskName;
      delete next.lastSyncedAt;
    }
    saveCrons(this.deps.repoRoot, crons.map((c) => (c.id === id ? next : c)));
    return { ok: true };
  }

  async remove(id: string): Promise<OpResult> {
    const { crons } = this.read();
    if (!crons.some((c) => c.id === id)) return { ok: false, error: `no cron ${id}` };
    if (this.deps.backend.available) {
      const un = await this.deps.backend.unregister(taskNameFor(id));
      // Leaving a live task behind while dropping its record would create
      // permanent invisible drift — refuse instead.
      if (!un.ok) return un;
    }
    const next = crons.filter((c) => c.id !== id);
    saveCrons(this.deps.repoRoot, next);
    // The task is gone, so its launcher must go too — and any other orphan
    // while we are here, or dead .cmd files accumulate forever.
    pruneOrphanLaunchers(this.deps.repoRoot, next.map((c) => c.id));
    return { ok: true };
  }

  /** Fire the registered task once, now — the OS runs it, exactly as scheduled. */
  async runNow(id: string): Promise<OpResult> {
    const { crons } = this.read();
    const cron = crons.find((c) => c.id === id);
    if (!cron) return { ok: false, error: `no cron ${id}` };
    if (!this.deps.backend.available) return { ok: false, error: this.deps.backend.unavailableReason ?? 'scheduler unavailable' };
    if (!cron.enabled) return { ok: false, error: `${cron.name} is disabled — enable it first` };
    ensureCronDirs(this.deps.repoRoot);
    return this.deps.backend.runNow(taskNameFor(id));
  }
}
