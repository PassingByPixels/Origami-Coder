// cronState.ts — `.origami/crons.json`, the git-trackable truth for scheduled runs. Atomic write
// (tmp + rename); a corrupt file is backed up beside itself rather than clobbered, since a human
// hand-editing it is the likeliest cause.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSchedule, type CronSchedule } from './cronSchedule';

export const CRONS_FILENAME = path.join('.origami', 'crons.json');

export interface CronRecord {
  /** Stable id — also the OS task name suffix, so it is the reconcile key. */
  id: string;
  name: string;
  prompt: string;
  schedule: CronSchedule;
  agent?: string;
  model?: string;
  enabled: boolean;
  createdAt: number;
  /** OS-side identity, set when the task was actually registered. */
  taskName?: string;
  /** When the OS task was last written. Doubles as the interval anchor
   *  nextRun() needs — Task Scheduler counts an interval from registration. */
  lastSyncedAt?: number;
}

export interface CronsFile {
  version: 1;
  crons: CronRecord[];
}

export interface InvalidCron {
  raw: unknown;
  reason: string;
}

export interface LoadResult {
  crons: CronRecord[];
  /** Entries present in the file that we could not read — shown, never dropped. */
  invalid: InvalidCron[];
  /** True when the whole file was unparseable and got backed up. */
  recovered: boolean;
  backupPath?: string;
}

export const emptyCrons = (): CronsFile => ({ version: 1, crons: [] });

export function newCronId(now = Date.now()): string {
  return `c${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function cronsFilePath(repoRoot: string): string {
  return path.join(repoRoot, CRONS_FILENAME);
}

/** Validate one entry, preserving any fields we do not model. */
export function parseCronRecord(raw: unknown): { ok: true; cron: CronRecord } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'entry is not an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.trim() === '') return { ok: false, reason: 'missing "id"' };
  if (typeof r.name !== 'string' || r.name.trim() === '') return { ok: false, reason: `cron ${r.id} is missing "name"` };
  if (typeof r.prompt !== 'string' || r.prompt.trim() === '') return { ok: false, reason: `cron ${r.id} is missing "prompt"` };

  const sched = parseSchedule(r.schedule);
  if (!sched.ok) return { ok: false, reason: `cron ${r.id}: ${sched.reason}` };

  return {
    ok: true,
    cron: {
      // Spread FIRST so unknown fields survive, then pin the ones we own.
      ...(r as object),
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      schedule: sched.schedule,
      enabled: r.enabled !== false,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
      ...(typeof r.agent === 'string' && r.agent ? { agent: r.agent } : {}),
      ...(typeof r.model === 'string' && r.model ? { model: r.model } : {}),
      ...(typeof r.taskName === 'string' ? { taskName: r.taskName } : {}),
      ...(typeof r.lastSyncedAt === 'number' ? { lastSyncedAt: r.lastSyncedAt } : {}),
    } as CronRecord,
  };
}

/**
 * Read the crons file. Missing means no crons. Unparseable copies the file to `<file>.corrupt-<ts>`
 *  and starts empty, so a bad hand-edit costs the user nothing they cannot get back.
 */
export function loadCrons(repoRoot: string): LoadResult {
  const file = cronsFilePath(repoRoot);
  let rawText: string;
  try {
    rawText = fs.readFileSync(file, 'utf8');
  } catch {
    return { crons: [], invalid: [], recovered: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
    const p = parsed as CronsFile;
    if (p?.version !== 1 || !Array.isArray(p.crons)) throw new Error('bad shape');
  } catch {
    const backupPath = `${file}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(file, backupPath);
    } catch {
      return { crons: [], invalid: [], recovered: true };
    }
    return { crons: [], invalid: [], recovered: true, backupPath };
  }

  const crons: CronRecord[] = [];
  const invalid: InvalidCron[] = [];
  for (const entry of (parsed as CronsFile).crons) {
    const res = parseCronRecord(entry);
    if (res.ok) crons.push(res.cron);
    else invalid.push({ raw: entry, reason: res.reason });
  }
  return { crons, invalid, recovered: false };
}

/** Atomic write: tmp + rename, so a crash mid-write cannot half-eat the file. */
export function saveCrons(repoRoot: string, crons: readonly CronRecord[]): void {
  const file = cronsFilePath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const doc: CronsFile = { version: 1, crons: [...crons] };
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
