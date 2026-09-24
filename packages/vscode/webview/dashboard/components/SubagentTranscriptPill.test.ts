// t-v47ytt, sub-agent panel. The jump pill must hide whenever the reader is at the bottom, however
// they got there. The panel shares the main chat's leaves (chatScrollRearm.ts, chatPin.ts), and it
// shared the defect: what the reader last SAW was recorded only by scroll events, so a poll that
// grew the transcript before the reader's own scroll event made a return to the painted bottom read
// as "still reading". The poll itself never looked again, so the pill stayed up.
//
// jsdom has no layout: the scroller CLAMPS like a browser, requestAnimationFrame is a queue this file
// drains, and scroll events are fired by hand when a browser would deliver them (the harness of
// SubagentTranscriptPin.test.ts).

import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SubagentTranscriptView from './SubagentTranscriptView.svelte';

const CHILD = 'ses_child_pill';
const reply = (data: Record<string, unknown>) =>
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'subagentTranscriptData', sessionId: CHILD, found: true, truncated: false, ...data },
  }));

const entry = (text: string) => ({ kind: 'agent', text, timestamp: 0 });
const page = (n: number) => [{ kind: 'user', text: 'audit the bundle', timestamp: 0 }, ...Array.from({ length: n }, (_, i) => entry(`step ${i}`))];

let frames: Array<() => void> = [];
const drainFrames = () => { for (let i = 0; i < 100 && frames.length; i++) frames.shift()!(); };
async function settle() { await tick(); await tick(); await Promise.resolve(); await tick(); }

/** A scroller with a browser's arithmetic: scrollTop is clamped to [0, scrollHeight - clientHeight].
 *  `resize` changes the viewport and clamps scrollTop again, as a browser does. */
