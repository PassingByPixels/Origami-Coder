// An OAuth-connected provider is NOT unreachable.
//
// OWNER UAT, 0.3.82: the Grok OAuth connection answered normally — real replies
// on grok-4.20-0309-reasoning — while every chat pane carried a yellow
// "xAI (SuperGrok) unreachable — check the server, then type a message to retry."
//
// THE CHAIN. `broadcastProviderStatus` probes each configured block and caches a
// verdict; `sessionModelStatus` reads that cache for a remote chat; the composer
// draws `bannerState(ok, reason, providerIsLocal)`. An OAuth block carries NO
// baseURL and NO apiKey on purpose (oauthConnections.ts: "NO apiKey IS WRITTEN"
// — the plugin injects the bearer), so it matched neither the endpoint-probe
// branch nor the key-present branch and fell to `reason = 'not configured'`,
// which the banner rule correctly reads as `offline-remote`.
//
// The SIDEBAR pill had already been fixed for this (providerGrid.lightOf takes
// an `oauth` flag), but that merge happens in the webview from
// `providerAuthData` and never reached the host-side status the chat reads. So
// the fix belongs where the verdict is made, not where it is drawn — and the
// alarm must still fire for a local server that is genuinely down.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oauthConnectedIds } from '../../../src/dashboard/providerAuthPane';
import { bannerState } from '../components/modelBanner';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const panel = readFileSync(path.join(pkgRoot, 'src/dashboard/DashboardPanel.ts'), 'utf8');

/** An ACP client that answers `provider_auth_list` with a fixed payload. */
const clientAnswering = (connected: Record<string, { type: string }>) => ({
  extMethod: async (method: string) => {
    if (method !== 'provider_auth_list') throw new Error(`unexpected ext method ${method}`);
    return { methods: {}, connected } as unknown as Record<string, unknown>;
  },
});

describe('which providers the host counts as signed in', () => {
  it('reports the providers holding an OAUTH credential', async () => {
    const ids = await oauthConnectedIds(clientAnswering({ xai: { type: 'oauth' }, openai: { type: 'oauth' } }));
    expect([...ids].sort()).toEqual(['openai', 'xai']);
  });

  it('an API-KEY credential is not an OAuth connection', async () => {
    // `origami providers login` can store an `api` credential for the same
    // provider. Counting it here would light a connection the user never made.
    const ids = await oauthConnectedIds(clientAnswering({ xai: { type: 'api' } }));
    expect([...ids]).toEqual([]);
  });

  it('an empty answer from a LIVE engine means "nobody is signed in"', async () => {
    expect([...(await oauthConnectedIds(clientAnswering({})) ?? new Set())]).toEqual([]);
  });

  it('COULD NOT ASK is undefined, never an empty set', async () => {
    // OWNER UAT, 0.4.64: the boot-time probe runs before any chat has spawned
    // an engine, so there is no client to ask. Answering an empty set there
    // made broadcastProviderStatus cache "not configured" for a signed-in
    // ChatGPT block — absence of an ANSWER cached as absence of a CREDENTIAL —
    // and every fresh chat wore the unreachable banner while the model
    // answered. undefined = the auth store was not asked; a liveness read
    // still degrades rather than throws.
    expect(await oauthConnectedIds(undefined)).toBeUndefined();
    const angry = { extMethod: async () => { throw new Error('engine gone'); } };
    expect(await oauthConnectedIds(angry)).toBeUndefined();
  });
});

describe('the liveness verdict for a keyless, URL-less block', () => {
  // DashboardPanel cannot be instantiated in jsdom (it owns a real webview
  // panel), so the branch is locked by reading the source — the same house
  // pattern modelBanner.test.ts uses for the PROVIDER_PROBING literal.
  const probe = /const oauthIds[\s\S]*?reason = 'not configured';/.exec(panel)?.[0] ?? '';

  it('the probe asks the engine which providers are signed in', () => {
    expect(probe, 'broadcastProviderStatus no longer resolves oauth connections').toContain('oauthConnectedIds');
  });

  it('a signed-in provider is LIVE, and is decided BEFORE the "not configured" fallback', () => {
    expect(probe).toContain('oauthIds.has(id)');
    expect(probe.indexOf('oauthIds.has(id)')).toBeLessThan(probe.indexOf(`reason = 'not configured'`));
  });

  it('the endpoint probe still owns every block that HAS a base URL', () => {
    // The regression this guards: an over-broad oauth branch swallowing the
    // local path, so a dead SGLang/LM Studio would report live.
    // Matched loosely on the ARGUMENTS because the probe now also forwards the
    // block's optional apiKey — `fetchLmStudioModels(baseURL, apiKey)`. Pinning
    // the old exact string would have made adding that argument look like the
    // branch had been removed.
    expect(probe).toMatch(/fetchLmStudioModels\(baseURL[,)]/);
    expect(probe.search(/fetchLmStudioModels\(baseURL[,)]/)).toBeLessThan(probe.indexOf('oauthIds.has(id)'));
  });

  it('that endpoint probe is given the block\'s key, so a keyed server is not read as dead', () => {
    // A key-protected LM Studio 401s an unauthenticated probe and would report
    // "no model reachable" forever while serving chat turns normally.
    expect(probe).toContain('fetchLmStudioModels(baseURL, apiKey)');
    expect(probe).toContain('detectLocalFlavor(baseURL, apiKey)');
  });

  it('an UNANSWERABLE auth store is "checking", never "not configured", and never cached', () => {
    // The boot-time probe runs before any chat has an engine. With no client to
    // ask, "not configured" is a guess — and caching it made every fresh
    // ChatGPT chat wear the unreachable banner (the second life of the 0.3.82
    // bug). The unknown branch must sit BEFORE the fallback, wear the neutral
    // probing sentinel the banner rule already knows, and skip the cache so the
    // very next status tick asks again instead of serving the guess for 20s.
    expect(probe).toContain('oauthIds === undefined');
    expect(probe.indexOf('oauthIds === undefined')).toBeLessThan(probe.indexOf(`reason = 'not configured'`));
    expect(probe).toContain('cacheable = false');
    expect(probe).toContain(`reason = 'Checking provider…'`);
  });
});

describe('what the chat composer then draws', () => {
  it('a signed-in cloud provider gets NO banner', () => {
    // live:true is what the fixed probe now caches, so sessionModelStatus reports
    // ok:true and the composer draws nothing at all.
    expect(bannerState(true, '', false)).toBe('ok');
  });

  it('an unsigned, unconfigured cloud block still says unreachable', () => {
    expect(bannerState(false, 'not configured', false)).toBe('offline-remote');
  });

  it('a genuinely-down LOCAL server keeps its alarm', () => {
    // The fix must not buy quiet by softening the real failure.
    expect(bannerState(false, 'no model reachable', true)).toBe('offline-local');
    expect(bannerState(false, 'ECONNREFUSED 127.0.0.1:30000', true)).toBe('offline-local');
  });
});
