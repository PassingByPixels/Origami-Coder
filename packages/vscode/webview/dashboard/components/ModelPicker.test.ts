// ModelPicker — the chat-pane model picker (per-chat model selection). These
// drive the real host→webview broadcasts (providerStatus / modelOptions /
// openRouterModels) and assert the EXACT host messages the picker posts, so
// they break if the per-chat wiring, the LM-Studio context prompt, the
// OpenRouter live switch, or eject regresses.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, beforeEach } from 'vitest';
import { tick } from 'svelte';
import ModelPicker from './ModelPicker.svelte';
import { usageLine } from '../../../src/dashboard/providerUsage';
// The host predicate that decides whether a pick costs an eject+reload. Read
// here so the "picking current is free" claim is checked against the REAL rule
// the DashboardPanel applies, not a restatement of it in a comment.
import { shouldReloadLocalModel } from '../../../src/dashboard/firstFold';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function postFromHost(data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

/** Post, then let Svelte flush.
 *
 *  Only needed where the assertion is an ABSENCE. `findBy*` polls, so a test
 *  waiting for something to appear flushes on its own; a bare `queryBy*`
 *  straight after a dispatch reads the PREVIOUS render and passes no matter what
 *  the component does — which is exactly how a "no wrong tab bar" assertion ends
 *  up unable to fail. Proven: with this flush the guard-removal run goes red. */
async function postAndFlush(data: Record<string, unknown>) {
  postFromHost(data);
  await tick();
}

describe('ModelPicker — per-chat model selection', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('reads "Select model" with no model and opens the picker on click', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: false } });
    const trigger = screen.getByRole('button', { name: /Select model/i });
    await fireEvent.click(trigger);
    // Menu open: before the FIRST providerStatus payload lands this is a loading
    // state, never the "no providers" message — that message used to flash
    // here even when providers WERE configured (see the loading-state block
    // below), because it fired before the host round-trip landed.
    expect(await screen.findByRole('dialog', { name: /Select model/i })).toBeInTheDocument();
    expect(screen.getByText(/Loading models/i)).toBeInTheDocument();
    expect(screen.queryByText(/No providers configured/i)).toBeNull();
  });

  it('LM Studio: picking a DIFFERENT model asks for a context length, then posts setModel with contextLength + sessionId', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    // Host probed it as LM Studio (flavor) → context prompt + eject apply.
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' }] });
    postFromHost({
      type: 'modelOptions',
      current: '',
      options: [{ value: 'lmstudio/qwen-coder', name: 'qwen-coder', configured: true }],
    });

    // Pick the model — a local model must PROMPT for a context length (not switch yet).
    await fireEvent.click(await screen.findByText('qwen-coder'));
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setModel' }),
    );

    const ctx = await screen.findByLabelText(/Context length/i) as HTMLInputElement;
    await fireEvent.input(ctx, { target: { value: '32768' } });
    await fireEvent.click(screen.getByText('Load'));

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setModel',
      modelId: 'lmstudio/qwen-coder',
      sessionId: SID,
      contextLength: 32768,
    });
  });

  // The old contract was "EVERY local pick prompts for a context, then ejects and
  // reloads". Re-picking the model LM Studio already holds therefore cost a full
  // unload+load — and, because LM Studio serves one model at a time, the switch
  // then carried every other chat on that provider onto it, cascading the
  // pointless reload across the window. There was also no way to say "just use
  // whatever is loaded". These pin the replacement.
  it('marks the model the server already holds as "current"', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' }] });
    postFromHost({
      type: 'modelOptions',
      current: '',
      options: [
        { value: 'lmstudio/qwen-coder', name: 'qwen-coder', configured: true },
        { value: 'lmstudio/qwen-30b', name: 'qwen-30b', configured: true },
      ],
    });
    // The host reports what is actually loaded.
    postFromHost({ type: 'modelStatus', sessionId: SID, contextWindow: 65536, loadedModelId: 'qwen-30b' });

    await screen.findByText('qwen-30b');
    // Exactly ONE row is flagged, and it is the loaded one.
    const chips = screen.getAllByText('current');
    expect(chips).toHaveLength(1);
    expect(chips[0].closest('button')?.getAttribute('title')).toBe('lmstudio/qwen-30b');
  });

  // …and the SECOND half of that replacement, which the first shipped without:
  // re-picking the loaded model short-circuited to a bare re-pick, so the window
  // it is actually loaded at was never shown and could not be changed from here
  // at all (the only route was: switch to another model, then switch back). The
  // row marked `current` now opens the SAME load prompt every other LM Studio
  // pick opens — seeded with, and labelled by, the real loaded window. The
  // no-reload guarantee did not move: it lives in the host's
  // shouldReloadLocalModel, which skips the eject+load on a model+window match.
  /** Open the picker on an LM Studio provider holding `qwen-30b` at 32k. */
  async function openWithLoaded32k() {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' }] });
    postFromHost({
      type: 'modelOptions',
      current: '',
      options: [{ value: 'lmstudio/qwen-30b', name: 'qwen-30b', configured: true }],
    });
    // `loadedContextLength` is the LOCAL server's own loaded window (a global
    // fact on every modelStatus post); `contextWindow` is THIS session's model's
    // window. They coincide for a local chat — the remote case is pinned below.
    postFromHost({ type: 'modelStatus', sessionId: SID, contextWindow: 32768, loadedContextLength: 32768, loadedModelId: 'qwen-30b' });
  }
  /** The `setModel` message the picker posted (undefined = it posted none). */
  function setModelCall(): Record<string, unknown> | undefined {
    return globalThis.__vscodeApiMock.postMessage.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((a) => a?.type === 'setModel');
  }
  /** What DashboardPanel's setModel handler would do with that message: the
   *  picker's contextLength wins, else the probed loaded window. */
  function hostWouldReload(posted: Record<string, unknown> | undefined, loadedCtx: number): boolean {
    const requested = typeof posted?.contextLength === 'number' && posted.contextLength > 0
      ? posted.contextLength as number
      : loadedCtx;
    return shouldReloadLocalModel({
      requestedModelId: 'qwen-30b',
      requestedContext: requested,
      loaded: { ok: true, modelId: 'qwen-30b', contextLength: loadedCtx },
    });
  }

  it('picking the ALREADY-LOADED model opens the context prompt, pre-filled with AND labelled by the loaded window', async () => {
    await openWithLoaded32k();

    await fireEvent.click(await screen.findByText('qwen-30b'));

    // The prompt is the ONLY place the loaded window is legible, so it must both
    // seed the input and say the number in words — a blank box would read as
    // "no window set" for a model that has one.
    const ctx = await screen.findByLabelText(/Context length/i) as HTMLInputElement;
    expect(ctx.value).toBe('32768');
    expect(screen.getByText(/currently loaded at 32k/i)).toBeInTheDocument();
    // Nothing is sent until the user confirms — the old short-circuit posted here.
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setModel' }),
    );
  });

  it('a NEW window on the loaded model rides setModel as contextLength — and the host then RELOADS', async () => {
    await openWithLoaded32k();
    await fireEvent.click(await screen.findByText('qwen-30b'));

    const ctx = await screen.findByLabelText(/Context length/i) as HTMLInputElement;
    await fireEvent.input(ctx, { target: { value: '86016' } });
    await fireEvent.click(screen.getByText('Load'));

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setModel',
      modelId: 'lmstudio/qwen-30b',
      sessionId: SID,
      contextLength: 86016,
    });
    // Same model, DIFFERENT window → the host must eject and reload at 84k.
    expect(hostWouldReload(setModelCall(), 32768)).toBe(true);
  });

  it('confirming the loaded window UNCHANGED lands in the host\'s "kept as is" skip — no eject+reload', async () => {
    await openWithLoaded32k();
    await fireEvent.click(await screen.findByText('qwen-30b'));

    // Straight to Load, leaving the seeded 32768 alone: the "I only wanted to
    // check the window" path, which must cost nothing.
    await fireEvent.click(await screen.findByText('Load'));

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setModel',
      modelId: 'lmstudio/qwen-30b',
      sessionId: SID,
      contextLength: 32768,
    });
    expect(hostWouldReload(setModelCall(), 32768)).toBe(false);
  });

  it('confirming the loaded model with a BLANK window also skips — the host inherits the probed one', async () => {
    await openWithLoaded32k();
    await fireEvent.click(await screen.findByText('qwen-30b'));

    const ctx = await screen.findByLabelText(/Context length/i) as HTMLInputElement;
    await fireEvent.input(ctx, { target: { value: '' } });
    await fireEvent.click(screen.getByText('Load'));

    // Blank = no usable number on the wire; DashboardPanel then falls back to
    // `this.contextWindow` (its own probe of the loaded window), which matches.
    expect(setModelCall()?.modelId).toBe('lmstudio/qwen-30b');
    expect(setModelCall()?.contextLength).toBeUndefined();
    expect(hostWouldReload(setModelCall(), 32768)).toBe(false);
  });

  it('a CLOUD chat\'s own 200k window never becomes the loaded model\'s "currently loaded" number', async () => {
    // The hazard the short-circuit used to hide. `contextWindow` on modelStatus is
    // THIS session's model's window — for a chat sitting on OpenRouter that is the
    // cloud model's 200k, while LM Studio holds qwen-30b at 32k. Reading that as
    // the loaded window would print a false "currently loaded at 195k" AND seed
    // `lms load -c 200000`, which is a VRAM blowout one confirm away. The picker
    // reads `loadedContextLength` (the local server's own window) instead.
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' }] });
    postFromHost({ type: 'modelOptions', current: '', options: [{ value: 'lmstudio/qwen-30b', name: 'qwen-30b', configured: true }] });
    postFromHost({ type: 'modelStatus', sessionId: SID, contextWindow: 200000, loadedContextLength: 32768, loadedModelId: 'qwen-30b' });

    await fireEvent.click(await screen.findByText('qwen-30b'));

    const ctx = await screen.findByLabelText(/Context length/i) as HTMLInputElement;
    expect(ctx.value).toBe('32768');
    expect(screen.getByText(/currently loaded at 32k/i)).toBeInTheDocument();
    expect(screen.queryByText(/195k/)).toBeNull();

    await fireEvent.click(screen.getByText('Load'));
    expect(setModelCall()?.contextLength).toBe(32768);
    expect(hostWouldReload(setModelCall(), 32768)).toBe(false);
  });

  it('cancelling the loaded model\'s prompt posts NOTHING — reading the window is not a pick', async () => {
    // The old short-circuit posted the moment the row was clicked, so "let me see
    // what it is loaded at" and "switch this chat to it" were the same gesture.
    // They are two now, and backing out must leave this chat's model alone.
    await openWithLoaded32k();
    await fireEvent.click(await screen.findByText('qwen-30b'));
    await fireEvent.click(await screen.findByText('Cancel'));

    expect(setModelCall()).toBeUndefined();
    expect(await screen.findByText('qwen-30b')).toBeInTheDocument();
  });

  it('another chat\'s modelStatus cannot masquerade as this chat\'s loaded model', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' }] });
    postFromHost({
      type: 'modelOptions',
      current: '',
      options: [{ value: 'lmstudio/qwen-30b', name: 'qwen-30b', configured: true }],
    });
    // Tagged for a DIFFERENT session — must be ignored (same guard that stops a
    // background chat's 131k window pre-filling this chat's `lms load -c`).
    postFromHost({ type: 'modelStatus', sessionId: 'some-other-session', contextWindow: 65536, loadedContextLength: 65536, loadedModelId: 'qwen-30b' });

    await fireEvent.click(await screen.findByText('qwen-30b'));
    // Prompt, yes — but EMPTY and unlabelled. Now that every local pick prompts,
    // the seeded number and the "currently loaded" line are the only things that
    // still tell the two cases apart, so they are what this guard asserts.
    const ctx = await screen.findByLabelText(/Context length/i) as HTMLInputElement;
    expect(ctx.value).toBe('');
    expect(screen.queryByText(/currently loaded at/i)).toBeNull();
    expect(screen.queryByText('current')).toBeNull();
  });

  it('OpenRouter: picking a model switches live (setModel + sessionId), no context prompt', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'openrouter', name: 'OpenRouter', live: true }] });
    postFromHost({
      type: 'openRouterModels',
      providerId: 'openrouter',
      models: [{ id: 'x-ai/grok-4', name: 'xAI: Grok 4', free: false }],
    });

    await fireEvent.click(await screen.findByText('xAI: Grok 4'));

    // Cloud model: no context prompt, switches straight away for THIS session.
    expect(screen.queryByLabelText(/Context length/i)).toBeNull();
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setModel',
      modelId: 'openrouter/x-ai/grok-4',
      sessionId: SID,
    });
  });

  it('Eject posts modelPanel.unload (LM Studio tab)', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' }] });
    await fireEvent.click(await screen.findByText(/Eject/i));
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'modelPanel.unload' });
  });

  it('remote vLLM (flavor other): switches live, NO context prompt, NO eject (lms ops do not apply)', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    // A remote OpenAI-compatible server — its model is fixed server-side, so it is
    // NOT lms-managed even though it isn't "cloud".
    postFromHost({ type: 'providerStatus', providers: [{ id: 'vllm', name: 'vLLM', live: true, baseURL: 'http://100.64.1.10:8000/v1', flavor: 'other' }] });
    postFromHost({
      type: 'modelOptions',
      current: '',
      options: [{ value: 'vllm/qwen3.6-35b', name: 'qwen3.6-35b', configured: true }],
    });

    // Eject must NOT be offered for a remote server.
    expect(screen.queryByText(/Eject/i)).toBeNull();

    // Picking switches live for THIS session — no context-length prompt.
    await fireEvent.click(await screen.findByText('qwen3.6-35b'));
    expect(screen.queryByLabelText(/Context length/i)).toBeNull();
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setModel',
      modelId: 'vllm/qwen3.6-35b',
      sessionId: SID,
    });
  });

  it('local Ollama (loopback but flavor ollama): NO eject, NO context prompt, switches live', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    // The hole the flavor gate closes: Ollama runs on LOOPBACK, so a base-URL gate
    // would wrongly show LM Studio's eject/context and fire useless `lms` commands.
    // Probed flavor 'ollama' -> not lms-managed -> honest switch-live.
    postFromHost({ type: 'providerStatus', providers: [{ id: 'ollama', name: 'Ollama', live: true, baseURL: 'http://127.0.0.1:11434/v1', flavor: 'ollama' }] });
    postFromHost({
      type: 'modelOptions',
      current: '',
      options: [{ value: 'ollama/llama3.1', name: 'llama3.1', configured: true }],
    });

    expect(screen.queryByText(/Eject/i)).toBeNull();

    await fireEvent.click(await screen.findByText('llama3.1'));
    expect(screen.queryByLabelText(/Context length/i)).toBeNull();
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setModel',
      modelId: 'ollama/llama3.1',
      sessionId: SID,
    });
  });
});

