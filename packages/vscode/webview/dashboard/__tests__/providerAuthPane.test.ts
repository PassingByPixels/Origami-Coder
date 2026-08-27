// providerAuthPane.test.ts — the OAuth connections flow, host side.
//
// The real sign-in cannot be tested here (it needs a browser and a real
// ChatGPT / SuperGrok account), so what these assert is everything AROUND it —
// the parts that were wrong-by-default and that a human eyeballing a browser
// window would not catch:
//
//   1. The config block written on success carries NO apiKey. Writing one would
//      override the plugin's own dummy-key + fetch-wrapper pair, which is the
//      thing that actually injects the OAuth bearer — the connection would look
//      configured and 401 on the first message.
//   2. The full model catalog is written, not just the default. This fork ships
//      no models.dev data, so a model absent from config does not exist for the
//      engine at all.
//   3. The authorize URL reaches `openExternal` VERBATIM. A mangled or dropped
//      URL is a sign-in that silently never starts.
//   4. `connected` reports oauth credentials only. A stale `api` credential for
//      the same provider reported as "signed in" is a green pill over a dead
//      connection.
//   5. A failed callback writes NOTHING.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fake } = vi.hoisted(() => ({ fake: { opened: [] as string[], infos: [] as string[] } }));

vi.mock('vscode', () => ({
  env: { openExternal: (u: unknown) => void fake.opened.push(String(u)) },
  Uri: { parse: (s: string) => s },
  window: { showInformationMessage: (m: string) => { fake.infos.push(m); return Promise.resolve(undefined); } },
  commands: { executeCommand: () => Promise.resolve(undefined) },
}));

import {
  PROVIDER_AUTH_MESSAGE_TYPES,
  handleProviderAuthMessage,
  type ProviderAuthHost,
} from '../../../src/dashboard/providerAuthPane';
import { OAUTH_PROVIDERS, oauthMethods } from '../../../src/dashboard/oauthConnections';
import type { ModelChoice } from '../../../src/dashboard/firstFold';

type Call = { method: string; params?: Record<string, unknown> };

function harness(replies: Record<string, unknown | (() => unknown)>) {
  const calls: Call[] = [];
  const posted: Record<string, unknown>[] = [];
  const writes: ModelChoice[] = [];
  const opened: string[] = [];
  const refreshed: string[] = [];
  const host: ProviderAuthHost = {
    client: {
      extMethod: async (method, params) => {
        calls.push({ method, ...(params ? { params } : {}) });
        const reply = replies[method];
        if (reply === undefined) throw new Error(`no stub reply for ${method}`);
        return (typeof reply === 'function' ? (reply as () => unknown)() : reply) as Record<string, unknown>;
      },
    },
    post: (m) => void posted.push(m),
    write: (choice) => {
      writes.push(choice);
      return { path: 'C:/Users/x/.config/origami/origami.json', model: `${choice.providerId}/${choice.modelId}` };
    },
    refresh: (id) => void refreshed.push(id),
    openExternal: (url) => void opened.push(url),
  };
  return { host, calls, posted, writes, opened, refreshed };
}

const BROWSER_AND_HEADLESS = {
  methods: {
    openai: [
      { type: 'oauth', label: 'ChatGPT Pro/Plus (browser)' },
      { type: 'oauth', label: 'ChatGPT Pro/Plus (headless)' },
      { type: 'api', label: 'Manually enter API Key' },
    ],
    xai: [
      { type: 'oauth', label: 'xAI Grok OAuth (SuperGrok Subscription)' },
      { type: 'oauth', label: 'xAI Grok OAuth (Headless / Remote / VPS)' },
      { type: 'api', label: 'Manually enter API Key' },
    ],
    anthropic: [{ type: 'api', label: 'Manually enter API Key' }],
  },
  connected: {},
};

const AUTHORIZED = {
  ok: true,
  url: 'https://auth.openai.com/oauth/authorize?code_challenge=abc&state=xyz',
  method: 'auto',
  instructions: 'Complete authorization in your browser.',
};

beforeEach(() => {
  fake.opened.length = 0;
  fake.infos.length = 0;
});

describe('oauthMethods — the API-key entry never shows up as a sign-in button', () => {
  it('keeps only oauth methods and preserves their ORIGINAL indexes', () => {
    expect(oauthMethods(BROWSER_AND_HEADLESS.methods.openai)).toEqual([
      { index: 0, label: 'ChatGPT Pro/Plus (browser)' },
      { index: 1, label: 'ChatGPT Pro/Plus (headless)' },
    ]);
  });

  it('filters by TYPE, so a plugin renaming its key entry cannot put it back', () => {
    expect(oauthMethods([{ type: 'api', label: 'Paste a token' }])).toEqual([]);
  });

  it('answers empty for a provider the engine did not report at all', () => {
    expect(oauthMethods(undefined)).toEqual([]);
  });
});

