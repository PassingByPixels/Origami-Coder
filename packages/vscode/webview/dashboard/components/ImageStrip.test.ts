// The composer strip had NO test before the lightbox landed, which is part of
// why the extraction was worth doing: "a click on a thumbnail opens it" and "a
// click on the ✕ removes it" are two handlers on two nested elements, and the
// interesting case is the one where they collide.
//
// The thumb is 48px and `object-fit: cover`, i.e. a CROP — so before this the
// user could not actually see what they had attached. That is the requirement
// being asserted, not "an onclick exists".

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, vi, afterEach } from 'vitest';
import ImageStrip from './ImageStrip.svelte';

afterEach(() => cleanup());

const IMAGES = [
  { id: 1, name: 'first.png', dataUrl: 'data:image/png;base64,AAA=' },
  { id: 2, name: 'second.png', dataUrl: 'data:image/png;base64,BBB=' },
];

describe('ImageStrip — clicking a thumbnail opens it enlarged', () => {
  it('reports the clicked image, not merely "a click happened"', async () => {
    const onOpen = vi.fn();
    const { container } = render(ImageStrip, {
      props: { images: IMAGES, onRemove: vi.fn(), onOpen },
    });
    const thumbs = container.querySelectorAll('.image-thumb img');
    expect(thumbs.length).toBe(2);

    await fireEvent.click(thumbs[1]);
    expect(onOpen).toHaveBeenCalledWith(IMAGES[1].dataUrl, IMAGES[1].name);
  });

  it('marks a clickable thumbnail as zoomable so the cursor can say so', () => {
    const { container } = render(ImageStrip, {
      props: { images: IMAGES, onRemove: vi.fn(), onOpen: vi.fn() },
    });
    expect(container.querySelector('.image-thumb img')!.classList.contains('zoomable')).toBe(true);
  });
});

describe('ImageStrip — the two handlers must not collide', () => {
  // The ✕ sits ON TOP of the thumbnail. If removing also opened, every
  // deletion would leave a lightbox showing the image that just went away.
  it('removing an image does not also open it', async () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    const { container } = render(ImageStrip, {
      props: { images: IMAGES, onRemove, onOpen },
    });
    await fireEvent.click(container.querySelectorAll('.image-remove')[0]);
    expect(onRemove).toHaveBeenCalledWith(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('ImageStrip — a composer with no lightbox above it', () => {
  // `onOpen` is optional because a bare/collab composer has no pane-level
  // lightbox. An absent handler must leave the strip exactly as it was.
  it('does not throw on click, and offers no zoom affordance', async () => {
    const { container } = render(ImageStrip, {
      props: { images: IMAGES, onRemove: vi.fn() },
    });
    const thumb = container.querySelector('.image-thumb img')!;
    expect(thumb.classList.contains('zoomable')).toBe(false);
    await expect(fireEvent.click(thumb)).resolves.not.toThrow();
  });
});