// Tweak 4 — the structured provider/quant/name label. A quant token in the id
// becomes a chip; an id without one shows no chip; and the parse is DISPLAY-only —
// selecting a row still posts the exact original id as the value.
describe('ModelPicker — structured model label (tweak 4)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('renders a quant chip + cleaned name for an id carrying a quant token', async () => {
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'vllm', name: 'vLLM', live: true, baseURL: 'http://100.64.1.10:8000/v1', flavor: 'other' }] });
    postFromHost({
      type: 'modelOptions',
      current: '',
      options: [{ value: 'vllm/qwen3.6-35b-Q4_K_M', name: 'qwen3.6-35b-Q4_K_M', configured: true }],
    });

    // The chip shows the quant; the name is the remainder with the token stripped.
    expect(await screen.findByText('Q4_K_M')).toBeInTheDocument();
    expect(screen.getByText('qwen3.6-35b')).toBeInTheDocument();
    expect(container.querySelector('.mp-model-quant')?.textContent).toBe('Q4_K_M');
  });

  it('shows NO chip for an id without a quant token', async () => {
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'vllm', name: 'vLLM', live: true, baseURL: 'http://100.64.1.10:8000/v1', flavor: 'other' }] });
    postFromHost({
      type: 'modelOptions',
      current: '',
      options: [{ value: 'vllm/qwen3-coder-30b', name: 'qwen3-coder-30b', configured: true }],
    });

    await screen.findByText('qwen3-coder-30b');
    expect(container.querySelector('.mp-model-quant')).toBeNull();
  });

  it('the parse is display-only: selecting a row posts the EXACT original id', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'vllm', name: 'vLLM', live: true, baseURL: 'http://100.64.1.10:8000/v1', flavor: 'other' }] });
    postFromHost({
      type: 'modelOptions',
      current: '',
      options: [{ value: 'vllm/qwen3.6-35b-Q4_K_M', name: 'qwen3.6-35b-Q4_K_M', configured: true }],
    });

    // Click the row by its cleaned name — the posted value is still the raw id.
    await fireEvent.click(await screen.findByText('qwen3.6-35b'));
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setModel',
      modelId: 'vllm/qwen3.6-35b-Q4_K_M',
      sessionId: SID,
    });
  });
});

