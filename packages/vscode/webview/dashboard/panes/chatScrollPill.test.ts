// t-v47ytt. The "Jump to the newest message and follow the turn again" pill stayed up after the
// reader was back at the bottom. Driven through the real ChatPane.
//
// THE BUG, measured in Chromium with the real leaves (lane probe): the stick rule compares a scroll
// against what the reader last SAW, but that record was only written by SCROLL EVENTS. Growth and our
// own scrolls (the follow, the pill's pin, a prepend's held place) fire no event before the next
// frame is painted, so the record kept a height several chunks old. Two misreads followed:
//   - our own follow's scroll event, landing after the next chunk, read as the reader leaving: the
//     follow dropped with no input and the pill came up;
//   - the reader moved back to the bottom they could see; a chunk landed before the event, and the
//     stale record said they were still reading, so the pill stayed up for the rest of the turn.
//
// jsdom has no layout, so the scroller below CLAMPS scrollTop the way a browser does and the scroll
// events are fired by hand, at the moment a browser would deliver them: after the frame that moved
// the scroller, often after the next chunk has already grown the content.
// Its own file for the reason chatScrollStick.test.ts gives: ChatPane's window listener outlives it.

import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import ChatPane from './ChatPane.svelte';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const postFromHost = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
/** A new ROW (the pill counts rows), not text appended to the open one. */
const row = (text: string) => postFromHost({ type: 'system', sessionId: SID, text });

/** A scroller with a browser's arithmetic: scrollTop is clamped to [0, scrollHeight - clientHeight].
 *  Returns a resize: the viewport changes, and scrollTop is clamped again, as a browser does. */
function browserScroller(el: HTMLElement, height: number, top: number, client = 400) {
  let h = height, t = top, c = client;
  Object.defineProperty(el, 'clientHeight', { get: () => c, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { get: () => h, set: (v: number) => { h = v; }, configurable: true });
  Object.defineProperty(el, 'scrollTop', { get: () => t, set: (v: number) => { t = Math.max(0, Math.min(v, h - c)); }, configurable: true });
  return (next: number) => { c = next; t = Math.max(0, Math.min(t, h - c)); };
}

/** jsdom has no ResizeObserver. This one reports when the test says the box changed. */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  targets: Element[] = [];
  constructor(private cb: ResizeObserverCallback) { FakeResizeObserver.all.push(this); }
  observe(target: Element) { this.targets.push(target); }
  unobserve() {}
  disconnect() { this.targets = []; }
  static fire(target: Element) {
    for (const ro of FakeResizeObserver.all) {
      if (ro.targets.includes(target)) ro.cb([{ target } as ResizeObserverEntry], ro as unknown as ResizeObserver);
    }
  }
}
const grow = (el: HTMLElement, height: number) => { (el as unknown as { scrollHeight: number }).scrollHeight = height; };

