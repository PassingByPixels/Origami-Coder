// CACHE HEALTH in the run index — the pure rule, and the column it draws.
//
// The failure this exists to stop is a confident 0%: a local provider reports
// no cache fields at all, and printing "0% cached" against those runs would
// send the reader hunting a caching bug that does not exist. The second is the
// small sample — flagging every three-turn chat as unhealthy would make the
// warning tone mean nothing on the runs where it does matter.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import LabyrinthPane from '../panes/LabyrinthPane.svelte';
import {
  HEALTHY_HIT_RATIO, MIN_REQUESTS_FOR_HEALTH, healthLabel, runCacheHealth,
} from '../components/labyrinthHealth';
import { runStatsPayload, statIds } from '../../../src/dashboard/runStats';

const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ');
const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const RUNS = [
  { sessionId: 'ses_a', title: 'Cached well', folder: 'f', cwd: 'C:/x', updatedAt: '2026-07-27T14:05:00.000Z' },
  { sessionId: 'ses_b', title: 'Cached badly', folder: 'f', cwd: 'C:/x', updatedAt: '2026-07-27T14:06:00.000Z' },
  { sessionId: 'ses_c', title: 'Local model', folder: 'f', cwd: 'C:/x', updatedAt: '2026-07-27T14:07:00.000Z' },
];

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('labyrinthHealth — it refuses to draw a rate it cannot stand behind', () => {
  const many = MIN_REQUESTS_FOR_HEALTH;

  it('reads the share of PREFILL served from cache', () => {
    const h = runCacheHealth({ requests: many, tokens: { input: 1_000, cacheRead: 9_000 } });
    expect(h.ratio).toBe(0.9);
    expect(h.warn).toBe(false);
    expect(healthLabel(h)).toBe('90%');
  });

  it('flags a session below the healthy share, and says what that share is', () => {
    expect(HEALTHY_HIT_RATIO).toBe(0.8);
    const h = runCacheHealth({ requests: many, tokens: { input: 700, cacheRead: 300 } });
    expect(h.warn).toBe(true);
    expect(healthLabel(h)).toBe('30%');
  });

  it('a provider that reported NO cache gets a dash, never 0%', () => {
    const h = runCacheHealth({ requests: many, tokens: { input: 900 } });
    expect(h.ratio).toBeUndefined();
    expect(h.warn).toBe(false);
    expect(healthLabel(h)).toBe('—');
  });

  it('a REPORTED zero is a measurement, and is flagged as the bad rate it is', () => {
    const h = runCacheHealth({ requests: many, tokens: { input: 900, cacheRead: 0 } });
    expect(h.ratio).toBe(0);
    expect(h.warn).toBe(true);
    expect(healthLabel(h)).toBe('0%');
  });

  it('too few requests means no rate at all — a short chat is mostly its first turn', () => {
    const h = runCacheHealth({ requests: MIN_REQUESTS_FOR_HEALTH - 1, tokens: { input: 900, cacheRead: 0 } });
    expect(h.ratio).toBeUndefined();
    expect(h.warn).toBe(false);
  });

  it('survives a missing row, a missing bag and a run with no prefill at all', () => {
    expect(runCacheHealth(undefined)).toEqual({ warn: false });
    expect(runCacheHealth({ requests: many })).toEqual({ warn: false });
    expect(runCacheHealth({ requests: many, tokens: { input: 0, cacheRead: 0 } })).toEqual({ warn: false });
  });
});