// t-o92558 round 5 — tier-1 replaced the old local-vs-Lab split (0.2.177,
// decided by the host's local/compat/cloud `kind`) with ONE mechanic applied
// uniformly to every connectionSection.ts group (Local/Self Hosted, Providers,
// Labs): 2+ members of a section collapse behind that section's own pill; a
// lone member stays a top-level tab. The pick value is unchanged; only WHICH
// pill sits where changes. Each block below mirrors the shape the original
// Lab-only tests used (reveal-on-open, auto-open onto the owning sub for the
// current model), extended to the sections that gained a pill.
//
// Local and Hosted were two of those groups until the merge. They are one now,
// so the two describes below became one — a loopback LM Studio and a tailnet
// vLLM share a pill instead of anchoring separate tabs. Reveal-on-open is still
// covered, by the Providers and Labs blocks further down; it cannot be shown
// with self-hosted providers alone any more, because their section is first in
// SECTION_ORDER and therefore always the default-selected (open) tab.
describe('ModelPicker — group pills at 2+ (Local/Self Hosted, Providers, Labs)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  describe('the Local/Self Hosted pill', () => {
    // This section is FIRST in SECTION_ORDER, so — unlike the other groups
    // below — it always wins the default top-level selection whenever it has
    // any members at all. Its pill therefore starts OPEN, not collapsed
    // waiting for a click; that is the one thing worth pinning here.
    it('2 loopback providers collapse into the pill, open by default (it always wins the default tab)', async () => {
      render(ModelPicker, { props: { sessionId: SID, online: true } });
      await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
      postFromHost({
        type: 'providerStatus',
        providers: [
          { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' },
          { id: 'ollama', name: 'Ollama', live: true, baseURL: 'http://127.0.0.1:11434/v1', flavor: 'ollama' },
        ],
      });

      expect(await screen.findByRole('tab', { name: /^Local\/Self Hosted$/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: /LM Studio/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /Ollama/i })).toBeInTheDocument();
    });

    it('the pill\'s sub-select defaults to the CURRENT model\'s own provider, not just the first member', async () => {
      render(ModelPicker, { props: { sessionId: SID, online: true } });
      await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
      postFromHost({
        type: 'providerStatus',
        providers: [
          { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' },
          { id: 'ollama', name: 'Ollama', live: true, baseURL: 'http://127.0.0.1:11434/v1', flavor: 'ollama' },
        ],
      });
      postFromHost({ type: 'modelOptions', current: '', options: [{ value: 'ollama/llama-3.1-8b', name: 'Llama 3.1 8B', configured: true }] });
      postFromHost({ type: 'sessionModels', models: { [SID]: 'ollama/llama-3.1-8b' } });

      expect(await screen.findByRole('tab', { name: /Ollama/i })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: /LM Studio/i })).toHaveAttribute('aria-selected', 'false');
      expect(await screen.findByText('Llama 3.1 8B')).toBeInTheDocument();
    });

    it('THE MERGE: loopback and tailnet servers share ONE pill, with no separate Hosted tab', async () => {
      render(ModelPicker, { props: { sessionId: SID, online: true } });
      await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
      postFromHost({
        type: 'providerStatus',
        providers: [
          { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' },
          { id: 'vllm', name: 'vLLM', live: true, baseURL: 'http://100.64.1.10:8000/v1', flavor: 'other' },
          { id: 'spark2', name: 'Spark2', live: false, baseURL: 'http://100.64.1.20:8000/v1', flavor: 'other' },
        ],
      });

      // Pre-merge this painted "LM Studio" as a lone tab PLUS a collapsed
      // "Hosted" pill hiding the two Sparks. One pill now holds all three.
      expect(await screen.findByRole('tab', { name: /^Local\/Self Hosted$/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByRole('tab', { name: /^Hosted$/ })).toBeNull();
      for (const name of [/LM Studio/i, /vLLM/i, /Spark2/i]) {
        expect(screen.getByRole('tab', { name })).toBeInTheDocument();
      }
    });

    it('auto-selects the owning TAILNET sub-provider when the current model belongs to one', async () => {
      render(ModelPicker, { props: { sessionId: SID, online: true } });
      await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
      postFromHost({
        type: 'providerStatus',
        providers: [
          { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' },
          { id: 'vllm', name: 'vLLM', live: true, baseURL: 'http://100.64.1.10:8000/v1', flavor: 'other' },
          { id: 'spark2', name: 'Spark2', live: false, baseURL: 'http://100.64.1.20:8000/v1', flavor: 'other' },
        ],
      });
      // Name distinct from the raw id suffix so the trigger's pretty-printed
      // current value ("qwen3.6-35b") and this row's friendly name don't
      // collide on the same findByText.
      postFromHost({ type: 'modelOptions', current: '', options: [{ value: 'vllm/qwen3.6-35b', name: 'Qwen3.6 35B', configured: true }] });
      postFromHost({ type: 'sessionModels', models: { [SID]: 'vllm/qwen3.6-35b' } });

      expect(await screen.findByRole('tab', { name: /^Local\/Self Hosted$/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: /vLLM/i })).toHaveAttribute('aria-selected', 'true');
      expect(await screen.findByText('Qwen3.6 35B')).toBeInTheDocument();
    });
  });

  describe('the Providers pill', () => {
    it('2 aggregators hide behind a Providers pill until it is opened', async () => {
      render(ModelPicker, { props: { sessionId: SID, online: true } });
      await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
      postFromHost({
        type: 'providerStatus',
        providers: [
          { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' },
          { id: 'openrouter', name: 'OpenRouter', live: true, baseURL: 'https://openrouter.ai/api/v1' },
          { id: 'opencode', name: 'OpenCode Zen', live: true, baseURL: 'https://opencode.ai/zen/v1' },
        ],
      });

      expect(await screen.findByRole('tab', { name: /LM Studio/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^Providers$/ })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: /^OpenRouter$/ })).toBeNull();
      expect(screen.queryByRole('tab', { name: /^OpenCode Zen$/ })).toBeNull();

      await fireEvent.click(screen.getByRole('tab', { name: /^Providers$/ }));
      expect(await screen.findByRole('tab', { name: /OpenRouter/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /OpenCode Zen/i })).toBeInTheDocument();
    });

    // The catalog-fetch-on-pick behaviour is OpenRouter-specific (maybeFetchOpenRouter),
    // so this stays scoped to Providers, the section OpenRouter now lives in.
    it('picking a model under the Providers pill\'s OpenRouter sub fetches its catalog and switches live (no ctx prompt)', async () => {
      render(ModelPicker, { props: { sessionId: SID, online: true } });
      await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
      postFromHost({
        type: 'providerStatus',
        providers: [
          { id: 'openrouter', name: 'OpenRouter', live: true, baseURL: 'https://openrouter.ai/api/v1' },
          { id: 'opencode', name: 'OpenCode Zen', live: true, baseURL: 'https://opencode.ai/zen/v1' },
        ],
      });

      await fireEvent.click(await screen.findByRole('tab', { name: /^Providers$/ }));
      await fireEvent.click(await screen.findByRole('tab', { name: /OpenRouter/i }));
      expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'requestOpenRouterModels', providerId: 'openrouter' });

      postFromHost({ type: 'openRouterModels', providerId: 'openrouter', models: [{ id: 'x-ai/grok-4', name: 'xAI: Grok 4', free: false }] });
      await fireEvent.click(await screen.findByText('xAI: Grok 4'));

      expect(screen.queryByLabelText(/Context length/i)).toBeNull();
      expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
        type: 'setModel',
        modelId: 'openrouter/x-ai/grok-4',
        sessionId: SID,
      });
    });

    it('auto-opens the Providers pill + the owning sub-provider when the current model belongs to one', async () => {
      render(ModelPicker, { props: { sessionId: SID, online: true } });
      await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
      postFromHost({
        type: 'providerStatus',
        providers: [
          { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' },
          { id: 'openrouter', name: 'OpenRouter', live: true, baseURL: 'https://openrouter.ai/api/v1' },
          { id: 'opencode', name: 'OpenCode Zen', live: true, baseURL: 'https://opencode.ai/zen/v1' },
        ],
      });
      postFromHost({ type: 'sessionModels', models: { [SID]: 'openrouter/x-ai/grok-4' } });

      expect(await screen.findByRole('tab', { name: /^Providers$/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: /OpenRouter/i })).toHaveAttribute('aria-selected', 'true');
      postFromHost({ type: 'openRouterModels', providerId: 'openrouter', models: [{ id: 'x-ai/grok-4', name: 'xAI: Grok 4', free: false }] });
      expect(await screen.findByText('xAI: Grok 4')).toBeInTheDocument();
    });
  });

  describe('the Labs pill (the original mechanic — now sourced by classifySection, not `kind`)', () => {
    it('2 labs hide behind a Labs pill until it is opened', async () => {
      render(ModelPicker, { props: { sessionId: SID, online: true } });
      await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
      postFromHost({
        type: 'providerStatus',
        providers: [
          { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' },
          { id: 'openai', name: 'OpenAI', live: true },
          { id: 'anthropic', name: 'Anthropic', live: true },
        ],
      });

      expect(await screen.findByRole('tab', { name: /LM Studio/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^Labs$/ })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: /^OpenAI$/ })).toBeNull();
      expect(screen.queryByRole('tab', { name: /^Anthropic/ })).toBeNull();

      await fireEvent.click(screen.getByRole('tab', { name: /^Labs$/ }));
      expect(await screen.findByRole('tab', { name: /OpenAI/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /Anthropic/i })).toBeInTheDocument();
    });

    it('auto-opens the Labs pill + the owning sub-provider when the current model belongs to a lab', async () => {
      render(ModelPicker, { props: { sessionId: SID, online: true } });
      await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
      postFromHost({
        type: 'providerStatus',
        providers: [
          { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' },
          { id: 'openai', name: 'OpenAI', live: true },
          { id: 'anthropic', name: 'Anthropic', live: true },
        ],
      });
      // Name distinct from the raw id suffix so the trigger's pretty-printed
      // current value ("gpt-5-turbo") and this row's friendly name don't
      // collide on the same findByText.
      postFromHost({ type: 'modelOptions', current: '', options: [{ value: 'openai/gpt-5-turbo', name: 'GPT-5 Turbo', configured: true }] });
      postFromHost({ type: 'sessionModels', models: { [SID]: 'openai/gpt-5-turbo' } });

      expect(await screen.findByRole('tab', { name: /^Labs$/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: /OpenAI/i })).toHaveAttribute('aria-selected', 'true');
      expect(await screen.findByText('GPT-5 Turbo')).toBeInTheDocument();
    });
  });
});

