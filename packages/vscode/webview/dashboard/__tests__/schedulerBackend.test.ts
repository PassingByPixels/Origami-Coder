// schedulerBackend — the query path, driven against a SIMULATED schtasks that
// reproduces its real, verified behaviour.
//
// WHY THIS FILE EXISTS. The plain fake backend used by cronService.test.ts can
// never catch a bug like the one these tests pin, because it does not model
// schtasks at all: it just returns whatever it was told to. The real defect was
// two mistakes stacked —
//   1. `/Query /TN "\Origami"` (no trailing separator) 404s even when the
//      folder is FULL, because schtasks reads it as a task name; and
//   2. that 404 was being interpreted as "no tasks registered".
// Together they made every correctly-registered cron report as missing forever.
// The runner below returns exactly what real schtasks returns for each argv, so
// mistake (1) is reproducible in-process and mistake (2) is observable.

import { describe, it, expect } from 'vitest';
import { windowsBackend, unavailableBackend, type SchtasksRun } from '../../../src/dashboard/crons/schedulerBackend';
import { schtasksFolderQueryArgs, schtasksQueryAllArgs } from '../../../src/dashboard/crons/cronCommand';

const NOT_FOUND = 'ERROR: The system cannot find the file specified.';
const OUR_ROW = '"\\Origami\\c1","30/07/2026 03:30:00","Ready"';
const OTHER_ROWS = [
  '"\\NightlyMirrorSync","30/07/2026 22:00:00","Ready"',
  '"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","N/A","Ready"',
].join('\r\n');

/**
 * Stands in for schtasks, honouring the behaviour verified against the real
 * one: a folder query WITHOUT a trailing separator 404s regardless of contents;
 * WITH one it lists the folder; a bare enumerate always succeeds.
 */
function simulate(opts: { folderExists: boolean; enumerateFails?: boolean }): { run: SchtasksRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: SchtasksRun = async (args) => {
    calls.push(args);
    const tnIndex = args.indexOf('/TN');
    const tn = tnIndex >= 0 ? args[tnIndex + 1] : undefined;

    if (args[0] === '/Query' && tn !== undefined) {
      // The real trap: no trailing separator => treated as a TASK name => 404.
      if (!tn.endsWith('\\')) return { ok: false, error: NOT_FOUND };
      if (!opts.folderExists) return { ok: false, error: NOT_FOUND };
      return { ok: true, stdout: OUR_ROW };
    }
    if (args[0] === '/Query') {
      if (opts.enumerateFails) return { ok: false, error: 'ERROR: Access is denied.' };
      return { ok: true, stdout: [opts.folderExists ? OUR_ROW : '', OTHER_ROWS].filter(Boolean).join('\r\n') };
    }
    return { ok: true, stdout: '' };
  };
  return { run, calls };
}

describe('schedulerBackend — the folder query must actually find the folder', () => {
  it('asks with a TRAILING SEPARATOR — without it schtasks 404s on a full folder', () => {
    // This is the argument-level regression. `\Origami` reads as a task name.
    expect(schtasksFolderQueryArgs()).toEqual(['/Query', '/TN', '\\Origami\\', '/FO', 'CSV', '/NH']);
    expect(schtasksFolderQueryArgs()[2].endsWith('\\')).toBe(true);
  });

  it('the enumerate form carries NO /TN, so it succeeds whether or not our folder exists', () => {
    expect(schtasksQueryAllArgs()).toEqual(['/Query', '/FO', 'CSV', '/NH']);
    expect(schtasksQueryAllArgs()).not.toContain('/TN');
  });

  it('finds a registered cron via the fast folder query, without enumerating', async () => {
    const { run, calls } = simulate({ folderExists: true });
    const res = await windowsBackend(run).query();
    expect(res).toEqual({ ok: true, taskNames: ['\\Origami\\c1'] });
    // The hot path stays fast: one call, no full-machine enumerate (~520ms).
    expect(calls).toHaveLength(1);
  });
});

describe('schedulerBackend — a failed query is NEVER reported as "no tasks"', () => {
  it('an absent folder yields an EMPTY list via the enumerate fallback, not an error', async () => {
    const { run, calls } = simulate({ folderExists: false });
    const res = await windowsBackend(run).query();
    expect(res).toEqual({ ok: true, taskNames: [] });
    // It had to check rather than assume — the 404 alone proves nothing.
    expect(calls).toHaveLength(2);
  });

  it('when BOTH forms fail, query reports ok:false — the conflation this fixes', async () => {
    // The old code turned any "cannot find" into { ok: true, taskNames: [] },
    // so a broken query was indistinguishable from an empty scheduler and every
    // healthy cron was reported as missing registration.
    const { run } = simulate({ folderExists: false, enumerateFails: true });
    const res = await windowsBackend(run).query();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('Access is denied');
  });

  it('never mistakes somebody else\'s task for one of ours, even when enumerating', async () => {
    const { run } = simulate({ folderExists: false });
    const res = await windowsBackend(run).query();
    if (!res.ok) throw new Error('unreachable');
    // NightlyMirrorSync and the Windows built-ins are present in the enumerate
    // output and must never be adopted.
    expect(res.taskNames).toEqual([]);
  });
});

describe('schedulerBackend — delete stays idempotent (a DIFFERENT rule from query)', () => {
  it('unregistering something already gone succeeds — that IS the desired end state', async () => {
    const run: SchtasksRun = async () => ({ ok: false, error: NOT_FOUND });
    expect(await windowsBackend(run).unregister('\\Origami\\gone')).toEqual({ ok: true });
  });

  it('a REAL unregister failure is still surfaced', async () => {
    const run: SchtasksRun = async () => ({ ok: false, error: 'ERROR: Access is denied.' });
    const res = await windowsBackend(run).unregister('\\Origami\\c1');
    expect(res.ok).toBe(false);
  });

  it('a failed register is surfaced verbatim — e.g. the 261-character /TR limit', async () => {
    const run: SchtasksRun = async () => ({ ok: false, error: "ERROR: Value for '/TR' option cannot be more than 261 character(s)." });
    const res = await windowsBackend(run).register({ taskName: '\\Origami\\c1', schedule: { kind: 'daily', time: '09:30' }, command: '"x"' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('261');
  });
});

describe('schedulerBackend — a platform with no scheduler refuses everything', () => {
  it('reports why, and registers nothing', async () => {
    // darwin has a real backend now (launchdBackend) — linux is the honest
    // refusal's remaining home.
    const be = unavailableBackend('linux');
    expect(be.available).toBe(false);
    expect(be.unavailableReason).toMatch(/Windows \(Task Scheduler\) and macOS \(launchd\)/);
    expect((await be.register({ taskName: 'x', schedule: { kind: 'daily', time: '09:30' }, command: 'c' })).ok).toBe(false);
    expect((await be.query()).ok).toBe(false);
  });
});
