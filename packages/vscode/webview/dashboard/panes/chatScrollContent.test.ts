// t-xtim9n. Owner UAT of 0.4.178, 4 chats each running 3 background sub-agents, with stops and
// restores: the "Jump to the newest message and follow the turn again" pill sometimes stayed on
// screen after the view was back at the newest message, and went only after a click outside the chat.
//
// THE STATE THAT KEEPS IT: the session's follow latch (`stuckToBottom === false`), which the pill
// reads. The latch is re-read on a scroll event, a wheel, a resize of the scroller's OWN box, and our
// follow after a row is added or appended. Content that changes height in place fires none of them:
// the in-flight row going at turn end (a turn ends each time a sub-agent's report is answered), an
// engine card folded on a stop or restore (showEngine, no follow call), a card or image that changes
// size. When that shrink puts the reader on the bottom without moving scrollTop (no clamp, so no
// scroll event), the latch stays off and the pill stays up. A click elsewhere moves the composer,
// which resizes the scroller's box: THAT re-reads the latch (followOnResize), and the pill goes.
//
// Same harness as chatScrollPill.test.ts (jsdom has no layout: the scroller clamps like a browser,
// and the resize reports are fired by hand). Its own file for the reason that file gives.

import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import ChatPane from './ChatPane.svelte';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const postFromHost = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const row = (text: string) => postFromHost({ type: 'system', sessionId: SID, text });

function browserScroller(el: HTMLElement, height: number, top: number, client = 400) {
  let h = height, t = top;
  Object.defineProperty(el, 'clientHeight', { get: () => client, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { get: () => h, set: (v: number) => { h = v; }, configurable: true });
  Object.defineProperty(el, 'scrollTop', { get: () => t, set: (v: number) => { t = Math.max(0, Math.min(v, h - client)); }, configurable: true });
}
const setHeight = (el: HTMLElement, height: number) => { (el as unknown as { scrollHeight: number }).scrollHeight = height; };

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

const frame = async () => { await nextFrame(); await tick(); };

describe('ChatPane: the jump pill goes when content brings the reader onto the bottom (t-xtim9n)', () => {
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

  /** A turn running, the reader 30px up (one arrow key), and a row arrived: the pill is up. */
  async function readingJustAbove() {
    const { container } = render(ChatPane);
    postFromHost({ type: 'sessionCreated', sessionId: SID, sessionNumber: 1, agentName: 'Coder', agentArt: null });
    postFromHost({ type: 'modelStatus', ok: true, modelName: 'qwen-coder' });
    postFromHost({ type: 'agentText', sessionId: SID, text: 'first line\n' });
    postFromHost({ type: 'busy', sessionId: SID });
    const el = await waitFor(() => {
      const found = container.querySelector<HTMLDivElement>('.cell-messages');
      expect(found).not.toBeNull();
      expect(found!.querySelector('.stream-indicator')).not.toBeNull();
      return found!;
    });
    await nextFrame();
    const pill = () => container.querySelector('.anchor-pill');
    browserScroller(el, 1000, 600);
    await fireEvent.scroll(el);
    el.scrollTop = 570;
    await fireEvent.scroll(el);
    row('arrived while reading');
    await frame();
    expect(pill(), 'precondition: the reader is up and a row arrived').not.toBeNull();
    return { el, pill };
  }

  it('TURN END: the in-flight row goes, the reader is on the bottom with no scroll event; the pill goes', async () => {
    const { el, pill } = await readingJustAbove();
    setHeight(el, 972);              // the 28px in-flight row is gone: bottom = 572, the reader at 570
    postFromHost({ type: 'turnDone', sessionId: SID });
    await frame();
    expect(el.querySelector('.stream-indicator'), 'precondition: the turn ended').toBeNull();
    expect(el.scrollTop, 'no clamp: scrollTop did not move, so no scroll event').toBe(570);
    expect(pill()).toBeNull();
  });

  it('IN-PLACE SHRINK: a row inside the transcript gets shorter (a folded card); the pill goes', async () => {
    const { el, pill } = await readingJustAbove();
    setHeight(el, 972);
    const transcript = Array.from(el.children).find((c) => c.querySelector('.stream-indicator') === null && c.textContent?.includes('first line'))
      ?? el.firstElementChild!;
    FakeResizeObserver.fire(transcript); // the browser's report that a child box changed size
    await tick();
    expect(pill()).toBeNull();
  });

  it('a reader well above the bottom keeps the pill when content changes size', async () => {
    const { el, pill } = await readingJustAbove();
    el.scrollTop = 200;
    await fireEvent.scroll(el);
    setHeight(el, 972);
    postFromHost({ type: 'turnDone', sessionId: SID });
    await frame();
    for (const child of Array.from(el.children)) FakeResizeObserver.fire(child);
    await tick();
    expect(el.scrollTop).toBe(200);
    expect(pill()).not.toBeNull();
  });
});