// The picker SELECTS a model. It does not establish connections — that is the
// sidebar's job (ControlStrip.svelte's own header says so, and setupCatalog.ts
// already carries Ollama as a normal localAuto preset). The "+ Connect Ollama"
// button (0.2.177) was the one place that rule was broken: a config WRITE
// (probe -> writeModelConfig -> reload toast) reachable from a selection-only
// surface, and offered whenever ANY provider list lacked an ollama flavor — so
// a user with LM Studio configured saw a connect affordance in a model list.
describe('ModelPicker — the picker never establishes a connection', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('offers NO connect affordance, whatever the configured providers are', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    // The exact state the old button was gated on: providers configured, none ollama.
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio', kind: 'local' }] });

    await screen.findByRole('tab', { name: /LM Studio/i });
    expect(screen.queryByRole('button', { name: /Connect/i })).toBeNull();
    expect(screen.queryByText(/Ollama/i)).toBeNull();
  });

  it('with NO providers it points at the sidebar and posts nothing that could write config', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    globalThis.__vscodeApiMock.postMessage.mockReset();
    // The host answers the probe with an empty list — the real "nothing configured" state.
    postFromHost({ type: 'providerStatus', providers: [] });

    expect(await screen.findByText(/No providers configured/i)).toBeInTheDocument();
    expect(screen.getByText(/Origami sidebar/i)).toBeInTheDocument();
    // A hint, not a control: nothing to click, and nothing was sent.
    expect(screen.queryByRole('button', { name: /Add provider/i })).toBeNull();
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();
  });
});

