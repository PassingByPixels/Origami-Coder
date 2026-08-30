// The Add-Connection catalog: what order the Labs entries render in, and what
// the compat form is allowed to submit.
//
// Both are OWNER UAT calls from the 0.3.83 round:
//
//   (E) The five Labs entries read as an unordered pile — each lab's API entry
//       and its OAuth twin were separated by the other lab. They must pair up:
//       API first, its OAuth entry directly under it, Anthropic last.
//
//   (D) "Other (OpenAI-compatible)" refused to save without an API key. That is
//       backwards for the endpoints it exists to reach: an SGLang / llama.cpp /
//       vLLM server on the tailnet enforces no auth at all, and the SDK only
//       sends an Authorization header when a key is actually configured
//       (@ai-sdk/openai-compatible's createOpenAICompatible spreads
//       `...options.apiKey && { Authorization }` — no key, no header, no throw).
//       So a blank key is a legitimate save, and the block simply omits the
//       field (firstFold.writeModelConfig: `if (choice.apiKey) options.apiKey =`).
//
// SETUP_PROVIDERS now lives in setupCatalog.ts, so the catalog half is IMPORTED
// rather than regex-scraped out of the component source. That is strictly
// stricter: the test reads the real values the component renders, so a typo in a
// field name is a type error here instead of a silently-unmatched regex. The
// form half is still rendered, because what is being asserted there is whether
// the Connect button is reachable.

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import ControlStrip from '../ControlStrip.svelte';
import { classifySection } from '../connectionSection';
import { SETUP_PROVIDERS } from '../setupCatalog';

const catalogIds = (): string[] => SETUP_PROVIDERS.map((p) => p.id);

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

describe('the Labs entries pair each lab with its own OAuth twin', () => {
  it('renders OpenAI, OpenAI (OAuth), Grok, Grok (OAuth), Anthropic — in that order', () => {
    const ids = catalogIds();
    const labs = ids.filter((id) => ['openai', 'openai-oauth', 'xai', 'xai-oauth', 'anthropic'].includes(id));
    expect(labs).toEqual(['openai', 'openai-oauth', 'xai', 'xai-oauth', 'anthropic']);
  });

  it('the parser found a real catalog (guards a silently-passing assertion)', () => {
    expect(catalogIds()).toContain('lmstudio');
    expect(catalogIds().length).toBeGreaterThan(8);
  });

  it('LM Studio is still first — it is the seeded default (setupProviderId)', () => {
    // SETUP_PROVIDERS[0] is the fallback for an unknown id, and 'lmstudio' is the
    // initial selection. A reorder that moved it would change the form on open.
    expect(catalogIds()[0]).toBe('lmstudio');
  });
});

// The Claude entry, 0.4.60. It was there before under the company's name
// ("Anthropic (API)", model claude-sonnet-4-5) and read as a lab nobody had
// heard of next to "OpenAI" and "Grok" — the product people actually ask for is
// Claude. Three separate facts are pinned because each fails differently:
//
//   label  — what the picker shows. Cosmetic, and the only one a user sees.
//   name   — the pill/chip face AND the `name` written into the provider block
//            (providerIdentity.setupProviderPayload -> writeModelConfig). The
//            sidebar chip is `name.slice(0,2).toUpperCase()`, so this is what
//            makes the chip read CL rather than AN.
//   id     — 'anthropic', unchanged. It is the engine catalog id, the auth.json
//            key and the `provider.<id>` block. Renaming it to match the label
//            would orphan every connection already on disk and quietly detach
//            the engine's own anthropic support, which is the whole point of
//            this being a separate field from the two above.
describe('the Anthropic entry presents as Claude', () => {
  const claude = () => SETUP_PROVIDERS.find((p) => p.id === 'anthropic')!;

  it('is labelled for the product, named for the pill, and still keyed on the provider id', () => {
    expect(claude(), 'the anthropic entry must not be renamed out of the catalog').toBeTruthy();
    expect(claude().label).toBe('Claude (Anthropic API)');
    expect(claude().name).toBe('Claude');
    expect(claude().id).toBe('anthropic');
  });

  it('starts on the current Sonnet id, and stays a keyed cloud entry with no base URL', () => {
    // claude-sonnet-4-5 was two generations stale. The id must be one the engine's
    // baked models.dev snapshot actually carries, or the first message 404s.
    expect(claude().model).toBe('claude-sonnet-5');
    expect(claude().kind).toBe('cloud');
    expect(claude().baseURL).toBeUndefined();
    expect(claude().keyOnly).toBeUndefined();
  });

  it('is still classified into Labs — the section reads the id, not the label', () => {
    expect(classifySection({ id: claude().id })).toBe('labs');
  });

  it('renders under Labs with its new face', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Labs/ }));
    expect(screen.getByRole('button', { name: 'Claude (Anthropic API)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Anthropic (API)' })).toBeNull();
  });
});

