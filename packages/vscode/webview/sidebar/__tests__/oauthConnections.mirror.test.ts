// MIRROR DRIFT GUARD + form contract for the two OAuth connections.
//
// The OAuth entries are declared twice by necessity: the catalog row lives in
// ControlStrip.svelte (tsconfig.webview.json pins rootDir to webview/, so the
// component cannot import a runtime value out of src/) and the provider spec it
// signs into lives in src/dashboard/oauthConnections.ts. Same house pattern as
// keyOnlyPresets.mirror.test.ts, and the same cost if it drifts:
//   - an `authProvider` the host does not know -> the sign-in button posts a
//     message providerAuthPane silently drops, and nothing at all happens.
//   - a duplicate catalog id -> Svelte's keyed {#each} throws at runtime, in a
//     component no unit test renders past.
//
// The rendered half asserts the FORM SHAPE, not colours: jsdom has no layout
// engine (vitest.config.mts does not set css: true), so anything read off a
// computed style here would be asserting nothing.

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import ControlStrip from '../ControlStrip.svelte';
import { lightOf } from '../providerGrid';
import { OAUTH_PROVIDERS } from '../../../src/dashboard/oauthConnections';
import { SETUP_PROVIDERS } from '../setupCatalog';

interface StripEntry { id: string; kind: string; authProvider?: string; label: string }

/** The webview catalog, IMPORTED now that it is a module rather than scraped out
 *  of the component source. Same comparison, real values. */
function stripEntries(): StripEntry[] {
  return SETUP_PROVIDERS.map((p) => ({
    id: p.id,
    kind: p.kind,
    ...(p.authProvider !== undefined ? { authProvider: p.authProvider } : {}),
    label: p.label,
  }));
}

function postFromHost(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

/**
 * Open the add form and select one OAuth entry.
 *
 * The Labs section is COLLAPSED by default, so an OAuth connection is three
 * clicks deep — Add provider, Labs, the entry. That is the real path and the
 * test walks it rather than reaching past it: the entries sit under Labs
 * beside their API-key twins precisely because `sectionOf` buckets them by
 * `authProvider`, and a regression there would put them under "Other" where
 * this helper would stop finding them.
 */
async function openOauthForm(label: string) {
  await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
  await fireEvent.click(screen.getByRole('button', { name: /Labs/ }));
  await fireEvent.click(screen.getByRole('button', { name: label }));
}

const posted: Array<Record<string, unknown>> = [];
(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: Record<string, unknown>) => void posted.push(m),
  getState: () => undefined,
  setState: () => undefined,
});

afterEach(() => {
  cleanup();
  posted.length = 0;
});

describe('the OAuth catalog rows and the host provider specs agree', () => {
  const entries = stripEntries();

  it('the parser actually found the catalog (guards a silently-passing test)', () => {
    expect(entries.length).toBeGreaterThan(8);
    expect(entries.map((e) => e.id)).toContain('openai-oauth');
  });

  it('every oauth row names a provider the host can actually sign into', () => {
    const oauthRows = entries.filter((e) => e.kind === 'oauth');
    expect(oauthRows.map((e) => e.authProvider).sort()).toEqual(Object.keys(OAUTH_PROVIDERS).sort());
  });

  it('catalog ids are unique — a duplicate is a runtime crash in the keyed each', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the OAuth rows do not collide with the API-key rows they sit beside', () => {
    for (const row of entries.filter((e) => e.kind === 'oauth')) {
      expect(row.id).not.toBe(row.authProvider);
      expect(entries.some((e) => e.id === row.authProvider), `${row.authProvider} API-key entry must survive`).toBe(true);
    }
  });

  it('an oauth row ships no model id — the host writes the whole catalog instead', () => {
    for (const row of entries.filter((e) => e.kind === 'oauth')) {
      expect(SETUP_PROVIDERS.find((p) => p.id === row.id)?.model).toBe('');
    }
  });
});

describe('the pill light for an OAuth connection', () => {
  it('is green on a stored credential even though the host probe says "not configured"', () => {
    // This is EXACTLY what broadcastProviderStatus reports for an OAuth block:
    // no baseURL and no apiKey, so its key-presence branch falls through.
    expect(lightOf({ name: 'OpenAI (ChatGPT)', live: false, reason: 'not configured', oauth: true })).toBe('green');
  });

  it('still goes red for a genuinely-failed provider with no credential', () => {
    expect(lightOf({ name: 'OpenAI', live: false, reason: 'not configured' })).toBe('red');
  });
});

