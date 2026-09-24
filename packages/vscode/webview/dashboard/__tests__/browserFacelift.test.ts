// The round-3 Browser pull-out facelift (t-qn0lpl, CHANGES.md 54): the action
// is a chip on the header line, the URL truncates from the LEFT, the frames are
// fixed thumbnails carrying their sequence number, and the strip gains the two
// things a screenshot had neither of — the size it was taken at, and a way out
// to the picture itself.
//
// THE SIZE IS A NEW HOST FIELD, not a measurement of the decoded <img>. The
// mock had to read `naturalWidth`, which is 0 until a data: URI decodes; the
// product knows the viewport it just set the page to, so the number travels
// with the frame. These assert the whole road: the capture attaches it, the
// snapshot carries it, the ring holds it, and the caption prints it.

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BrowserOverlay from '../components/BrowserOverlay.svelte';
import { pushFrame, viewportCaption, type BrowserFrame } from '../panes/browserFrames';
import { frameOf } from '../../../src/browserSnapshot';
import { measuredSize, DEFAULT_WIDTH, DEFAULT_HEIGHT } from '../../../src/browserViewport';

afterEach(cleanup);

const frame = (over: Partial<BrowserFrame> = {}): BrowserFrame => ({
  action: 'screenshot', ts: 1, seq: 0, url: 'http://localhost:5173/pane.html?surface=board',
  imageDataUrl: 'data:image/png;base64,AAAA', ...over,
});

describe('the host attaches the size the capture was taken at', () => {
  // `measuredNote` already reads the page's own reply out of run_playwright_code
  // (`Result: "1280x720"`); this returns the same reading as a pair of numbers,
  // so the caption and the sentence the model gets cannot disagree.
  it('reads the page’s reported size, and falls back to the configured one', () => {
    expect(measuredSize({ width: 1920, height: 1080 }, 'Result: "1280x720"')).toEqual({ width: 1280, height: 720 });
    expect(measuredSize({ width: 800, height: 600 }, 'the page said nothing')).toEqual({ width: 800, height: 600 });
    expect(measuredSize({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }, '')).toEqual({ width: 1920, height: 1080 });
  });

  it('frameOf carries the size onto the snapshot, and omits it when there is none', () => {
    const answer = { ok: true, url: 'http://x/y' } as never;
    const image = { ok: true, imageBase64: 'AAAA', imageMime: 'image/png', width: 1280, height: 720 } as never;
    expect(frameOf('screenshot', answer, image, 7)).toMatchObject({ width: 1280, height: 720 });
    const sizeless = { ok: true, imageBase64: 'AAAA' } as never;
    expect(frameOf('screenshot', answer, sizeless, 7)).not.toHaveProperty('width');
  });

  it('the ring keeps the size on the frame it belongs to', () => {
    const store = pushFrame({}, 's1', { action: 'screenshot', ts: 1, imageDataUrl: 'data:image/png;base64,A', width: 320, height: 180 });
    expect(store['s1'][0]).toMatchObject({ width: 320, height: 180 });
  });
});

describe('the viewport caption', () => {
  it('names which frame it describes and the size of it', () => {
    expect(viewportCaption([frame({ seq: 0 }), frame({ seq: 1 }), frame({ seq: 2, width: 320, height: 180 })]))
      .toBe('frame 3 of 3 · 320 × 180 px');
  });

  // A frame from an older host, or one whose viewport could not be set, has no
  // size. Saying "frame 2 of 2" alone is honest; inventing 0 × 0 is not.
  it('drops the size rather than printing a made-up one', () => {
    expect(viewportCaption([frame({ seq: 0 }), frame({ seq: 1 })])).toBe('frame 2 of 2');
  });

  it('no frames, no caption', () => {
    expect(viewportCaption([])).toBe('');
  });
});

describe('the strip draws the facelift', () => {
  const draw = (frames: BrowserFrame[], onReveal = vi.fn()) =>
    render(BrowserOverlay, {
      frames, collapsed: false, onToggleCollapse: () => {}, onOpen: () => {}, onReveal,
    });

  it('the action is a chip on the header line, not a line of its own', () => {
    const { container } = draw([frame({ action: 'click' })]);
    const header = container.querySelector('.browser-header') as HTMLElement;
    expect(header.querySelector('.browser-action')?.textContent).toBe('click');
  });

  it('every frame carries its sequence number and the newest wears the accent', () => {
    const { container } = draw([frame({ seq: 0 }), frame({ seq: 1 }), frame({ seq: 2 })]);
    expect([...container.querySelectorAll('.browser-frame-seq')].map((s) => s.textContent)).toEqual(['1', '2', '3']);
    const frames = [...container.querySelectorAll('.browser-frame')];
    expect(frames.map((f) => f.classList.contains('browser-frame-new'))).toEqual([false, false, true]);
  });

  it('the caption prints the size and the reveal asks for the newest frame', async () => {
    const onReveal = vi.fn();
    const { container } = draw([frame({ seq: 0 }), frame({ seq: 1, width: 320, height: 180 })], onReveal);
    expect(container.querySelector('.browser-viewport-size')?.textContent).toBe('frame 2 of 2 · 320 × 180 px');
    await fireEvent.click(container.querySelector('.browser-reveal') as HTMLElement);
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal.mock.calls[0][0]).toMatchObject({ seq: 1 });
  });

  // The end of a path is what tells one frame from another, so the URL loses its
  // FRONT when it does not fit. jsdom has no layout, so this reads the source.
  it('the url line truncates from the left', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(dir, '../components/BrowserOverlay.svelte'), 'utf8');
    const start = src.indexOf('.browser-caption {');
    expect(start).toBeGreaterThan(-1);
    const rule = src.slice(start, src.indexOf('}', start));
    expect(rule).toMatch(/direction:\s*rtl/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
  });

  // Fixed thumbnails, so five frames read as five of the same thing rather than
  // five different shapes. Also a source check — jsdom sizes nothing.
  it('a thumbnail is a fixed box', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(dir, '../components/BrowserFilmFrame.svelte'), 'utf8');
    const start = src.indexOf('.browser-frame {');
    const rule = src.slice(start, src.indexOf('}', start));
    expect(rule).toMatch(/width:\s*104px/);
    expect(rule).toMatch(/height:\s*66px/);
  });
});