describe('providerAuthRequest', () => {
  it('reports only the two OAuth connections, with the API-key methods stripped', async () => {
    const h = harness({ provider_auth_list: BROWSER_AND_HEADLESS });
    await handleProviderAuthMessage(h.host, { type: 'providerAuthRequest' });
    const data = h.posted[0] as { type: string; methods: Record<string, unknown[]> };
    expect(data.type).toBe('providerAuthData');
    expect(Object.keys(data.methods).sort()).toEqual(['openai', 'xai']);
    expect(data.methods['openai']).toHaveLength(2);
  });

  it('an api-only credential is NOT reported as signed in', async () => {
    const h = harness({
      provider_auth_list: {
        ...BROWSER_AND_HEADLESS,
        connected: { openai: { type: 'api' }, xai: { type: 'oauth', expires: 123 } },
      },
    });
    await handleProviderAuthMessage(h.host, { type: 'providerAuthRequest' });
    const data = h.posted[0] as { connected: Record<string, unknown> };
    expect(data.connected).toEqual({ xai: { type: 'oauth', expires: 123 } });
  });

  it('with no engine session it says so instead of showing an empty, silent form', async () => {
    const h = harness({});
    delete (h.host as { client?: unknown }).client;
    await handleProviderAuthMessage(h.host, { type: 'providerAuthRequest' });
    expect(String((h.posted[0] as { error?: string }).error)).toContain('Open a chat first');
  });
});

