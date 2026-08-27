// cronService — cron bookkeeping against a FAKE SchedulerBackend. No real
// scheduled task is created, modified, deleted or queried anywhere in this
// suite; the fake records what it was ASKED to do, which is exactly what needs
// asserting.
//
// The invariants under test are the ones that would otherwise fail silently:
// nothing registers itself, the file never claims a registration that does not
// exist, and drift is REPORTED in both directions rather than quietly repaired.

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CronService, reconcileCrons } from '../../../src/dashboard/crons/cronService';
import { loadCrons, saveCrons, type CronRecord } from '../../../src/dashboard/crons/cronState';
import type { BackendResult, QueryResult, RegisterRequest, SchedulerBackend } from '../../../src/dashboard/crons/schedulerBackend';

// The literal `\Origami\…` task names and `.cmd` launcher assertions below go
// through the service's platform DEFAULTS — pin the platform so the suite
// holds on macOS too. The service logic itself is platform-free.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
afterAll(() => { Object.defineProperty(process, 'platform', realPlatform); });

interface FakeBackend extends SchedulerBackend {
  registered: Map<string, RegisterRequest>;
  calls: string[];
  failNext?: string;
}

function fakeBackend(over: Partial<SchedulerBackend> = {}): FakeBackend {
  const registered = new Map<string, RegisterRequest>();
  const calls: string[] = [];
  const be: FakeBackend = {
    available: true,
    registered,
    calls,
    async register(req): Promise<BackendResult> {
      calls.push(`register:${req.taskName}`);
      if (be.failNext === 'register') return { ok: false, error: 'access denied' };
      registered.set(req.taskName, req);
      return { ok: true };
    },
    async unregister(taskName): Promise<BackendResult> {
      calls.push(`unregister:${taskName}`);
      if (be.failNext === 'unregister') return { ok: false, error: 'the task is in use' };
      registered.delete(taskName);
      return { ok: true };
    },
    async runNow(taskName): Promise<BackendResult> {
      calls.push(`runNow:${taskName}`);
      return { ok: true };
    },
    async query(): Promise<QueryResult> {
      calls.push('query');
      return { ok: true, taskNames: [...registered.keys()] };
    },
    ...over,
  };
  return be;
}

let root: string;
let backend: FakeBackend;
let svc: CronService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-cronsvc-'));
  backend = fakeBackend();
  svc = new CronService({ repoRoot: root, backend, resolveBinary: () => 'C:\\bin\\origami.exe', now: () => 5000 });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

// `model` is part of the BASELINE draft, not an extra: a cron may no longer be
// created without one (CronService.validate), because an unpinned job silently
// adopts the machine's last-used model at run time. Every case below is about
// something else, so they all carry a valid model and say nothing about it.
const draft = (over: Record<string, unknown> = {}) => ({
  name: 'nightly', prompt: 'triage the backlog', schedule: { kind: 'daily', time: '09:30' },
  model: 'anthropic/claude-sonnet-4', ...over,
});