let resize: (client: number) => void = () => {};
function browserScroller(el: HTMLElement, height: number, client = 400) {
  let h = height, t = 0, c = client;
  Object.defineProperty(el, 'clientHeight', { get: () => c, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { get: () => h, set: (v: number) => { h = v; }, configurable: true });
  Object.defineProperty(el, 'scrollTop', { get: () => t, set: (v: number) => { t = Math.max(0, Math.min(v, h - c)); }, configurable: true });
  resize = (next) => { c = next; t = Math.max(0, Math.min(t, h - c)); };
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

async function openAtBottom(running = true) {
  const { container } = render(SubagentTranscriptView, { sessionId: CHILD, title: 'task: audit', onClose: () => {} });
  const body = container.querySelector('.sat-body') as HTMLElement;
  browserScroller(body, 2000);
  reply({ running, entries: page(2) });
  await settle();
  drainFrames();
  await fireEvent.scroll(body); // the open-time pin's own event (0 -> 1600)
  await settle();
  const pill = () => container.querySelector('.anchor-pill');
  expect(body.scrollTop, 'precondition: opened at the newest reply').toBe(1600);
  return { container, body, pill };
}

/** Opened at the bottom, scrolled up to read, and a poll brought one more row: the pill is up. */
async function readingUp() {
  const m = await openAtBottom();
  m.body.scrollTop = 300;
  await fireEvent.scroll(m.body);
  grow(m.body, 2300);
  reply({ running: true, entries: page(3) });
  await settle();
  drainFrames();
  expect(m.pill(), 'precondition: a row arrived while the reader was up').not.toBeNull();
  return m;
}

describe('SubagentTranscriptView: the jump pill hides whenever the reader is at the bottom (t-v47ytt)', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.postMessage.mockReset();
    frames = [];
    FakeResizeObserver.all = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('SCROLL: back on the painted bottom when the next poll lands first, the pill goes and the panel follows', async () => {
    const { body, pill } = await readingUp();
    body.scrollTop = 1900;            // the bottom as painted (2300 - 400)
    grow(body, 2600);                 // the next poll grows the transcript before the scroll event
    reply({ running: true, entries: page(4) });
    await settle();
    drainFrames();
    await fireEvent.scroll(body);
    await settle();
    expect(pill()).toBeNull();
    expect(body.scrollTop, 'following again').toBe(2200);
  });

  it('SCROLL: back on the bottom with no poll in between hides the pill', async () => {
    const { body, pill } = await readingUp();
    body.scrollTop = 1900;
    await fireEvent.scroll(body);
    await settle();
    expect(pill()).toBeNull();
  });

  it('WHEEL: a wheel back down onto the bottom hides the pill', async () => {
    const { body, pill } = await readingUp();
    await fireEvent.wheel(body, { deltaY: 400 });
    body.scrollTop = 1900;
    await fireEvent.scroll(body);
    await settle();
    expect(pill()).toBeNull();
  });

  it('CLICK: the pill goes, and the pin\'s own late scroll event does not bring it back', async () => {
    const { body, pill } = await readingUp();
    (pill() as HTMLButtonElement).click();
    await settle();
    expect(pill()).toBeNull();
    grow(body, 2600);                 // a poll lands between the pin's move and its event
    reply({ running: true, entries: page(4) });
    await settle();
    await fireEvent.scroll(body);
    await settle();
    drainFrames();
    expect(pill()).toBeNull();
    expect(body.scrollTop).toBe(2200);
  });

  it('NEW ROWS WHILE STUCK: a poll that lands before the pin\'s own scroll event keeps the reader following', async () => {
    const { body, pill } = await openAtBottom();
    grow(body, 2300);
    reply({ running: true, entries: page(3) });
    await settle();                   // the pin moves 1600 -> 1900
    grow(body, 2600);                 // the next poll grows it before that move's scroll event
    await fireEvent.scroll(body);
    reply({ running: true, entries: page(4) });
    await settle();
    drainFrames();
    expect(pill()).toBeNull();
    expect(body.scrollTop, 'still following').toBe(2200);
  });

  it('RESIZE: the panel grows and brings the reader onto the bottom with no scroll event; the pill goes', async () => {
    const { body, pill } = await openAtBottom();
    body.scrollTop = 1540;            // 60px up: reading
    await fireEvent.scroll(body);
    reply({ running: true, entries: page(3) });
    await settle();
    drainFrames();
    expect(pill(), 'precondition: a row arrived while the reader was up').not.toBeNull();
    resize(460);                      // scrollTop is unchanged, and now at the bottom
    FakeResizeObserver.fire(body);
    await settle();
    expect(pill()).toBeNull();
  });

  it('RESIZE WHILE FOLLOWING: the panel shrinks, and the newest lines are pinned into view at once', async () => {
    const { body, pill } = await openAtBottom();
    resize(340);                      // scrollTop stays, the bottom 60px are hidden
    FakeResizeObserver.fire(body);
    await settle();
    expect(body.scrollTop, 'pinned without waiting for the next poll').toBe(1660);
    expect(pill()).toBeNull();
  });

  it('RESIZE WHILE READING UP: a reader who scrolled away keeps their place', async () => {
    const { body } = await openAtBottom();
    body.scrollTop = 300;
    await fireEvent.scroll(body);
    resize(340);
    FakeResizeObserver.fire(body);
    await settle();
    expect(body.scrollTop).toBe(300);
  });
  it('WHEEL INSIDE A TOOL BOX: an upward wheel that scrolls a box inside the transcript does not release the follow', async () => {
    const { body, pill } = await openAtBottom();
    const box = body.querySelector<HTMLElement>('.sat-body *:last-child')!;
    box.scrollTop = 300;              // a tool output box, scrolled down inside itself
    await fireEvent.wheel(box, { deltaY: -100 });
    grow(body, 2300);
    reply({ running: true, entries: page(3) });
    await settle();
    drainFrames();
    expect(body.scrollTop, 'the transcript never moved, so it still follows').toBe(1900);
    expect(pill()).toBeNull();
  });
  it('PAGE PREPEND: an older block drawn above a reader at the bottom leaves no pill', async () => {
    const { container } = render(SubagentTranscriptView, { sessionId: CHILD, title: 'task: audit', onClose: () => {} });
    const body = container.querySelector('.sat-body') as HTMLElement;
    browserScroller(body, 300);       // the newest page fits: the reader is at its bottom by definition
    reply({ running: false, entries: page(2), hasMore: true, cursor: 'cur_1' });
    await settle();
    drainFrames();
    await fireEvent.click(container.querySelector('.sat-earlier button') as HTMLButtonElement);
    reply({ running: false, entries: page(3), hasMore: false, cursor: null, before: 'cur_1' });
    grow(body, 1300);                 // the older block, drawn above (the place is read before the render)
    await settle();
    await fireEvent.scroll(body);     // the held place's own scroll event
    await settle();
    expect(body.scrollTop, 'held place, clamped to the bottom').toBe(900);
    expect(container.querySelector('.anchor-pill')).toBeNull();
  });
});
