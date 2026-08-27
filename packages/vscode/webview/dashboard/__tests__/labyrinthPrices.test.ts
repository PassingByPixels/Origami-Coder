// YOUR OWN PRICES, and the indicative figure drawn from them.
//
// The failures worth catching are all one failure — a currency number the
// reader believes and should not:
//  - a dollar figure with no prices behind it,
//  - a price the store refused still showing as though it had been kept,
//  - a rate typed as nonsense reaching the arithmetic as NaN,
//  - a figure that silently ignores a model with no price.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import LabyrinthPane from '../panes/LabyrinthPane.svelte';
import {
  LABYRINTH_PRICES_MESSAGE_TYPES, handleLabyrinthPricesMessage, sanitisePrices, type PriceTable,
} from '../../../src/dashboard/labyrinthPrices';

const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ');
const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const RUNS = [{ sessionId: 'ses_a', title: 'T', folder: 'f', cwd: 'C:/x', updatedAt: '2026-07-27T14:05:00.000Z' }];
const step = (ordinal: number, over: Record<string, unknown> = {}) => ({ ordinal, kind: 'reply', title: `s${ordinal}`, ...over });
const RUN = [
  step(0, { agent: 'build', model: 'openai/gpt-5.6-sol', tokens: { input: 1_000, output: 100, cache: { read: 9_000 } } }),
  step(1, { agent: 'build', model: 'xai/grok-4.5', tokens: { input: 200, output: 20, cache: { read: 800 } } }),
];

async function openRun() {
  const rendered = render(LabyrinthPane);
  send({ type: 'historyList', sessions: RUNS });
  await tick();
  await fireEvent.click(rendered.container.querySelector('.lab-run')!);
  await tick();
  send({ type: 'runStepsData', sessionId: 'ses_a', steps: RUN, truncated: false, total: RUN.length });
  await tick();
  return rendered;
}

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('labyrinthPrices host leaf — nothing crosses the wire unchecked', () => {
  /** A Memento stand-in: what the panel stores really is read back. */
  function host(initial: unknown = undefined) {
    const posted: Array<Record<string, unknown>> = [];
    let stored: unknown = initial;
    return {
      posted,
      read: () => stored,
      current: () => stored,
      impl: { read: () => stored, write: (next: PriceTable) => { stored = next; }, post: (x: Record<string, unknown>) => { posted.push(x); } },
    };
  }

  it('round-trips a saved table through the store and echoes what was KEPT', () => {
    const h = host();
    handleLabyrinthPricesMessage(h.impl, { type: 'saveLabyrinthPrices', prices: { 'openai/gpt-5.6-sol': { input: 1.25, output: 10 } } });
    expect(h.current()).toEqual({ 'openai/gpt-5.6-sol': { input: 1.25, output: 10 } });

    const h2 = host(h.current());
    handleLabyrinthPricesMessage(h2.impl, { type: 'requestLabyrinthPrices' });
    expect(h2.posted).toEqual([{ type: 'labyrinthPrices', prices: { 'openai/gpt-5.6-sol': { input: 1.25, output: 10 } } }]);
  });

  it('the echo is the STORED table, not the one that was asked for', () => {
    const h = host();
    // Every field unusable, so nothing is kept — and the panel must be told so
    // rather than left showing a price that was refused.
    handleLabyrinthPricesMessage(h.impl, { type: 'saveLabyrinthPrices', prices: { 'a/b': { input: -1, output: Number.NaN } } });
    expect(h.current()).toEqual({});
    expect(h.posted[0]).toEqual({ type: 'labyrinthPrices', prices: {} });
  });

  it('refuses what is not a price: NaN, Infinity, negatives, strings, nesting', () => {
    expect(sanitisePrices({ 'a/b': { input: Number.NaN } })).toEqual({});
    expect(sanitisePrices({ 'a/b': { input: Number.POSITIVE_INFINITY } })).toEqual({});
    expect(sanitisePrices({ 'a/b': { input: -2 } })).toEqual({});
    expect(sanitisePrices({ 'a/b': { input: '1.25' } })).toEqual({});
    expect(sanitisePrices({ 'a/b': { input: 1, junk: 'x' } })).toEqual({ 'a/b': { input: 1 } });
    // A genuine 0 IS a price — a free local model costs nothing, and saying so
    // is a measurement, not an absence.
    expect(sanitisePrices({ 'a/b': { input: 0 } })).toEqual({ 'a/b': { input: 0 } });
  });

  it('survives a store that holds junk, or nothing at all', () => {
    expect(sanitisePrices(undefined)).toEqual({});
    expect(sanitisePrices(null)).toEqual({});
    expect(sanitisePrices('nope')).toEqual({});
    expect(sanitisePrices([{ input: 1 }])).toEqual({});
  });

  it('owns exactly the two message types the pane sends', () => {
    expect([...LABYRINTH_PRICES_MESSAGE_TYPES].sort()).toEqual(['requestLabyrinthPrices', 'saveLabyrinthPrices']);
  });
});

