// browserFrames.test.ts — the browser strip's frame ring.
//
// These assert the four things a viewer of the strip can actually observe: it
// never grows past a screenful, the newest picture is the one on the right, one
// chat's pages never appear in another chat's strip, and closing a session
// takes its pictures with it. Each one is a real failure mode: an unbounded ring
// is hundreds of kilobytes per frame held in the webview's heap for as long as
// the session runs; a wrong order is a strip that reads backwards; a leak
// between sessions is one agent's page shown under another agent's name.

import { describe, expect, it } from 'vitest';
import {
  FRAME_BYTE_BUDGET,
  FRAME_CAP,
  clearFrames,
  framesFor,
  pushFrame,
  type FrameStore,
} from '../panes/browserFrames';

const shot = (n: number) => ({
  action: 'click',
  ts: 1000 + n,
  url: `https://a.test/${n}`,
  imageDataUrl: `data:image/png;base64,AAA${n}`,
});

/** Push n frames into one session, oldest first. */
function fill(sessionId: string, n: number, from: FrameStore = {}): FrameStore {
  let store = from;
  for (let i = 0; i < n; i++) store = pushFrame(store, sessionId, shot(i));
  return store;
}

describe('the frame ring', () => {
  it('holds the newest frame LAST, in the order the pages were seen', () => {
    const store = fill('s1', 3);
    expect(framesFor(store, 's1').map((f) => f.url)).toEqual([
      'https://a.test/0',
      'https://a.test/1',
      'https://a.test/2',
    ]);
  });

  it(`never holds more than ${FRAME_CAP}, and it is the OLDEST that goes`, () => {
    const store = fill('s1', FRAME_CAP + 5);
    const held = framesFor(store, 's1');
    expect(held).toHaveLength(FRAME_CAP);
    // 17 pushed, 12 held: 0-4 dropped, 5-16 kept, newest still last.
    expect(held[0].url).toBe('https://a.test/5');
    expect(held[held.length - 1].url).toBe(`https://a.test/${FRAME_CAP + 4}`);
  });

  it('gives every frame in a session a key of its own, so twelve can be drawn at once', () => {
    // Two frames arriving in the SAME millisecond is the case a `ts` key dies
    // on — Svelte refuses a duplicate {#each} key outright.
    let store = pushFrame({}, 's1', { ...shot(0), ts: 7 });
    store = pushFrame(store, 's1', { ...shot(1), ts: 7 });
    const seqs = framesFor(store, 's1').map((f) => f.seq);
    expect(new Set(seqs).size).toBe(2);
  });

  it('keeps each session to its own frames', () => {
    let store = fill('s1', 2);
    store = pushFrame(store, 's2', { ...shot(9), url: 'https://b.test/' });
    expect(framesFor(store, 's1')).toHaveLength(2);
    expect(framesFor(store, 's2').map((f) => f.url)).toEqual(['https://b.test/']);
    // ...and s2 filling up does not evict anything from s1.
    store = fill('s2', FRAME_CAP + 3, store);
    expect(framesFor(store, 's1')).toHaveLength(2);
  });

  it('a session with no frames reads as empty rather than undefined', () => {
    expect(framesFor({}, 'never-seen')).toEqual([]);
  });

  it('closing a session forgets its frames and leaves every other session alone', () => {
    let store = fill('s1', 3);
    store = fill('s2', 2, store);
    store = clearFrames(store, 's1');
    expect(framesFor(store, 's1')).toEqual([]);
    expect('s1' in store).toBe(false);
    expect(framesFor(store, 's2')).toHaveLength(2);
  });

  it('refuses a frame with no picture — the strip has no way to draw one', () => {
    const store = pushFrame({}, 's1', { action: 'click', ts: 1, url: 'https://a.test/' });
    expect(framesFor(store, 's1')).toEqual([]);
  });

  it('never edits the store it was given (the pane holds it in $state)', () => {
    const before = fill('s1', 2);
    const snapshot = framesFor(before, 's1').length;
    pushFrame(before, 's1', shot(9));
    clearFrames(before, 's1');
    expect(framesFor(before, 's1')).toHaveLength(snapshot);
  });
});