// The per-chat SUB-AGENT model override. A fan-out is the chat's cost centre —
// ten children on the chat's own frontier model is ten times the bill — so the
// picker gained a TARGET: this chat, or the sub-agents it spawns. The pick then
// rides a different host message, and must not drag the chat's own model with
// it.
describe('ModelPicker — the sub-agent target', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  // t-lmqe0g: a sub-agent pick now asks for an OPTIONAL context-window override
  // (bookkeeping for the children's own auto-compaction, never a load) before it
  // posts — for every provider, not just LM Studio's "load this now" prompt.
  it('asks for an (optional) context length, then sends the pick to setSubagentModel with no override when left blank', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'openrouter', name: 'OpenRouter', live: true, kind: 'cloud' }] });
    postFromHost({ type: 'openRouterModels', providerId: 'openrouter', models: [{ id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' }] });

    await fireEvent.click(await screen.findByRole('button', { name: /^Sub-agents$/ }));
    await fireEvent.click(await screen.findByText('Qwen3 Coder'));
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setSubagentModel' }),
    );

    await fireEvent.click(await screen.findByText('Set'));

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setSubagentModel',
      modelId: 'openrouter/qwen/qwen3-coder',
      sessionId: SID,
    });
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setModel' }),
    );
  });

  it('a filled-in context length rides setSubagentModel as contextLength, for LM Studio too — no load happens', async () => {
    // Unlike the main-chat prompt this never loads/ejects anything: it is
    // bookkeeping for the sub-agents' own auto-compaction budget only.
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio', kind: 'local' }] });
    postFromHost({ type: 'modelOptions', current: '', options: [{ value: 'lmstudio/qwen-coder', name: 'qwen-coder', configured: true }] });

    await fireEvent.click(await screen.findByRole('button', { name: /^Sub-agents$/ }));
    await fireEvent.click(await screen.findByText('qwen-coder'));

    const ctx = await screen.findByLabelText(/Context length/i) as HTMLInputElement;
    await fireEvent.input(ctx, { target: { value: '65536' } });
    await fireEvent.click(screen.getByText('Set'));

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setSubagentModel',
      modelId: 'lmstudio/qwen-coder',
      sessionId: SID,
      contextLength: 65536,
    });
  });

  // The sub-agent target is UNCHANGED by the "picking current shows its window"
  // work: it never reached the loaded-model short-circuit in the first place
  // (its own branch returns before it), and it drives no `lms load`, so there is
  // no loaded window to reveal — its number is the CHILDREN's compaction budget,
  // which is not the parent's loaded window and must not be seeded from it.
  it('the loaded model on the SUB-AGENT target still gets the blank override prompt, not the load prompt', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' }] });
    postFromHost({ type: 'modelOptions', current: '', options: [{ value: 'lmstudio/qwen-30b', name: 'qwen-30b', configured: true }] });
    postFromHost({ type: 'modelStatus', sessionId: SID, contextWindow: 32768, loadedModelId: 'qwen-30b' });

    await fireEvent.click(await screen.findByRole('button', { name: /^Sub-agents$/ }));
    await fireEvent.click(await screen.findByText('qwen-30b'));

    // The override prompt (Set), not the load prompt (Load) — and blank, not
    // seeded with the parent's 32k.
    const ctx = await screen.findByLabelText(/Context length/i) as HTMLInputElement;
    expect(ctx.value).toBe('');
    expect(screen.queryByText('Load')).toBeNull();
    await fireEvent.click(screen.getByText('Set'));

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setSubagentModel',
      modelId: 'lmstudio/qwen-30b',
      sessionId: SID,
    });
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setModel' }),
    );
  });

  it('cancelling the sub-agent context prompt posts nothing and returns to the model list', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'openrouter', name: 'OpenRouter', live: true, kind: 'cloud' }] });
    postFromHost({ type: 'openRouterModels', providerId: 'openrouter', models: [{ id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' }] });

    await fireEvent.click(await screen.findByRole('button', { name: /^Sub-agents$/ }));
    await fireEvent.click(await screen.findByText('Qwen3 Coder'));
    await fireEvent.click(await screen.findByText('Cancel'));

    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'setSubagentModel' }),
    );
    // Back to the model row, not a dead menu.
    expect(await screen.findByText('Qwen3 Coder')).toBeInTheDocument();
  });

  it('defaults back to THIS chat every time the picker is reopened', async () => {
    // A sticky target would send a later pick somewhere the user is no longer
    // looking — the chat model would silently stop changing.
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [{ id: 'openrouter', name: 'OpenRouter', live: true, kind: 'cloud' }] });
    postFromHost({ type: 'openRouterModels', providerId: 'openrouter', models: [{ id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' }] });
    await fireEvent.click(await screen.findByRole('button', { name: /^Sub-agents$/ }));

    // Close and reopen.
    await fireEvent.click(container.querySelector('.mp-trigger') as HTMLElement);
    await fireEvent.click(container.querySelector('.mp-trigger') as HTMLElement);
    postFromHost({ type: 'openRouterModels', providerId: 'openrouter', models: [{ id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' }] });
    await fireEvent.click(await screen.findByText('Qwen3 Coder'));

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'setModel',
      modelId: 'openrouter/qwen/qwen3-coder',
      sessionId: SID,
    });
  });
});

// The blank-flash fix: the empty-providers message used to render on EVERY
// first open — even with providers configured and a model already active —
// because it fired before the host round-trip landed (owner screenshot). It is
// now gated on whether a REAL payload has arrived at least once, not on
// whatever `grouping.tabs` happens to be mid-flight.
//
// The gate reads providerStatus, NOT modelOptions. Two reasons, and both are
// load-bearing: providerStatus is the only payload carrying the baseURL a tab
// is bucketed by (see the re-bucketing block below), and the host SKIPS the
// modelOptions broadcast entirely when it has nothing to send — so a
// modelOptions-gated message would never appear for the very case it exists
// for, an install with no providers at all.
describe('ModelPicker — no blank-flash before the first providerStatus payload', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('shows "Loading models…" before any payload has arrived — never the empty-providers message', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    expect(screen.getByText('Loading models…')).toBeInTheDocument();
    expect(screen.queryByText(/No providers configured/i)).toBeNull();
  });

  it('falls to the real empty-providers message once the PROBE actually answers empty', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [] });
    expect(await screen.findByText(/No providers configured — add one in the Origami sidebar/i)).toBeInTheDocument();
    expect(screen.queryByText('Loading models…')).toBeNull();
  });

  it('modelOptions alone does NOT lift the gate — the host may never send it', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    await postAndFlush({ type: 'modelOptions', current: '', options: [] });
    expect(screen.getByText('Loading models…')).toBeInTheDocument();
    expect(screen.queryByText(/No providers configured/i)).toBeNull();
  });

  it('a reopened picker with cached options shows them instantly — no loading flash, no empty state', async () => {
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    const trigger = () => container.querySelector('.mp-trigger') as HTMLElement;
    await fireEvent.click(trigger());
    postFromHost({ type: 'providerStatus', providers: [{ id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' }] });
    postFromHost({ type: 'modelOptions', current: '', options: [{ value: 'lmstudio/qwen-coder', name: 'qwen-coder', configured: true }] });
    await screen.findByText('qwen-coder');

    // Close, then reopen — no new host message before the assertion: the
    // cached tab + model row must already be there, no flash of either state.
    await fireEvent.click(trigger());
    await fireEvent.click(trigger());

    expect(screen.queryByText('Loading models…')).toBeNull();
    expect(screen.queryByText(/No providers configured/i)).toBeNull();
    expect(screen.getByText('qwen-coder')).toBeInTheDocument();
  });
});

// The re-bucketing flicker (picker UAT). modelOptions and providerStatus are two
// independent host round-trips fired by the same click, and modelOptions wins:
// it merges its live polls in parallel, while providerStatus probed each provider
// in turn. The picker used to fill the gap by grouping the provider ids it could
// read off modelOptions — but a section is decided by baseURL, which only the
// probe carries, so every id fell to modelGrouping's no-baseURL "Local" default
// and the tab bar then visibly re-shuffled when the real payload landed.
//
// The fix is a gate, not a repaint: nothing in tier-1 renders until the probe has
// answered once, so the tab bar paints ONCE and is already right.
describe('ModelPicker — the tab bar never paints from the id-only bootstrap', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  // These three ids carry NO baseURL on modelOptions, so the old bootstrap
  // bucketed them by the no-baseURL default and the tab bar then re-shuffled
  // when the probe landed. (Pre-merge the re-shuffle was starker — the same
  // three straddled the old Local and Hosted sections — but the gate this block
  // pins is about painting BEFORE the probe, not about which sections exist.)
  const OPTIONS = [
    { value: 'lmstudio/qwen-coder', name: 'qwen-coder', configured: true },
    { value: 'vllm/qwen3.6-35b', name: 'Qwen3.6 35B', configured: true },
    { value: 'spark2/gpt-oss-120b', name: 'GPT-OSS 120B', configured: true },
  ];
  const PROBED = [
    { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1', flavor: 'lmstudio' },
    { id: 'vllm', name: 'vLLM', live: true, baseURL: 'http://100.64.1.10:8000/v1', flavor: 'other' },
    { id: 'spark2', name: 'Spark2', live: false, baseURL: 'http://100.64.1.20:8000/v1', flavor: 'other' },
  ];

  it('modelOptions arriving FIRST paints no tabs at all, then the probe paints the RIGHT ones once', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));

    // The fast broadcast lands on its own — the race this whole block is about.
    // Flushed, so the assertions below read the render this payload produced.
    await postAndFlush({ type: 'modelOptions', current: '', options: OPTIONS });

    // Nothing bucketed: no tab bar, no model rows, just the loading gate. The
    // mis-bucketed intermediate state is what must never reach the screen.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByRole('tab', { name: /^Local\/Self Hosted$/ })).toBeNull();
    expect(screen.queryByText('qwen-coder')).toBeNull();
    expect(screen.getByText('Loading models…')).toBeInTheDocument();

    // The probe answers. One paint, already correct: all three are self-hosted,
    // so they collapse into that section's single pill with its members shown.
    postFromHost({ type: 'providerStatus', providers: PROBED });

    expect(await screen.findByRole('tab', { name: /^Local\/Self Hosted$/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /LM Studio/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Hosted$/ })).toBeNull();
    expect(screen.queryByText('Loading models…')).toBeNull();
  });

  it('the probe answering EMPTY still lets a stray modelOptions id show — a final state, not a mid-flight one', async () => {
    // The degenerate safety net: the host listed no providers, yet the engine's
    // own catalog carries ids. Reachable only AFTER the answer, so it cannot
    // re-bucket under the user — it is the last word, not a guess.
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'providerStatus', providers: [] });
    postFromHost({ type: 'modelOptions', current: '', options: [OPTIONS[0]] });

    expect(await screen.findByRole('tab', { name: /lmstudio/i })).toBeInTheDocument();
    expect(screen.queryByText(/No providers configured/i)).toBeNull();
  });
});

