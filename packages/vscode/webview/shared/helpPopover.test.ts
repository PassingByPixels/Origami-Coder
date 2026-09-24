// t-vbj8xu — the "?" help popover beside the Artifacts and Nests pane titles.
//
// Requirement: the icon opens a short text and a diagram by mouse (hover, click)
// and keyboard, closes on Escape and on blur, has an accessible name, and never
// draws a native title tooltip. Enter and Space come from the icon being a
// native <button>; jsdom does not turn a key into a click, so that part is
// checked in real Chromium (the lane report) and here only as "it is a button".
// Layout and colour need a human eye: jsdom applies no CSS.
import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ArtifactsHelp from '../dashboard/components/ArtifactsHelp.svelte';
import NestsHelp from '../dashboard/components/NestsHelp.svelte';
import ArtifactsPane from '../dashboard/panes/ArtifactsPane.svelte';
import NestsPane from '../dashboard/panes/NestsPane.svelte';
import { TIP_FUSE, TIP_GRACE } from './warmTip';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(path.join(pkgRoot, rel), 'utf8');

function mount() {
  const { container, getByRole } = render(ArtifactsHelp);
  const btn = getByRole('button', { name: 'How artifacts work between desks' }) as HTMLButtonElement;
  const wrap = container.querySelector('.og-help') as HTMLElement;
  const box = container.querySelector('.og-help-box') as HTMLElement;
  const isOpen = () => box.classList.contains('is-in') && btn.getAttribute('aria-expanded') === 'true';
  return { container, btn, wrap, box, isOpen };
}

describe('help popover — mouse', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens on hover after the warm-tip fuse, not before, and closes after the grace', async () => {
    const h = mount();
    expect(h.isOpen()).toBe(false);
    await fireEvent.mouseEnter(h.wrap);
    vi.advanceTimersByTime(TIP_FUSE - 1);
    await tick();
    expect(h.isOpen()).toBe(false);
    vi.advanceTimersByTime(1);
    await tick();
    expect(h.isOpen()).toBe(true);
    await fireEvent.mouseLeave(h.wrap);
    vi.advanceTimersByTime(TIP_GRACE);
    await tick();
    expect(h.isOpen()).toBe(false);
  });

  it('stays open when the pointer comes back within the grace (icon to box)', async () => {
    const h = mount();
    await fireEvent.mouseEnter(h.wrap);
    vi.advanceTimersByTime(TIP_FUSE);
    await fireEvent.mouseLeave(h.wrap);
    vi.advanceTimersByTime(TIP_GRACE - 10);
    await fireEvent.mouseEnter(h.wrap);
    vi.advanceTimersByTime(TIP_GRACE * 2);
    await tick();
    expect(h.isOpen()).toBe(true);
  });

  it('a click opens it at once and pins it against the pointer leaving; a second click closes it', async () => {
    const h = mount();
    await fireEvent.click(h.btn);
    expect(h.isOpen()).toBe(true);
    await fireEvent.mouseLeave(h.wrap);
    vi.advanceTimersByTime(TIP_GRACE * 5);
    await tick();
    expect(h.isOpen()).toBe(true);
    await fireEvent.click(h.btn);
    expect(h.isOpen()).toBe(false);
  });
});

describe('help popover — keyboard and screen reader', () => {
  it('is a native button with an accessible name and no native title anywhere', () => {
    const h = mount();
    expect(h.btn.tagName).toBe('BUTTON');
    expect(h.btn.type).toBe('button');
    expect(h.container.querySelectorAll('[title]')).toHaveLength(0);
    const nests = render(NestsHelp);
    expect(nests.getByRole('button', { name: 'How Nests works between desks' })).toBeTruthy();
    expect(nests.container.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('describes the icon with the box, which holds the heading, the lines and a labelled diagram', () => {
    const h = mount();
    const target = document.getElementById(h.btn.getAttribute('aria-describedby') ?? '');
    expect(target).toBe(h.box);
    expect(h.btn.getAttribute('aria-controls')).toBe(h.box.id);
    expect(h.box.textContent).toContain('How artifacts move between your desks');
    expect(h.box.querySelectorAll('.og-help-line').length).toBeGreaterThanOrEqual(3);
    const svg = h.box.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(20);
  });

  it('closes on Escape', async () => {
    const h = mount();
    await fireEvent.click(h.btn);
    expect(h.isOpen()).toBe(true);
    await fireEvent.keyDown(h.btn, { key: 'Escape' });
    expect(h.isOpen()).toBe(false);
  });

  it('closes when focus leaves the icon, not when it stays inside', async () => {
    const h = mount();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    await fireEvent.click(h.btn);
    await fireEvent.focusOut(h.btn, { relatedTarget: h.btn });
    expect(h.isOpen()).toBe(true);
    await fireEvent.focusOut(h.btn, { relatedTarget: outside });
    expect(h.isOpen()).toBe(false);
    outside.remove();
  });

  it('leaves Escape alone while closed', async () => {
    mount();
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('help popover — on each pane, beside the title', () => {
  it('Artifacts: the icon sits right after the pane title', () => {
    const { container } = render(ArtifactsPane);
    const title = container.querySelector('.af-head .af-title');
    expect(title?.nextElementSibling?.querySelector('button[aria-label="How artifacts work between desks"]')).toBeTruthy();
  });

  it('Nests: the icon sits right after the pane title, with Nests off too', () => {
    const { container } = render(NestsPane);
    const title = container.querySelector('.bar .title');
    expect(title?.nextElementSibling?.querySelector('button[aria-label="How Nests works between desks"]')).toBeTruthy();
  });
});

describe('help popover — the diagrams keep the house style', () => {
  // Mirror guard: the SVG classes are styled in two places, the What's-new page
  // (changelogPanel.ts, host HTML) and HelpPopover.svelte (webview). A webview
  // file cannot import the host's CSS, so each rule is compared here.
  const rules = (src: string, prefix: RegExp) =>
    new Map([...src.matchAll(prefix)].map((m) => [m[1]!, m[2]!.trim()]));
  const house = rules(read('src/dashboard/changelogPanel.ts'), /\.wn-fig svg (text|\.[a-z-]+) \{([^}]*)\}/g);
  const ours = rules(read('webview/shared/HelpPopover.svelte'), /:global\(svg (text|\.[a-z-]+)\) \{([^}]*)\}/g);

  it('reads both files (a guard that parses nothing proves nothing)', () => {
    expect(house.size).toBeGreaterThan(10);
    expect(ours.size).toBeGreaterThan(10);
  });

  it('every diagram rule in the popover matches the What\'s-new rule of the same name', () => {
    for (const [sel, body] of ours) expect(house.get(sel), sel).toBe(body);
  });

  it('every class the two diagrams use is styled', () => {
    for (const rel of ['webview/dashboard/components/ArtifactsHelp.svelte', 'webview/dashboard/components/NestsHelp.svelte']) {
      const used = new Set([...read(rel).matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)));
      for (const c of used) expect(ours.has(`.${c}`), `${rel} uses .${c}`).toBe(true);
    }
  });
});
