// t-ru13hb item 5 — PINNING THE CONTEXT BREAKDOWN CARD.
//
// The breakdown card was hover-only: it opened on entering the gauge wrap and
// went away on leaving it, and the card itself is `pointer-events: none`, so
// the numbers could be read but never held still, copied or pointed at.
//
// DEVIATION, declared. The ruling says "click the gauge pins the card". The
// gauge's click is already taken: it arms the compaction fuse (`onGaugeClick`
// → contextFuse.ts), which its own aria-label and warm tip both advertise.
// Taking that click for the pin would either remove compaction from the gauge
// (an engine that reports a composition would have no compact button at all,
// since the card is drawn for exactly that engine) or fire both actions from
// one click. The pin is therefore its own control, inside the gauge wrap so
// the hover that drew the card is not broken by reaching for it. Everything
// else in the ruling holds: one card, one component, the same composer-anchored
// position, Esc and click-outside unpin.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import InputBar from './InputBar.svelte';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const SID = 'sess-pin-1';
const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const COMPOSITION = { systemPrompt: 1800, tools: 4200, conversation: 106900, estimated: true, method: 'chars/4' };

afterEach(cleanup);

async function withCard(): Promise<HTMLElement> {
  const { container } = render(InputBar, {
    props: {
      inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
      sessionId: SID, onCompact: () => {}, onSend: () => {}, onCancel: () => {},
    },
  });
  post({
    type: 'contextUpdate', sessionId: SID, turns: 3, contextWindow: 128000,
    contextUsed: 112900, contextTotal: 0, composition: COMPOSITION,
  });
  await new Promise((r) => setTimeout(r, 0));
  return container as HTMLElement;
}

const wrap = (c: HTMLElement) => c.querySelector('.ctx-gauge-wrap') as HTMLElement;
const pin = (c: HTMLElement) => c.querySelector('.ctx-pin') as HTMLButtonElement | null;
const card = (c: HTMLElement) => c.querySelector('.ctx-card');
const pop = (c: HTMLElement) => c.querySelector('.ctx-card-pop') as HTMLElement | null;

describe('the breakdown card can be pinned open', () => {
  it('offers no pin until the card is on screen', async () => {
    const c = await withCard();
    expect(pin(c), 'nothing to pin yet').toBeNull();
    await fireEvent.mouseEnter(wrap(c));
    expect(pin(c)).not.toBeNull();
  });

  it('a click on the pin holds the card through the pointer leaving', async () => {
    const c = await withCard();
    await fireEvent.mouseEnter(wrap(c));
    await fireEvent.click(pin(c)!);
    await fireEvent.mouseLeave(wrap(c));
    expect(card(c), 'the whole point: it survives the pointer moving away').not.toBeNull();
    expect(pin(c)!.getAttribute('aria-pressed')).toBe('true');
  });

  it('is the SAME card, in the same composer-anchored place — not a second one', async () => {
    const c = await withCard();
    await fireEvent.mouseEnter(wrap(c));
    await fireEvent.click(pin(c)!);
    await fireEvent.mouseLeave(wrap(c));
    expect(c.querySelectorAll('.ctx-card')).toHaveLength(1);
    expect(c.querySelectorAll('.ctx-card-pop')).toHaveLength(1);
    // `.ctx-card-pop` is what carries the anchoring (right edge on the
    // composer's own gutter); the pin must not move the card out of it.
    expect(pop(c)!.contains(card(c)!)).toBe(true);
    // Pinned, it is reachable: a card nobody can put the pointer on cannot be
    // read from, which is what `pointer-events: none` means at rest.
    expect(pop(c)!.classList.contains('pinned')).toBe(true);
  });

  it('Escape unpins it', async () => {
    const c = await withCard();
    await fireEvent.mouseEnter(wrap(c));
    await fireEvent.click(pin(c)!);
    await fireEvent.mouseLeave(wrap(c));
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(card(c)).toBeNull();
  });

  it('a click outside unpins it, and a click inside the card does not', async () => {
    const c = await withCard();
    await fireEvent.mouseEnter(wrap(c));
    await fireEvent.click(pin(c)!);
    await fireEvent.mouseLeave(wrap(c));

    await fireEvent.pointerDown(card(c)!);
    expect(card(c), 'reading the card is not leaving it').not.toBeNull();

    await fireEvent.pointerDown(document.body);
    expect(card(c)).toBeNull();
  });

  it('clicking the pin again puts it away', async () => {
    const c = await withCard();
    await fireEvent.mouseEnter(wrap(c));
    await fireEvent.click(pin(c)!);
    await fireEvent.click(pin(c)!);
    await fireEvent.mouseLeave(wrap(c));
    expect(card(c)).toBeNull();
  });

  it('the pin does not arm the compaction fuse the gauge click arms', async () => {
    const c = await withCard();
    await fireEvent.mouseEnter(wrap(c));
    await fireEvent.click(pin(c)!);
    // `armed` is the fuse's own class on the gauge (contextFuse.ts).
    expect(c.querySelector('.ctx-gauge.armed'), 'the pin is not a compact').toBeNull();
  });

  it('keeps the card anchored to the composer, pinned or not (CSS source)', () => {
    const css = readFileSync(path.join(thisDir, 'InputBar.svelte'), 'utf8');
    const rule = /\.ctx-card-pop\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/right:\s*var\(--composer-gutter\)/);
    // The pinned variant may only re-enable the pointer; moving it would put
    // the same card in two different places depending on how it was opened.
    const pinned = /\.ctx-card-pop\.pinned\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(pinned).toMatch(/pointer-events:\s*auto/);
    expect(pinned, 'the pin must not re-anchor the card').not.toMatch(/right:|left:|bottom:|top:/);
  });
});