// Subscription usage, read where the user actually is: next to the model
// name in the model bar, for the model THIS chat is actively running — reuses
// the exact providerUsageRequest/providerUsageData contract ControlStrip's
// oauth fold already speaks (see providerUsage.test.ts for that host contract;
// this only covers the webview's read + trigger + render of it).
describe('ModelPicker — subscription usage readout (OAuth-active model)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  it('posts providerUsageRequest for the active model\'s provider when the model bar opens, and renders the host\'s line verbatim', async () => {
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    const trigger = () => container.querySelector('.mp-trigger') as HTMLElement;
    // First open seeds which model is active and which providers are OAuth —
    // the picker cannot know to ask before it knows both.
    await fireEvent.click(trigger());
    postFromHost({ type: 'sessionModels', models: { [SID]: 'openai/gpt-5-turbo' } });
    postFromHost({ type: 'providerAuthData', methods: {}, connected: { openai: { type: 'oauth' } } });
    await fireEvent.click(trigger()); // close

    globalThis.__vscodeApiMock.postMessage.mockReset();
    await fireEvent.click(trigger()); // reopen — now it knows enough to ask
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'providerUsageRequest', providerId: 'openai' });

    postFromHost({
      type: 'providerUsageData',
      providerId: 'openai',
      plan: 'plus',
      lines: ['5-hour: 12% used, resets in 2h 30m', 'Weekly: 48% used'],
    });
    // The host pre-formats the wording (see providerUsage.ts) — shown as
    // given, not re-derived from raw numbers here.
    expect(await screen.findByText('5-hour: 12% used, resets in 2h 30m')).toBeInTheDocument();
  });

  it('asks nothing and shows nothing when the active model\'s provider is not OAuth-connected', async () => {
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    const trigger = () => container.querySelector('.mp-trigger') as HTMLElement;
    await fireEvent.click(trigger());
    postFromHost({ type: 'sessionModels', models: { [SID]: 'lmstudio/qwen-coder' } });
    // No providerAuthData at all — a key-based / local provider stays silent.
    await fireEvent.click(trigger());
    globalThis.__vscodeApiMock.postMessage.mockReset();
    await fireEvent.click(trigger());

    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'providerUsageRequest' }),
    );
    expect(screen.queryByText(/used/i)).toBeNull();
  });

  it('an "unavailable" answer (xai has no usage endpoint) renders nothing — quieter than an error line', async () => {
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    const trigger = () => container.querySelector('.mp-trigger') as HTMLElement;
    await fireEvent.click(trigger());
    postFromHost({ type: 'sessionModels', models: { [SID]: 'xai/grok-4' } });
    postFromHost({ type: 'providerAuthData', methods: {}, connected: { xai: { type: 'oauth' } } });
    await fireEvent.click(trigger());

    postFromHost({ type: 'providerUsageData', providerId: 'xai', unavailable: 'xAI publishes no usage endpoint for OAuth sign-ins.' });

    expect(screen.queryByText(/xAI publishes/i)).toBeNull();
    expect(screen.queryByText(/used/i)).toBeNull();
  });

  it('asks the host WHICH providers can report usage, once, on mount', async () => {
    // Config-only on the host side, so it answers before any chat exists — the
    // pill for a key-bought plan must not wait for a session to open.
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'providerUsageCapableRequest' });
  });

  it('refreshes on turnDone for THIS session — not a timer, and not another session\'s turn', async () => {
    render(ModelPicker, { props: { sessionId: SID, online: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Select model/i }));
    postFromHost({ type: 'sessionModels', models: { [SID]: 'openai/gpt-5-turbo' } });
    postFromHost({ type: 'providerAuthData', methods: {}, connected: { openai: { type: 'oauth' } } });
    globalThis.__vscodeApiMock.postMessage.mockReset();

    postFromHost({ type: 'turnDone', stopReason: 'end_turn', sessionId: SID });
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'providerUsageRequest', providerId: 'openai' });

    globalThis.__vscodeApiMock.postMessage.mockReset();
    postFromHost({ type: 'turnDone', stopReason: 'end_turn', sessionId: 'some-other-session' });
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'providerUsageRequest' }),
    );
  });
});

