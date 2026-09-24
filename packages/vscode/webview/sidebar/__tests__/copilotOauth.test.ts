// GitHub Copilot as an OAuth connection — the catalog entry, the card states,
// and the DEVICE CODE the user has to read off the screen and type into GitHub.
//
// WHY THIS IS ITS OWN FILE. Copilot is the first OAuth connection whose ONLY
// method is a device-code flow. OpenAI and xAI both lead with a loopback PKCE
// browser flow, so the pane never had to show a user code at all: it opened a
// URL, said "waiting", and the redirect did the rest. Copilot's plugin answers
// with `instructions: "Enter code: XXXX-XXXX"` and a github.com/login/device
// URL — the code IS the flow, and a code buried mid-sentence in a hint line is
// a code the user mistypes.
//
// The engine plugin is packages/engine/src/plugin/github-copilot/copilot.ts;
// `auth.methods[0]` is the oauth entry and `authorize()` defaults to github.com
// when no prompt answers are supplied, which is exactly what ACP sends
// (acp/provider-auth.ts passes no `inputs`).

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import ControlStrip from '../ControlStrip.svelte';
import { SETUP_PROVIDERS } from '../setupCatalog';
import { classifySection } from '../connectionSection';
import { oauthCardState } from '../oauthCard';
import { deviceCodeOf, oauthFormHint } from '../oauthForm';
import { oauthEntryFor } from '../providerIdentity';
import { OAUTH_PROVIDERS } from '../../../src/dashboard/oauthConnections';

const COPILOT = 'github-copilot';

function postFromHost(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function posted(type: string) {
  return globalThis.__vscodeApiMock.postMessage.mock.calls
    .map((c: unknown[]) => c[0] as Record<string, unknown>)
    .filter((c) => c.type === type);
}

/** Add provider -> Providers -> GitHub Copilot (OAuth). The real click path:
 *  Copilot buckets with the aggregators, not with Labs (connectionSection.ts). */
async function openCopilotForm(methods: Record<string, unknown>, connected: Record<string, unknown> = {}) {
  render(ControlStrip);
  postFromHost({ type: 'providerAuthData', methods, connected });
  await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
  await fireEvent.click(screen.getByRole('button', { name: /Providers/ }));
  await fireEvent.click(screen.getByRole('button', { name: 'GitHub Copilot (OAuth)' }));
}

beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
});
afterEach(() => cleanup());

