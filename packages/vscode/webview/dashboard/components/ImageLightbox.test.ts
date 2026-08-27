// The lightbox's whole contract: it shows the one image it was handed, and it
// closes on exactly three gestures — backdrop, Escape, and the ✕.
//
// Three things can go wrong here and none of them look broken in a screenshot:
//  1. IT WILL NOT CLOSE. A lightbox with no exit is a webview the user has to
//     reload out of, so all three dismissals are asserted separately rather
//     than trusting one to stand for the others.
//  2. IT CLOSES WHEN YOU CLICK THE PICTURE. The one click a viewer makes most
//     often is on the image itself — if that bubbles to the backdrop, the
//     feature reads as "it keeps closing on me".
//  3. IT EATS ESCAPE WHILE SHUT. <svelte:window> stays bound for the whole life
//     of the chat pane, so an unguarded handler would swallow Escape from every
//     other surface (the confirm dialog, the question modal, the slash palette)
//     for as long as a chat is open, with nothing on screen to explain it.
//
// jsdom has NO layout engine and vitest.config.mts does not set `css: true`, so
// no <style> ever reaches this DOM: getComputedStyle would report '' for every
// rule below. The fit-to-viewport sizing is therefore asserted against the
// component SOURCE (the ChatsList.test.ts idiom), and how it actually looks at
// 92vw/92vh still needs a human eye.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ImageLightbox from './ImageLightbox.svelte';

afterEach(() => cleanup());

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const shot = (over: Record<string, unknown> = {}) => ({
  src: PNG,
  alt: 'screenshot.png',
  onClose: vi.fn(),
  ...over,
});

describe('ImageLightbox — what it shows', () => {
  it('draws nothing at all when there is no image', () => {
    const { container } = render(ImageLightbox, { props: shot({ src: null }) });
    expect(container.querySelector('.il-backdrop')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('draws the image it was handed, with the alt text of the thumbnail', () => {
    const { container } = render(ImageLightbox, { props: shot() });
    const img = container.querySelector('.il-image') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe(PNG);
    expect(img.getAttribute('alt')).toBe('screenshot.png');
  });

  it('falls back to a described alt when the thumbnail had none', () => {
    const { container } = render(ImageLightbox, { props: shot({ alt: '' }) });
    expect(container.querySelector('.il-image')!.getAttribute('alt')).toBe('Enlarged image');
  });
});

describe('ImageLightbox — the three ways out', () => {
  it('closes when the backdrop is clicked', async () => {
    const props = shot();
    const { container } = render(ImageLightbox, { props });
    await fireEvent.click(container.querySelector('.il-backdrop')!);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when Escape is pressed', async () => {
    const props = shot();
    render(ImageLightbox, { props });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the ✕ is clicked', async () => {
    const props = shot();
    const { container } = render(ImageLightbox, { props });
    await fireEvent.click(container.querySelector('.il-close')!);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ImageLightbox — what must NOT close it', () => {
  // Failure 2: the most common click of all is on the picture.
  it('stays open when the image itself is clicked', async () => {
    const props = shot();
    const { container } = render(ImageLightbox, { props });
    await fireEvent.click(container.querySelector('.il-image')!);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('ignores keys that are not Escape', async () => {
    const props = shot();
    render(ImageLightbox, { props });
    await fireEvent.keyDown(window, { key: 'Enter' });
    await fireEvent.keyDown(window, { key: 'a' });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  // Failure 3: the handler is bound for the whole life of the chat pane.
  it('does NOT swallow Escape while it is shut', async () => {
    const props = shot({ src: null });
    render(ImageLightbox, { props });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe('ImageLightbox — fit-to-viewport (source assertion; jsdom has no layout)', () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'ImageLightbox.svelte'),
    'utf8',
  );

  it('bounds the image to the viewport in BOTH directions and never crops it', () => {
    expect(src).toMatch(/\.il-image\s*\{[^}]*max-width:\s*92vw;/);
    expect(src).toMatch(/\.il-image\s*\{[^}]*max-height:\s*92vh;/);
    // `contain`, not `cover` — a cropped screenshot is a different picture.
    expect(src).toMatch(/\.il-image\s*\{[^}]*object-fit:\s*contain;/);
  });

  it('covers the viewport from above the popovers but below the confirm dialog', () => {
    expect(src).toMatch(/\.il-backdrop\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/);
    const z = src.match(/\.il-backdrop\s*\{[^}]*z-index:\s*(\d+);/);
    expect(z, '.il-backdrop must declare a z-index').not.toBeNull();
    expect(Number(z![1])).toBeGreaterThan(60); // above every menu/popover/modal in the dashboard
    expect(Number(z![1])).toBeLessThan(100); // below ConfirmModal.svelte's 100
  });
});
