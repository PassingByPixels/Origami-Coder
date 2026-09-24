// t-qn0wj5, proposal 26 (port of Mock-Redesign CHANGES.md #39). getVsCodeApi
// is stubbed globally (webview/dashboard/__tests__/setup.ts); this file reads
// its captured postMessage buffer.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DensityCard from './DensityCard.svelte';

afterEach(cleanup);
beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
  delete (window as unknown as { __ORIGAMI_CHAT_DENSITY_COMPACT__?: boolean }).__ORIGAMI_CHAT_DENSITY_COMPACT__;
});

// t-s9jr6u: the card is now Settings › Chat's row, a Compact | Comfortable
// segmented control; the reload caveat is the row's "reload" pill.
const seg = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((b) => b.textContent === name)!;

describe('DensityCard', () => {
  it('reads its initial state from window.__ORIGAMI_CHAT_DENSITY_COMPACT__', () => {
    (window as unknown as { __ORIGAMI_CHAT_DENSITY_COMPACT__?: boolean }).__ORIGAMI_CHAT_DENSITY_COMPACT__ = true;
    const { container } = render(DensityCard);
    expect(seg(container, 'Compact').getAttribute('aria-checked')).toBe('true');
    expect(seg(container, 'Comfortable').getAttribute('aria-checked')).toBe('false');
  });

  it('defaults to Comfortable when the global is absent', () => {
    const { container } = render(DensityCard);
    expect(seg(container, 'Comfortable').getAttribute('aria-checked')).toBe('true');
  });

  it('posts setChatDensity with the new value on a press, and nothing for the one already on', async () => {
    const { container } = render(DensityCard);
    await fireEvent.click(seg(container, 'Comfortable'));
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();
    await fireEvent.click(seg(container, 'Compact'));
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'setChatDensity', compact: true });
  });

  it('raises a confirmation toast naming the density just chosen', async () => {
    const { container } = render(DensityCard);
    await fireEvent.click(seg(container, 'Compact'));
    expect(container.querySelector('.og-toast-desc')?.textContent).toBe('Compact density');
  });

  it('the toast dismisses itself (fuse) and is gone from the DOM after', async () => {
    const { container } = render(DensityCard);
    await fireEvent.click(seg(container, 'Compact'));
    const fuse = container.querySelector('.og-toast-fuse')!;
    await fireEvent(fuse, new Event('animationend', { bubbles: true }));
    expect(container.querySelector('.og-toast-desc')).toBeNull();
  });

  it('carries the "reload" pill, whose tooltip says to reload the window', () => {
    const { container } = render(DensityCard);
    expect(container.querySelector('.pill')?.getAttribute('data-tip')).toContain('Reload the window');
  });
});
