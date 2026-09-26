// elasticParkDefaults.test.ts — t-ze0hwh: the park defaults went from 60 (timed) and 120 (untimed) minutes
// to 20. A stored value equal to an OLD default (the settings UI writes the shown default) moves to 20 once,
// at every scope where it is set; any other value the user chose stays; an unset scope stays unset.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    // key -> inspect() result, per resource ('' = no resource)
    inspect: {} as Record<string, Record<string, Record<string, unknown>>>,
    writes: [] as Array<[string, string, unknown, number]>,
    folders: [] as Array<{ uri: { fsPath: string } }>,
  },
}));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() { return fake.folders; },
    getConfiguration: (section: string, resource?: { fsPath: string }) => ({
      inspect: (key: string) => fake.inspect[resource?.fsPath ?? '']?.[`${section}.${key}`],
      update: (key: string, value: unknown, target: number) => {
        fake.writes.push([resource?.fsPath ?? '', `${section}.${key}`, value, target]);
        return Promise.resolve();
      },
    }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));

import { migrateParkDefaults, vscodeParkScopes, type ParkScope } from '../../../src/elastic/parkDefaults';

/** One scope over a plain map, the way a settings file holds it. */
function scope(label: string, values: Record<string, unknown>, fail = false): ParkScope & { values: Record<string, unknown> } {
  return {
    label, values,
    value: (key) => values[key],
    write: async (key, v) => { if (fail) throw new Error('settings file is read-only'); values[key] = v; },
  };
}
function marker(done?: boolean) {
  const m = { done, get: () => m.done, set: (v: boolean) => { m.done = v; } };
  return m;
}
const log: string[] = [];
beforeEach(() => { log.length = 0; fake.inspect = {}; fake.writes = []; fake.folders = []; });

describe('migrateParkDefaults', () => {
  it('moves a stored old default (60 timed, 120 untimed) to 20 at every scope where it is set', async () => {
    const user = scope('user', { parkAfterMinutes: 60, parkUntimedAfterMinutes: 120 });
    const ws = scope('workspace', { parkAfterMinutes: 60 });
    await migrateParkDefaults(marker(), [user, ws], (l) => log.push(l));
    expect(user.values).toEqual({ parkAfterMinutes: 20, parkUntimedAfterMinutes: 20 });
    expect(ws.values).toEqual({ parkAfterMinutes: 20 });
    expect(log.join('\n')).toContain('parkAfterMinutes 60 -> 20 (user)');
  });

  it('keeps any value the user chose, including the OTHER key\'s old default (120 timed / 60 untimed)', async () => {
    const user = scope('user', { parkAfterMinutes: 45, parkUntimedAfterMinutes: 90 });
    const ws = scope('workspace', { parkAfterMinutes: 120, parkUntimedAfterMinutes: 60 });
    const off = scope('folder', { parkAfterMinutes: 0 });
    await migrateParkDefaults(marker(), [user, ws, off], () => {});
    expect(user.values).toEqual({ parkAfterMinutes: 45, parkUntimedAfterMinutes: 90 });
    expect(ws.values).toEqual({ parkAfterMinutes: 120, parkUntimedAfterMinutes: 60 });
    expect(off.values).toEqual({ parkAfterMinutes: 0 });
  });

  it('leaves an unset scope unset: nothing is written where nothing was stored', async () => {
    const user = scope('user', {});
    await migrateParkDefaults(marker(), [user], () => {});
    expect(user.values).toEqual({});
    expect('parkAfterMinutes' in user.values).toBe(false);
  });

  it('runs once: the marker is set after a pass, and a set marker skips the pass (a later 60 is the user\'s)', async () => {
    const m = marker();
    await migrateParkDefaults(m, [scope('user', {})], () => {});
    expect(m.done).toBe(true);
    const later = scope('user', { parkAfterMinutes: 60 });
    await migrateParkDefaults(m, [later], () => {});
    expect(later.values).toEqual({ parkAfterMinutes: 60 });
  });

  it('a failed write does not throw, logs, and leaves the marker unset so the next start tries again', async () => {
    const m = marker();
    const ro = scope('workspace', { parkAfterMinutes: 60 }, true);
    const user = scope('user', { parkUntimedAfterMinutes: 120 });
    await expect(migrateParkDefaults(m, [ro, user], (l) => log.push(l))).resolves.toBeDefined();
    expect(m.done).toBeUndefined();
    expect(user.values).toEqual({ parkUntimedAfterMinutes: 20 }); // one bad scope does not stop the others
    expect(log.join('\n')).toContain('read-only');
  });
});

describe('vscodeParkScopes — the scopes VS Code holds', () => {
  it('reads the global and the workspace value and writes each back to its own target', async () => {
    fake.inspect[''] = {
      'origamicoder.elastic.parkAfterMinutes': { defaultValue: 20, globalValue: 60, workspaceValue: 30 },
      'origamicoder.elastic.parkUntimedAfterMinutes': { defaultValue: 20, workspaceValue: 120 },
    };
    const m = marker();
    await migrateParkDefaults(m, vscodeParkScopes(), () => {});
    expect(fake.writes).toEqual([
      ['', 'origamicoder.elastic.parkAfterMinutes', 20, 1],
      ['', 'origamicoder.elastic.parkUntimedAfterMinutes', 20, 2],
    ]);
    expect(m.done).toBe(true);
  });

  it('never writes a workspace-folder target: the keys are window-scoped, VS Code throws on that write and ignores the value', async () => {
    fake.folders = [{ uri: { fsPath: '/a' } }];
    fake.inspect['/a'] = { 'origamicoder.elastic.parkAfterMinutes': { defaultValue: 20, workspaceFolderValue: 60 } };
    const m = marker();
    await migrateParkDefaults(m, vscodeParkScopes(), () => {});
    expect(fake.writes.filter((w) => w[3] === 3)).toEqual([]);
    expect(m.done).toBe(true); // so the pass is not tried again on every start
  });

  it('a default value alone (nothing stored) is never written', async () => {
    fake.inspect[''] = { 'origamicoder.elastic.parkAfterMinutes': { defaultValue: 60 } };
    await migrateParkDefaults(marker(), vscodeParkScopes(), () => {});
    expect(fake.writes).toEqual([]);
  });
});
