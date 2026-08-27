// The Lab fold's usage read: one lazy call, and every answer it can get.
//
// NO LIVE CALLS. The engine client is a stub throughout. The point of these
// tests is the CONTRACT the fold depends on: whatever happens — no engine, an
// old engine, a refusal, an empty answer — exactly one `providerUsageData`
// message comes back, so the fold always knows whether to draw a line or hide
// it. Silence is the one outcome that would leave it spinning, and none of the
// paths below is allowed to produce it.

import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_USAGE_MESSAGE_TYPES,
  handleProviderUsageMessage,
  usageLine,
  type ProviderUsageClient,
} from '../../../src/dashboard/providerUsage';

const NOW = 1_786_874_400_000;

/** Collects what the host posted back to the webview. */
function hostOf(client?: ProviderUsageClient) {
  const posted: Record<string, unknown>[] = [];
  return { host: { ...(client ? { client } : {}), post: (m: Record<string, unknown>) => posted.push(m) }, posted };
}

const ask = { type: 'providerUsageRequest', providerId: 'openai' };

describe('usageLine — a window as one sentence', () => {
  it('names the lane, the percentage and the wait', () => {
    expect(usageLine({ label: '5-hour', usedPercent: 12, resetsAt: NOW + 9_000_000 }, NOW)).toBe(
      '5-hour: 12% used, resets in 2h 30m',
    );
  });

  it('a multi-day wait reads in days and hours, not 137 hours', () => {
    expect(usageLine({ label: 'Weekly', usedPercent: 47.5, resetsAt: NOW + 300_000_000 }, NOW)).toBe(
      'Weekly: 48% used, resets in 3d 11h',
    );
  });

  it('under an hour drops to minutes', () => {
    expect(usageLine({ label: '5-hour', usedPercent: 99, resetsAt: NOW + 300_000 }, NOW)).toBe(
      '5-hour: 99% used, resets in 5m',
    );
  });

  it('a reset already past says so instead of counting backwards', () => {
    // The window has rolled over and the percentage beside it is stale — showing
    // "resets in -3m" would read as a bug in the extension.
    expect(usageLine({ label: '5-hour', usedPercent: 80, resetsAt: NOW - 180_000 }, NOW)).toBe(
      '5-hour: 80% used, resetting now',
    );
  });

  it('no reset time renders the percentage alone rather than a guess', () => {
    expect(usageLine({ label: 'Session', usedPercent: 3 }, NOW)).toBe('Session: 3% used');
  });
});

describe('handleProviderUsageMessage — exactly one answer, on every path', () => {
  it('asks the engine with the provider id and posts READY-TO-RENDER lines', async () => {
    // Formatted host-side on purpose: the webview cannot import this module
    // (rootDir split), so raw numbers would mean a second copy of the wording.
    const extMethod = vi.fn().mockResolvedValue({
      ok: true,
      providerID: 'openai',
      plan: 'plus',
      windows: [
        { label: '5-hour', usedPercent: 12, resetsAt: Date.now() + 9_000_000 },
        { label: 'Weekly', usedPercent: 48 },
      ],
    });
    const { host, posted } = hostOf({ extMethod });
    await handleProviderUsageMessage(host, ask);
    expect(extMethod).toHaveBeenCalledWith('provider_auth_usage', { providerID: 'openai' });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe('providerUsageData');
    expect(posted[0]!.providerId).toBe('openai');
    expect(posted[0]!.plan).toBe('plus');
    expect((posted[0]!.lines as string[])[0]).toMatch(/^5-hour: 12% used, resets in 2h \d+m$/);
    expect((posted[0]!.lines as string[])[1]).toBe('Weekly: 48% used');
  });

  it('CALLS ONCE — the fold asks on open, and nothing here re-asks or polls', async () => {
    const extMethod = vi.fn().mockResolvedValue({ ok: true, windows: [{ label: 'x', usedPercent: 1 }] });
    const { host } = hostOf({ extMethod });
    await handleProviderUsageMessage(host, ask);
    expect(extMethod).toHaveBeenCalledTimes(1);
  });

  it('an engine refusal is passed through verbatim — it is the only wording that helps', async () => {
    const { host, posted } = hostOf({
      extMethod: async () => ({ ok: false, providerID: 'xai', unavailable: 'xAI publishes no usage endpoint for OAuth sign-ins.' }),
    });
    await handleProviderUsageMessage(host, { type: 'providerUsageRequest', providerId: 'xai' });
    expect(posted[0]).toEqual({
      type: 'providerUsageData',
      providerId: 'xai',
      unavailable: 'xAI publishes no usage endpoint for OAuth sign-ins.',
    });
  });

  it('an old engine (method_not_found) reads as version skew, not a broken account', async () => {
    const { host, posted } = hostOf({
      extMethod: async () => {
        throw new Error('Method not found: _provider_auth_usage');
      },
    });
    await handleProviderUsageMessage(host, ask);
    expect(posted).toHaveLength(1);
    expect(String(posted[0]!.unavailable)).toContain('engine build');
    // The raw JSON-RPC wording must not reach the fold.
    expect(String(posted[0]!.unavailable)).not.toContain('Method not found');
  });

  it('no engine yet still answers, so the fold stops waiting', async () => {
    const { host, posted } = hostOf();
    await handleProviderUsageMessage(host, ask);
    expect(posted).toHaveLength(1);
    expect(String(posted[0]!.unavailable)).toContain('Open a chat');
  });

  it('ok with an EMPTY window list is unavailable, not an empty line', async () => {
    const { host, posted } = hostOf({ extMethod: async () => ({ ok: true, windows: [] }) });
    await handleProviderUsageMessage(host, ask);
    expect(posted[0]!.unavailable).toBeTruthy();
    // No `lines` key at all — the fold renders the row only when lines exist, so
    // this is what makes an unavailable answer hide the line rather than show a
    // blank one.
    expect(posted[0]!.lines).toBeUndefined();
  });

  it('a malformed engine answer degrades to unavailable rather than throwing', async () => {
    for (const answer of [null, undefined, {}, { ok: true }, { ok: true, windows: 'nope' }]) {
      const { host, posted } = hostOf({ extMethod: async () => answer as never });
      await handleProviderUsageMessage(host, ask);
      expect(posted).toHaveLength(1);
      expect(posted[0]!.unavailable).toBeTruthy();
    }
  });

  it('a message with no provider id is ignored — it names no fold to answer', async () => {
    const extMethod = vi.fn();
    const { host, posted } = hostOf({ extMethod });
    await handleProviderUsageMessage(host, { type: 'providerUsageRequest' });
    expect(extMethod).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('another message type is not this handler\'s business', async () => {
    const extMethod = vi.fn();
    const { host, posted } = hostOf({ extMethod });
    await handleProviderUsageMessage(host, { type: 'providerAuthStart', providerId: 'openai' });
    expect(extMethod).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    // And the dispatch set must not claim it either.
    expect(PROVIDER_USAGE_MESSAGE_TYPES.has('providerAuthStart')).toBe(false);
    expect(PROVIDER_USAGE_MESSAGE_TYPES.has('providerUsageRequest')).toBe(true);
  });
});
