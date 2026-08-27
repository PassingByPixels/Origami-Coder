// providerProbe — the fan-out that broadcastProviderStatus runs its per-provider
// liveness probes through. Three properties, and the picker's open lag is the
// first one: the probes must run AT THE SAME TIME, one bad provider must cost
// only itself, and one hung provider must not hold the batch open.
//
// The concurrency assertion is a live counter, not a stopwatch: each fake probe
// records how many were in flight when it started, so "parallel" is proved by
// observation (max in flight == N) instead of by a timing margin that a loaded
// CI box can flake on. The wall-clock check is kept as a second, independent
// witness with a wide margin.

import { describe, expect, it } from 'vitest';
import { probeConcurrently, PROVIDER_PROBE_TIMEOUT_MS } from '../../../src/dashboard/providerProbe';

/** A probe set that reports the peak number of simultaneous in-flight calls. */
function tracker() {
  let inFlight = 0;
  let peak = 0;
  return {
    get peak() { return peak; },
    /** Wrap a probe body so entry/exit is counted. */
    wrap<T, R>(body: (item: T) => Promise<R>) {
      return async (item: T): Promise<R> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try { return await body(item); }
        finally { inFlight -= 1; }
      };
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('probeConcurrently — the providers probe together, not in turn', () => {
  it('runs EVERY probe at the same time (the picker-open lag: sum of latencies -> the slowest one)', async () => {
    const t = tracker();
    const items = ['lmstudio', 'vllm', 'spark2', 'openrouter'];

    const started = Date.now();
    const out = await probeConcurrently(
      items,
      t.wrap(async (id: string) => { await sleep(40); return `${id}:live`; }),
      (id: string, reason: string) => `${id}:${reason}`,
      PROVIDER_PROBE_TIMEOUT_MS,
    );
    const elapsed = Date.now() - started;

    // The property that matters: all four were mid-probe simultaneously. The old
    // `for` loop would peak at 1, however fast each probe was.
    expect(t.peak).toBe(items.length);
    // Second witness, generously bounded: four 40ms probes cost ~40ms in
    // parallel and ~160ms in series. Anything under 160 cannot be sequential.
    expect(elapsed).toBeLessThan(160);
    expect(out).toEqual(['lmstudio:live', 'vllm:live', 'spark2:live', 'openrouter:live']);
  });

  it('keeps input order even when the probes settle out of order', async () => {
    // The order the panel builds its rows in is the order origami.json lists the
    // providers, so the tab bar must not re-order itself by who answered first.
    const out = await probeConcurrently(
      [30, 5, 20],
      async (ms: number) => { await sleep(ms); return ms; },
      (ms: number) => ms,
      PROVIDER_PROBE_TIMEOUT_MS,
    );
    expect(out).toEqual([30, 5, 20]);
  });

  it('a REJECTING probe costs only its own entry — the neighbours keep their real answers', async () => {
    const out = await probeConcurrently(
      ['good', 'bad', 'alsogood'],
      async (id: string) => {
        if (id === 'bad') throw new Error('ECONNREFUSED');
        return `${id}:live`;
      },
      (id: string, reason: string) => `${id}:down(${reason})`,
      PROVIDER_PROBE_TIMEOUT_MS,
    );
    expect(out).toEqual(['good:live', 'bad:down(ECONNREFUSED)', 'alsogood:live']);
  });

  it('a probe that NEVER settles cannot hold the batch open past the bound', async () => {
    const t = tracker();
    const started = Date.now();
    const out = await probeConcurrently(
      ['hung', 'fine'],
      t.wrap(async (id: string) => {
        if (id === 'hung') return await new Promise<string>(() => { /* never settles */ });
        return `${id}:live`;
      }),
      (id: string, reason: string) => `${id}:down(${reason})`,
      30,
    );
    const elapsed = Date.now() - started;

    expect(out[1]).toBe('fine:live');
    expect(out[0]).toMatch(/^hung:down\(probe timed out after 30ms\)$/);
    // Bounded, not hung: without the race this test would never finish.
    expect(elapsed).toBeLessThan(1000);
    expect(t.peak).toBe(2);
  });

  it('an empty provider list resolves immediately to an empty array (a fresh install still gets its post)', async () => {
    await expect(
      probeConcurrently([], async () => 'never', () => 'never', PROVIDER_PROBE_TIMEOUT_MS),
    ).resolves.toEqual([]);
  });

  it('the bound is a ceiling, not a latency target — a slow-but-real probe is NOT cut short', async () => {
    // A provider answering after 50ms under a 10s ceiling must return its own
    // answer. A bound that reported merely-slow servers as down would be worse
    // than the lag it replaced.
    const out = await probeConcurrently(
      ['slow'],
      async (id: string) => { await sleep(50); return `${id}:live`; },
      (id: string) => `${id}:down`,
      PROVIDER_PROBE_TIMEOUT_MS,
    );
    expect(out).toEqual(['slow:live']);
    expect(PROVIDER_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(8000);
  });
});
