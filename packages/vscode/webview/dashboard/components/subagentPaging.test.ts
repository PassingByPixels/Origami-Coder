// subagentPaging.test.ts — t-krxap7. The rules that decide which block of a
// sub-agent transcript may be asked for, and which reply may be drawn.
//
// The real bugs these catch:
//  - the button and the scroll-top observer both firing, so the same block is
//    fetched twice and prepended twice;
//  - a reply for a block already on screen being drawn again (the ticket's "do
//    not re-read already-loaded steps");
//  - an offer of "earlier steps" the engine gave no cursor for, which is a
//    button that can only ever answer nothing.

import { describe, expect, it } from 'vitest';
import {
  atLatestOnly,
  beginEarlier,
  beginLatest,
  earlierCursor,
  initialPaging,
  LATEST,
  settle,
} from './subagentPaging';

/** The state after the newest page came back with an older block behind it. */
function afterFirstPage(cursor = 'cur_1') {
  return settle(beginLatest(), { cursor, hasMore: true }).state;
}

describe('opening the panel', () => {
  it('starts with nothing loaded and nothing older known', () => {
    expect(initialPaging()).toEqual({ inFlight: false, hasMore: false, loaded: [] });
  });

  it('records the newest page under its own key and keeps the cursor behind it', () => {
    const settled = settle(beginLatest(), { cursor: 'cur_1', hasMore: true });
    expect(settled.mode).toBe('latest');
    expect(settled.state).toEqual({ inFlight: false, hasMore: true, cursor: 'cur_1', loaded: [LATEST] });
  });

  it('offers nothing earlier when the whole transcript already fitted', () => {
    const state = settle(beginLatest(), { hasMore: false }).state;
    expect(state.hasMore).toBe(false);
    expect(earlierCursor(state)).toBeNull();
  });

  // The engine says "more exists" and the cursor is what makes it reachable.
  it('treats hasMore with NO cursor as the head, not as a dead button', () => {
    const state = settle(beginLatest(), { hasMore: true }).state;
    expect(state.hasMore).toBe(false);
    expect(beginEarlier(state)).toBeNull();
  });
});

describe('the double-fetch guard', () => {
  it('lets the FIRST trigger through and refuses the second while it is in flight', () => {
    const state = afterFirstPage();

    // The button fires.
    const first = beginEarlier(state);
    expect(first).not.toBeNull();
    expect(first!.before).toBe('cur_1');

    // The observer fires on the same block, before the reply lands.
    expect(beginEarlier(first!.state)).toBeNull();
    expect(earlierCursor(first!.state)).toBeNull();
  });

  it('lets the next block through once the reply has landed', () => {
    const inFlight = beginEarlier(afterFirstPage())!;
    const state = settle(inFlight.state, { before: 'cur_1', cursor: 'cur_2', hasMore: true }).state;

    expect(state.loaded).toEqual([LATEST, 'cur_1']);
    expect(beginEarlier(state)!.before).toBe('cur_2');
  });
});

describe('already-loaded steps are never re-read', () => {
  // A newest-page reply is the exception: it REPLACES the window, so a refresh
  // or a poll on a running child must redraw rather than be dropped as stale.
  it('always applies a newest-page reply, and resets the window to it', () => {
    const inFlight = beginEarlier(afterFirstPage())!;
    const paged = settle(inFlight.state, { before: 'cur_1', cursor: 'cur_2', hasMore: true }).state;

    const refreshed = settle(paged, { cursor: 'cur_9', hasMore: true });
    expect(refreshed.mode).toBe('latest');
    expect(refreshed.state.loaded).toEqual([LATEST]);
    expect(refreshed.state.cursor).toBe('cur_9');
  });

  it('drops a reply for a block that is already in the window', () => {
    const inFlight = beginEarlier(afterFirstPage())!;
    const once = settle(inFlight.state, { before: 'cur_1', cursor: 'cur_2', hasMore: true });
    expect(once.mode).toBe('earlier');

    // The same reply again — a crossed request, or a second panel answering.
    const twice = settle(once.state, { before: 'cur_1', cursor: 'cur_2', hasMore: true });
    expect(twice.mode).toBe('stale');
    // And the window is unchanged apart from clearing the in-flight flag.
    expect(twice.state.loaded).toEqual([LATEST, 'cur_1']);
  });

  it('refuses to ask again for a cursor whose block is already drawn', () => {
    const inFlight = beginEarlier(afterFirstPage())!;
    // The engine repeats the SAME cursor it already served.
    const state = settle(inFlight.state, { before: 'cur_1', cursor: 'cur_1', hasMore: true }).state;
    expect(earlierCursor(state)).toBeNull();
  });
});

describe('reaching the head of the transcript', () => {
  it('stops offering earlier steps once a page comes back with no cursor', () => {
    const inFlight = beginEarlier(afterFirstPage())!;
    const state = settle(inFlight.state, { before: 'cur_1', hasMore: false }).state;

    expect(state.hasMore).toBe(false);
    expect(beginEarlier(state)).toBeNull();
  });
});

describe('the running-child poll', () => {
  it('is allowed while the window is exactly the newest page', () => {
    expect(atLatestOnly(initialPaging())).toBe(true);
    expect(atLatestOnly(afterFirstPage())).toBe(true);
  });

  it('is refused once the reader has paged back', () => {
    const inFlight = beginEarlier(afterFirstPage())!;
    const state = settle(inFlight.state, { before: 'cur_1', cursor: 'cur_2', hasMore: true }).state;
    expect(atLatestOnly(state)).toBe(false);
  });

  it('resets the window, because the reply rebuilds the list from scratch', () => {
    const inFlight = beginEarlier(afterFirstPage())!;
    const paged = settle(inFlight.state, { before: 'cur_1', cursor: 'cur_2', hasMore: true }).state;
    expect(beginLatest()).toEqual({ inFlight: true, hasMore: false, loaded: [] });
    expect(paged.loaded.length).toBe(2);
  });
});
