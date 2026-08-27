// Wiring guard tests for the chat shell + the ControlStrip, ALIGNED to the
// current architecture (2026-07-14):
//   - ChatView has two modes: the plain sidebar mounts SidebarLauncher
//     (Settings + Chats); a popped-out solo tab mounts ChatPane + an honest
//     status badge. Chat threads live in their own editor tabs.
//   - ControlStrip is CONNECTIONS ONLY — provider pills + per-provider settings
//     folds (endpoint / view-models / rep / re-key / remove). Model + context
//     SELECTION moved to the chat pane's ModelPicker, so the old top-level
//     switchModel / modelPanel.refresh / modelPanel.swap / Apply / status pill
//     are GONE from here (guarded below).
//
// These are NOT echo tests. Each breaks on a specific regression:
//   1. ChatView faking connection status instead of reading `modelStatus`.
//   2. The control strip not driving the REAL connection messages
//      (setEngineUrl / setupProvider) or leaking the retired model controls.

import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ChatView from '../../chat/ChatView.svelte';
import ControlStrip from '../ControlStrip.svelte';

function postFromHost(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

const ACP_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

afterEach(() => {
  delete (window as unknown as { __ORIGAMI_SOLO_SESSION__?: string }).__ORIGAMI_SOLO_SESSION__;
});

describe('ChatView — sidebar mounts the launcher, solo mounts the thread', () => {
  it('the plain sidebar mounts SidebarLauncher (Settings + Chats), not a chat thread', () => {
    render(ChatView);
    // SidebarLauncher's section labels + new-chat action.
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Chats')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New chat/ })).toBeInTheDocument();
  });

  it('a solo tab mounts ChatPane + an honest status badge (Offline until modelStatus.ok)', async () => {
    (window as unknown as { __ORIGAMI_SOLO_SESSION__?: string }).__ORIGAMI_SOLO_SESSION__ = ACP_UUID;
    render(ChatView);
    // Honest default: Offline until a real modelStatus.ok arrives.
    expect(screen.getByText('Offline')).toBeInTheDocument();
    postFromHost({
      type: 'sessionCreated',
      sessionId: ACP_UUID,
      sessionNumber: 1,
      agentName: 'Origami',
      agentArt: null,
    });
    postFromHost({
      type: 'modelStatus',
      ok: true,
      modelName: 'qwen-coder',
      state: 'loaded',
      contextWindow: 32768,
    });
    // The model name surfaces (honest status). It appears in the header badge
    // AND the chat-pane picker, so assert presence, not a single instance.
    await waitFor(() => expect(screen.getAllByText('qwen-coder').length).toBeGreaterThan(0));
    // The composer is mounted in the solo thread.
    expect(document.querySelector('textarea')).not.toBeNull();
  });

  it('the shell source mounts ChatPane + SidebarLauncher, NOT App.svelte / the old pane grid', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'chat', 'ChatView.svelte'), 'utf-8');
    expect(src).toMatch(/ChatPane/);
    expect(src).toMatch(/SidebarLauncher/);
    expect(src).not.toMatch(/App\.svelte/);
    expect(src).not.toMatch(/ModelPanel|HistoryPane|SkillsPane|ActivityFeed/);
  });

  it('the chat entry mounts ChatView, not the old combined Sidebar', () => {
    const main = readFileSync(join(__dirname, '..', '..', 'chat', 'main.ts'), 'utf-8');
    expect(main).toMatch(/ChatView/);
    expect(main).not.toMatch(/Sidebar/);
  });
});