describe('cronService — creating a cron registers exactly one OS task', () => {
  it('registers, then writes the record with its taskName and sync stamp', async () => {
    expect(await svc.create(draft())).toEqual({ ok: true });
    expect(backend.registered.size).toBe(1);
    const [taskName, req] = [...backend.registered.entries()][0];
    expect(taskName).toMatch(/^\\Origami\\c/);
    expect(req.schedule).toEqual({ kind: 'daily', time: '09:30' });
    // /TR is only the launcher path — that is what keeps it inside schtasks'
    // 261-character limit. The prompt lives in the script.
    expect(req.command).toBe(`"${path.join(root, '.origami', 'crons', `${loadCrons(root).crons[0].id}.cmd`)}"`);
    expect(req.command.length).toBeLessThanOrEqual(261);
    const script = fs.readFileSync(path.join(root, '.origami', 'crons', `${loadCrons(root).crons[0].id}.cmd`), 'utf8');
    expect(script).toContain('--auto');
    expect(script).toContain('run "triage the backlog"');

    const { crons } = loadCrons(root);
    expect(crons).toHaveLength(1);
    expect(crons[0].taskName).toBe(taskName);
    expect(crons[0].lastSyncedAt).toBe(5000);
    expect(crons[0].enabled).toBe(true);
  });

  it('an untranslatable schedule is refused BEFORE anything is registered or written', async () => {
    const res = await svc.create(draft({ schedule: { kind: 'hourly', every: 24 } }));
    expect(res.ok).toBe(false);
    expect(backend.calls).toEqual([]);
    expect(loadCrons(root).crons).toEqual([]);
  });

  it('a prompt that cannot survive a scheduled command is refused before registering', async () => {
    const res = await svc.create(draft({ prompt: 'line one\nline two' }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/line break/);
    expect(backend.calls).toEqual([]);
  });

  it('a prompt containing %VAR% is now ACCEPTED and reaches origami literally', async () => {
    // The launcher doubles it; only the old inline command-line form needed to
    // refuse it. The escaped text must appear in the script, unexpanded.
    expect(await svc.create(draft({ prompt: 'summarise %USERPROFILE% please' }))).toEqual({ ok: true });
    const id = loadCrons(root).crons[0].id;
    const script = fs.readFileSync(path.join(root, '.origami', 'crons', `${id}.cmd`), 'utf8');
    expect(script).toContain('run "summarise %%USERPROFILE%% please"');
  });

  it('the chosen model is STORED and reaches the launcher as --model', async () => {
    // The whole point of the picker. Two halves, because either one alone is a
    // lie: the record has to remember the choice (so the pane and a later edit
    // agree with it), and the generated script has to actually pass it (so the
    // 3am run does). A cron whose file says one model and whose .cmd runs
    // another is the exact failure this feature exists to prevent.
    expect(await svc.create(draft({ model: 'openai/gpt-5-mini' }))).toEqual({ ok: true });
    const [cron] = loadCrons(root).crons;
    expect(cron.model).toBe('openai/gpt-5-mini');
    const script = fs.readFileSync(path.join(root, '.origami', 'crons', `${cron.id}.cmd`), 'utf8');
    expect(script).toContain('--model "openai/gpt-5-mini"');
  });

  it('a cron with NO model is refused before anything is registered or written', async () => {
    for (const bad of [undefined, '', '   ']) {
      const res = await svc.create(draft({ model: bad }));
      expect(res.ok, `model=${JSON.stringify(bad)} was accepted`).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.error).toMatch(/model is required/);
    }
    // Refused at validation, so the scheduler was never even asked.
    expect(backend.calls).toEqual([]);
    expect(loadCrons(root).crons).toEqual([]);
  });

  it('editing cannot CLEAR a model either — the hole closes from both ends', async () => {
    expect(await svc.create(draft())).toEqual({ ok: true });
    const id = loadCrons(root).crons[0].id;
    const res = await svc.update(id, draft({ model: '' }));
    expect(res.ok).toBe(false);
    // ...and the stored cron is untouched, not half-edited.
    expect(loadCrons(root).crons[0].model).toBe('anthropic/claude-sonnet-4');
  });

  it('when registration FAILS, nothing is written — the file never claims a task that does not exist', async () => {
    backend.failNext = 'register';
    const res = await svc.create(draft());
    expect(res).toEqual({ ok: false, error: 'access denied' });
    expect(loadCrons(root).crons).toEqual([]);
    expect(fs.existsSync(path.join(root, '.origami', 'crons.json'))).toBe(false);
  });
});