describe('providerAuthStart — the browser hand-off', () => {
  it('opens the authorize URL VERBATIM and reports the waiting state before the callback lands', async () => {
    let released: (v: unknown) => void = () => {};
    const h = harness({
      provider_auth_list: BROWSER_AND_HEADLESS,
      provider_auth_authorize: AUTHORIZED,
      provider_auth_callback: () => new Promise((r) => { released = r; }),
    });
    const running = handleProviderAuthMessage(h.host, { type: 'providerAuthStart', providerId: 'openai', methodIndex: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.opened).toEqual([AUTHORIZED.url]);
    const pending = h.posted.find((p) => p['type'] === 'providerAuthPending');
    expect(pending).toMatchObject({ providerId: 'openai', url: AUTHORIZED.url, method: 'auto' });
    // Nothing is written while the browser is still open.
    expect(h.writes).toEqual([]);
    released({ ok: true, credential: { type: 'oauth', expires: 1 } });
    await running;
  });

  it('passes the chosen method index through — a headless pick must not start the browser flow', async () => {
    const h = harness({
      provider_auth_list: BROWSER_AND_HEADLESS,
      provider_auth_authorize: AUTHORIZED,
      provider_auth_callback: { ok: true, credential: { type: 'oauth', expires: 1 } },
    });
    await handleProviderAuthMessage(h.host, { type: 'providerAuthStart', providerId: 'xai', methodIndex: 1 });
    expect(h.calls.find((c) => c.method === 'provider_auth_authorize')?.params)
      .toEqual({ providerID: 'xai', methodIndex: 1 });
    expect(h.calls.find((c) => c.method === 'provider_auth_callback')?.params)
      .toEqual({ providerID: 'xai', methodIndex: 1 });
  });

  it('a refused authorize surfaces the engine\'s own message and writes nothing', async () => {
    const h = harness({
      provider_auth_list: BROWSER_AND_HEADLESS,
      provider_auth_authorize: { ok: false, message: 'A xai sign-in is already in progress.' },
    });
    await handleProviderAuthMessage(h.host, { type: 'providerAuthStart', providerId: 'xai', methodIndex: 0 });
    expect(h.posted.find((p) => p['type'] === 'providerAuthFailed'))
      .toMatchObject({ message: 'A xai sign-in is already in progress.' });
    expect(h.opened).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('a browser that refuses to open does NOT abandon the flow — the engine still holds the pending sign-in', async () => {
    const h = harness({
      provider_auth_list: BROWSER_AND_HEADLESS,
      provider_auth_authorize: AUTHORIZED,
      provider_auth_callback: { ok: true, credential: { type: 'oauth', expires: 1 } },
    });
    h.host.openExternal = () => { throw new Error('no handler for uri'); };
    await handleProviderAuthMessage(h.host, { type: 'providerAuthStart', providerId: 'openai', methodIndex: 0 });
    // Only `provider_auth_callback` releases the engine's per-provider guard, so
    // returning early here would lock the provider out until a restart.
    expect(h.calls.some((c) => c.method === 'provider_auth_callback')).toBe(true);
    expect(h.writes).toHaveLength(1);
    expect(String((h.posted.find((p) => p['type'] === 'providerAuthPending') ?? {})['instructions']))
      .toContain('open the URL below yourself');
  });

  it('ignores a provider id that is not an OAuth connection', async () => {
    const h = harness({ provider_auth_list: BROWSER_AND_HEADLESS });
    await handleProviderAuthMessage(h.host, { type: 'providerAuthStart', providerId: 'anthropic', methodIndex: 0 });
    expect(h.calls.some((c) => c.method === 'provider_auth_authorize')).toBe(false);
  });
});

describe('the config block written on success', () => {
  it('carries NO apiKey, the plugin npm package, and the whole model catalog', async () => {
    const h = harness({
      provider_auth_list: BROWSER_AND_HEADLESS,
      provider_auth_authorize: AUTHORIZED,
      provider_auth_callback: { ok: true, credential: { type: 'oauth', expires: 5 } },
    });
    await handleProviderAuthMessage(h.host, { type: 'providerAuthStart', providerId: 'openai', methodIndex: 0 });

    expect(h.writes).toHaveLength(1);
    const choice = h.writes[0];
    expect(choice.apiKey).toBeUndefined();
    expect(choice.baseURL).toBeUndefined();
    expect(choice.providerId).toBe('openai');
    expect(choice.npm).toBe('@ai-sdk/openai');
    expect(choice.modelId).toBe('gpt-5.5');
    // Every model the ChatGPT backend serves, not just the default — an absent
    // model does not exist for the engine at all in this fork.
    expect(Object.keys(choice.catalog ?? {}).sort()).toEqual(Object.keys(OAUTH_PROVIDERS['openai'].models).sort());
    expect(h.refreshed).toEqual(['openai']);
    expect(h.posted.find((p) => p['type'] === 'providerAuthDone')).toMatchObject({ model: 'openai/gpt-5.5' });
  });

  it('the xai block names the xai sdk and the Grok models', async () => {
    const h = harness({
      provider_auth_list: BROWSER_AND_HEADLESS,
      provider_auth_authorize: AUTHORIZED,
      provider_auth_callback: { ok: true, credential: { type: 'oauth', expires: 5 } },
    });
    await handleProviderAuthMessage(h.host, { type: 'providerAuthStart', providerId: 'xai', methodIndex: 0 });
    expect(h.writes[0].npm).toBe('@ai-sdk/xai');
    expect(h.writes[0].apiKey).toBeUndefined();
    expect(Object.keys(h.writes[0].catalog ?? {})).toContain('grok-4.5');
  });

  it('every declared model carries a real context limit — a 0 there disables auto-compaction', () => {
    for (const spec of Object.values(OAUTH_PROVIDERS)) {
      expect(spec.models[spec.defaultModel], `${spec.id} default model must be in its own catalog`).toBeDefined();
      for (const [id, model] of Object.entries(spec.models)) {
        expect(model.limit.context, `${spec.id}/${id} context`).toBeGreaterThan(0);
        expect(model.limit.output, `${spec.id}/${id} output`).toBeGreaterThan(0);
      }
    }
  });

  it('a failed callback writes NOTHING', async () => {
    const h = harness({
      provider_auth_list: BROWSER_AND_HEADLESS,
      provider_auth_authorize: AUTHORIZED,
      provider_auth_callback: { ok: false, message: 'xAI device authorization was denied' },
    });
    await handleProviderAuthMessage(h.host, { type: 'providerAuthStart', providerId: 'xai', methodIndex: 0 });
    expect(h.writes).toEqual([]);
    expect(h.refreshed).toEqual([]);
    expect(h.posted.find((p) => p['type'] === 'providerAuthFailed'))
      .toMatchObject({ message: 'xAI device authorization was denied' });
  });
});

describe('providerAuthSubmitCode — the paste-a-code path', () => {
  it('sends the trimmed code and then completes the same way the browser path does', async () => {
    const h = harness({
      provider_auth_list: BROWSER_AND_HEADLESS,
      provider_auth_callback: { ok: true, credential: { type: 'oauth', expires: 7 } },
    });
    await handleProviderAuthMessage(h.host, {
      type: 'providerAuthSubmitCode', providerId: 'openai', methodIndex: 1, code: '  ABCD-1234  ',
    });
    expect(h.calls.find((c) => c.method === 'provider_auth_callback')?.params)
      .toEqual({ providerID: 'openai', methodIndex: 1, code: 'ABCD-1234' });
    expect(h.writes).toHaveLength(1);
  });

  it('a blank code is a no-op, not an empty callback', async () => {
    const h = harness({ provider_auth_list: BROWSER_AND_HEADLESS });
    await handleProviderAuthMessage(h.host, {
      type: 'providerAuthSubmitCode', providerId: 'openai', methodIndex: 1, code: '   ',
    });
    expect(h.calls.some((c) => c.method === 'provider_auth_callback')).toBe(false);
  });
});

describe('a code method stops and waits for the paste', () => {
  it('does not call the callback itself when authorize answered method:"code"', async () => {
    const h = harness({
      provider_auth_list: BROWSER_AND_HEADLESS,
      provider_auth_authorize: { ok: true, url: 'https://auth.x.ai/device', method: 'code', instructions: 'Enter code: AB-12' },
    });
    await handleProviderAuthMessage(h.host, { type: 'providerAuthStart', providerId: 'xai', methodIndex: 1 });
    expect(h.calls.some((c) => c.method === 'provider_auth_callback')).toBe(false);
    expect(h.posted.find((p) => p['type'] === 'providerAuthPending')).toMatchObject({ method: 'code' });
  });
});

describe('the message-type registry', () => {
  it('names exactly the three messages the form sends', () => {
    expect([...PROVIDER_AUTH_MESSAGE_TYPES].sort())
      .toEqual(['providerAuthRequest', 'providerAuthStart', 'providerAuthSubmitCode']);
  });
});