// OpenCode GO is a FLAT-RATE plan bought with an API key, so it has no OAuth
// credential to light the gate above — and it is metered nowhere, so the cost
// badge it used to show was a price nobody pays. The pill has to read
// CONSUMPTION for it instead, which means the gate needs a second way in:
// `providerUsageCapable`, an id list the host reads from the config file.
describe('ModelPicker — subscription usage for a key-bought plan (opencode-go)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
  });

  /** Seed the picker with an active model, then reopen so the gate can fire. */
  async function openWith(container: HTMLElement, model: string, seed: Record<string, unknown>[]) {
    const trigger = () => container.querySelector('.mp-trigger') as HTMLElement;
    await fireEvent.click(trigger());
    postFromHost({ type: 'sessionModels', models: { [SID]: model } });
    for (const m of seed) postFromHost(m);
    await fireEvent.click(trigger()); // close
    globalThis.__vscodeApiMock.postMessage.mockReset();
    await fireEvent.click(trigger()); // reopen — it now knows enough to ask
  }

  it('asks for usage and renders the Weekly line when the host says opencode-go is capable', async () => {
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    await openWith(container, 'opencode-go/deepseek-v4-flash', [
      { type: 'providerUsageCapable', ids: ['opencode-go'] },
    ]);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'providerUsageRequest',
      providerId: 'opencode-go',
    });

    postFromHost({
      type: 'providerUsageData',
      providerId: 'opencode-go',
      plan: 'go',
      lines: ['Weekly: 12% used, resets in 3d 11h', '5-hour: 30% used, resets in 2h 30m', 'Monthly: 6% used'],
    });
    // The pill shows the FIRST line only — the Weekly cap is the budget a user
    // actually manages.
    expect(await screen.findByText('Weekly: 12% used, resets in 3d 11h')).toBeInTheDocument();
    expect(screen.queryByText(/Monthly/)).toBeNull();
  });

  it('asks NOTHING and shows NOTHING for opencode-go when the host did not report it capable', async () => {
    // No key in the config = the engine would refuse. Firing anyway would put an
    // ext round-trip on every turn end for a provider that can never answer.
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    await openWith(container, 'opencode-go/deepseek-v4-flash', [{ type: 'providerUsageCapable', ids: [] }]);

    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'providerUsageRequest' }),
    );
    postFromHost({ type: 'providerUsageData', providerId: 'opencode-go', lines: ['5-hour: 30% used'] });
    await tick();
    expect(screen.queryByText(/30% used/)).toBeNull();
  });

  it('capability is PER PROVIDER — a capable opencode-go does not unlock OpenCode Zen', async () => {
    // `opencode` and `opencode-go` are two providers on one host. Zen is metered
    // per token and has no usage route; asking for it would earn a refusal.
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    await openWith(container, 'opencode/deepseek-v4-flash', [{ type: 'providerUsageCapable', ids: ['opencode-go'] }]);

    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'providerUsageRequest' }),
    );
  });

  it('an OLDER host that never sends providerUsageCapable leaves the OAuth path working', async () => {
    // Version skew: a new webview against an engine/host build without the
    // capability message must not lose the pill it already had.
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    await openWith(container, 'openai/gpt-5-turbo', [
      { type: 'providerAuthData', methods: {}, connected: { openai: { type: 'oauth' } } },
    ]);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'providerUsageRequest',
      providerId: 'openai',
    });
  });

  it('a capability list does not disturb the OAuth providers already in it', async () => {
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    await openWith(container, 'xai/grok-4', [
      { type: 'providerAuthData', methods: {}, connected: { xai: { type: 'oauth' } } },
      { type: 'providerUsageCapable', ids: ['opencode-go'] },
    ]);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'providerUsageRequest',
      providerId: 'xai',
    });
  });

  it('a malformed capability payload closes the gate rather than opening it', async () => {
    const { container } = render(ModelPicker, { props: { sessionId: SID, online: true } });
    await openWith(container, 'opencode-go/deepseek-v4-flash', [{ type: 'providerUsageCapable', ids: 'opencode-go' }]);

    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'providerUsageRequest' }),
    );
  });
});