describe('cronService — the launcher script lives and dies with its cron', () => {
  const scriptPath = (id: string) => path.join(root, '.origami', 'crons', `${id}.cmd`);

  it('creating a cron writes its launcher', async () => {
    await svc.create(draft());
    expect(fs.existsSync(scriptPath(loadCrons(root).crons[0].id))).toBe(true);
  });

  it('deleting a cron removes its launcher — no dead .cmd left behind', async () => {
    await svc.create(draft());
    const id = loadCrons(root).crons[0].id;
    await svc.remove(id);
    expect(fs.existsSync(scriptPath(id))).toBe(false);
  });

  it('disabling removes the launcher, re-enabling writes it back', async () => {
    await svc.create(draft());
    const id = loadCrons(root).crons[0].id;
    await svc.setEnabled(id, false);
    expect(fs.existsSync(scriptPath(id))).toBe(false);
    await svc.setEnabled(id, true);
    expect(fs.existsSync(scriptPath(id))).toBe(true);
  });

  it('a FAILED registration leaves no launcher behind', async () => {
    backend.failNext = 'register';
    await svc.create(draft());
    expect(fs.readdirSync(path.join(root, '.origami', 'crons')).filter((f) => f.endsWith('.cmd'))).toEqual([]);
  });

  it('orphan launchers (record removed by hand) are swept on the next mutation, and reported meanwhile', async () => {
    await svc.create(draft());
    const id = loadCrons(root).crons[0].id;
    fs.writeFileSync(scriptPath('ghostcron'), '@echo off\r\n');

    // Reported, not silently deleted, by a plain read.
    expect((await svc.list()).drift.orphanScripts).toEqual(['ghostcron']);
    expect(fs.existsSync(scriptPath('ghostcron'))).toBe(true);

    // Swept at an explicit mutation point, so they cannot accumulate forever.
    await svc.remove(id);
    expect(fs.existsSync(scriptPath('ghostcron'))).toBe(false);
  });

  it('a workspace too deeply nested is refused before anything is written or registered', async () => {
    const deep = path.join(root, ...Array.from({ length: 18 }, (_, i) => `deeply-nested-directory-number-${i}`));
    fs.mkdirSync(deep, { recursive: true });
    const s = new CronService({ repoRoot: deep, backend, resolveBinary: () => 'x', now: () => 1 });
    const res = await s.create(draft());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('261');
    expect(backend.calls).toEqual([]);
    expect(fs.existsSync(path.join(deep, '.origami', 'crons.json'))).toBe(false);
  });
});

