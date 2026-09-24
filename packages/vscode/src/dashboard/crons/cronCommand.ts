// cronCommand.ts — the quoting primitives, the `origami run` invocation, and the schtasks argv.
// Pure: string in, string/array out, asserted verbatim in tests, since a wrong quote here means a
// task that does the wrong thing at 3am, unattended. Crons run auto-approved (`--auto`): nothing is
// there to answer a permission ask, so every cron is write-capable and its log is the audit trail.

import * as path from 'node:path';
import { scheduleFlags, type CronSchedule } from './cronSchedule';

/** Task Scheduler folder for everything this view owns, so a stray task is identifiable. */
export const TASK_FOLDER = '\\Origami';
/** launchd label prefix — the macOS TASK_FOLDER: how a registered job is recognised as ours. */
export const LAUNCHD_LABEL_PREFIX = 'com.origami.cron.';

export const CRON_LOG_DIR = path.join('.origami', 'cron-logs');
/** Launcher scripts. Kept SHORT deliberately — every character here eats into
 *  the 261-character `/TR` budget (cronLauncher.ts). */
export const CRON_SCRIPT_DIR = path.join('.origami', 'crons');

/** The OS task name for a cron id. Stable — it IS the reconcile key. On
 *  Windows a Task Scheduler path, on macOS a launchd label (cron ids are
 *  lowercase alphanumerics — legal in a label as-is). */
export function taskNameFor(id: string, platform: string = process.platform): string {
  return platform === 'darwin' ? `${LAUNCHD_LABEL_PREFIX}${id}` : `${TASK_FOLDER}\\${id}`;
}

export function cronLogRelPath(id: string): string {
  return path.join(CRON_LOG_DIR, `${id}.log`);
}

export function cronLogPath(workspace: string, id: string): string {
  return path.join(workspace, CRON_LOG_DIR, `${id}.log`);
}

/** Launcher extension per platform: a batch file for schtasks, a sh script for
 *  launchd (run via `/bin/sh <script>`, so it needs no execute bit). */
function scriptExt(platform: string): string {
  return platform === 'darwin' ? 'sh' : 'cmd';
}

export function cronScriptRelPath(id: string, platform: string = process.platform): string {
  return path.join(CRON_SCRIPT_DIR, `${id}.${scriptExt(platform)}`);
}

export function cronScriptPath(workspace: string, id: string, platform: string = process.platform): string {
  return path.join(workspace, CRON_SCRIPT_DIR, `${id}.${scriptExt(platform)}`);
}

/**
 * Quote one token. Embedded quotes are doubled (`"` -> `""`), never backslash-escaped — doubling
 *  keeps cmd's quote-state parity even, which a `\"` escape does not.
 */
export function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Double every `%` so a batch file emits it literally. See cronLauncher.ts (1). */
export function batchPercent(value: string): string {
  return value.replace(/%/g, '%%');
}

/**
 * Escape bare (unquoted) text for a batch `echo` — the cron's display name is the only such text
 *  emitted. Quoted tokens must not go through this, since `^` is literal inside quotes and escaping
 *  there would log a command that did not really run that way.
 */
export function batchBareText(value: string): string {
  return batchPercent(value.replace(/[\^&|<>()]/g, (c) => `^${c}`));
}

/**
 * Why this prompt cannot be scheduled, or null if it can. A line break cannot survive the
 *  single-line batch invocation. `%VAR%` no longer needs refusing, since the launcher doubles every
 *  `%` and the text reaches origami literally.
 */
export function promptHazard(prompt: string): string | null {
  if (prompt.trim().length === 0) return 'prompt is empty';
  if (/[\r\n]/.test(prompt)) return 'prompt contains a line break — a scheduled command cannot carry one; put it on a single line';
  if (/\0/.test(prompt)) return 'prompt contains a NUL character';
  return null;
}

export interface RunCommandSpec {
  /** Resolved origami binary (acpClient.resolveOrigamiBinary). */
  binary: string;
  /** Cron display name, for the log's start line. */
  name: string;
  prompt: string;
  /** Absolute workspace root — becomes `--dir`. */
  workspace: string;
  agent?: string;
  model?: string;
  /** Absolute log path; stdout+stderr are APPENDED so history survives. */
  logPath: string;
}

/** The `origami run …` invocation — the command a cron exists to run. */
export function runInvocation(spec: RunCommandSpec): string {
  const parts = [cmdQuote(spec.binary), 'run', cmdQuote(spec.prompt), '--auto', '--dir', cmdQuote(spec.workspace)];
  if (spec.agent) parts.push('--agent', cmdQuote(spec.agent));
  if (spec.model) parts.push('--model', cmdQuote(spec.model));
  return parts.join(' ');
}

/**
 * argv for `schtasks /Create`, passed to execFile as an array with no shell — this module must not
 *  pre-quote elements or the task name would arrive with literal quotes. `/F` overwrites an
 *  existing task of the same name.
 */
export function schtasksCreateArgs(taskName: string, schedule: CronSchedule, command: string): string[] {
  return ['/Create', '/TN', taskName, '/TR', command, ...scheduleFlags(schedule), '/F'];
}

export function schtasksDeleteArgs(taskName: string): string[] {
  return ['/Delete', '/TN', taskName, '/F'];
}

/**
 * Query our folder. The trailing separator is load-bearing: `/TN "\Origami"` fails while `/TN
 *  "\Origami\"` lists it. Fast (~25ms) but cannot distinguish "no folder yet" from "query failed" —
 *  schedulerBackend pairs it with the enumerate form below.
 */
export function schtasksFolderQueryArgs(): string[] {
  return ['/Query', '/TN', `${TASK_FOLDER}\\`, '/FO', 'CSV', '/NH'];
}

/**
 * Every task on the machine, filtered to ours. Slower (~520ms) but succeeds whether or not our
 *  folder exists, so a failure unambiguously means the query failed.
 */
export function schtasksQueryAllArgs(): string[] {
  return ['/Query', '/FO', 'CSV', '/NH'];
}

export function schtasksRunArgs(taskName: string): string[] {
  return ['/Run', '/TN', taskName];
}

/**
 * Task names out of `schtasks /Query /FO CSV /NH`. Rows for other folders are dropped, so a caller
 *  can never mistake somebody else's scheduled task for one of ours.
 */
export function parseQueriedTaskNames(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^"((?:[^"]|"")*)"/.exec(trimmed);
    const name = m ? m[1].replace(/""/g, '"') : trimmed.split(',')[0];
    if (name.startsWith(`${TASK_FOLDER}\\`)) names.push(name);
  }
  return names;
}
