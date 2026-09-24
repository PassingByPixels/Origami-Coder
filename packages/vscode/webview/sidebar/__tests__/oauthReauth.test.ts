// The two ways an OAuth connection used to become unrecoverable from the UI.
//
// The owner hit both on the same evening (2026-09-02): a test run rotated the
// stored xAI refresh_token, every Grok turn started failing, and
//   (1) the fold's "Re-authorize…" button was GONE, and
//   (2) "Add provider → Grok (OAuth)" opened a form with nothing to click.
// Two removals and two re-adds later it came back by luck.
//
// Neither is about xAI. (1) gated the action on `providerAuthData.connected`,
// a map the host answers EMPTY whenever it has no live chat client to ask the
// engine through (providerAuthPane.listPayload) — so the action disappeared for
// a reason that has nothing to do with the provider. (2) rendered the engine's
// method list and, when that list was empty for the same reason, a sentence and
// no button.
//
// These render the REAL ControlStrip from host messages, because both bugs were
// invisible in every unit under it: each individual piece was correct.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, beforeEach } from 'vitest';
import ControlStrip from '../ControlStrip.svelte';
import { oauthCardState, signInOptions, FALLBACK_SIGN_IN } from '../oauthCard';

function postFromHost(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

const GROK = { id: 'xai', name: 'xAI', live: false };
const REFUSED = 'xAI token refresh failed (400): {"error":"invalid_grant"}';

function posted(type: string) {
  return globalThis.__vscodeApiMock.postMessage.mock.calls
    .map((c: unknown[]) => c[0] as Record<string, unknown>)
    .filter((c) => c.type === type);
}

/** Open the Grok fold with whatever provider-auth state the host reported. */
async function openGrokFold(connected: Record<string, unknown>, methods: Record<string, unknown> = {}) {
  render(ControlStrip);
  postFromHost({ type: 'providerStatus', providers: [GROK] });
  postFromHost({ type: 'providerAuthData', methods, connected });
  await fireEvent.click(await screen.findByRole('button', { name: /xAI/i }));
}

describe('oauthCard — the decisions', () => {
  it('flags a refused credential with the provider’s own words', () => {
    const card = oauthCardState('xai', 'xAI', { xai: { type: 'oauth', needsReauth: REFUSED } });
    expect(card.needsReauth).toBe(REFUSED);
    expect(card.statusLabel).toBe('Needs sign-in');
    expect(card.actionLabel).toBe('Reauthorize…');
    expect(card.entryId).toBe('xai-oauth');
  });

  it('still offers the action when the credential read came back EMPTY', () => {
    // The regression: an empty map is "could not ask", not "no OAuth here".
    const card = oauthCardState('xai', 'xAI', {});
    expect(card.canAuthorize).toBe(true);
    expect(card.actionLabel).toBe('Sign in…');
    expect(card.needsReauth).toBe('');
  });

  it('offers nothing for a provider with no OAuth entry in the catalog', () => {
    const card = oauthCardState('lmstudio', 'LM Studio', {}, true);
    expect(card.canAuthorize).toBe(false);
    expect(card.entryId).toBe('');
    expect(card.statusLabel).toBe('Live');
  });

  it('an api-key credential is not a sign-in', () => {
    const card = oauthCardState('xai', 'xAI', { xai: { type: 'api' } });
    expect(card.signedIn).toBe(false);
    expect(card.needsReauth).toBe('');
  });

  it('signInOptions never hands the form an empty list', () => {
    expect(signInOptions(undefined)).toEqual([FALLBACK_SIGN_IN]);
    expect(signInOptions([])).toEqual([FALLBACK_SIGN_IN]);
    const real = [{ index: 0, label: 'Browser' }, { index: 1, label: 'Headless' }];
    expect(signInOptions(real)).toBe(real);
  });
});

describe('the connection card, from the engine’s status', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockReset());

  it('a refused credential shows the reason and a Reauthorize button', async () => {
    await openGrokFold({ xai: { type: 'oauth', needsReauth: REFUSED } });
    expect(screen.getByRole('alert')).toHaveTextContent(/Needs reauthorization/);
    expect(screen.getByRole('alert')).toHaveTextContent(/invalid_grant/);
    expect(screen.getByRole('button', { name: 'Reauthorize…' })).toBeInTheDocument();
  });

  it('a HEALTHY credential shows the action but no alarm', async () => {
    await openGrokFold({ xai: { type: 'oauth', expires: Date.now() + 3.6e6 } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reauthorize…' })).toBeInTheDocument();
  });

  it('THE REGRESSION: the action survives a credential read that came back empty', async () => {
    // Exactly what the host posts when there is no live chat client to ask.
    await openGrokFold({}, {});
    expect(screen.getByRole('button', { name: 'Sign in…' })).toBeInTheDocument();
    // …and it is not the API-key-only copy the fold used to fall through to.
    expect(screen.queryByText(/API key is the connection\. Re-key to replace it\./)).toBeNull();
  });

  it('Reauthorize opens the OAuth sign-in form for that provider', async () => {
    await openGrokFold({ xai: { type: 'oauth', needsReauth: REFUSED } });
    await fireEvent.click(screen.getByRole('button', { name: 'Reauthorize…' }));
    expect(await screen.findByText('Sign in')).toBeInTheDocument();
    // The form asks the engine for this provider's methods on open.
    expect(posted('providerAuthRequest').length).toBeGreaterThan(0);
  });
});

describe('the add flow for an already-configured OAuth provider', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockReset());

  it('THE REGRESSION: opens the auth flow even when the engine reported NO methods', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await fireEvent.click(await screen.findByRole('button', { name: /^Labs$/i }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Grok (OAuth)' }));
    // The host could not ask the engine: empty methods, an error line.
    postFromHost({ type: 'providerAuthData', methods: {}, connected: {}, error: 'Open a chat first.' });

    const signIn = await screen.findByRole('button', { name: FALLBACK_SIGN_IN.label });
    await fireEvent.click(signIn);
    expect(posted('providerAuthStart')).toContainEqual({
      type: 'providerAuthStart',
      providerId: 'xai',
      methodIndex: FALLBACK_SIGN_IN.index,
    });
    // The reason is still shown — the button is an offer, not a claim that all is well.
    expect(screen.getByText('Open a chat first.')).toBeInTheDocument();
  });

  it('uses the engine’s real methods when it has them', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await fireEvent.click(await screen.findByRole('button', { name: /^Labs$/i }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Grok (OAuth)' }));
    postFromHost({
      type: 'providerAuthData',
      methods: { xai: [{ index: 0, label: 'SuperGrok browser' }, { index: 1, label: 'Headless' }] },
      connected: {},
    });
    await fireEvent.click(await screen.findByRole('button', { name: 'Headless' }));
    expect(posted('providerAuthStart')).toContainEqual({
      type: 'providerAuthStart',
      providerId: 'xai',
      methodIndex: 1,
    });
    expect(screen.queryByRole('button', { name: FALLBACK_SIGN_IN.label })).toBeNull();
  });
});
