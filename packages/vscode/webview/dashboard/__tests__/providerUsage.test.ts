// The Lab fold's usage read: one lazy call, and every answer it can get.
//
// NO LIVE CALLS. The engine client is a stub throughout. The point of these
// tests is the CONTRACT the fold depends on: whatever happens — no engine, an
// old engine, a refusal, an empty answer — exactly one `providerUsageData`
// message comes back, so the fold always knows whether to draw a line or hide
// it. Silence is the one outcome that would leave it spinning, and none of the
// paths below is allowed to produce it.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_USAGE_MESSAGE_TYPES,
  handleProviderUsageMessage,
  usageLine,
  type ProviderUsageClient,
} from '../../../src/dashboard/providerUsage';
import { KEY_USAGE_PROVIDERS, usageCapableIds } from '../../../src/dashboard/usageCapable';

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

  // OpenCode GO reports three lanes at once. The model-bar pill renders only the
  // FIRST line, so the order the engine sends is the order the user reads — and
  // the WEEKLY cap is the budget a user actually manages.
  it('a GO answer keeps the engine\'s lane order, Weekly first', async () => {
    const { host, posted } = hostOf({
      extMethod: async () => ({
        ok: true,
        providerID: 'opencode-go',
        plan: 'go',
        windows: [
          { label: 'Weekly', usedPercent: 12, resetsAt: NOW + 300_000_000 },
          { label: '5-hour', usedPercent: 30, resetsAt: NOW + 9_000_000 },
          { label: 'Monthly', usedPercent: 6 },
        ],
      }),
    });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      await handleProviderUsageMessage(host, { type: 'providerUsageRequest', providerId: 'opencode-go' });
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    expect(posted[0]!.plan).toBe('go');
    expect(posted[0]!.lines).toEqual([
      'Weekly: 12% used, resets in 3d 11h',
      '5-hour: 30% used, resets in 2h 30m',
      'Monthly: 6% used',
    ]);
  });
});

// WHICH providers can be asked at all. Read from the config FILE, not the
// engine — the model bar asks this once on mount, when no chat may be running.
describe('usageCapableIds — the model bar\'s gate', () => {
  it('a configured OpenCode GO key makes it capable', () => {
    expect(usageCapableIds({ 'opencode-go': { options: { apiKey: 'sk-not-a-real-go-key' } } })).toEqual(['opencode-go']);
  });

  it('OpenCode ZEN is NEVER capable, even with a key — it is metered and has no usage route', () => {
    // `opencode` and `opencode-go` are two providers on one host. Treating Zen
    // as capable would fire a read the engine has to refuse, every turn.
    expect(usageCapableIds({ opencode: { options: { apiKey: 'sk-zen' } } })).toEqual([]);
    expect(KEY_USAGE_PROVIDERS).not.toContain('opencode');
  });

  it('a GO block with no usable key is not capable', () => {
    // A provider block written without a key (a half-finished connect, or an
    // OAuth provider's keyless block) would earn a refusal, not a number.
    for (const block of [{}, { options: {} }, { options: { apiKey: '' } }, { options: { apiKey: '   ' } }, { options: { apiKey: 123 } }]) {
      expect(usageCapableIds({ 'opencode-go': block })).toEqual([]);
    }
  });

  it('a missing or malformed config answers "none" rather than throwing', () => {
    for (const providers of [undefined, null, 'nope', 42, [], {}]) {
      expect(usageCapableIds(providers)).toEqual([]);
    }
  });
});

describe('providerUsageCapableRequest — answered from the config, with no engine', () => {
  /** Point the global-config helpers at a scratch dir for one call. Never the
   *  developer's own ~/.config/origami — realConfigGuard.ts explains why. */
  function withConfig<T>(json: unknown | undefined, run: () => T): T {
    const previous = process.env.XDG_CONFIG_HOME;
    const dir = mkdtempSync(path.join(tmpdir(), 'origami-usage-capable-'));
    mkdirSync(path.join(dir, 'origami'), { recursive: true });
    if (json !== undefined) writeFileSync(path.join(dir, 'origami', 'origami.json'), JSON.stringify(json), 'utf8');
    process.env.XDG_CONFIG_HOME = dir;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  }

  it('reports opencode-go when the global config carries its key', async () => {
    const { host, posted } = hostOf();
    await withConfig({ provider: { 'opencode-go': { options: { apiKey: 'sk-not-a-real-go-key' } } } }, () =>
      handleProviderUsageMessage(host, { type: 'providerUsageCapableRequest' }),
    );
    expect(posted).toEqual([{ type: 'providerUsageCapable', ids: ['opencode-go'] }]);
  });

  it('NEVER puts the key on the wire — only the fact that one exists', async () => {
    const { host, posted } = hostOf();
    await withConfig({ provider: { 'opencode-go': { options: { apiKey: 'sk-not-a-real-go-key' } } } }, () =>
      handleProviderUsageMessage(host, { type: 'providerUsageCapableRequest' }),
    );
    expect(JSON.stringify(posted)).not.toContain('sk-not-a-real-go-key');
  });

  it('answers with NO engine client at all — a fresh window has no chat open yet', async () => {
    // The whole reason this is a config read and not an ext method: the model
    // bar mounts before any session exists.
    const { host, posted } = hostOf();
    await withConfig({ provider: {} }, () => handleProviderUsageMessage(host, { type: 'providerUsageCapableRequest' }));
    expect(posted).toEqual([{ type: 'providerUsageCapable', ids: [] }]);
  });

  it('an absent or corrupt config still answers, so the gate never hangs', async () => {
    for (const cfg of [undefined, { provider: 'not-an-object' }]) {
      const { host, posted } = hostOf();
      await withConfig(cfg, () => handleProviderUsageMessage(host, { type: 'providerUsageCapableRequest' }));
      expect(posted).toEqual([{ type: 'providerUsageCapable', ids: [] }]);
    }
  });

  it('is routed — DashboardPanel dispatches on this set, so an absent member is a dead message', () => {
    expect(PROVIDER_USAGE_MESSAGE_TYPES.has('providerUsageCapableRequest')).toBe(true);
  });
});
