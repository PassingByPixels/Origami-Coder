// gatewayEntitledCache.test.ts — a model the gateway ADDS must reach the picker
// without a window reload (t-ttmo5w, src/dashboard/gatewayEntitledCache.ts).
//
// The defect (owner, 2026-09-23): a new OpenCode model showed only after a full
// VS Code reload. The picker's OpenCode Zen/Go rows are this cache's answer, and
// its only expiry was a six-hour full sweep, so for six hours the panel kept
// serving the list it swept first; a reload made a new panel with an empty cache.
//
// The fixture is a fake OpenAI-compatible gateway: GET /models is the menu,
// POST /chat/completions is the per-id entitlement probe (gatewayEntitlements.ts).

import { describe, expect, it } from 'vitest';
import { GatewayEntitledCache } from '../../../src/dashboard/gatewayEntitledCache';

const BASE = 'https://opencode.ai/zen/v1';
const KEY = 'sk-test';
const FIVE_MINUTES = 5 * 60_000;

function fakeGateway(initial: string[]) {
  const gw = {
    catalog: [...initial], refused: new Set<string>(), up: true, gets: 0, probes: [] as string[],
    /** When set, GET /models answers only once this resolves (a slow gateway). */
    gate: undefined as Promise<void> | undefined,
  };
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (!gw.up) throw new Error('offline');
    if (u === `${BASE}/models`) {
      gw.gets++;
      const menu = [...gw.catalog]; // the menu as it was when the request left
      if (gw.gate) await gw.gate;
      return { ok: true, status: 200, json: async () => ({ object: 'list', data: menu.map((id) => ({ id })) }) } as Response;
    }
    const model = JSON.parse(String(init?.body)).model as string;
    gw.probes.push(model);
    const s = gw.refused.has(model) ? 401 : 200;
    return { ok: s === 200, status: s } as Response;
  }) as unknown as typeof fetch;
  return { gw, fetchImpl };
}

function setup(initial: string[]) {
  const { gw, fetchImpl } = fakeGateway(initial);
  let clock = 1_000_000;
  let landed = 0;
  const cache = new GatewayEntitledCache({ fetch: fetchImpl, sessionId: 's', now: () => clock, onLanded: () => landed++ });
  /** What the picker shows after one open: the answer, once any sweep it started has landed. */
  const open = async () => {
    await cache.served(BASE, KEY);
    await cache.idle();
    return cache.served(BASE, KEY);
  };
  return { gw, cache, open, advance: (ms: number) => (clock += ms), landed: () => landed };
}

describe('GatewayEntitledCache — a new gateway model reaches the picker on its own', () => {
  it('first open: sweeps in the background and serves the entitled ids once it lands', async () => {
    const t = setup(['a', 'b', 'paid']);
    t.gw.refused.add('paid');
    expect(await t.cache.served(BASE, KEY)).toEqual([]);
    await t.cache.idle();
    expect(await t.cache.served(BASE, KEY)).toEqual(['a', 'b']);
    expect(t.landed()).toBe(1);
  });

  it('REPRO: the gateway gains a model -> the picker shows it within five minutes, no reload', async () => {
    const t = setup(['a', 'b']);
    expect(await t.open()).toEqual(['a', 'b']);
    t.gw.catalog.push('new-model');
    t.advance(FIVE_MINUTES + 1);
    expect(await t.open()).toEqual(['a', 'b', 'new-model']);
  });

  it('inside the five minutes the cached answer stands and nothing goes on the wire', async () => {
    const t = setup(['a']);
    await t.open();
    const gets = t.gw.gets;
    t.gw.catalog.push('b');
    t.advance(FIVE_MINUTES - 1);
    expect(await t.open()).toEqual(['a']);
    expect(t.gw.gets).toBe(gets);
  });

  it('revalidation probes ONLY the new id, not the whole catalog again', async () => {
    const t = setup(['a', 'b', 'c']);
    await t.open();
    expect(t.gw.probes.sort()).toEqual(['a', 'b', 'c']);
    t.gw.probes = [];
    t.gw.catalog.push('d');
    t.advance(FIVE_MINUTES + 1);
    await t.open();
    expect(t.gw.probes).toEqual(['d']);
  });

  it('an unchanged catalog costs one GET /models and no probe', async () => {
    const t = setup(['a', 'b']);
    await t.open();
    t.gw.probes = [];
    const gets = t.gw.gets;
    t.advance(FIVE_MINUTES + 1);
    expect(await t.open()).toEqual(['a', 'b']);
    expect(t.gw.gets).toBe(gets + 1);
    expect(t.gw.probes).toEqual([]);
  });

  it('a new id this key cannot call stays hidden; a model the gateway drops leaves the picker', async () => {
    const t = setup(['a', 'b']);
    await t.open();
    t.gw.catalog = ['a', 'locked'];
    t.gw.refused.add('locked');
    t.advance(FIVE_MINUTES + 1);
    expect(await t.open()).toEqual(['a']);
  });

  it('a gateway that does not answer keeps the cached list', async () => {
    const t = setup(['a', 'b']);
    await t.open();
    t.gw.up = false;
    t.advance(FIVE_MINUTES + 1);
    expect(await t.open()).toEqual(['a', 'b']);
  });
});

describe('GatewayEntitledCache.clear — the Refresh button', () => {
  it('drops every entry, so the next open sweeps at once and shows the new model', async () => {
    const t = setup(['a']);
    await t.open();
    t.gw.catalog.push('b');
    t.cache.clear();
    expect(await t.open()).toEqual(['a', 'b']);
  });

  it('a sweep already running when Refresh is pressed does not write its older list back', async () => {
    const t = setup(['a']);
    let release!: () => void;
    t.gw.gate = new Promise<void>((r) => (release = r));
    void t.cache.served(BASE, KEY); // the slow sweep leaves with the menu ['a']
    t.cache.clear();
    t.gw.gate = undefined;
    t.gw.catalog.push('b');
    expect(await t.open()).toEqual(['a', 'b']); // Refresh starts its own sweep at once
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.cache.served(BASE, KEY)).toEqual(['a', 'b']);
  });

  it('idle() reports false when a sweep could not reach the gateway', async () => {
    const t = setup(['a']);
    t.gw.up = false;
    await t.cache.served(BASE, KEY);
    expect(await t.cache.idle()).toBe(false);
    t.gw.up = true;
    t.cache.clear();
    await t.cache.served(BASE, KEY);
    expect(await t.cache.idle()).toBe(true);
  });
});
