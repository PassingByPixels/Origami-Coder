// SecondOpinionMenu — the flyout, rendered.
//
// secondOpinionModels.test.ts already pins WHICH models qualify and how they
// tier, on the pure projection. What this file adds is the half that
// projection cannot prove: that the menu actually READS the broadcasts it
// claims to be self-contained on, that the session it was mounted for is the
// one whose current model gets excluded (a grid shows twelve composers, and
// reading the wrong cell's model would offer the wrong exclusion in every one
// of them), that a provider group actually OPENS on its header and typing
// actually flattens the tree, and that a pick reports the model rather than
// posting a switch of its own.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { tick } from 'svelte';
import SecondOpinionMenu from './SecondOpinionMenu.svelte';

const post = () => globalThis.__vscodeApiMock.postMessage;
const posts = () => post().mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;

const CATALOGUE = [
  { value: 'lmstudio/qwen3-coder-30b', name: 'Qwen3 Coder 30B' },
  { value: 'lmstudio/devstral-small', name: 'Devstral Small' },
  { value: 'openrouter/openai/gpt-5', name: 'GPT-5' },
];

// The providerStatus rows the host would broadcast for that catalogue — the
// baseURL is the tier signal (loopback → Local/Self Hosted, a known
// aggregator → Providers), same as ModelPicker's tier-1.
const STATUS = [
  { id: 'lmstudio', name: 'LM Studio', live: true, baseURL: 'http://127.0.0.1:1234/v1' },
  { id: 'openrouter', name: 'OpenRouter', live: true, baseURL: 'https://openrouter.ai/api/v1' },
];

async function open(sessionModels: Record<string, string>, props: Record<string, unknown> = {}) {
  const rendered = render(SecondOpinionMenu, {
    sessionId: 'chat-7',
    onPick: () => {},
    onClose: () => {},
    ...props,
  });
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'modelOptions', options: CATALOGUE } }));
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'sessionModels', models: sessionModels } }));
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'providerStatus', providers: STATUS } }));
  await tick();
  return rendered;
}

const rowText = (container: HTMLElement) =>
  [...container.querySelectorAll('.so-model')].map((el) => el.textContent!.trim());
const headerText = (container: HTMLElement) =>
  [...container.querySelectorAll('.so-provider .so-provider-name')].map((el) => el.textContent!.trim());
const expandProvider = async (container: HTMLElement, name: string) => {
  const header = [...container.querySelectorAll('.so-provider')].find(
    (el) => el.querySelector('.so-provider-name')!.textContent!.trim() === name,
  )!;
  await fireEvent.click(header);
  await tick();
};

beforeEach(() => post().mockReset());
afterEach(() => cleanup());

describe('it feeds itself from the broadcasts, like the model picker', () => {
  it('asks for all three lists on mount — it only ever mounts when it opens', () => {
    render(SecondOpinionMenu, { sessionId: 'chat-7', onPick: () => {}, onClose: () => {} });
    expect(posts()).toEqual([
      { type: 'requestModels' },
      { type: 'requestSessionModels' },
      { type: 'requestProviderStatus' },
    ]);
  });

  it('says so, rather than rendering an empty box, when nothing has arrived', async () => {
    const { container } = render(SecondOpinionMenu, { sessionId: 'chat-7', onPick: () => {}, onClose: () => {} });
    await tick();
    expect(container.querySelector('.so-empty')!.textContent).toContain('No models are configured');
  });
});

