// The sampling pass, and the one message it answers.
//
// NO LIVE CALLS. The engine client and the Claude reader are stubs throughout.
// Following providerUsage.test.ts's contract: the webview must get exactly one
// `glidepathData` per `glidepathRequest`, on every path — with no engine, with a
// refusing provider, with a provider that throws. Silence would leave the view
// spinning, and none of the paths below may produce it.
//
// The second contract is the one that keeps this from being a poller: the
// 5-minute per-provider floor, and one provider's failure not costing another
// its sample.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_PLAN_ID,
  GLIDEPATH_MESSAGE_TYPES,
  PROVIDER_FLOOR_MS,
  __resetUsageSamplingForTests,
  handleGlidepathMessage,
  sampleUsage,
  type UsageHistoryHost,
} from '../../../src/dashboard/usageHistory';
import type { UsageHistoryStore } from '../../../src/dashboard/usageHistoryStore';

const T0 = 1_786_874_400_000;
const WEEK = 7 * 86_400_000;

interface Rig {
  host: UsageHistoryHost;
  posted: Record<string, unknown>[];
  written: UsageHistoryStore[];
  extMethod: ReturnType<typeof vi.fn>;
  setNow(t: number): void;
}

function rig(over: Partial<UsageHistoryHost> = {}, answers: Record<string, unknown> = {}): Rig {
  const posted: Record<string, unknown>[] = [];
  const written: UsageHistoryStore[] = [];
  let stored: unknown;
  let clock = T0;
  const extMethod = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
    const id = String(params?.providerID ?? '');
    const answer = answers[id];
    if (answer instanceof Error) throw answer;
    return (answer ?? { ok: false, unavailable: 'Not signed in.' }) as Record<string, unknown>;
  });
  const host: UsageHistoryHost = {
    client: { extMethod },
    post: (m) => posted.push(m),
    read: () => stored,
    write: (next) => { stored = next; written.push(next); },
    now: () => clock,
    capableIds: async () => ['openai'],
    planWindows: async () => [],
    ...over,
  };
  return { host, posted, written, extMethod, setNow: (t) => { clock = t; } };
}

const weekly = (pct: number) => ({ ok: true, windows: [{ label: 'Weekly', usedPercent: pct, resetsAt: T0 + WEEK }] });

beforeEach(() => __resetUsageSamplingForTests());

describe('the message contract', () => {
  it('answers glidepathRequest with exactly one glidepathData', async () => {
    const r = rig({}, { openai: weekly(12) });
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]!.type).toBe('glidepathData');
    expect(r.posted[0]!.now).toBe(T0);
    expect(r.posted[0]!.capable).toEqual(['openai']);
    expect(r.posted[0]!.providers).toEqual({
      openai: { windows: { Weekly: { resetsAt: T0 + WEEK, samples: [{ t: T0, pct: 12 }] } } },
    });
  });

  it('ignores a message that is not its own', async () => {
    const r = rig();
    await handleGlidepathMessage(r.host, { type: 'somethingElse' });
    expect(r.posted).toEqual([]);
    expect(GLIDEPATH_MESSAGE_TYPES.has('glidepathRequest')).toBe(true);
    expect(GLIDEPATH_MESSAGE_TYPES.has('providerUsageRequest')).toBe(false);
  });

  it('still answers when there is NO engine, with whatever was recorded before', async () => {
    // With no chat open there is nothing to ask. The view must still draw the
    // history rather than wait for a reply that is not coming.
    const r = rig({ client: undefined });
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]!.providers).toEqual({});
  });

  it('answers even when the capability read itself fails', async () => {
    const r = rig({ capableIds: async () => { throw new Error('no config'); } });
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]!.capable).toEqual([]);
  });
});

describe('one provider failing costs only that provider its sample', () => {
  it('records the good ones when another refuses and another throws', async () => {
    const r = rig(
      { capableIds: async () => ['openai', 'xai', 'github-copilot'] },
      {
        openai: weekly(12),
        xai: { ok: false, unavailable: 'Not signed in to Grok.' },
        'github-copilot': new Error('socket hang up'),
      },
    );
    const { store } = await sampleUsage(r.host);
    expect(Object.keys(store.providers)).toEqual(['openai']);
    expect(r.extMethod).toHaveBeenCalledTimes(3);
  });

  it('records the Claude passthrough beside the engine connections', async () => {
    const r = rig(
      {
        capableIds: async () => ['openai', CLAUDE_PLAN_ID],
        planWindows: async () => [
          { label: '5h', usedPercent: 22, resetsAt: T0 + 3_600_000 },
          { label: '7d', usedPercent: 4, resetsAt: T0 + WEEK },
        ],
      },
      { openai: weekly(12) },
    );
    const { store } = await sampleUsage(r.host);
    expect(Object.keys(store.providers).sort()).toEqual(['claude-code', 'openai']);
    expect(Object.keys(store.providers[CLAUDE_PLAN_ID]!.windows)).toEqual(['5h', '7d']);
  });

  it('a provider that answers nothing is not written as an empty window', async () => {
    const r = rig({}, { openai: { ok: true, windows: [] } });
    const { store } = await sampleUsage(r.host);
    expect(store.providers).toEqual({});
    expect(r.written).toEqual([]);
  });
});

describe('the 5-minute per-provider floor', () => {
  it('does not ask twice inside the floor, however many triggers fire', async () => {
    // Panel-created, view-opened and the timer can all land in the same minute.
    const r = rig({}, { openai: weekly(12) });
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    r.setNow(T0 + PROVIDER_FLOOR_MS - 1);
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    expect(r.extMethod).toHaveBeenCalledTimes(1);
    // And it still answers the second request, from the stored history.
    expect(r.posted).toHaveLength(2);
  });

  it('asks again once the floor has passed', async () => {
    const r = rig({}, { openai: weekly(12) });
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    r.setNow(T0 + PROVIDER_FLOOR_MS);
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    expect(r.extMethod).toHaveBeenCalledTimes(2);
  });

  it('a REFUSAL costs the floor too, so a broken connection is not hammered', async () => {
    const r = rig({}, { openai: { ok: false, unavailable: 'Not signed in.' } });
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    r.setNow(T0 + PROVIDER_FLOOR_MS - 1);
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    expect(r.extMethod).toHaveBeenCalledTimes(1);
  });
});

describe('persistence', () => {
  it('writes only when something was actually recorded', async () => {
    const r = rig({}, { openai: weekly(12) });
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    expect(r.written).toHaveLength(1);
    // Inside the floor nothing is read, so nothing is written.
    r.setNow(T0 + 60_000);
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    expect(r.written).toHaveLength(1);
  });

  it('grows one window across passes rather than replacing it', async () => {
    const r = rig({}, { openai: weekly(12) });
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    r.setNow(T0 + PROVIDER_FLOOR_MS);
    await handleGlidepathMessage(r.host, { type: 'glidepathRequest' });
    const windows = (r.posted[1]!.providers as UsageHistoryStore['providers']).openai!.windows;
    expect(windows['Weekly']!.samples).toHaveLength(2);
  });
});