async function mounted() {
  const { container } = render(ChatPane);
  postFromHost({ type: 'sessionCreated', sessionId: SID, sessionNumber: 1, agentName: 'Coder', agentArt: null });
  postFromHost({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
  postFromHost({ type: 'agentText', sessionId: SID, text: 'first line\n' });
  const el = await waitFor(() => {
    const found = container.querySelector<HTMLDivElement>('.cell-messages');
    expect(found).not.toBeNull();
    return found!;
  });
  await nextFrame();
  const pill = () => container.querySelector('.anchor-pill');
  return { container, el, pill };
}

/** Settle Svelte after a frame, so the pill reflects the latch. */
const frame = async () => { await nextFrame(); await tick(); };

describe('ChatPane: the jump pill hides whenever the reader is at the bottom (t-v47ytt)', () => {
  const strays: EventListenerOrEventListenerObject[] = [];
  const realAdd = window.addEventListener.bind(window);
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
    FakeResizeObserver.all = [];
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
      if (type === 'message') strays.push(fn);
      realAdd(type as keyof WindowEventMap, fn as EventListener, opts as AddEventListenerOptions);
    }) as typeof window.addEventListener;
  });
  afterEach(() => {
    cleanup();
    for (const fn of strays.splice(0)) window.removeEventListener('message', fn);
    window.addEventListener = realAdd;
    vi.unstubAllGlobals();
  });

  /** At the bottom, then scrolled up to read: the pill is up once a row lands. */
  async function readingUp() {
    const m = await mounted();
    browserScroller(m.el, 1000, 600);
    await fireEvent.scroll(m.el);
    m.el.scrollTop = 100;
    await fireEvent.scroll(m.el);
    grow(m.el, 1200);
    row('arrived while reading');
    await frame();
    expect(m.pill(), 'precondition: a row arrived while the reader was up').not.toBeNull();
    return m;
  }

  it('SCROLL: back on the bottom they can see, mid-stream, the pill goes and the follow resumes', async () => {
    const { el, pill } = await readingUp();
    el.scrollTop = 800;   // the bottom as painted (1200 - 400)
    grow(el, 1400);       // the next chunk lands before the queued scroll event
    row('next chunk');
    await fireEvent.scroll(el);
    await frame();
    expect(pill()).toBeNull();
    expect(el.scrollTop, 'following again').toBe(1000);
  });

  it('WHEEL: a wheel back down onto the painted bottom, mid-stream, hides the pill', async () => {
    const { el, pill } = await readingUp();
    await fireEvent.wheel(el, { deltaY: 400 });
    el.scrollTop = 800;
    grow(el, 1400);
    row('next chunk');
    await fireEvent.scroll(el);
    await frame();
    expect(pill()).toBeNull();
    expect(el.scrollTop).toBe(1000);
  });

  it('CLICK: the pill goes, and the pin\'s own late scroll events do not bring it back', async () => {
    const { el, pill } = await readingUp();
    (pill() as HTMLButtonElement).click();
    await tick();
    expect(pill()).toBeNull();
    for (let i = 0; i < 3; i++) {
      grow(el, 1400 + i * 200); // a chunk lands between each pin step and its event
      row(`chunk ${i}`);
      await fireEvent.scroll(el);
      await frame();
      expect(pill(), `after pin step ${i}`).toBeNull();
    }
    expect(el.scrollTop).toBe(1400 + 2 * 200 - 400);
  });

  it('NEW ROWS WHILE STUCK: our own follow\'s scroll event, landing after the next chunk, is not the reader leaving', async () => {
    const { el, pill } = await mounted();
    browserScroller(el, 1000, 0);   // a fresh chat: no scroll event seen yet
    row('reply');
    await frame();                   // the follow moves 0 -> 600
    expect(el.scrollTop).toBe(600);
    grow(el, 1200);                  // the next chunk lands before that move's scroll event
    row('next chunk');
    await fireEvent.scroll(el);      // the event for OUR move to 600
    await frame();
    grow(el, 1400);
    row('and the next');
    await frame();
    expect(pill()).toBeNull();
    expect(el.scrollTop, 'still following').toBe(1000);
  });

  it('PAGE PREPEND: an older page landing while the reader follows at the bottom keeps them following', async () => {
    const { el, pill } = await mounted();
    browserScroller(el, 1000, 600);
    await fireEvent.scroll(el);
    postFromHost({
      type: 'historyPage', sessionId: SID, messageIds: ['m-old-1'], cursor: null, hasMore: false,
      messages: [{ kind: 'user', text: 'an older question', timestamp: 0 }],
    });
    grow(el, 1500);                  // the page's rows, drawn above
    await tick(); await tick();      // historyScroll.ts puts the place back after the render: 1100
    expect(el.scrollTop, 'place held at the bottom').toBe(1100);
    grow(el, 1700);                  // a chunk lands before the scroll event for that move
    row('streamed on');
    await fireEvent.scroll(el);
    await frame();
    expect(pill()).toBeNull();
    expect(el.scrollTop, 'still following').toBe(1300);
  });

  it('RESIZE: the composer shrinks and brings the reader onto the bottom with no scroll event; the pill goes', async () => {
    const { el, pill } = await mounted();
    const resize = browserScroller(el, 1000, 600);
    await fireEvent.scroll(el);
    el.scrollTop = 540;              // 60px up: reading
    await fireEvent.scroll(el);
    row('arrived while reading');
    await frame();
    expect(pill(), 'precondition: a row arrived while the reader was up').not.toBeNull();
    resize(460);                     // the composer lost a line: scrollTop is unchanged, and now at the bottom
    FakeResizeObserver.fire(el);
    await tick();
    expect(pill()).toBeNull();
    grow(el, 1200);
    row('streamed on');
    await frame();
    expect(el.scrollTop, 'following again').toBe(740);
  });

  it('RESIZE WHILE FOLLOWING: the composer grows, and the newest lines are pinned into view at once', async () => {
    const { el, pill } = await mounted();
    const resize = browserScroller(el, 1000, 600);
    await fireEvent.scroll(el);
    resize(340);                     // the composer gained a line: scrollTop stays, the bottom 60px are hidden
    FakeResizeObserver.fire(el);
    await tick();
    expect(el.scrollTop, 'pinned without waiting for the next chunk').toBe(660);
    expect(pill()).toBeNull();
  });

  it('RESIZE WHILE READING UP: a reader who scrolled away keeps their place', async () => {
    const { el } = await mounted();
    const resize = browserScroller(el, 1000, 600);
    await fireEvent.scroll(el);
    el.scrollTop = 100;
    await fireEvent.scroll(el);
    resize(340);
    FakeResizeObserver.fire(el);
    await tick();
    expect(el.scrollTop).toBe(100);
  });
  it('WHEEL INSIDE A TOOL BOX: an upward wheel that scrolls a box inside the transcript does not release the follow', async () => {
    const { el, pill } = await mounted();
    browserScroller(el, 1000, 600);
    await fireEvent.scroll(el);
    const box = el.querySelector<HTMLElement>('.cell-messages *:last-child')!;
    box.scrollTop = 300;             // a tool output box, scrolled down inside itself
    await fireEvent.wheel(box, { deltaY: -100 });
    grow(el, 1200);
    row('next chunk');
    await frame();
    expect(el.scrollTop, 'the transcript never moved, so it still follows').toBe(800);
    expect(pill()).toBeNull();
  });

  it('a wheel on a box already at its own top reaches the transcript, and releases the follow', async () => {
    const { el, pill } = await mounted();
    browserScroller(el, 1000, 600);
    await fireEvent.scroll(el);
    const box = el.querySelector<HTMLElement>('.cell-messages *:last-child')!;
    box.scrollTop = 0;
    await fireEvent.wheel(box, { deltaY: -100 });
    grow(el, 1200);
    row('next chunk');
    await frame();
    expect(el.scrollTop).toBe(600);
    expect(pill()).not.toBeNull();
  });
  it('a reader who stays up keeps the pill: the fix does not re-arm a reader who is reading', async () => {
    const { el, pill } = await readingUp();
    for (let i = 0; i < 3; i++) {
      grow(el, 1400 + i * 200);
      row(`chunk ${i}`);
      await frame();
      expect(el.scrollTop).toBe(100);
      expect(pill()).not.toBeNull();
    }
  });
});