describe('the GitHub Copilot catalog entry', () => {
  const spec = () => OAUTH_PROVIDERS[COPILOT];

  it('exists, and names the engine provider id the plugin registers', () => {
    // plugin/github-copilot/copilot.ts -> `provider: { id: "github-copilot" }`.
    // A different id here means provider_auth_authorize addresses a provider
    // the engine has no auth hook for, and the sign-in button does nothing.
    expect(spec()).toBeDefined();
    expect(spec().id).toBe(COPILOT);
    expect(spec().npm).toBe('@ai-sdk/github-copilot');
  });

  it('the default model is one the plugin itself names as always-served', () => {
    // copilot.ts's UTILITY_MODELS is the only model list the plugin source
    // carries: the ids GitHub serves for title generation on every plan. The
    // default a fresh connection writes has to be one of those, because the
    // picker list a signed-in account gets is decided by GitHub, not by us.
    expect(['gpt-5.4-nano', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini']).toContain(spec().defaultModel);
    expect(Object.keys(spec().models)).toContain(spec().defaultModel);
  });

  it('every seed model declares the Copilot API base, so a snapshot-less engine still dials GitHub', () => {
    // provider.ts resolves a model's url as
    //   `model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[id]?.api ?? ""`
    // An engine spawned from source (origami.devEngineSource) has NO baked
    // models.dev snapshot, so the two middle fallbacks are empty and an
    // undeclared url leaves createOpenaiCompatible on its OWN default —
    // https://api.openai.com/v1. Every request would go to the wrong company.
    for (const [id, model] of Object.entries(spec().models)) {
      expect(model.provider?.api, `${id} must carry the Copilot base URL`).toBe('https://api.githubcopilot.com');
    }
  });

  it('the hint is honest about the v1 limits', () => {
    // github.com only: ACP sends no prompt answers, so the plugin's
    // deploymentType prompt is never asked and `authorize(inputs = {})`
    // defaults to github.com. Promising Enterprise here would be a lie.
    const hint = spec().hint;
    expect(hint).toMatch(/github\.com/i);
    expect(hint).toMatch(/Enterprise/i);
  });
});

describe('the picker row and where it sits', () => {
  const row = () => SETUP_PROVIDERS.find((p) => p.id === 'github-copilot-oauth');

  it('is an oauth row pointing at the github-copilot provider', () => {
    expect(row()).toBeDefined();
    expect(row()!.kind).toBe('oauth');
    expect(row()!.authProvider).toBe(COPILOT);
    // An oauth row ships no model id — the host writes the whole seed catalog.
    expect(row()!.model).toBe('');
  });

  it('buckets with the aggregators, not with Labs and not into Other', () => {
    // One subscription, many model families (GPT, Claude, Gemini) behind it —
    // the same shape connectionSection.ts already reads as an aggregator for
    // OpenRouter and OpenCode. 'other' is the nothing-matched fallback, and
    // Labs is for a lab's OWN first-party endpoint.
    expect(classifySection({ id: COPILOT })).toBe('providers');
  });

  it('the settings fold finds this row when it offers a Copilot sign-in', () => {
    expect(oauthEntryFor(COPILOT)).toBe('github-copilot-oauth');
  });
});

describe('the connection card for github-copilot', () => {
  it('offers a sign-in even when the credential read came back empty', () => {
    const card = oauthCardState(COPILOT, 'GitHub Copilot', {});
    expect(card.canAuthorize).toBe(true);
    expect(card.actionLabel).toBe('Sign in…');
    expect(card.entryId).toBe('github-copilot-oauth');
  });

  it('reads a stored oauth credential as Signed in', () => {
    const card = oauthCardState(COPILOT, 'GitHub Copilot', { [COPILOT]: { type: 'oauth' } });
    expect(card.signedIn).toBe(true);
    expect(card.statusLabel).toBe('Signed in');
    expect(card.actionLabel).toBe('Reauthorize…');
  });

  it('reads a refused credential as Needs sign-in, in the provider’s own words', () => {
    const refused = 'GitHub refused the stored token (401)';
    const card = oauthCardState(COPILOT, 'GitHub Copilot', { [COPILOT]: { type: 'oauth', needsReauth: refused } });
    expect(card.statusLabel).toBe('Needs sign-in');
    expect(card.needsReauth).toBe(refused);
  });
});

describe('deviceCodeOf — pulling the user code out of the plugin’s instructions', () => {
  it('reads the copilot plugin’s exact wording', () => {
    expect(deviceCodeOf('Enter code: A1B2-C3D4')).toBe('A1B2-C3D4');
  });

  it('reads the xai headless wording, where the code trails a sentence', () => {
    expect(deviceCodeOf('Open https://x.ai/device on any device and enter code: WXYZ-9999')).toBe('WXYZ-9999');
  });

  it('survives the host appending its could-not-open-the-browser note', () => {
    // providerAuthPane.start posts `${instructions}${launchNote}` as one string.
    const note = ' (could not open your browser automatically — spawn EACCES; open the URL below yourself)';
    expect(deviceCodeOf(`Enter code: A1B2-C3D4${note}`)).toBe('A1B2-C3D4');
  });

  it('finds no code in a browser-flow instruction, so nothing is shown', () => {
    expect(deviceCodeOf('Complete authorization in your browser. This window will close automatically.')).toBe('');
    expect(deviceCodeOf('')).toBe('');
    expect(deviceCodeOf(undefined)).toBe('');
  });

  it('does not mistake a trailing full stop or quote for part of the code', () => {
    expect(deviceCodeOf('Enter code: A1B2-C3D4.')).toBe('A1B2-C3D4');
  });

  // The launch note is host prose wrapped around an OS error message, and an
  // OS error says "code:" all the time ("exit code: 1", "error code: 0x…").
  // A BROWSER flow has no code of its own, so the note's is the FIRST match
  // and the pane would put a big spaced-out "Your code: 1" with a Copy button
  // in front of someone whose only real problem is that a browser did not
  // open. The three device-code methods in the engine all say "enter code:"
  // (github-copilot/copilot.ts:263, openai/codex.ts:533, xai.ts:634), which
  // no OS error does.
  it('a browser flow whose launch note carries an OS error code shows NO code', () => {
    const note =
      ' (could not open your browser automatically — Command failed with exit code: 1; open the URL below yourself)';
    expect(deviceCodeOf(`Complete authorization in your browser. This window will close automatically.${note}`)).toBe('');
    expect(deviceCodeOf(`Complete authorization in your browser.${note.replace('exit code: 1', 'error code: 0x80004005')}`)).toBe('');
  });
});

describe('the sign-in form, driven by real host messages', () => {
  it('offers the plugin’s device-code method and posts its index', async () => {
    await openCopilotForm({ [COPILOT]: [{ index: 0, label: 'Login with GitHub Copilot' }] });
    await fireEvent.click(await screen.findByRole('button', { name: 'Login with GitHub Copilot' }));
    expect(posted('providerAuthStart')).toEqual([
      { type: 'providerAuthStart', providerId: COPILOT, methodIndex: 0 },
    ]);
  });

  it('shows the code as its own field, plus the verification URL', async () => {
    await openCopilotForm({ [COPILOT]: [{ index: 0, label: 'Login with GitHub Copilot' }] });
    await fireEvent.click(await screen.findByRole('button', { name: 'Login with GitHub Copilot' }));
    postFromHost({
      type: 'providerAuthPending',
      providerId: COPILOT,
      url: 'https://github.com/login/device',
      method: 'auto',
      instructions: 'Enter code: A1B2-C3D4',
    });

    // The code on its own, not only buried inside the waiting sentence.
    const code = await screen.findByTestId('oauth-device-code');
    expect(code).toHaveTextContent('A1B2-C3D4');
    expect(screen.getByText('https://github.com/login/device')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });

  it('Copy code puts the code — and nothing else — on the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await openCopilotForm({ [COPILOT]: [{ index: 0, label: 'Login with GitHub Copilot' }] });
    await fireEvent.click(await screen.findByRole('button', { name: 'Login with GitHub Copilot' }));
    postFromHost({
      type: 'providerAuthPending',
      providerId: COPILOT,
      url: 'https://github.com/login/device',
      method: 'auto',
      instructions: 'Enter code: A1B2-C3D4',
    });
    await fireEvent.click(await screen.findByRole('button', { name: 'Copy code' }));

    expect(writeText).toHaveBeenCalledWith('A1B2-C3D4');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
  });

  it('a refused clipboard leaves the button honest instead of claiming a copy', async () => {
    // A webview can be denied clipboard-write, and an older host may expose no
    // navigator.clipboard at all. Saying "Copied" then is a lie the user acts
    // on — they paste whatever was already on the clipboard into GitHub.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('NotAllowedError')) },
      configurable: true,
    });

    await openCopilotForm({ [COPILOT]: [{ index: 0, label: 'Login with GitHub Copilot' }] });
    await fireEvent.click(await screen.findByRole('button', { name: 'Login with GitHub Copilot' }));
    postFromHost({
      type: 'providerAuthPending', providerId: COPILOT,
      url: 'https://github.com/login/device', method: 'auto', instructions: 'Enter code: A1B2-C3D4',
    });
    await fireEvent.click(await screen.findByRole('button', { name: 'Copy code' }));

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
    // …and the code itself is still there to select by hand.
    expect(screen.getByTestId('oauth-device-code')).toHaveTextContent('A1B2-C3D4');
  });

  it('a browser-only flow shows no code field at all', async () => {
    // The regression guard: OpenAI's loopback method carries no code, and an
    // empty box labelled "Your code" would be a thing to hunt for that is not
    // there.
    render(ControlStrip);
    postFromHost({ type: 'providerAuthData', methods: { openai: [{ index: 0, label: 'Browser' }] }, connected: {} });
    await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    await fireEvent.click(screen.getByRole('button', { name: /Labs/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'OpenAI (OAuth)' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Browser' }));
    postFromHost({
      type: 'providerAuthPending',
      providerId: 'openai',
      url: 'https://auth.openai.com/x',
      method: 'auto',
      instructions: 'Complete authorization in your browser. This window will close automatically.',
    });

    await waitFor(() => expect(screen.getByText(/Waiting for sign-in/)).toBeInTheDocument());
    expect(screen.queryByTestId('oauth-device-code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull();
  });

  it('the form carries the Copilot hint, and the engine’s failure verbatim', async () => {
    await openCopilotForm({ [COPILOT]: [{ index: 0, label: 'Login with GitHub Copilot' }] });
    expect(await screen.findByText(oauthFormHint(COPILOT))).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Login with GitHub Copilot' }));
    postFromHost({
      type: 'providerAuthFailed',
      providerId: COPILOT,
      message: 'Failed to initiate device authorization',
    });
    await waitFor(() => expect(screen.getByText('Failed to initiate device authorization')).toBeInTheDocument());
  });

  // ONE `oauthState` SERVES THREE PROVIDERS NOW, and the waiting/failed/done
  // block never asks whose result it is holding: `providerAuthFailed` and
  // `providerAuthDone` are taken whatever `providerId` they name, unlike
  // `providerAuthPending`. What keeps that honest is ONE line in
  // `applyProviderDefaults` — `oauthState = { phase: 'idle' }` on picking an
  // OAuth row — and `closeProviderSetup` does not clear it, so nothing else
  // would. Both of these go red when that line is removed (proven), which is
  // the point: the next form opened must not wear the last one's outcome —
  // OpenAI's fold reporting a GitHub failure, or worse, "Signed in, reload the
  // window" for an account nobody signed into.
  it('a failure belongs to the provider that produced it, not to the next form opened', async () => {
    await openCopilotForm({
      [COPILOT]: [{ index: 0, label: 'Login with GitHub Copilot' }],
      openai: [{ index: 0, label: 'Browser' }],
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Login with GitHub Copilot' }));
    postFromHost({ type: 'providerAuthFailed', providerId: COPILOT, message: 'Failed to initiate device authorization' });
    await waitFor(() => expect(screen.getByText('Failed to initiate device authorization')).toBeInTheDocument());

    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    await fireEvent.click(screen.getByRole('button', { name: /Labs/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'OpenAI (OAuth)' }));

    expect(screen.queryByText('Failed to initiate device authorization')).toBeNull();
  });

  it('a SUCCESS does not follow the reader into the next provider’s form', async () => {
    await openCopilotForm({
      [COPILOT]: [{ index: 0, label: 'Login with GitHub Copilot' }],
      openai: [{ index: 0, label: 'Browser' }],
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Login with GitHub Copilot' }));
    postFromHost({ type: 'providerAuthDone', providerId: COPILOT, model: 'gpt-4.1' });
    await waitFor(() => expect(screen.getByText(/Signed in — default model gpt-4\.1/)).toBeInTheDocument());

    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    await fireEvent.click(screen.getByRole('button', { name: /Labs/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'OpenAI (OAuth)' }));

    // Telling someone they are signed in to a provider they have not touched
    // is the one of the two that costs them a window reload to disprove.
    expect(screen.queryByText(/Signed in — default model/)).toBeNull();
  });
});

describe('oauthFormHint — one hint per provider, no silent fallback', () => {
  it('keeps the two shipped hints word for word', () => {
    // Extracting the if/else chain out of the markup must not reword anything a
    // user already reads. oauthConnections.mirror.test.ts asserts these two
    // phrases against the RENDERED form; they are asserted here against the
    // leaf so a regression names the leaf rather than the component.
    expect(oauthFormHint('xai')).toMatch(/403/);
    expect(oauthFormHint('xai')).toMatch(/API-key entry instead/);
    expect(oauthFormHint('openai')).toMatch(/ChatGPT subscription backend/);
  });

  it('gives Copilot its own hint rather than OpenAI’s', () => {
    // The old markup was `{#if oauthTarget === 'xai'} … {:else} …`, so ANY id
    // that was not xai got OpenAI's sentence — a third provider included.
    const hint = oauthFormHint(COPILOT);
    expect(hint).toMatch(/github\.com/i);
    expect(hint).toMatch(/Enterprise/i);
    expect(hint).not.toMatch(/ChatGPT/);
  });

  it('answers an unknown target with nothing rather than another provider’s copy', () => {
    expect(oauthFormHint('')).toBe('');
    expect(oauthFormHint('lmstudio')).toBe('');
  });

  it('every OAuth provider in the catalog has a form hint', () => {
    for (const id of Object.keys(OAUTH_PROVIDERS)) {
      expect(oauthFormHint(id).length, `${id} hint`).toBeGreaterThan(0);
    }
  });
});
