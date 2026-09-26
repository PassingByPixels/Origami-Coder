// elasticWarmWake.test.ts — t-z6ytkw: a cache warm across a park (src/elastic/warmWake.ts, parkHost.ts, park.ts).
// A fake engine speaks the wire of engine acp/elastic.ts: `_elastic_park` hands its armed warm over
// (`warms: [{sessionId, dueAt}]`), `_elastic_warm` sends it. The real EngineGate, parkChat and ParkHost run on a
// fake clock. That the warm's bytes equal the live engine's is the engine test park-warm-bytes.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { EngineGate } from '../../../src/dashboard/engineGate';
import { ParkHost } from '../../../src/elastic/parkHost';
import { WAKE_LEAD_MS } from '../../../src/elastic/warmWake';

const MIN = 60_000;

/** A chat whose engine has a cache warm armed `dueIn` ms from now (the 1-hour cache: 48 min). */
function chat(dueIn: number | null) {
  const calls: string[] = [];
  let armedAt: number | null = dueIn === null ? null : Date.now() + dueIn;
  const client = {
    currentSessionId: 'ses_a' as string | null,
    pid: 100 as number | undefined,
    wake: null as (() => Promise<void>) | null,
    sets: new Map<string, string>(),
    async park() { calls.push('stop'); this.pid = undefined; },
    async restore() { calls.push('restore'); this.pid = 101; return true; },
    async stopStart() { this.pid = undefined; },
    async extMethod(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
      calls.push(method);
      if (method === '_elastic_park') {
        // The engine hands the armed warm over; a woken engine that sent it has none (one per real request).
        const warms = armedAt === null ? [] : [{ sessionId: 'ses_a', dueAt: armedAt }];
        armedAt = null;
        return { parked: true, sessionIds: ['ses_a'], ...(warms.length ? { warms } : {}) };
      }
      if (method === '_elastic_warm') return params?.['sessionId'] === 'ses_a' ? { warmed: true, cacheRead: 1234 } : { warmed: false, reason: 'no warm was handed over' };
      return {};
    },
    async setConfigOption() { /* nothing to set again */ },
    getModelOption: () => null,
    getEffortOption: () => null,
    getModeOption: () => null,
  };
  const gate = new EngineGate(() => undefined);
  return { id: 'session-1', client, gate, calls, count: (m: string) => calls.filter((c) => c === m).length };
}

let log: string[];
let warming: boolean;

async function parked(dueIn: number | null) {
  const c = chat(dueIn);
  await c.gate.start(async () => undefined);
  const host = new ParkHost({ sessions: () => [c as never], log: (l) => void log.push(l), warming: () => warming, watch: () => ({ dispose() {} }), mail: () => false });
  expect(await host.park('session-1')).toBeNull();
  expect(c.gate.current).toBe('parked');
  return { c, host };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  log = [];
  warming = true;
});
afterEach(() => vi.useRealTimers());

describe('a parked chat is woken to warm its cache, then parked again', () => {
  it('wakes in the background just before the warm is due, warms once, parks again, and stops there', async () => {
    const { c } = await parked(48 * MIN);
    await vi.advanceTimersByTimeAsync(48 * MIN - WAKE_LEAD_MS - 1_000);
    expect(c.count('restore')).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(c.calls.slice(c.calls.indexOf('restore'))).toEqual(['restore', '_elastic_warm', '_elastic_park', 'stop']);
    expect(c.gate.current).toBe('parked');
    const lines = log.filter((l) => /woken to warm|warmed|parked again/.test(l));
    expect(lines.map((l) => l.replace(/^.*: /, ''))).toEqual(['woken to warm', 'warmed, cache read 1234 tokens', 'parked again']);
    // One warm per handed-over schedule, as the live engine sends one per real request.
    await vi.advanceTimersByTimeAsync(10 * 60 * MIN);
    expect(c.count('_elastic_warm')).toBe(1);
    expect(c.count('restore')).toBe(1);
  });

  it('no warm handed over (it fired before the park): never woken', async () => {
    const { c } = await parked(null);
    await vi.advanceTimersByTimeAsync(10 * 60 * MIN);
    expect(c.count('restore')).toBe(0);
  });

  it('warming turned off before the warm is due: not woken', async () => {
    const { c } = await parked(48 * MIN);
    warming = false;
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(c.count('restore')).toBe(0);
    expect(c.count('_elastic_warm')).toBe(0);
    expect(log.some((l) => /not woken to warm \(cache warming is off\)/.test(l))).toBe(true);
  });

  it('warming off at the park: no wake is armed at all', async () => {
    warming = false;
    const { c, host } = await parked(48 * MIN);
    expect(host.warmWake.armed).toBe(0);
    warming = true;
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(c.count('restore')).toBe(0);
  });

  it('the chat closed: not woken', async () => {
    const { c, host } = await parked(48 * MIN);
    host.closed(c as never);
    c.client.currentSessionId = null; // client.dispose()
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(c.count('restore')).toBe(0);
  });

  it('the user took the chat up before the warm was due: no background warm (its engine warms by itself)', async () => {
    const { c } = await parked(48 * MIN);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await c.gate.whenUp(); // a message or focus restored it
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(c.count('restore')).toBe(1);
    expect(c.count('_elastic_warm')).toBe(0);
  });

  it('a warm due within the wake lead is woken for at once', async () => {
    const { c } = await parked(30_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.count('_elastic_warm')).toBe(1);
  });
});