describe('the tree: tier headings over COLLAPSED provider groups', () => {
  it('renders the tier headings the connections picker uses, with providers under them', async () => {
    const { container } = await open({ 'chat-7': '' });
    expect([...container.querySelectorAll('.so-tier')].map((e) => e.textContent)).toEqual([
      'Local/Self Hosted',
      'Providers',
    ]);
    expect(headerText(container)).toEqual(['lmstudio', 'openrouter']);
  });

  it('starts every group collapsed — a header row with the model COUNT, no model rows at all', async () => {
    const { container } = await open({ 'chat-7': '' });
    expect(rowText(container)).toEqual([]);
    expect([...container.querySelectorAll('.so-count')].map((e) => e.textContent)).toEqual(['2', '1']);
    for (const header of container.querySelectorAll('.so-provider')) {
      expect(header.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('opens ONE group on its header click, leaves the others shut, and closes it again', async () => {
    const { container } = await open({ 'chat-7': '' });

    await expandProvider(container, 'lmstudio');
    expect(rowText(container)).toEqual(['Qwen3 Coder 30B', 'Devstral Small']);

    await expandProvider(container, 'lmstudio');
    expect(rowText(container)).toEqual([]);
  });
});

describe('THIS chat’s model is off the list', () => {
  it('excludes it, and says why', async () => {
    const { container } = await open({ 'chat-7': 'lmstudio/qwen3-coder-30b' });
    await expandProvider(container, 'lmstudio');
    expect(rowText(container)).toEqual(['Devstral Small']);
    expect(container.textContent).toContain('it cannot second-guess itself');
  });

  it('reads the model of the session it was MOUNTED for, not some other cell’s', async () => {
    // The grid case. `chat-9` runs the model that would have been excluded; this
    // menu belongs to `chat-7`, so that model must still be offered here.
    const { container } = await open({ 'chat-7': 'lmstudio/devstral-small', 'chat-9': 'lmstudio/qwen3-coder-30b' });
    await expandProvider(container, 'lmstudio');
    expect(rowText(container)).toEqual(['Qwen3 Coder 30B']);
  });

  it('offers everything when the chat has no model yet, and claims no exclusion', async () => {
    const { container } = await open({});
    expect([...container.querySelectorAll('.so-count')].map((e) => e.textContent)).toEqual(['2', '1']);
    expect(container.textContent).not.toContain('second-guess itself');
  });
});

describe('the filter bypasses the tree', () => {
  it('shows matching MODEL rows flat — no headers to click through — and restores the tree when cleared', async () => {
    const { container } = await open({ 'chat-7': '' });
    const input = container.querySelector('.so-filter') as HTMLInputElement;

    await fireEvent.input(input, { target: { value: 'devstral' } });
    await tick();
    expect(rowText(container)).toEqual(['Devstral Small']);
    expect(container.querySelectorAll('.so-provider')).toHaveLength(0);
    expect(container.querySelectorAll('.so-tier')).toHaveLength(0);

    await fireEvent.input(input, { target: { value: '' } });
    await tick();
    expect(rowText(container)).toEqual([]);
    expect(headerText(container)).toEqual(['lmstudio', 'openrouter']);
  });

  it('says so when nothing matches', async () => {
    const { container } = await open({ 'chat-7': '' });
    const input = container.querySelector('.so-filter') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'nothing-matches' } });
    await tick();
    expect(rowText(container)).toEqual([]);
    expect(container.querySelector('.so-empty')!.textContent).toContain('No other model matches your filter');
  });

  it('cannot bring the excluded current model back', async () => {
    const { container } = await open({ 'chat-7': 'lmstudio/qwen3-coder-30b' });
    const input = container.querySelector('.so-filter') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'qwen3-coder' } });
    await tick();
    expect(rowText(container)).toEqual([]);
  });
});

describe('picking and closing', () => {
  it('reports the pick upward and posts NOTHING itself', async () => {
    const onPick = vi.fn();
    const { container } = await open({ 'chat-7': 'lmstudio/qwen3-coder-30b' }, { onPick });
    await expandProvider(container, 'openrouter');
    post().mockReset();

    await fireEvent.click(container.querySelector('.so-model')!);

    // The row owns the request (ChangesPill); the menu owns the choice. A menu
    // that posted its own would put the wire in two places.
    expect(onPick).toHaveBeenCalledWith('openrouter/openai/gpt-5', 'GPT-5');
    expect(post()).not.toHaveBeenCalled();
  });

  it('keeps the full value on each row’s title, so an ambiguous name is still identifiable', async () => {
    const { container } = await open({ 'chat-7': '' });
    await expandProvider(container, 'openrouter');
    expect((container.querySelector('.so-model') as HTMLElement).title).toBe('openrouter/openai/gpt-5');
  });

  it('closes on Escape and on a click outside', async () => {
    const onClose = vi.fn();
    const { container } = await open({ 'chat-7': '' }, { onClose });

    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    await fireEvent.click(container.querySelector('.so-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('says review-only on its face — the user is told before picking, not after', async () => {
    const { container } = await open({ 'chat-7': '' });
    expect(container.querySelector('.so-lede')!.textContent).toContain('it cannot change anything');
  });
});