describe('ControlStrip — connections only (pills + folds, no model selection)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('the retired model controls are GONE (no select-model / Apply / Online-Offline pill)', () => {
    render(ControlStrip);
    // Model selection + context + status moved to the chat pane's ModelPicker.
    expect(screen.queryByText('select model')).toBeNull();
    expect(screen.queryByText('Apply')).toBeNull();
    expect(screen.queryByText('Online')).toBeNull();
    expect(screen.queryByText('Offline')).toBeNull();
  });

  it('with no providers configured, offers + Add provider', () => {
    render(ControlStrip);
    expect(screen.getByText(/Add provider/)).toBeInTheDocument();
  });

  it('a configured provider renders as a pill; clicking it opens its settings fold (engine endpoint)', async () => {
    render(ControlStrip);
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true }] });
    const pill = await screen.findByRole('button', { name: /LM Studio/i });
    await fireEvent.click(pill);
    // The LM Studio fold reveals the engine-endpoint input (a connection setting).
    const input = await screen.findByPlaceholderText('http://127.0.0.1:1234/v1');
    expect(input).toBeInTheDocument();
  });

  it('saving the engine endpoint posts the REAL setEngineUrl message', async () => {
    render(ControlStrip);
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true }] });
    await fireEvent.click(await screen.findByRole('button', { name: /LM Studio/i }));
    const input = await screen.findByPlaceholderText('http://127.0.0.1:1234/v1') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'http://192.0.2.10:1234/v1' } });
    // Target the endpoint Save specifically (the fold also has a concurrency Save).
    await fireEvent.click(screen.getByTitle('Save endpoint + reconnect origami-acp'));
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setEngineUrl',
      url: 'http://192.0.2.10:1234/v1',
    });
  });

  it('Save is disabled (posts nothing) for an empty endpoint', async () => {
    render(ControlStrip);
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true }] });
    await fireEvent.click(await screen.findByRole('button', { name: /LM Studio/i }));
    await screen.findByPlaceholderText('http://127.0.0.1:1234/v1');
    const save = screen.getByTitle('Save endpoint + reconnect origami-acp') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('Add provider opens the setup fold and Connect posts the REAL setupProvider message', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    // The progressive setup fold (LM Studio default = endpoint-only).
    expect(await screen.findByLabelText(/Model provider/i)).toBeInTheDocument();
    await fireEvent.click(screen.getByText('Connect'));
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setupProvider', providerId: 'lmstudio' }),
    );
  });

  // t-o92558 round 4, on the surface the user actually touched: picking OpenCode
  // Zen and pasting a key produced NO pill, because the form sent modelId:''
  // for every keyOnly preset and the host rejected it. Round 5 reclassified
  // OpenCode from Labs to Providers (connectionSection.ts) — this preset now
  // lives under the Providers section, beside OpenRouter.
  it('a Providers key-only preset submits a REAL model id, not a blank', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await fireEvent.click(await screen.findByRole('button', { name: /^Providers$/i }));
    await fireEvent.click(await screen.findByRole('button', { name: 'OpenCode Zen' }));
    const key = screen.getByLabelText('Provider API key') as HTMLInputElement;
    await fireEvent.input(key, { target: { value: 'sk-zen' } });
    await fireEvent.click(screen.getByText('Connect'));
    const call = globalThis.__vscodeApiMock.postMessage.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((c) => c.type === 'setupProvider');
    expect(call).toBeTruthy();
    expect(call!.providerId).toBe('opencode');
    expect(call!.baseURL).toBe('https://opencode.ai/zen/v1');
    expect(call!.apiKey).toBe('sk-zen');
    expect(call!.modelId).not.toBe('');
    expect(String(call!.modelId)).not.toMatch(/^(gpt|claude)-/);
  });

  it('OpenRouter still submits a BLANK model — its host-side free-tier pick is untouched', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await fireEvent.click(await screen.findByRole('button', { name: /^Providers$/i }));
    await fireEvent.click(await screen.findByRole('button', { name: 'OpenRouter' }));
    await fireEvent.input(screen.getByLabelText('Provider API key'), { target: { value: 'sk-or' } });
    await fireEvent.click(screen.getByText('Connect'));
    const call = globalThis.__vscodeApiMock.postMessage.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((c) => c.type === 'setupProvider' && c.providerId === 'openrouter');
    expect(call!.modelId).toBe('');
  });

  it('picking a keyless-catalog preset asks the host for the live model list', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await fireEvent.click(await screen.findByRole('button', { name: /^Providers$/i }));
    await fireEvent.click(await screen.findByRole('button', { name: 'OpenCode Zen' }));
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'requestPresetModels',
      providerId: 'opencode',
      baseURL: 'https://opencode.ai/zen/v1',
    });
  });

  it('the live catalog replaces the baked default in the picker, and Connect sends the pick', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await fireEvent.click(await screen.findByRole('button', { name: /^Providers$/i }));
    await fireEvent.click(await screen.findByRole('button', { name: 'OpenCode Zen' }));
    // A /models-shaped reply (ids as the host parses them out of the real payload).
    postFromHost({
      type: 'presetModels',
      providerId: 'opencode',
      models: ['kimi-k2.7-code', 'glm-5.2', 'deepseek-v4-pro'],
      defaultModel: 'kimi-k2.7-code',
    });
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect([...select.options].map((o) => o.value)).toEqual(['kimi-k2.7-code', 'glm-5.2', 'deepseek-v4-pro']);
    await fireEvent.change(select, { target: { value: 'glm-5.2' } });
    await fireEvent.input(screen.getByLabelText('Provider API key'), { target: { value: 'sk-zen' } });
    await fireEvent.click(screen.getByText('Connect'));
    const call = globalThis.__vscodeApiMock.postMessage.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((c) => c.type === 'setupProvider');
    expect(call!.modelId).toBe('glm-5.2');
  });

  it('a catalog reply for a preset the user clicked AWAY from is ignored', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await fireEvent.click(await screen.findByRole('button', { name: /^Providers$/i }));
    await fireEvent.click(await screen.findByRole('button', { name: 'OpenCode Zen' }));
    // OpenAI is still under Labs (sections stay open independently — this
    // reaches it without closing Providers).
    await fireEvent.click(await screen.findByRole('button', { name: /^Labs$/i }));
    await fireEvent.click(await screen.findByRole('button', { name: 'OpenAI (API)' }));
    postFromHost({ type: 'presetModels', providerId: 'opencode', models: ['kimi-k2.7-code'], defaultModel: 'kimi-k2.7-code' });
    await fireEvent.input(screen.getByLabelText('Provider API key'), { target: { value: 'sk-oa' } });
    await fireEvent.click(screen.getByText('Connect'));
    const call = globalThis.__vscodeApiMock.postMessage.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((c) => c.type === 'setupProvider' && c.providerId === 'openai');
    // OpenAI's own baked default, not the stale Zen reply.
    expect(call!.modelId).toBe('gpt-5');
  });
});