describe('the "Other (OpenAI-compatible)" form and a blank API key', () => {
  /** Open Add provider -> Other -> the generic compat entry. */
  async function openOther() {
    await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Other/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Other (OpenAI-compatible)' }));
  }

  it('Connect is reachable with a URL and a model but NO key', async () => {
    render(ControlStrip);
    await openOther();
    await fireEvent.input(screen.getByLabelText('Provider base URL'), {
      target: { value: 'http://localhost:30000/v1' },
    });
    await fireEvent.input(screen.getByLabelText('Model id'), { target: { value: 'qwen38-27b' } });

    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(connect.disabled, 'a keyless OpenAI-compatible server must be savable').toBe(false);

    await fireEvent.click(connect);
    const sent = posted.find((m) => m['type'] === 'setupProvider');
    expect(sent, 'Connect posted nothing').toBeTruthy();
    expect(sent!['baseURL']).toBe('http://localhost:30000/v1');
    expect(sent!['modelId']).toBe('qwen38-27b');
    // Blank, not absent-and-invented: the host writes no apiKey field for it.
    expect(sent!['apiKey']).toBe('');
  });

  it('still needs the base URL and the model — the key is the ONLY field relaxed', async () => {
    render(ControlStrip);
    await openOther();
    const connect = () => screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(connect().disabled).toBe(true);

    await fireEvent.input(screen.getByLabelText('Provider base URL'), { target: { value: 'http://localhost:30000/v1' } });
    expect(connect().disabled, 'a model id is still required').toBe(true);
  });

  it('a CLOUD entry still refuses to save without a key', async () => {
    // Anthropic/OpenAI/xAI carry a baked catalog and no base URL — a keyless
    // block there is not an unauthenticated server, it is a broken connection.
    render(ControlStrip);
    await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Labs/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Claude (Anthropic API)' }));
    await fireEvent.input(screen.getByLabelText('Model id'), { target: { value: 'claude-sonnet-4-5' } });

    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// A self-hosted server MAY require a key. LM Studio, Ollama and vLLM can all be
// put behind one ("I could require an API for LM studio if i wanted"), and until
// now the form gave those three presets no way to enter it — the field was not
// rendered for kind:'local' at all, and the submit hard-coded `apiKey: undefined`.
//
// The field is OPTIONAL, and that is the load-bearing half: the overwhelmingly
// common case is an unauthenticated loopback server, and a blank key must behave
// EXACTLY as it did before — Connect stays enabled, and nothing is written into
// the provider block (writeModelConfig's `if (choice.apiKey)` guards that, and
// @ai-sdk/openai-compatible only spreads an Authorization header when a key is
// truthy, so blank means no header on the wire either).
describe('a self-hosted preset can carry an OPTIONAL API key', () => {
  /** Open Add provider and pick one of the self-hosted presets. The merged
   *  Local/Self Hosted section is open by default, so no header click needed. */
  async function openSelfHosted(label: string) {
    await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    await fireEvent.click(screen.getByRole('button', { name: label }));
  }

  it('LM Studio now OFFERS an API key field, marked optional', async () => {
    render(ControlStrip);
    await openSelfHosted('LM Studio (local)');
    const key = screen.getByLabelText('Provider API key (optional)') as HTMLInputElement;
    expect(key).toBeInTheDocument();
    expect(key.type, 'a key must never render in the clear').toBe('password');
  });

  it('Ollama, vLLM and SGLang offer it too — every self-hosted preset, not just LM Studio', async () => {
    for (const label of ['Ollama (local)', 'vLLM (self-hosted)', 'SGLang (local)']) {
      render(ControlStrip);
      await openSelfHosted(label);
      expect(screen.getByLabelText('Provider API key (optional)'), label).toBeInTheDocument();
      cleanup();
    }
  });

  it('a BLANK key still connects, and posts no key — byte-identical to the old behaviour', async () => {
    render(ControlStrip);
    await openSelfHosted('LM Studio (local)');
    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(connect.disabled, 'the base URL alone must still be enough').toBe(false);

    await fireEvent.click(connect);
    const sent = posted.find((m) => m['type'] === 'setupProvider')!;
    expect(sent['baseURL']).toBe('http://127.0.0.1:1234/v1');
    // Falsy, so writeModelConfig writes no apiKey field and the SDK sends no
    // Authorization header. '' and undefined are both acceptable here; what must
    // NOT happen is a key appearing from nowhere.
    expect(sent['apiKey'] || '').toBe('');
  });

  it('a TYPED key is posted through to the host', async () => {
    render(ControlStrip);
    await openSelfHosted('LM Studio (local)');
    await fireEvent.input(screen.getByLabelText('Provider API key (optional)'), {
      target: { value: 'lms-secret-123' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    const sent = posted.find((m) => m['type'] === 'setupProvider')!;
    expect(sent['apiKey']).toBe('lms-secret-123');
    // The model is still left blank for the host to auto-pick: adding a key must
    // not turn LM Studio into a form that demands a model id.
    expect(sent['modelId']).toBe('');
  });

  it('the key stays OPTIONAL — a typed-then-cleared key does not block Connect', async () => {
    render(ControlStrip);
    await openSelfHosted('LM Studio (local)');
    const key = screen.getByLabelText('Provider API key (optional)');
    await fireEvent.input(key, { target: { value: 'oops' } });
    await fireEvent.input(key, { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a CLOUD entry keeps its own required, non-optional key field (unchanged)', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    await fireEvent.click(screen.getByRole('button', { name: /^Labs/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Claude (Anthropic API)' }));
    // Still the plain "API key" label, not the optional one — cloud is untouched.
    expect(screen.getByLabelText('Provider API key')).toBeInTheDocument();
    expect(screen.queryByLabelText('Provider API key (optional)')).toBeNull();
  });
});

// SGLang used to be mentioned only in comments/prose (a keyless-compat example
// in ControlStrip.svelte and this file's own header comment) — it had no
// catalog template, so it never actually appeared in the picker. It now mirrors
// the lmstudio/vllm/ollama template shape: a real SETUP_PROVIDERS entry, in the
// Local/Self Hosted section (mechanically, off its loopback baseURL), keyless
// by default with the same optional key field as its siblings.
describe('SGLang is a REAL catalog entry, not prose-only', () => {
  it('SETUP_PROVIDERS carries an sglang entry, local/localAuto, no fixed model', () => {
    const sglang = SETUP_PROVIDERS.find((p) => p.id === 'sglang');
    expect(sglang).toBeTruthy();
    expect(sglang!.kind).toBe('local');
    expect(sglang!.localAuto).toBe(true);
    expect(sglang!.baseURL).toBe('http://localhost:30000/v1');
    expect(sglang!.npm).toBe('@ai-sdk/openai-compatible');
  });

  it('renders in the picker, in the Local/Self Hosted section (open by default)', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    expect(screen.getByRole('button', { name: 'SGLang (local)' })).toBeInTheDocument();
  });

  it('accepting the default endpoint (no key) connects — byte-identical shape to LM Studio/vLLM/Ollama', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'SGLang (local)' }));
    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
    await fireEvent.click(connect);
    const sent = posted.find((m) => m['type'] === 'setupProvider')!;
    expect(sent['providerId']).toBe('sglang');
    expect(sent['baseURL']).toBe('http://localhost:30000/v1');
    expect(sent['apiKey']).toBe('');
    // localAuto: the host auto-picks the loaded model, same as its siblings.
    expect(sent['modelId']).toBe('');
  });

  it('a typed key is posted through, same as LM Studio', async () => {
    render(ControlStrip);
    await fireEvent.click(screen.getByRole('button', { name: /Add provider/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'SGLang (local)' }));
    await fireEvent.input(screen.getByLabelText('Provider API key (optional)'), { target: { value: 'sglang-secret' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const sent = posted.find((m) => m['type'] === 'setupProvider')!;
    expect(sent['apiKey']).toBe('sglang-secret');
  });
});