// The `.mp-usage` pill used to clip the reset time in usageLine()'s own output
// ("On-demand: 100% used, resets in 29d 23h") behind a fixed 150px + ellipsis —
// not just under a crowded model-bar, but always, because 150px is narrower
// than the text at any realistic length. jsdom never lays out the <style>
// block (see docs/WORKING_ON_ORIGAMI_CODER.md Part 6: no `css: true` in
// vitest.config.mts, so getComputedStyle answers ''), so this reads the
// SOURCE instead — the same technique chartCard.test.ts uses for ToolCard's
// max-height — and checks the declared rule against a real worst-case string
// rather than trusting a hand-picked number.
describe('ModelPicker — the usage pill is sized to fit a real reset-time line', () => {
  const MODEL_PICKER_SRC = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'ModelPicker.svelte'),
    'utf8',
  );

  /** The declared value of one CSS property on one selector inside
   *  ModelPicker's <style> block, or undefined when either is absent. */
  function declaredCss(selector: string, prop: string): string | undefined {
    const escapedSel = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = new RegExp(`(?:^|\\n)\\s*${escapedSel}\\s*\\{([^}]*)\\}`).exec(MODEL_PICKER_SRC)?.[1];
    if (!body) return undefined;
    const escapedProp = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${escapedProp}:\\s*([^;]+)`).exec(body)?.[1].trim();
  }

  it('sizes to its content — no fixed width forcing an early ellipsis', () => {
    expect(declaredCss('.mp-usage', 'width')).toBe('max-content');
  });

  it('still truncates SAFELY — overflow/ellipsis remain, guarding a pathological provider-supplied label', () => {
    expect(declaredCss('.mp-usage', 'overflow')).toBe('hidden');
    expect(declaredCss('.mp-usage', 'white-space')).toBe('nowrap');
    expect(declaredCss('.mp-usage', 'text-overflow')).toBe('ellipsis');
  });

  it('the max-width safety cap comfortably fits the longest line the two OAuth providers actually produce', () => {
    // "On-demand" is xai's own second row (see OAUTH_PROVIDER_NAME +
    // parseGrokUsage in packages/engine/src/acp/provider-usage.ts) and a
    // near-month reset is the longest span usageLine() renders in days+hours —
    // together the worst realistic case this pill has to fit.
    const now = Date.now();
    const worst = usageLine(
      { label: 'On-demand', usedPercent: 100, resetsAt: now + (29 * 86400 + 23 * 3600) * 1000 },
      now,
    );
    expect(worst).toBe('On-demand: 100% used, resets in 29d 23h');

    const declared = declaredCss('.mp-usage', 'max-width') ?? '';
    const maxWidthPx = Number(/^([\d.]+)px$/.exec(declared)?.[1]);
    expect(Number.isFinite(maxWidthPx)).toBe(true);
    // A conservative average glyph width for a 9.5px UI sans font. The OLD
    // rule (150px) fails this by a wide margin for ANY line carrying a reset
    // time — that gap is the bug this pins.
    const estimatedTextWidthPx = worst.length * 5.5;
    expect(maxWidthPx).toBeGreaterThanOrEqual(estimatedTextWidthPx);
  });
});