// The connection surface is ALWAYS the compact grid of traffic-light squares
// (providerGrid.ts decides via useGrid; this checks ControlStrip actually
// renders that decision) — no pill phase, from the first configured provider
// on. Breaks if a pill ever reappears, or a square stops opening its fold.
describe('ControlStrip — provider grid is the layout from the first provider', () => {
  beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockReset(); });

  function providers(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `prov${i}`,
      name: `Prov${i}`,
      live: i === 0,
      kind: 'local' as const,
    }));
  }

  it('a single configured provider renders as a grid square, not a pill', async () => {
    const { container } = render(ControlStrip);
    postFromHost({ type: 'providerStatus', providers: providers(1) });
    await waitFor(() => expect(container.querySelectorAll('.grid-square').length).toBe(1));
    expect(container.querySelectorAll('.pill').length).toBe(0);
  });

  it('two configured providers render as a grid, not pills', async () => {
    const { container } = render(ControlStrip);
    postFromHost({ type: 'providerStatus', providers: providers(2) });
    await waitFor(() => expect(container.querySelectorAll('.grid-square').length).toBe(2));
    expect(container.querySelectorAll('.pill').length).toBe(0);
  });

  it('5 configured providers render as a grid of squares, with NO pills', async () => {
    const { container } = render(ControlStrip);
    postFromHost({ type: 'providerStatus', providers: providers(5) });
    await waitFor(() => expect(container.querySelectorAll('.grid-square').length).toBe(5));
    expect(container.querySelectorAll('.pill').length).toBe(0);
  });

  it('clicking a grid square opens that provider\'s settings fold', async () => {
    render(ControlStrip);
    postFromHost({ type: 'providerStatus', providers: providers(5) });
    // Prov0 is the live one — its square's accessible name is the name alone (green, no reason).
    const square = await screen.findByRole('button', { name: 'Prov0' });
    await fireEvent.click(square);
    expect(await screen.findByPlaceholderText('http://127.0.0.1:1234/v1')).toBeInTheDocument();
  });

  it('a square carries the reason in its tooltip/aria-label when red (probed and failed)', async () => {
    render(ControlStrip);
    const provs = [
      { id: 'lmstudio', name: 'LM Studio', live: true, kind: 'local' as const },
      { id: 'openrouter', name: 'OpenRouter', live: false, reason: '401 invalid key', kind: 'compat' as const },
    ];
    postFromHost({ type: 'providerStatus', providers: provs });
    const square = await screen.findByRole('button', { name: 'OpenRouter — 401 invalid key' });
    expect(square).toHaveAttribute('title', 'OpenRouter — 401 invalid key');
  });
});