describe('cronService — the generated directories ignore themselves, in-repo', () => {
  const ignorePath = () => path.join(root, '.origami', 'cron-logs', '.gitignore');

  it('creating a cron drops a .gitignore beside the logs', async () => {
    await svc.create(draft());
    expect(fs.existsSync(ignorePath())).toBe(true);
  });

  it('the body ignores the logs but KEEPS the ignore-file tracked, so it travels with the repo', async () => {
    // A bare `*` would ignore the .gitignore itself: untracked, never committed,
    // and therefore useless to every other clone — the opposite of the point.
    await svc.create(draft());
    expect(fs.readFileSync(ignorePath(), 'utf8')).toBe('*\n!.gitignore\n');
  });

  it('the launcher directory gets the same treatment', async () => {
    await svc.create(draft());
    expect(fs.readFileSync(path.join(root, '.origami', 'crons', '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n');
  });

  it('crons.json itself stays OUTSIDE both ignored directories — it is the tracked truth', async () => {
    await svc.create(draft());
    expect(fs.existsSync(path.join(root, '.origami', 'crons.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.origami', '.gitignore'))).toBe(false);
  });

  it('never clobbers an existing .gitignore a user has edited', async () => {
    fs.mkdirSync(path.join(root, '.origami', 'cron-logs'), { recursive: true });
    fs.writeFileSync(ignorePath(), '# mine\n*.log\n');
    await svc.create(draft());
    expect(fs.readFileSync(ignorePath(), 'utf8')).toBe('# mine\n*.log\n');
  });

  it('is idempotent across repeated operations', async () => {
    await svc.create(draft({ name: 'one' }));
    const first = fs.statSync(ignorePath()).mtimeMs;
    await svc.create(draft({ name: 'two' }));
    await svc.runNow(loadCrons(root).crons[0].id);
    expect(fs.statSync(ignorePath()).mtimeMs).toBe(first);
    expect(fs.readFileSync(ignorePath(), 'utf8')).toBe('*\n!.gitignore\n');
  });
});

describe('cronService — enable/disable drives registration, nothing self-registers', () => {
  it('disabling unregisters the OS task and clears the sync stamp', async () => {
    await svc.create(draft());
    const id = loadCrons(root).crons[0].id;

    expect(await svc.setEnabled(id, false)).toEqual({ ok: true });
    expect(backend.registered.size).toBe(0);
    const after = loadCrons(root).crons[0];
    expect(after.enabled).toBe(false);
    expect(after.taskName).toBeUndefined();
    expect(after.lastSyncedAt).toBeUndefined();
  });

  it('re-enabling registers it again', async () => {
    await svc.create(draft());
    const id = loadCrons(root).crons[0].id;
    await svc.setEnabled(id, false);
    expect(await svc.setEnabled(id, true)).toEqual({ ok: true });
    expect(backend.registered.size).toBe(1);
    expect(loadCrons(root).crons[0].taskName).toBe(`\\Origami\\${id}`);
  });

  it('deleting unregisters first; if that fails the record is KEPT so the task never becomes invisible', async () => {
    await svc.create(draft());
    const id = loadCrons(root).crons[0].id;
    backend.failNext = 'unregister';

    const res = await svc.remove(id);
    expect(res.ok).toBe(false);
    // Dropping the record here would leave a live 3am job with nothing in the
    // UI pointing at it — permanent invisible drift.
    expect(loadCrons(root).crons).toHaveLength(1);
    expect(backend.registered.size).toBe(1);
  });

  it('a successful delete removes both the task and the record', async () => {
    await svc.create(draft());
    const id = loadCrons(root).crons[0].id;
    expect(await svc.remove(id)).toEqual({ ok: true });
    expect(backend.registered.size).toBe(0);
    expect(loadCrons(root).crons).toEqual([]);
  });

  it('editing a live cron re-registers it with the NEW schedule and prompt', async () => {
    await svc.create(draft());
    const id = loadCrons(root).crons[0].id;
    expect(await svc.update(id, draft({ name: 'renamed', prompt: 'new prompt', schedule: { kind: 'hourly', every: 6 } }))).toEqual({ ok: true });

    const req = backend.registered.get(`\\Origami\\${id}`)!;
    expect(req.schedule).toEqual({ kind: 'hourly', every: 6 });
    // The launcher must be REGENERATED, or the task would keep running the old
    // prompt while the record showed the new one.
    expect(fs.readFileSync(path.join(root, '.origami', 'crons', `${id}.cmd`), 'utf8')).toContain('run "new prompt"');
    expect(loadCrons(root).crons[0].name).toBe('renamed');
  });

  it('editing a DISABLED cron does not register it — disabled means disabled', async () => {
    await svc.create(draft());
    const id = loadCrons(root).crons[0].id;
    await svc.setEnabled(id, false);
    backend.calls.length = 0;

    expect(await svc.update(id, draft({ prompt: 'edited while off' }))).toEqual({ ok: true });
    expect(backend.calls).toEqual([]);
    expect(backend.registered.size).toBe(0);
    expect(loadCrons(root).crons[0].prompt).toBe('edited while off');
  });

  it('Run now refuses a disabled cron rather than firing an unregistered task', async () => {
    await svc.create(draft());
    const id = loadCrons(root).crons[0].id;
    await svc.setEnabled(id, false);
    const res = await svc.runNow(id);
    expect(res.ok).toBe(false);
    expect(backend.calls).not.toContain(`runNow:\\Origami\\${id}`);
  });
});

describe('cronService — reconcile reports drift in BOTH directions and fixes neither', () => {
  const rec = (over: Partial<CronRecord> = {}): CronRecord => ({
    id: 'c1', name: 'nightly', prompt: 'p', schedule: { kind: 'daily', time: '09:30' },
    enabled: true, createdAt: 0, ...over,
  });

  it('an enabled cron with no OS task is reported as missing registration', () => {
    const drift = reconcileCrons([rec({ id: 'c1' })], []);
    expect(drift.missingRegistration).toEqual([{ id: 'c1', name: 'nightly', taskName: '\\Origami\\c1' }]);
    expect(drift.strayRegistration).toEqual([]);
  });

  it('an OS task with no cron here is reported as a stray, tagged unknown', () => {
    const drift = reconcileCrons([], ['\\Origami\\ghost']);
    expect(drift.strayRegistration).toEqual([{ taskName: '\\Origami\\ghost', reason: 'unknown' }]);
    expect(drift.missingRegistration).toEqual([]);
  });

  it('a DISABLED cron that is still registered is a stray too — it would fire anyway', () => {
    const drift = reconcileCrons([rec({ id: 'c1', enabled: false })], ['\\Origami\\c1']);
    expect(drift.strayRegistration).toEqual([{ taskName: '\\Origami\\c1', reason: 'disabled' }]);
    expect(drift.missingRegistration).toEqual([]);
  });

  it('reports both directions at once', () => {
    const drift = reconcileCrons([rec({ id: 'here' })], ['\\Origami\\ghost']);
    expect(drift.missingRegistration.map((m) => m.id)).toEqual(['here']);
    expect(drift.strayRegistration.map((s) => s.taskName)).toEqual(['\\Origami\\ghost']);
  });

  it('a matched, enabled pair is NOT drift', () => {
    expect(reconcileCrons([rec({ id: 'c1' })], ['\\Origami\\c1'], ['c1'])).toEqual({
      missingRegistration: [], strayRegistration: [], orphanScripts: [],
    });
  });

  it('list() surfaces real drift and REPAIRS NOTHING', async () => {
    // A cron in the file that the OS has never heard of — e.g. cloned from git
    // onto a fresh machine, which is the everyday case.
    saveCrons(root, [rec({ id: 'fromGit' })]);
    const payload = await svc.list();

    expect(payload.drift.missingRegistration.map((m) => m.id)).toEqual(['fromGit']);
    // The give-away that we did not "helpfully" fix it:
    expect(backend.calls).toEqual(['query']);
    expect(backend.registered.size).toBe(0);
    expect(loadCrons(root).crons).toHaveLength(1);
  });

  it('when the OS cannot be queried, drift is UNKNOWN rather than reported as clean', async () => {
    const broken = fakeBackend({ query: async () => ({ ok: false, error: 'schtasks not found' }) });
    const s = new CronService({ repoRoot: root, backend: broken, resolveBinary: () => 'x', now: () => 5000 });
    saveCrons(root, [rec({ id: 'c1' })]);
    const payload = await s.list();
    expect(payload.drift.error).toBe('schtasks not found');
    expect(payload.drift.missingRegistration).toEqual([]);
  });
});

describe('cronService — a platform with no scheduler refuses cleanly, never half-registers', () => {
  const offline: SchedulerBackend = {
    available: false,
    unavailableReason: 'OS-level crons are Windows-only for now (this is darwin).',
    register: async () => ({ ok: false, error: 'unavailable' }),
    unregister: async () => ({ ok: false, error: 'unavailable' }),
    runNow: async () => ({ ok: false, error: 'unavailable' }),
    query: async () => ({ ok: false, error: 'unavailable' }),
  };

  it('create is refused with the platform reason and writes nothing', async () => {
    const s = new CronService({ repoRoot: root, backend: offline, resolveBinary: () => 'x', now: () => 1 });
    const res = await s.create(draft());
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toMatch(/Windows-only/);
    expect(fs.existsSync(path.join(root, '.origami', 'crons.json'))).toBe(false);
  });

  it('list still shows the crons in the file, flagged unavailable, with no drift claim', async () => {
    const s = new CronService({ repoRoot: root, backend: offline, resolveBinary: () => 'x', now: () => 1 });
    saveCrons(root, [{ id: 'c1', name: 'n', prompt: 'p', schedule: { kind: 'daily', time: '09:30' }, enabled: true, createdAt: 0 }]);
    const payload = await s.list();
    expect(payload.crons).toHaveLength(1);
    expect(payload.backendAvailable).toBe(false);
    expect(payload.backendReason).toMatch(/Windows-only/);
    expect(payload.drift.missingRegistration).toEqual([]);
  });
});

describe('cronService — the pane payload', () => {
  it('computes an absolute next run for a daily cron', async () => {
    const s = new CronService({
      repoRoot: root, backend, resolveBinary: () => 'x',
      now: () => new Date(2026, 6, 29, 10, 0, 0).getTime(),
    });
    await s.create(draft());
    const payload = await s.list();
    expect(payload.crons[0].nextRunAt).toBe(new Date(2026, 6, 30, 9, 30, 0, 0).toISOString());
    expect(payload.crons[0].scheduleLabel).toBe('daily at 09:30');
  });

  it('a disabled cron advertises no next run', async () => {
    await svc.create(draft());
    const id = loadCrons(root).crons[0].id;
    await svc.setEnabled(id, false);
    expect((await svc.list()).crons[0].nextRunAt).toBeNull();
  });

  it('reports no last output until the log actually exists', async () => {
    await svc.create(draft());
    expect((await svc.list()).crons[0].lastOutputAt).toBeNull();
    const id = loadCrons(root).crons[0].id;
    fs.writeFileSync(path.join(root, '.origami', 'cron-logs', `${id}.log`), 'ran');
    expect((await svc.list()).crons[0].lastOutputAt).toBeGreaterThan(0);
  });
});