describe('Labyrinth prices — the panel, the gear, and the indicative figure', () => {
  it('asks the host for the stored table on mount', async () => {
    render(LabyrinthPane);
    await tick();
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'requestLabyrinthPrices' });
  });

  it('the gear opens a row per model that RAN, and closes again', async () => {
    const { container } = await openRun();
    expect(container.querySelector('.lp-panel')).toBeNull();

    await fireEvent.click(container.querySelector('.lab-prices') as HTMLButtonElement);
    await tick();
    const rows = Array.from(container.querySelectorAll('.lp-row:not(.lp-header) .lp-model')).map((e) => flat(e.textContent));
    expect(rows).toEqual(['openai/gpt-5.6-sol', 'xai/grok-4.5']);
    expect(container.querySelector('.lab-prices')!.getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(container.querySelector('.lab-prices') as HTMLButtonElement);
    await tick();
    expect(container.querySelector('.lp-panel')).toBeNull();
  });

  // COMMITTED, not per keystroke: the host echoes the stored table straight
  // back, so a per-keystroke save would normalise a half-typed "1." to "1"
  // under the cursor and the decimal could never be typed.
  it('a typed price is sent to the host when the box is committed, not on every keystroke', async () => {
    const { container } = await openRun();
    await fireEvent.click(container.querySelector('.lab-prices') as HTMLButtonElement);
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    const input = container.querySelector('.lp-row:not(.lp-header) .lp-num') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '1.2' } });
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();

    await fireEvent.change(input, { target: { value: '1.25' } });
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'saveLabyrinthPrices', prices: { 'openai/gpt-5.6-sol': { input: 1.25 } },
    });
  });

  it('clearing a box ERASES that price rather than storing a zero', async () => {
    const { container } = await openRun();
    send({ type: 'labyrinthPrices', prices: { 'openai/gpt-5.6-sol': { input: 1.25, output: 10 } } });
    await tick();
    await fireEvent.click(container.querySelector('.lab-prices') as HTMLButtonElement);
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    const input = container.querySelector('.lp-row:not(.lp-header) .lp-num') as HTMLInputElement;
    await fireEvent.change(input, { target: { value: '' } });

    // A stored 0 would price the run's whole prefill at nothing, which reads as
    // a free model rather than as a price nobody has entered.
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'saveLabyrinthPrices', prices: { 'openai/gpt-5.6-sol': { output: 10 } },
    });
  });

  it('NO prices means NO currency figure — never a $0 that reads as free', async () => {
    const { container } = await openRun();
    expect(container.querySelector('.spend-quote')).toBeNull();
    expect(flat(container.querySelector('.lab-spend')!.textContent)).not.toContain('indicative');
  });

  it('with prices, the figure appears — labelled indicative, and marked PARTIAL when one model has none', async () => {
    const { container } = await openRun();
    send({ type: 'labyrinthPrices', prices: { 'openai/gpt-5.6-sol': { input: 1.25, output: 10 } } });
    await tick();

    const quote = flat(container.querySelector('.spend-quote')!.textContent);
    // 1,000 in + 9,000 cached at a tenth + 100 out = $0.0022...; the xAI model
    // has no price, so the figure is a FLOOR and says so with the ≥.
    expect(quote).toContain('indicative');
    expect(quote).toContain('≥');

    send({ type: 'labyrinthPrices', prices: { 'openai/gpt-5.6-sol': { input: 1.25, output: 10 }, 'xai/grok-4.5': { input: 3, output: 15 } } });
    await tick();
    expect(flat(container.querySelector('.spend-quote')!.textContent)).toContain('~');
  });

  it('a table the host refused leaves the panel showing nothing, not the refused value', async () => {
    const { container } = await openRun();
    send({ type: 'labyrinthPrices', prices: {} });
    await tick();
    await fireEvent.click(container.querySelector('.lab-prices') as HTMLButtonElement);
    await tick();

    const boxes = Array.from(container.querySelectorAll('.lp-row:not(.lp-header) .lp-num')) as HTMLInputElement[];
    expect(boxes.every((b) => b.value === '')).toBe(true);
    expect(container.querySelector('.spend-quote')).toBeNull();
  });
});
