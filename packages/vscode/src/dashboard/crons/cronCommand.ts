// cronCommand.ts — the quoting primitives, the `origami run` invocation, and
// the schtasks argv. PURE: string in, string/array out, nothing spawns, so
// everything here can be asserted VERBATIM in tests. That matters more than
// usual: the failure mode is a task that registers cleanly and then does the
// wrong thing at 3am, unattended, for weeks.
//
// The invocation is assembled here but EXECUTED from a launcher script
// (cronLauncher.ts), because schtasks caps `/TR` at 261 characters. The batch
// escaping rules — which are NOT the command-line rules — are documented there.
//
// CRONS RUN AUTO-APPROVED (`--auto`). A cron fires with the editor closed and
// nobody to answer a permission ask, so without the flag the run cannot get
// past the first one. Every cron is therefore write-capable and its log is the
// audit trail.

import * as path from 'node:path';
import { scheduleFlags, type CronSchedule } from './cronSchedule';

/** Task Scheduler folder for everything this view owns, so a stray task is
 *  identifiable and the user's own tasks are never in scope. */
export const TASK_FOLDER = '\\Origami';
/** launchd label prefix — the macOS equivalent of TASK_FOLDER: it is how a
 *  registered job is recognised as ours (and ONLY ours) in `launchctl list`. */
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
 * Quote one token. Embedded quotes are DOUBLED (`"` -> `""`), never
 * backslash-escaped: doubling keeps cmd's quote-state parity even AND the CRT
 * parser origami is handed reads `""` inside a quoted argument as one literal
 * `"`. A `\"` escape satisfies only the second.
 */
export function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Double every `%` so a batch file emits it literally. See cronLauncher.ts (1). */
export function batchPercent(value: string): string {
  return value.replace(/%/g, '%%');
}

/**
 * Escape BARE (unquoted) text for a batch `echo` — the cron's display name is
 * the only such text we emit. Quoted tokens must NOT go through this: `^` is
 * literal inside quotes, so escaping there would record `^&` for a command that
 * really ran with `&`, i.e. an audit line that lies.
 */
export function batchBareText(value: string): string {
  return batchPercent(value.replace(/[\^&|<>()]/g, (c) => `^${c}`));
}

/**
 * Why this prompt cannot be scheduled, or null if it can.
 *
 * A line break cannot survive the single-line batch invocation, and there is no
 * escape for it. `%VAR%` used to be refused here; it no longer needs to be,
 * because the launcher doubles every `%` and the text reaches origami literally
 * (verified by execution — see cronLauncher.ts (1)).
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
 * argv for `schtasks /Create`. Passed to execFile as an ARRAY with no shell, so
 * OS-level quoting of these elements is Node's job — this module must not
 * pre-quote them or the task name would arrive with literal quotes in it.
 *
 * `/F` overwrites an existing task of the same name, which is what an edit is.
 */
export function schtasksCreateArgs(taskName: string, schedule: CronSchedule, command: string): string[] {
  return ['/Create', '/TN', taskName, '/TR', command, ...scheduleFlags(schedule), '/F'];
}

export function schtasksDeleteArgs(taskName: string): string[] {
  return ['/Delete', '/TN', taskName, '/F'];
}

/**
 * Query OUR folder. The TRAILING SEPARATOR is load-bearing: without it schtasks
 * reads `\Origami` as a task NAME and answers "The system cannot find the file
 * specified." even when the folder is full of tasks. Verified against a real
 * registered task — `/TN "\Origami"` failed while `/TN "\Origami\"` listed it.
 *
 * Fast (~25ms) but it CANNOT distinguish "no folder yet" from "query failed":
 * both 404. schedulerBackend pairs it with the enumerate form below.
 */
export function schtasksFolderQueryArgs(): string[] {
  return ['/Query', '/TN', `${TASK_FOLDER}\\`, '/FO', 'CSV', '/NH'];
}

/**
 * Every task on the machine, filtered to ours by parseQueriedTaskNames. Slower
 * (~520ms over ~257 tasks here) but it SUCCEEDS whether or not our folder
 * exists — so a failure unambiguously means the query failed, and an empty
 * result unambiguously means no crons. Read-only.
 */
export function schtasksQueryAllArgs(): string[] {
  return ['/Query', '/FO', 'CSV', '/NH'];
}

export function schtasksRunArgs(taskName: string): string[] {
  return ['/Run', '/TN', taskName];
}

/**
 * Task names out of `schtasks /Query /FO CSV /NH`. The first CSV column is the
 * task name; rows for other folders (and the informational rows schtasks emits
 * for an empty folder) are dropped, so a caller can never mistake somebody
 * else's scheduled task for one of ours.
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
