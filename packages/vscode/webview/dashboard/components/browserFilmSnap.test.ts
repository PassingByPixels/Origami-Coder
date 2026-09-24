// t-ru13hb item 4 — THE NEWEST BROWSER FRAME, FULLY IN VIEW.
//
// The strip auto-scrolled to the newest frame with `scrollLeft = scrollWidth`.
// That is not the same thing as showing it. The strip carries
// `scroll-snap-type: x mandatory`, so after any programmatic scroll the browser
// re-snaps to the nearest snap position — and with every frame aligned `start`,
// the position it lands on cuts the last frame off at the right edge. The one
// frame the header and the caption are both describing was the one clipped.
//
// The fix is two halves that have to agree: the newest frame snaps to `end`
// (its own edge is the one flush with the strip's), and the arrival scrolls
// THAT ELEMENT into view with `inline: 'end'` instead of pushing scrollLeft
// past the end. Either half alone still fights the other.
//
// jsdom has no layout, so nothing here can measure a rect — the honest test is
// that the right element is asked, in the way the CSS is written to satisfy
// (WORKING_ON_ORIGAMI_CODER.md Part 6). The pixels were checked by eye; the
// shot is in the lane's report folder.

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';
import BrowserOverlay from './BrowserOverlay.svelte';
import type { BrowserFrame } from '../panes/browserFrames';

const overlaySrc = readFileSync(join(__dirname, 'BrowserOverlay.svelte'), 'utf8');
const frameSrc = readFileSync(join(__dirname, 'BrowserFilmFrame.svelte'), 'utf8');

const frame = (seq: number): BrowserFrame => ({
  seq,
  action: 'navigate',
  url: `https://example.test/page/${seq}`,
  imageDataUrl: `data:image/png;base64,frame${seq}`,
});

let calls: Array<{ el: Element; arg: unknown }>;
beforeEach(() => {
  calls = [];
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView =
    function (this: Element, arg: unknown) { calls.push({ el: this, arg }); };
});
afterEach(() => cleanup());

const props = (frames: BrowserFrame[]) => ({
  frames, collapsed: false, onToggleCollapse: () => {}, onOpen: () => {}, onReveal: () => {},
});

describe('a new frame brings the newest thumbnail fully into view', () => {
  it('scrolls the NEWEST frame element into view, at its end edge', async () => {
    const { container, rerender } = render(BrowserOverlay, props([frame(1), frame(2)]));
    await tick();
    calls.length = 0;

    await rerender(props([frame(1), frame(2), frame(3)]));
    await tick();
    await tick();

    expect(calls.length, 'the arrival has to move the strip').toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    const thumbs = [...container.querySelectorAll('.browser-frame')];
    expect(last.el, 'the newest frame is the one being shown').toBe(thumbs[thumbs.length - 1]);
    expect(last.el.classList.contains('browser-frame-new')).toBe(true);
    expect(last.arg).toMatchObject({ inline: 'end' });
  });

  // "At three strip widths" — jsdom gives every element a zero box, so a width
  // cannot be measured here. What CAN be asserted is that the behaviour does
  // not depend on the width at all: the same element is asked, the same way,
  // however wide the strip is told it is. A width-dependent implementation
  // (a scrollLeft arithmetic, say) is what this would catch.
  for (const width of [220, 420, 900]) {
    it(`asks for the same frame at a ${width}px strip`, async () => {
      const { container, rerender } = render(BrowserOverlay, props([frame(1), frame(2)]));
      const strip = container.querySelector('.browser-film') as HTMLElement;
      Object.defineProperty(strip, 'clientWidth', { value: width, configurable: true });
      Object.defineProperty(strip, 'scrollWidth', { value: 104 * 3 + 8, configurable: true });
      await tick();
      calls.length = 0;

      await rerender(props([frame(1), frame(2), frame(3)]));
      await tick();
      await tick();

      const thumbs = [...container.querySelectorAll('.browser-frame')];
      expect(calls.at(-1)?.el).toBe(thumbs[thumbs.length - 1]);
      expect(calls.at(-1)?.arg).toMatchObject({ inline: 'end' });
    });
  }

  it('a re-render with the SAME frames does not yank a user who scrolled back', async () => {
    const { rerender } = render(BrowserOverlay, props([frame(1), frame(2)]));
    await tick();
    calls.length = 0;
    await rerender(props([frame(1), frame(2)]));
    await tick();
    await tick();
    expect(calls, 'only a new frame moves the strip').toHaveLength(0);
  });
});

describe('the CSS that the scroll has to agree with', () => {
  it('the strip still snaps on the x axis', () => {
    const rule = /\.browser-film\s*\{([^}]*)\}/.exec(overlaySrc)?.[1] ?? '';
    expect(rule).toMatch(/scroll-snap-type:\s*x\s+mandatory/);
  });

  it('the NEWEST frame snaps to its end edge, so mandatory snapping cannot clip it', () => {
    const base = /\.browser-frame\s*\{([^}]*)\}/.exec(frameSrc)?.[1] ?? '';
    expect(base, 'every other frame still aligns to its start').toMatch(/scroll-snap-align:\s*start/);
    const newest = /\.browser-frame-new\s*\{([^}]*)\}/.exec(frameSrc)?.[1] ?? '';
    expect(newest).toMatch(/scroll-snap-align:\s*end/);
  });
});