// The byte budget. The COUNT cap does not hold the memory: a frame is a base64
// full-page screenshot, and its size is the page's rather than ours, so twelve
// frames is kilobytes on a login form and hundreds of megabytes across a grid
// of chats on long pages at a high device pixel ratio.
describe('the byte budget', () => {
  /** One frame of roughly `mb` megabytes of held string. */
  const heavy = (n: number, mb: number) => ({
    action: 'screenshot',
    ts: 2000 + n,
    url: `https://big.test/${n}`,
    imageDataUrl: `data:image/png;base64,${'x'.repeat(mb * 1024 * 1024)}`,
  });

  const bytesOf = (store: FrameStore, sessionId: string) =>
    framesFor(store, sessionId).reduce(
      (total, f) => total + (f.imageDataUrl?.length ?? 0) + (f.pageText?.length ?? 0),
      0,
    );

  it('a run of large frames stays under the budget, dropping the OLDEST to fit', () => {
    let store: FrameStore = {};
    for (let i = 0; i < 6; i++) store = pushFrame(store, 's1', heavy(i, 6));
    expect(bytesOf(store, 's1')).toBeLessThanOrEqual(FRAME_BYTE_BUDGET);
    // Well under the count cap — the bytes are what bit, not the twelve.
    const held = framesFor(store, 's1');
    expect(held.length).toBeLessThan(FRAME_CAP);
    // ...and the frame the agent is ON is still the one on the right.
    expect(held[held.length - 1].url).toBe('https://big.test/5');
  });

  it('counts the caption text too, not the picture alone', () => {
    // DIFFERENTIAL, because the obvious version of this test passes whether or
    // not the text is counted: the same two frames, whose IMAGES alone fit
    // exactly, held once without captions and once with.
    const PREFIX = 'data:image/png;base64,';
    const half = Math.floor(FRAME_BYTE_BUDGET / 2) - PREFIX.length;
    const big = (n: number) => ({
      action: 'screenshot',
      ts: 3000 + n,
      url: `https://big.test/${n}`,
      imageDataUrl: PREFIX + 'x'.repeat(half),
    });
    let pictures = pushFrame({}, 's1', big(0));
    pictures = pushFrame(pictures, 's1', big(1));
    expect(framesFor(pictures, 's1')).toHaveLength(2);

    let captioned = pushFrame({}, 's1', { ...big(0), pageText: 'y'.repeat(512) });
    captioned = pushFrame(captioned, 's1', { ...big(1), pageText: 'y'.repeat(512) });
    expect(framesFor(captioned, 's1')).toHaveLength(1);
  });

  it('keeps a single OVERSIZE frame alone rather than showing nothing', () => {
    // The budget bounds ACCUMULATION, which one frame is not; a strip whose job
    // is saying where the agent is cannot answer "that page was too big".
    const store = pushFrame({}, 's1', heavy(0, 20));
    const held = framesFor(store, 's1');
    expect(held).toHaveLength(1);
    expect(held[0].url).toBe('https://big.test/0');
    expect(bytesOf(store, 's1')).toBeGreaterThan(FRAME_BYTE_BUDGET);
  });

  it('an oversize frame is cleared by the NEXT push rather than pinned forever', () => {
    let store = pushFrame({}, 's1', heavy(0, 20));
    store = pushFrame(store, 's1', shot(1));
    expect(framesFor(store, 's1').map((f) => f.url)).toEqual(['https://a.test/1']);
  });

  it('budgets each session on its own', () => {
    let store: FrameStore = {};
    for (let i = 0; i < 4; i++) store = pushFrame(store, 's1', heavy(i, 6));
    store = pushFrame(store, 's2', shot(0));
    expect(bytesOf(store, 's1')).toBeLessThanOrEqual(FRAME_BYTE_BUDGET);
    // A small session is untouched by a heavy neighbour.
    expect(framesFor(store, 's2')).toHaveLength(1);
  });

  it('leaves ordinary frames alone — the budget is a ceiling, not a policy', () => {
    const store = fill('s1', 5);
    expect(framesFor(store, 's1')).toHaveLength(5);
  });
});