// The provider picker is a collapsible Local/Self Hosted / Providers / Labs /
// Other accordion (t-kgt7wh) — everything but the first starts collapsed —
// with an "Other" generic OpenAI-compatible entry that's always its own
// visible section (never hidden inside another group). Breaks if the accordion
// reverts to a flat/always-open list, a section vanishes, or Other loses its
// custom fields.
//
// Local and Hosted were TWO sections until the merge; vLLM used to be one
// collapsed click away under "Hosted". It now sits beside LM Studio in the
// section that is already open, which is the user-visible point of the change.
describe('ControlStrip — provider setup accordion (Local/Self Hosted, Providers, Labs, Other)', () => {
  beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockReset(); });

  it('only Local/Self Hosted starts open; the other three sections are collapsed but present as headers', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await screen.findByLabelText(/Model provider/i);
    // The merged section is open by default → every self-run server is visible,
    // loopback and tailnet alike.
    expect(screen.getByRole('button', { name: 'LM Studio (local)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ollama (local)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'vLLM (self-hosted)' })).toBeInTheDocument();
    // The other three section headers render, but their options don't (collapsed).
    for (const header of ['Providers', 'Labs', 'Other']) {
      expect(screen.getByRole('button', { name: header })).toBeInTheDocument();
    }
    // The section that no longer exists must be GONE, not merely empty.
    expect(screen.queryByRole('button', { name: 'Hosted' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'OpenRouter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Grok (API)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Other (OpenAI-compatible)' })).toBeNull();
  });

  it('THE MERGE: vLLM (tailnet) and LM Studio (loopback) sit under ONE header', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await screen.findByLabelText(/Model provider/i);
    expect(screen.getByRole('button', { name: 'Local/Self Hosted' })).toBeInTheDocument();
    // Both reachable without expanding anything — one section, already open.
    expect(screen.getByRole('button', { name: 'vLLM (self-hosted)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'LM Studio (local)' })).toBeInTheDocument();
  });

  it('the merged section collapses and re-expands as ONE unit, carrying both kinds', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await screen.findByLabelText(/Model provider/i);

    // Collapsing hides the loopback AND the tailnet presets together — proof
    // they share one `sectionOpen` key rather than two that merely agree.
    await fireEvent.click(screen.getByRole('button', { name: 'Local/Self Hosted' }));
    expect(screen.queryByRole('button', { name: 'LM Studio (local)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'vLLM (self-hosted)' })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Local/Self Hosted' }));
    expect(screen.getByRole('button', { name: 'LM Studio (local)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'vLLM (self-hosted)' })).toBeInTheDocument();
  });

  // Re-key reuses classifySection to decide WHICH section to reveal, so the
  // merge has to hold on that path too. The failure it guards is silent: if the
  // reveal wrote a section key that no longer exists ('hosted'), the spread
  // would add a phantom entry, no header would open, and the user would land on
  // a form whose selected preset is nowhere visible.
  //
  // Every kind now carries a "Re-key…" button, including kind:'local' (see the
  // describe block below) — this used to be OpenRouter/OAuth/cloud only, and a
  // self-hosted connection had to be re-added from scratch just to change a key.
  it('Re-key reveals the entry\'s own section, which starts collapsed', async () => {
    render(ControlStrip);
    postFromHost({ type: 'providerStatus', providers: [{ id: 'openrouter', name: 'OpenRouter', live: true, kind: 'compat' as const, baseURL: 'https://openrouter.ai/api/v1' }] });
    await fireEvent.click(await screen.findByRole('button', { name: /OpenRouter/i }));
    await fireEvent.click(screen.getByTitle("Replace this provider's API key"));

    // Assert on a Providers option whose name is NOT also a configured pill, so
    // this cannot pass on the pill that was already on screen. Providers starts
    // collapsed, so seeing it at all proves the reveal fired on the right key.
    expect(await screen.findByRole('button', { name: 'OpenCode Zen' })).toBeInTheDocument();
    // Labs was NOT dragged open with it — the reveal opens one section, the one
    // the entry classifies into, and leaves every other section's state alone.
    // (The merged section stays open because it is open by DEFAULT; revealing
    // Providers adds a key, it does not collapse anything.)
    expect(screen.queryByRole('button', { name: 'Anthropic (API)' })).toBeNull();
  });

  it('expanding Providers reveals OpenRouter + OpenCode Zen/Go; expanding Labs reveals the cloud labs only', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await screen.findByLabelText(/Model provider/i);
    await fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
    expect(screen.getByRole('button', { name: 'OpenRouter' })).toBeInTheDocument();
    // t-o92558 round 5 — OpenCode moved out of Labs into Providers.
    expect(screen.getByRole('button', { name: 'OpenCode Zen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OpenCode Go' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Labs' }));
    expect(screen.getByRole('button', { name: 'Grok (API)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OpenAI (API)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anthropic (API)' })).toBeInTheDocument();
  });

  it('selecting Other (under its own section) reveals the generic base URL + API key + model fields', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByText(/Add provider/));
    await screen.findByLabelText(/Model provider/i);
    // The LM Studio default (localAuto) shows only the base URL — no key/model.
    expect(screen.queryByPlaceholderText('sk-…')).toBeNull();
    expect(screen.queryByPlaceholderText('model id')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Other (OpenAI-compatible)' }));
    // Other (compat, no flags) → all three generic fields appear.
    expect(screen.getByPlaceholderText('sk-…')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('model id')).toBeInTheDocument();
  });
});

// Quirk 2 (0.4.27 follow-up): a self-hosted (kind:'local') fold used to have no
// Re-key affordance at all — changing a key meant Remove & re-add, which also
// threw away the endpoint and rep-penalty settings. It now gets the same
// Re-key… button the other kinds have, through the SAME openReKey/submit path
// (providerIdentity.ts + ControlStrip's reKeyProviderId), not a parallel one.
describe('ControlStrip — Re-key on a self-hosted (kind:local) fold', () => {
  beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockReset(); });

  it('a kind:local fold now offers a Re-key… button', async () => {
    render(ControlStrip);
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, kind: 'local' as const, baseURL: 'http://127.0.0.1:1234/v1', primary: true }] });
    await fireEvent.click(await screen.findByRole('button', { name: /LM Studio/i }));
    expect(screen.getByTitle("Set, replace, or clear this provider's API key")).toBeInTheDocument();
  });

  it('a SECONDARY local fold (primary: false) offers it too — Re-key is endpoint-independent', async () => {
    render(ControlStrip);
    postFromHost({ type: 'providerStatus', providers: [{ id: 'vllm-2', name: 'S2 - DGX Spark 2', live: true, kind: 'local' as const, baseURL: 'http://100.64.1.30:8000/v1', primary: false }] });
    await fireEvent.click(await screen.findByRole('button', { name: /S2 - DGX Spark 2/i }));
    expect(screen.getByTitle("Set, replace, or clear this provider's API key")).toBeInTheDocument();
  });

  it('Re-key opens the form with the base URL prefilled from the LIVE pill, not the catalog default', async () => {
    render(ControlStrip);
    // A customised endpoint — different from LM Studio's catalog default
    // (127.0.0.1:1234) — proves the form seeds from the pill, not the template.
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, kind: 'local' as const, baseURL: 'http://192.168.1.50:1234/v1', primary: true }] });
    await fireEvent.click(await screen.findByRole('button', { name: /LM Studio/i }));
    await fireEvent.click(screen.getByTitle("Set, replace, or clear this provider's API key"));
    const baseUrlInput = await screen.findByLabelText('Provider base URL') as HTMLInputElement;
    expect(baseUrlInput.value).toBe('http://192.168.1.50:1234/v1');
    // Connect is reachable straight away — no re-typing the URL just to change a key.
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a BLANK re-key still connects and posts an empty key, targeting the SAME provider id', async () => {
    render(ControlStrip);
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, kind: 'local' as const, baseURL: 'http://127.0.0.1:1234/v1', primary: true }] });
    await fireEvent.click(await screen.findByRole('button', { name: /LM Studio/i }));
    await fireEvent.click(screen.getByTitle("Set, replace, or clear this provider's API key"));
    await fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    const call = globalThis.__vscodeApiMock.postMessage.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((c) => c.type === 'setupProvider');
    expect(call!.providerId).toBe('lmstudio');
    expect(call!.apiKey).toBe('');
    // ...and says CLEAR out loud. 0.4.28 left the host to infer this from the
    // key being blank, which deleted the key on every model pin too — see
    // providerIdentity.clearsStoredKey and firstFold.writeModelConfig.
    expect(call!.clearApiKey).toBe(true);
  });

  it('a typed re-key posts the new key, and a SECOND local instance targets ITS OWN id — not the 1st instance, not a freshly minted one', async () => {
    render(ControlStrip);
    postFromHost({
      type: 'providerStatus',
      providers: [
        { id: 'lmstudio', name: 'LM Studio', live: true, kind: 'local' as const, baseURL: 'http://127.0.0.1:1234/v1', primary: true },
        { id: 'vllm-2', name: 'S2 - DGX Spark 2', live: true, kind: 'local' as const, baseURL: 'http://100.64.1.30:8000/v1', primary: false },
      ],
    });
    await fireEvent.click(await screen.findByRole('button', { name: /S2 - DGX Spark 2/i }));
    await fireEvent.click(screen.getByTitle("Set, replace, or clear this provider's API key"));
    await fireEvent.input(screen.getByLabelText('Provider API key (optional)'), { target: { value: 'spark2-secret' } });
    await fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    const call = globalThis.__vscodeApiMock.postMessage.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((c) => c.type === 'setupProvider');
    expect(call!.providerId).toBe('vllm-2');
    expect(call!.apiKey).toBe('spark2-secret');
    expect(call!.clearApiKey).toBe(false); // a typed key REPLACES; it never clears

    // The real endpoint is preserved, not reset to the LM Studio template's default.
    expect(call!.baseURL).toBe('http://100.64.1.30:8000/v1');
  });
});
