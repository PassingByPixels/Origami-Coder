// cacheStats — the host leaf behind the Insights cache-hit-ratio card. Same
// shape as promptCapture.test.ts, and the same thing matters: a session with
// no engine connection yet must answer empty, not error.

import { describe, it, expect } from 'vitest';
import { cacheStatsPayload } from '../../../src/dashboard/cacheStats';

const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  input, output, cacheRead, cacheWrite,
});

const clientWith = (
  result: unknown,
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [],
  sessionId: string | null = 'ses_live',
) => ({
  currentSessionId: sessionId,
  extMethod: async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params });
    return result as Record<string, unknown>;
  },
});

describe('cacheStatsPayload', () => {
  it('asks the engine for THIS client’s own session, on the cache_stats method', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    await cacheStatsPayload(clientWith({ sessionId: 'ses_live', current: null, lifetime: tokens(0, 0, 0, 0), sessionCount: 0 }, calls));

    expect(calls).toEqual([{ method: 'cache_stats', params: { sessionId: 'ses_live' } }]);
  });

  it('passes the engine’s current + lifetime tokens through verbatim', async () => {
    const current = tokens(100, 50, 10, 5);
    const lifetime = tokens(900, 400, 80, 20);
    const out = await cacheStatsPayload(clientWith({ sessionId: 'ses_live', current, lifetime, sessionCount: 7 }));

    expect(out).toEqual({ current, lifetime, sessionCount: 7 });
  });

  it('a session whose own row was not found reports current: null, lifetime still real', async () => {
    const lifetime = tokens(10, 10, 1, 1);
    const out = await cacheStatsPayload(clientWith({ sessionId: 'ses_live', current: null, lifetime, sessionCount: 1 }));

    expect(out.current).toBeNull();
    expect(out.lifetime).toEqual(lifetime);
    expect(out.error).toBeUndefined();
  });

  it('a client with no engine session yet asks nothing and reports no error', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const out = await cacheStatsPayload(clientWith({}, calls, null));

    expect(calls).toEqual([]);
    expect(out).toEqual({ current: null, lifetime: null, sessionCount: 0 });
  });

  it('with no client at all it says a chat is needed — that IS the actionable error', async () => {
    const out = await cacheStatsPayload(null);

    expect(out.current).toBeNull();
    expect(out.lifetime).toBeNull();
    expect(out.error).toContain('Open a chat first');
  });

  it('a throwing engine surfaces the message rather than a silent empty card', async () => {
    const out = await cacheStatsPayload({
      currentSessionId: 'ses_live',
      extMethod: async () => {
        throw new Error('method_not_found');
      },
    });

    expect(out.error).toBe('method_not_found');
    expect(out.current).toBeNull();
    expect(out.lifetime).toBeNull();
  });

  it('a malformed current (missing a token number) is rejected as null, not rendered half-built', async () => {
    const out = await cacheStatsPayload(
      clientWith({ sessionId: 'ses_live', current: { input: 1, output: 1, cacheRead: 1 }, lifetime: tokens(9, 9, 9, 9), sessionCount: 1 }),
    );
    expect(out.current).toBeNull();
    // The (valid) lifetime is untouched by the malformed sibling field.
    expect(out.lifetime).toEqual(tokens(9, 9, 9, 9));
  });

  it('a malformed lifetime (wrong type, or missing entirely) is rejected as null, never crashes', async () => {
    for (const bad of [
      { sessionId: 'ses_live', current: null, lifetime: 'not tokens', sessionCount: 0 },
      {},
    ]) {
      const out = await cacheStatsPayload(clientWith(bad));
      expect(out.current).toBeNull();
      expect(out.lifetime).toBeNull();
    }
  });
});
