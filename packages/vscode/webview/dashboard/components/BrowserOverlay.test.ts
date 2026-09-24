// BrowserOverlay.test.ts — the browser strip as a viewer sees it.
//
// Same harness and the same contract as TodoStrip.test.ts, because the drawer
// is deliberately the same idiom: the pull-tab is present in BOTH states and
// reports aria-expanded honestly, collapsing slides the panel (a CSS class)
// rather than dropping the frames, and the tab asks the PARENT to toggle.
//
// The strip's own claims are the other three: one thumbnail per frame in the
// order they were seen, a caption naming the page the newest frame is OF (a
// strip that showed pictures without saying which page they are is a strip you
// cannot act on), and a click handing the parent the full-size src so the
// pane's one lightbox can enlarge it.
//
// jsdom has no layout, so nothing here asserts the 96px thumbnail ceiling or
// the auto-scroll — both are CSS/geometry and neither is observable in this
// environment. They are named in the report as untested.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import BrowserOverlay from './BrowserOverlay.svelte';

const frame = (seq: number, url: string, action = 'click') => ({
  seq,
  action,
  ts: 1000 + seq,
  url,
  imageDataUrl: `data:image/png;base64,AAA${seq}`,
});

const FRAMES = [frame(0, 'https://a.test/one'), frame(1, 'https://a.test/two', 'screenshot')];

const props = (over: Record<string, unknown> = {}) => ({
  frames: FRAMES,
  collapsed: false,
  onToggleCollapse: () => {},
  onOpen: () => {},
  ...over,
});

describe('BrowserOverlay — the agent page strip', () => {
  it('draws one thumbnail per frame, oldest first, each with its page in the label', () => {
    const { container } = render(BrowserOverlay, { props: props() });
    const thumbs = [...container.querySelectorAll('.browser-frame img')] as HTMLImageElement[];
    expect(thumbs).toHaveLength(2);
    expect(thumbs.map((i) => i.getAttribute('src'))).toEqual([
      'data:image/png;base64,AAA0',
      'data:image/png;base64,AAA1',
    ]);
    expect(thumbs[0].getAttribute('alt')).toContain('https://a.test/one');
  });

  it('captions the strip with the NEWEST frame\'s page and the verb that took it', () => {
    const { container } = render(BrowserOverlay, { props: props() });
    expect(container.querySelector('.browser-caption')?.textContent).toBe('https://a.test/two');
    expect(container.querySelector('.browser-action')?.textContent).toBe('screenshot');
    // ...and it says how many pictures are behind the one on the right.
    expect(container.querySelector('.browser-count')?.textContent).toBe('2');
  });

  it('falls back to the page text when a frame carries no url', () => {
    const only = [{ seq: 0, action: 'read', ts: 1, pageText: 'a summary', imageDataUrl: 'data:image/png;base64,Z' }];
    const { container } = render(BrowserOverlay, { props: props({ frames: only }) });
    expect(container.querySelector('.browser-caption')?.textContent).toBe('a summary');
  });

  it('expanded: strip is NOT collapsed and the tab reports aria-expanded=true', () => {
    const { container } = render(BrowserOverlay, { props: props() });
    expect(container.querySelector('.browser-strip')!.classList.contains('collapsed')).toBe(false);
    const tab = screen.getByRole('button', { name: /hide browser preview/i });
    expect(tab.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapsed: the panel slides (a class) but every frame STAYS mounted', () => {
    const { container } = render(BrowserOverlay, { props: props({ collapsed: true }) });
    expect(container.querySelector('.browser-strip')!.classList.contains('collapsed')).toBe(true);
    expect(container.querySelectorAll('.browser-frame img')).toHaveLength(2);
    const tab = screen.getByRole('button', { name: /show browser preview/i });
    expect(tab.getAttribute('aria-expanded')).toBe('false');
  });

  it('the pull-tab asks the PARENT to toggle — the drawer owns no collapse state', async () => {
    const onToggleCollapse = vi.fn();
    const { container } = render(BrowserOverlay, { props: props({ onToggleCollapse }) });
    await fireEvent.click(container.querySelector('.browser-tab')!);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    // A component that toggled itself would have flipped the class as well.
    expect(container.querySelector('.browser-strip')!.classList.contains('collapsed')).toBe(false);
  });

  it('a thumbnail click hands the parent the FULL src and a label, for the pane lightbox', async () => {
    const onOpen = vi.fn();
    const { container } = render(BrowserOverlay, { props: props({ onOpen }) });
    await fireEvent.click(container.querySelectorAll('.browser-frame')[1]);
    expect(onOpen).toHaveBeenCalledWith('data:image/png;base64,AAA1', expect.stringContaining('https://a.test/two'));
  });
});