describe('the OAuth sign-in form', () => {
  it('asks the host for the sign-in options on mount', () => {
    render(ControlStrip);
    expect(posted.some((m) => m['type'] === 'providerAuthRequest')).toBe(true);
  });

  it('shows one button per OAuth method and none for the plugin API-key entry', async () => {
    render(ControlStrip);
    postFromHost({
      type: 'providerAuthData',
      // Host-side already strips the api method; this is its real payload shape.
      methods: { openai: [{ index: 0, label: 'ChatGPT Pro/Plus (browser)' }, { index: 1, label: 'ChatGPT Pro/Plus (headless)' }], xai: [] },
      connected: {},
    });
    await openOauthForm('OpenAI (OAuth)');

    expect(await screen.findByRole('button', { name: 'ChatGPT Pro/Plus (browser)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ChatGPT Pro/Plus (headless)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manually enter API Key' })).toBeNull();
    // No key/URL/model fields at all — the whole point of the entry.
    expect(screen.queryByLabelText('Provider API key')).toBeNull();
    expect(screen.queryByLabelText('Model id')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('a method click posts providerAuthStart with that method\'s index', async () => {
    render(ControlStrip);
    postFromHost({
      type: 'providerAuthData',
      methods: { openai: [], xai: [{ index: 0, label: 'SuperGrok' }, { index: 1, label: 'Headless' }] },
      connected: {},
    });
    await openOauthForm('Grok (OAuth)');
    await fireEvent.click(await screen.findByRole('button', { name: 'Headless' }));

    expect(posted.filter((m) => m['type'] === 'providerAuthStart')).toEqual([
      { type: 'providerAuthStart', providerId: 'xai', methodIndex: 1 },
    ]);
  });

  it('shows the waiting state and the URL the host opened, then the failure verbatim', async () => {
    render(ControlStrip);
    postFromHost({ type: 'providerAuthData', methods: { openai: [], xai: [{ index: 0, label: 'SuperGrok' }] }, connected: {} });
    await openOauthForm('Grok (OAuth)');
    await fireEvent.click(await screen.findByRole('button', { name: 'SuperGrok' }));

    postFromHost({ type: 'providerAuthPending', providerId: 'xai', url: 'https://auth.x.ai/oauth2/authorize?x=1', method: 'auto', instructions: 'Complete authorization in your browser.' });
    await waitFor(() => expect(screen.getByText(/Waiting for sign-in/)).toBeInTheDocument());
    expect(screen.getByText('https://auth.x.ai/oauth2/authorize?x=1')).toBeInTheDocument();

    postFromHost({ type: 'providerAuthFailed', providerId: 'xai', message: 'xAI device authorization was denied' });
    await waitFor(() => expect(screen.getByText('xAI device authorization was denied')).toBeInTheDocument());
  });

  it('a "code" method reveals the paste box and submits the code', async () => {
    render(ControlStrip);
    postFromHost({ type: 'providerAuthData', methods: { openai: [{ index: 1, label: 'Headless' }], xai: [] }, connected: {} });
    await openOauthForm('OpenAI (OAuth)');
    await fireEvent.click(await screen.findByRole('button', { name: 'Headless' }));
    postFromHost({ type: 'providerAuthPending', providerId: 'openai', url: 'https://auth.openai.com/codex/device', method: 'code', instructions: 'Enter code: WXYZ' });

    const box = await screen.findByLabelText('Authorization code');
    await fireEvent.input(box, { target: { value: 'WXYZ-9999' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(posted.filter((m) => m['type'] === 'providerAuthSubmitCode')).toEqual([
      { type: 'providerAuthSubmitCode', providerId: 'openai', methodIndex: 1, code: 'WXYZ-9999' },
    ]);
  });

  it('the Grok form carries the 403-by-tier fallback line, and the OpenAI one names the ChatGPT backend', async () => {
    render(ControlStrip);
    postFromHost({ type: 'providerAuthData', methods: { openai: [{ index: 0, label: 'Browser' }], xai: [{ index: 0, label: 'SuperGrok' }] }, connected: {} });
    await openOauthForm('Grok (OAuth)');
    expect(await screen.findByText(/403/)).toBeInTheDocument();
    expect(screen.getByText(/API-key entry instead/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'OpenAI (OAuth)' }));
    expect(await screen.findByText(/ChatGPT subscription backend/)).toBeInTheDocument();
  });
});
