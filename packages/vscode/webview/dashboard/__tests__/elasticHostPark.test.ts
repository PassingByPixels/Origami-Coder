// elasticHostPark.test.ts — t-wdyi2t (review_extension-lifecycle.md #5, lead decision 2026-09-25): the window's
// host engine is stopped after 10 min with no host call and no work, and started again by the next host read.
// The REAL HostEngine (src/dashboard/hostEngine.ts) and the real stop (src/elastic/hostPark.ts) over fake
// engine clients. The bugs each test catches:
//   - a host engine that runs for the rest of the window once a timer started it (it never parked);
//   - a stop that ignores the engine's own last check (the flock lease, a collab run);
//   - a stop that kills a host call made while the park was asked, or leaves the engine half-parked;
//   - a stopped host engine that is never started again, or peer stand-ins left for an engine that is gone.
import { describe, expect, it, vi } from 'vitest';
import { QUIET } from '../../../src/elastic/activityClass';
import { HostEngine, type HostClient } from '../../../src/dashboard/hostEngine';
import { HOST_PARK_AFTER_MS, parkHostEngine } from '../../../src/elastic/hostPark';
import { engineViews } from '../../../src/elastic/sessionSignals';

type Reply = Record<string, unknown> | Error;

class FakeHostClient implements HostClient {
  public calls: string[] = [];
  public disposed = 0;
  public lastExtAt = 0;
  public replies: Record<string, Reply> = { _elastic_park: { parked: true, sessionIds: ['ses_collab'] }, _elastic_unpark: { unparked: true, delivered: 0 } };
  /** Runs while `_elastic_park` is out: a host call arriving in that window. */
  public duringPark: (() => void) | null = null;
  async connect(): Promise<void> { /* connected */ }
  async extMethod(method: string): Promise<Record<string, unknown>> {
    this.calls.push(method);
    if (!method.startsWith('_elastic_')) this.lastExtAt = Date.now();
    if (method === '_elastic_park') this.duringPark?.();
    const r = this.replies[method] ?? {};
    if (r instanceof Error) throw r;
    return r;
  }
  dispose(): void { this.disposed++; }
}

async function running() {
  const made: FakeHostClient[] = [];
  const host = new HostEngine<FakeHostClient>({ make: () => { const c = new FakeHostClient(); made.push(c); return c; }, cwd: () => 'C:/work', log: () => undefined });
  await host.ensureOwn();
  return { host, made, client: made[0]! };
}

const missing = () => Object.assign(new Error('Method not found'), { code: -32601 });

describe('the host engine is stopped when idle, and started again by the next host read', () => {
  it('asks the engine first, then stops it; its peer stand-ins go with it; the next read starts a new one', async () => {
    const { host, made, client } = await running();
    const removed: string[] = [];
    expect(await parkHostEngine(host, { log: () => undefined, removeStandIn: (sid) => void removed.push(sid) })).toBeNull();
    expect(client.calls).toEqual(['_elastic_park']);
    expect(client.disposed).toBe(1);
    expect(host.ownClient()).toBeUndefined();
    expect(removed).toEqual(['ses_collab']); // a stopped host engine is not addressable (as after a window close)
    const next = await host.ensure();
    expect(made.length).toBe(2);
    expect(next).toBe(made[1]);
  });

  it('is not stopped when the engine refuses (the flock lease, a collab run): the engine\'s own last check wins', async () => {
    const { host, client } = await running();
    client.replies['_elastic_park'] = { parked: false, reasons: ['flock-lease'] };
    expect(await parkHostEngine(host, { log: () => undefined })).toMatch(/flock-lease/);
    expect(client.disposed).toBe(0);
    expect(host.ownClient()).toBe(client);
  });

  it('a host call made while the park was asked keeps it up, and it is unparked', async () => {
    const { host, client } = await running();
    client.duringPark = () => { void client.extMethod('usage_sample'); };
    expect(await parkHostEngine(host, { log: () => undefined })).toMatch(/used/);
    expect(client.calls).toEqual(['_elastic_park', 'usage_sample', '_elastic_unpark']);
    expect(client.disposed).toBe(0);
    expect(host.ownClient()).toBe(client);
  });

  it('an ask that failed keeps it up (unparked); if the unpark fails too it is stopped, and the next read starts a new one', async () => {
    const { host, client } = await running();
    client.replies['_elastic_park'] = new Error('broken pipe');
    expect(await parkHostEngine(host, { log: () => undefined })).toMatch(/did not answer/);
    expect(client.calls.at(-1)).toBe('_elastic_unpark');
    expect(client.disposed).toBe(0);
    client.replies['_elastic_unpark'] = missing();
    await parkHostEngine(host, { log: () => undefined });
    expect(client.disposed).toBe(1);
    expect(host.ownClient()).toBeUndefined();
  });

  it('an engine older than _elastic_park is stopped all the same; no host engine = nothing to do', async () => {
    const { host, client } = await running();
    client.replies['_elastic_park'] = missing();
    expect(await parkHostEngine(host, { log: () => undefined })).toBeNull();
    expect(client.disposed).toBe(1);
    expect(await parkHostEngine(host, { log: () => undefined })).toBe('no host engine');
  });

  it('the host engine view carries the park hook and the 10 min delay (lead decision)', () => {
    const c = new FakeHostClient();
    const park = vi.fn(async () => null);
    const views = engineViews(null, { sidebarVisible: () => false, phoneFocus: () => null, engineBusy: () => false }, c, park);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ label: 'host engine', parkAfterMs: HOST_PARK_AFTER_MS, signals: { ...QUIET, lastActivityAt: 0 } });
    void views[0]!.park!();
    expect(park).toHaveBeenCalledTimes(1);
    expect(HOST_PARK_AFTER_MS).toBe(10 * 60_000);
  });

  it('a chat view carries parkSoon for a finished fold (sessionSignals reads the panel)', () => {
    const s = { id: 'session-1', client: new FakeHostClient(), gate: { current: 'ready' }, pendingPermissions: { size: 0 }, runningChildren: { size: 0 } };
    const panel = { sessions: () => [s], activeId: () => null, grid: () => false, solo: () => undefined, question: () => false, park: async () => null, parkSoon: (id: string) => id === 'session-1' };
    const [v] = engineViews(panel, { sidebarVisible: () => false, phoneFocus: () => null, engineBusy: () => false }, undefined);
    expect(v?.parkSoon).toBe(true);
  });
});