describe('runStats host leaf — one batched read, and never a rejected promise', () => {
  it('de-duplicates and drops blanks before spending a read on them', () => {
    expect(statIds(['a', 'a', '', 'b', 7, null])).toEqual(['a', 'b']);
    expect(statIds(undefined)).toEqual([]);
  });

  it('answers an EMPTY id list without a round trip — nothing to count is not an error', async () => {
    let called = 0;
    const client = { getRunStats: async () => { called++; return { stats: [], truncated: false, requested: 0 }; } };
    expect(await runStatsPayload(client, [])).toEqual({ stats: [], truncated: false });
    expect(called).toBe(0);
  });

  it('asks ONCE for the whole page, and passes the cap through', async () => {
    const seen: string[][] = [];
    const client = {
      getRunStats: async (ids: string[]) => { seen.push(ids); return { stats: [{ sessionId: 'a' }], truncated: true, requested: 40 }; },
    };
    const payload = await runStatsPayload(client, ['a', 'b', 'a']);
    expect(seen).toEqual([['a', 'b']]);
    expect(payload.truncated).toBe(true);
    expect(payload.stats).toEqual([{ sessionId: 'a' }]);
  });

  it('a malformed row is dropped rather than trusted', async () => {
    const client = {
      getRunStats: async () => ({ stats: [{ sessionId: 'a' }, null, { sessionId: 7 }, {}] as never, truncated: false, requested: 1 }),
    };
    expect((await runStatsPayload(client, ['a'])).stats).toEqual([{ sessionId: 'a' }]);
  });

  it('a failure becomes an error FIELD — the panel still has to draw something', async () => {
    const client = { getRunStats: async () => { throw new Error('engine gone'); } };
    expect(await runStatsPayload(client, ['a'])).toEqual({ stats: [], truncated: false, error: 'engine gone' });
    const none = await runStatsPayload(null, ['a']);
    expect(none.error).toContain('Open a chat first');
  });
});

describe('Labyrinth run index — the cache column', () => {
  async function withStats(stats: unknown[]) {
    const rendered = render(LabyrinthPane);
    send({ type: 'historyList', sessions: RUNS });
    await tick();
    send({ type: 'runStatsData', stats, truncated: false });
    await tick();
    return rendered;
  }

  it('asks the host for the listed page ONCE, by id', async () => {
    render(LabyrinthPane);
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    send({ type: 'historyList', sessions: RUNS });
    await tick();

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'requestRunStats', sessionIds: ['ses_a', 'ses_b', 'ses_c'],
    });
  });

  it('draws a rate per run, flags the unhealthy one, and dashes the unmeasured one', async () => {
    const { container } = await withStats([
      { sessionId: 'ses_a', requests: 40, tokens: { input: 1_000, output: 10, cacheRead: 9_000 } },
      { sessionId: 'ses_b', requests: 40, tokens: { input: 7_000, output: 10, cacheRead: 3_000 } },
      { sessionId: 'ses_c', requests: 40, tokens: { input: 5_000, output: 10 } },
    ]);

    const cells = Array.from(container.querySelectorAll('.lab-health'));
    expect(cells.map((c) => flat(c.textContent))).toEqual(['cache 90%', 'cache 30%', 'cache —']);
    // The tone is not the only signal — the number says it too — but the tone
    // is what carries at a glance, so exactly the bad one must carry it.
    expect(cells.map((c) => c.classList.contains('warn'))).toEqual([false, true, false]);
  });

  it('a run the stats never covered gets NO cell — not a 0%, and not a dash', async () => {
    const { container } = await withStats([
      { sessionId: 'ses_a', requests: 40, tokens: { input: 1_000, output: 10, cacheRead: 9_000 } },
    ]);
    expect(container.querySelectorAll('.lab-health')).toHaveLength(1);
    expect(flat(container.textContent)).not.toContain('cache 0%');
  });

  it('before the stats land, the index draws no cache cells at all', async () => {
    const { container } = render(LabyrinthPane);
    send({ type: 'historyList', sessions: RUNS });
    await tick();
    expect(container.querySelectorAll('.lab-health')).toHaveLength(0);
    // ...and the runs themselves are listed regardless, so a stats read that
    // never answers costs the index a column, never the index.
    expect(container.querySelectorAll('.lab-run')).toHaveLength(3);
  });

  it('the column survives a stats reply that arrived malformed', async () => {
    const { container } = await withStats([null, { sessionId: '' }, { sessionId: 'ses_a', requests: 40 }]);
    expect(container.querySelectorAll('.lab-health')).toHaveLength(1);
    expect(flat(container.querySelector('.lab-health')!.textContent)).toBe('cache —');
  });

  it('picking a run still works with the column on it', async () => {
    const { container } = await withStats([{ sessionId: 'ses_b', requests: 40, tokens: { input: 1, output: 1, cacheRead: 99 } }]);
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(container.querySelectorAll('.lab-run')[1]!);

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'requestRunSteps', sessionId: 'ses_b', cwd: 'C:/x',
    });
  });
});
