// gatewayEntitlements.test.ts — "entitled" must mean "turn one will work"
// (src/dashboard/gatewayEntitlements.ts).
//
// The defect this suite pins (owner, 2026-08-21): Zen/Go's GET /models answers
// the same 64 ids for EVERY key — the tier is enforced per request. Feeding the
// raw catalog to the picker offered a menu where a Go key's first turn died on
// 55 of 64 rows. The status fixture below is the LIVE sweep of the owner's Go
// key (2026-08-21): 6 × 2xx, 55 × 401, one 400 (deepseek-v4-flash-free —
// listed but answering 500/400 on a valid key), one 429 (the sweep tripping
// the limiter on mimo-v2.5-free).

import { describe, expect, it, vi } from 'vitest';
import { sweepEntitledModels } from '../../../src/dashboard/gatewayEntitlements';

/** A fetch stand-in answering a fixed status per model id. */
function statusFetch(status: (model: string) => number) {
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model as string;
    const s = status(model);
    return { ok: s >= 200 && s < 300, status: s } as Response;
  }) as unknown as typeof fetch;
  return impl;
}

describe('sweepEntitledModels — the verdict table', () => {
  it('keeps 2xx, keeps 429, drops 401/403, drops other 4xx/5xx', async () => {
    const table: Record<string, number> = {
      'big-pickle': 200,               // entitled — the live Go answer
      'laguna-s-2.1-free': 200,        // entitled
      'kimi-k3': 401,                  // tier-refused
      'claude-fable-5': 401,           // tier-refused
      'muse-spark-1.2-contributor-free': 403, // gated
      'deepseek-v4-flash-free': 500,   // listed but broken on a VALID key
      'mimo-v2.5-free': 429,           // the sweep itself tripped the limiter
    };
    const ids = Object.keys(table);
    const out = await sweepEntitledModels('https://zen.example/v1', 'k', ids, statusFetch((m) => table[m]));
    expect(out).toEqual(['big-pickle', 'laguna-s-2.1-free', 'mimo-v2.5-free']);
  });

  it('returns ids in CATALOG order regardless of which probe answers first', async () => {
    const ids = ['third', 'first', 'second'];
    const delays: Record<string, number> = { third: 30, first: 1, second: 15 };
    const impl = (async (_url: unknown, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string;
      await new Promise((r) => setTimeout(r, delays[model]));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    expect(await sweepEntitledModels('https://zen.example/v1', 'k', ids, impl)).toEqual(ids);
  });

  it('a probe that THROWS is excluded quietly and costs no neighbour', async () => {
    const impl = (async (_url: unknown, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string;
      if (model === 'dead') throw new TypeError('fetch failed');
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const out = await sweepEntitledModels('https://zen.example/v1', 'k', ['a', 'dead', 'b'], impl);
    expect(out).toEqual(['a', 'b']);
  });

  it('never exceeds the concurrency bound', async () => {
    let inFlight = 0;
    let peak = 0;
    const impl = (async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
    await sweepEntitledModels('https://zen.example/v1', 'k', ids, impl, 4);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('probes the gateway\'s own chat/completions with the key and ONE token', async () => {
    const calls: Array<{ url: string; auth?: string; body: { model: string; max_tokens: number } }> = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: (init?.headers as Record<string, string>).Authorization,
        body: JSON.parse(String(init?.body)),
      });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    await sweepEntitledModels('https://opencode.ai/zen/v1/', 'go-key', ['big-pickle'], impl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(calls[0].auth).toBe('Bearer go-key');
    expect(calls[0].body).toMatchObject({ model: 'big-pickle', max_tokens: 1 });
  });

  it('an empty catalog sweeps nothing and returns []', async () => {
    const spy = vi.fn();
    expect(await sweepEntitledModels('https://zen.example/v1', 'k', [], spy as unknown as typeof fetch)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
