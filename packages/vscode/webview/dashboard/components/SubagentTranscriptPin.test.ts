// SubagentTranscriptPin.test.ts — t-ucn3fj. Opening a sub-agent transcript must
// show the NEWEST reply at the bottom. Before this, a newest-page reply was
// drawn into a new scroller at scrollTop 0 (the OLDEST row of the page), and the
// scroll-up sentinel above that row was in view at once, so the panel fetched an
// older page by itself before the reader did anything.
//
// jsdom has no layout: the scroller's metrics are written by hand, the same way
// subagentScrollAnchor.test.ts and the A2 parity tests do it. requestAnimationFrame
// is a queue this file drains, so the pin (chatPin.ts) runs frame by frame.
// IntersectionObserver does not exist in jsdom; the fake below reports what a
// browser reports: the sentinel sits above the first row, so it is in view only
// near scrollTop 0, and the first report comes when observing starts.

import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SubagentTranscriptView from './SubagentTranscriptView.svelte';

const CHILD = 'ses_child_pin';
const post = () => globalThis.__vscodeApiMock.postMessage;
const reply = (data: Record<string, unknown>) =>
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'subagentTranscriptData', sessionId: CHILD, found: true, running: false, truncated: false, ...data },
  }));

const ENTRIES = [
  { kind: 'user', text: 'audit the bundle', timestamp: 0 },
  { kind: 'agent', text: 'done — see src/foo.ts:12', timestamp: 0 },
];
const GROWN = [...ENTRIES, { kind: 'agent', text: 'follow-up note', timestamp: 0 }];
const SENTINEL_PX = 40;

let frames: Array<() => void> = [];
const drainFrames = () => { for (let i = 0; i < 100 && frames.length; i++) frames.shift()!(); };

class FakeIO {
  static all: FakeIO[] = [];
  targets: Element[] = [];
  constructor(private cb: IntersectionObserverCallback, private opts: IntersectionObserverInit) { FakeIO.all.push(this); }
  observe(target: Element) { this.targets.push(target); queueMicrotask(() => this.report()); }
  disconnect() { this.targets = []; }
  /** What the browser reports for the sentinel at the root's CURRENT scrollTop. */
  report() {
    if (!this.targets.length) return;
    const hit = (this.opts.root as HTMLElement).scrollTop < SENTINEL_PX;
    this.cb(this.targets.map((target) => ({ target, isIntersecting: hit }) as IntersectionObserverEntry), this as unknown as IntersectionObserver);
  }
}
const watching = () => FakeIO.all.some((io) => io.targets.length > 0);

/** Let the reply draw, the pin start, and any queued observer report run. */
async function settle() {
  await tick();
  await tick();
  await Promise.resolve();
  await tick();
}

function metrics(el: HTMLElement, top: number, height: number, client = 400) {
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: height, writable: true, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: client, writable: true, configurable: true });
}

function mount() {
  const { container } = render(SubagentTranscriptView, { sessionId: CHILD, title: 'task: audit', onClose: () => {} });
  const body = container.querySelector('.sat-body') as HTMLElement;
  metrics(body, 0, 2000); // a new scroller: at its top, a page taller than the view
  return { container, body };
}

const askedEarlier = () => post().mock.calls.some(([m]) => m && typeof m === 'object' && 'before' in m);

describe('SubagentTranscriptView — opens at the newest reply (t-ucn3fj)', () => {
  beforeEach(() => {
    post().mockReset();
    frames = [];
    FakeIO.all = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('IntersectionObserver', FakeIO);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('pins the first newest-page reply to the bottom, and keeps it there while the page still grows', async () => {
    const { body } = mount();
    reply({ entries: ENTRIES });
    await settle();
    expect(body.scrollTop, 'the reader starts at the newest reply, not at the oldest row').toBe(2000);
    // A late image grows the page between frames: the pin re-assigns (chatPin.ts).
    body.scrollHeight = 2300;
    drainFrames();
    expect(body.scrollTop).toBe(2300);
  });

  it('never fetches an older page by itself on open; a scroll to the top does', async () => {
    const { body } = mount();
    reply({ entries: ENTRIES, hasMore: true, cursor: 'cur_1' });
    await settle();
    expect(askedEarlier(), 'opening alone must not ask for an older page').toBe(false);
    expect(watching(), 'no scroll-up trigger while the pin is still running').toBe(false);
    drainFrames();
    await settle();
    expect(watching(), 'armed once the pin has finished').toBe(true);
    expect(askedEarlier(), 'opening alone must not ask for an older page').toBe(false);

    body.scrollTop = 0;
    await fireEvent.scroll(body);
    FakeIO.all.forEach((io) => io.report());
    await settle();
    expect(post()).toHaveBeenCalledWith({ type: 'requestSubagentTranscript', sessionId: CHILD, before: 'cur_1' });
  });

  it('a user wheel arms the trigger even before the pin has finished', async () => {
    const { body } = mount();
    reply({ entries: ENTRIES, hasMore: true, cursor: 'cur_1' });
    await settle();
    expect(watching()).toBe(false);
    await fireEvent.wheel(body, { deltaY: -120 });
    await settle();
    expect(watching()).toBe(true);
    expect(askedEarlier(), 'still pinned at the bottom: the sentinel is out of view').toBe(false);
  });

  it('a running child’s poll re-pins a reader who is stuck to the bottom', async () => {
    const { body } = mount();
    reply({ running: true, entries: ENTRIES });
    await settle();
    drainFrames();
    body.scrollHeight = 2600; // the next read carries one more row
    reply({ running: true, entries: GROWN });
    await settle();
    drainFrames();
    expect(body.scrollTop).toBe(2600);
  });

  it('a reader who scrolled up keeps their place across a poll', async () => {
    const { container, body } = mount();
    reply({ running: true, entries: ENTRIES });
    await settle();
    drainFrames();
    body.scrollTop = 300;
    await fireEvent.scroll(body);
    body.scrollHeight = 2600;
    reply({ running: true, entries: GROWN });
    await settle();
    drainFrames();
    expect(body.scrollTop, 'the poll must not yank the reader down').toBe(300);
    expect(container.querySelector('.anchor-pill'), 'the pill says what arrived instead').not.toBeNull();
  });

  it('shows a loading state for the first page and for an older page (plan 3.6)', async () => {
    const { container } = mount();
    expect(container.querySelector('.sat-body')?.textContent).toContain('Loading transcript…');
    reply({ entries: ENTRIES, hasMore: true, cursor: 'cur_1' });
    await settle();
    const button = () => container.querySelector('.sat-earlier button') as HTMLButtonElement;
    expect(button().textContent?.trim()).toBe('Load earlier messages');
    await fireEvent.click(button());
    expect(button().textContent?.trim()).toBe('Loading earlier messages…');
  });
});
