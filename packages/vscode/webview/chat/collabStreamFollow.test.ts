// W2 (report 1.11 / F10) — the collab stream FOLLOWS the stream, on the chat's
// rule and not a second one.
//
// THE BUG. CollabStream.svelte had no scroll logic at all, so the one live
// signal a room has — the running agent's pill — sat below the fold on any
// transcript longer than the pane. A collab that took four minutes showed its
// work to nobody unless the user dragged the scrollbar down by hand after every
// message.
//
// WHY THE RULE IS LIFTED, NOT RE-DERIVED. `chatScroll.ts` already answers
// "should this transcript follow?" and was hardened twice (0.4.2, then M4.4) on
// the exact traps a naive autoscroll walks into: a scrollbar drag whose `scroll`
// event has not fired yet, growth that moves the bottom rather than scrollTop,
// and a threshold loose enough that one arrow-key press re-armed the follow.
// `collabStreamFollow.ts` is the WIRING of that rule for one scroller; the rule
// itself stays where it was proven. The wiki page
// `origami_coder_arc_2026-08-17_049.md` section 1 records why inferring intent
// from the input events instead failed.
//
// Driven against a fake element rather than a render: jsdom lays nothing out, so
// the scroller's metrics are supplied here either way, and the controller is the
// whole decision.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeStreamFollow } from './collabStreamFollow';

/** Runs the queued frame straight away, so a test asserts the outcome rather
 *  than the scheduling. The real one is requestAnimationFrame — see the leaf. */
const now = (fn: () => void) => fn();

let el: HTMLDivElement;

/** jsdom has no layout: the metrics ARE the fixture. `atBottom` puts scrollTop
 *  where a scroller parked at its true bottom would report it. */
function scroller(scrollHeight = 1000, clientHeight = 400, scrollTop = 600): HTMLDivElement {
  const node = document.createElement('div');
  Object.defineProperty(node, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(node, 'clientHeight', { value: clientHeight, configurable: true });
  node.scrollTop = scrollTop;
  return node;
}
/** Content arriving UNDER the scroller: only the bottom moves. */
const grow = (node: HTMLDivElement, scrollHeight: number) =>
  Object.defineProperty(node, 'scrollHeight', { value: scrollHeight, configurable: true });

beforeEach(() => { el = scroller(); });

describe('collabStreamFollow — a settled room follows its own stream', () => {
  it('scrolls a bound stream to the bottom when a message lands', () => {
    const follow = makeStreamFollow(now);
    follow.bind(el);
    grow(el, 1400);
    follow.follow();
    expect(el.scrollTop).toBe(1400);
  });

  it('follows every message, not just the first — the stick is not a one-shot', () => {
    const follow = makeStreamFollow(now);
    follow.bind(el);
    for (const h of [1400, 1800, 2200]) {
      grow(el, h);
      follow.follow();
      expect(el.scrollTop).toBe(h);
    }
  });

  it('a stream with nothing bound to it does nothing at all, and never throws', () => {
    const follow = makeStreamFollow(now);
    expect(() => follow.follow()).not.toThrow();
    follow.bind(null);
    expect(() => follow.follow()).not.toThrow();
  });
});

describe('collabStreamFollow — reading STOPS the follow', () => {
  it('holds position once the user has scrolled away from the bottom', () => {
    const follow = makeStreamFollow(now);
    follow.bind(el);
    el.scrollTop = 100;
    follow.onScroll();

    grow(el, 1400);
    follow.follow();
    expect(el.scrollTop).toBe(100);
  });

  it('honours an upward wheel BEFORE the movement has cleared the threshold', () => {
    // The 0.4.2 trap: a `scroll` event is queued to the next rendering
    // opportunity, so the queued frame snaps the scroller back first and the
    // coalesced event then reports the bottom. The wheel is the earlier signal.
    const follow = makeStreamFollow(now);
    follow.bind(el);
    follow.onWheel(-20);

    grow(el, 1400);
    follow.follow();
    expect(el.scrollTop).toBe(600);
  });

  it('holds a scrollbar drag whose scroll event has not fired when a message lands', () => {
    // No onScroll() call at all here — that is the point. The anchor the last
    // follow left behind is the only evidence the user moved, and it is enough.
    const follow = makeStreamFollow(now);
    follow.bind(el);
    follow.follow();

    el.scrollTop = 100;
    grow(el, 1400);
    follow.follow();
    expect(el.scrollTop).toBe(100);
  });

  it('a scroll shorter than one message row still counts as reading', () => {
    // ~30px is one arrow-key press. Treating it as "still at the bottom" is
    // what made the 0.4.2 fix leak.
    const follow = makeStreamFollow(now);
    follow.bind(el);
    follow.follow();

    el.scrollTop = 570;
    follow.onScroll();
    grow(el, 1400);
    follow.follow();
    expect(el.scrollTop).toBe(570);
  });

  it('growth under an armed follow is not mistaken for a user scroll', () => {
    const follow = makeStreamFollow(now);
    follow.bind(el);
    follow.follow();
    for (const h of [1200, 1600, 2000]) {
      grow(el, h);
      follow.follow();
      expect(el.scrollTop).toBe(h);
    }
  });
});

describe('collabStreamFollow — coming back re-arms it', () => {
  it('resumes the moment the user scrolls back to a genuine bottom', () => {
    const follow = makeStreamFollow(now);
    follow.bind(el);
    el.scrollTop = 100;
    follow.onScroll();

    el.scrollTop = 600;
    follow.onScroll();

    grow(el, 1400);
    follow.follow();
    expect(el.scrollTop).toBe(1400);
  });

  it('the user POSTING re-arms it, wherever they were reading', () => {
    // Their own message is an explicit "I want to watch this" — the same call
    // ChatPane's send makes, and it outranks a position it inferred.
    const follow = makeStreamFollow(now);
    follow.bind(el);
    el.scrollTop = 100;
    follow.onScroll();

    grow(el, 1400);
    follow.follow(7, true);
    expect(el.scrollTop).toBe(1400);
  });

  it('re-arms ONCE per human message, so scrolling away after posting still holds', () => {
    // The newest message stays the human's until an agent answers, which can be
    // minutes. Re-arming on every render through that window would defeat the
    // stick exactly while the user is reading back over what they asked for.
    const follow = makeStreamFollow(now);
    follow.bind(el);
    follow.follow(7, true);

    el.scrollTop = 100;
    follow.onScroll();
    grow(el, 1400);
    follow.follow(7, true);
    expect(el.scrollTop).toBe(100);
  });

  it('re-arms on a scroll back to the bottom the user SAW, even after growth beat the event', () => {
    // THE GROWTH RACE. `scroll` is queued to the next rendering opportunity, so
    // a message can land between the drag and its event. Measured against the
    // new bottom the user reads as 400px up; against the one they were looking
    // at, they are exactly on it.
    const follow = makeStreamFollow(now);
    follow.bind(el);
    follow.onScroll();          // at the bottom, 1000/400 — what they SAW

    el.scrollTop = 100;
    follow.onScroll();          // reading back: the follow is off

    el.scrollTop = 600;         // back on the bottom as it was DRAWN
    grow(el, 1400);             // a message lands before the queued event runs
    follow.onScroll();

    grow(el, 1800);
    follow.follow();
    expect(el.scrollTop).toBe(1800);
  });

  it('an upward wheel on a stream too short to scroll never freezes the follow', () => {
    // THE DEAD WHEEL LATCH. Nothing to scroll means no `scroll` event to re-arm
    // on, so the latch would stay off for the rest of the room's life — the
    // moment the transcript outgrows the pane is the moment it stops following.
    const follow = makeStreamFollow(now);
    const short = scroller(300, 400, 0);
    follow.bind(short);

    follow.onWheel(-20);

    grow(short, 1400);
    follow.follow();
    expect(short.scrollTop).toBe(1400);
  });

  it('a reader parked above the bottom they last saw stays parked as it grows', () => {
    // The other edge of the re-arm: NEAR the seen bottom is not ON it.
    const follow = makeStreamFollow(now);
    follow.bind(el);
    follow.onScroll();
    el.scrollTop = 400;         // 200px above the bottom they saw
    follow.onScroll();

    for (const h of [1400, 1600, 1800]) {
      grow(el, h);
      follow.follow();
      expect(el.scrollTop).toBe(400);
    }
  });

  it('an AGENT message never re-arms a follow the user turned off', () => {
    const follow = makeStreamFollow(now);
    follow.bind(el);
    el.scrollTop = 100;
    follow.onScroll();

    grow(el, 1400);
    follow.follow(9, false);
    expect(el.scrollTop).toBe(100);
  });
});

// t-v47ytt. The chat's stale-record defect, on this surface: the record of what the reader SAW was
// written only by scroll events, so our own follow's event, landing a frame late after the next
// message grew the stream, read as the reader leaving. The scroller below clamps like a browser.
describe('collabStreamFollow — our own follow is never read as the reader leaving (t-v47ytt)', () => {
  function clamped(height: number, client: number, top: number): HTMLDivElement {
    const node = document.createElement('div');
    let h = height, t = top;
    Object.defineProperty(node, 'clientHeight', { get: () => client, configurable: true });
    Object.defineProperty(node, 'scrollHeight', { get: () => h, set: (v: number) => { h = v; }, configurable: true });
    Object.defineProperty(node, 'scrollTop', { get: () => t, set: (v: number) => { t = Math.max(0, Math.min(v, h - client)); }, configurable: true });
    return node;
  }
  const rise = (node: HTMLDivElement, h: number) => { (node as unknown as { scrollHeight: number }).scrollHeight = h; };

  it('the scroll event for our own move, landing after the next message, keeps the follow', () => {
    const follow = makeStreamFollow(now);
    const box = clamped(1000, 400, 0);   // a fresh room: no scroll event seen yet
    follow.bind(box);
    follow.follow();                     // our move: 0 -> 600
    rise(box, 1200);                     // the next message lands before that move's event
    follow.onScroll();                   // the event for OUR move
    rise(box, 1400);
    follow.follow();
    expect(box.scrollTop).toBe(1000);
  });

  it('an upward wheel that scrolls a box inside the stream does not release the follow', () => {
    const follow = makeStreamFollow(now);
    const box = clamped(1000, 400, 600);
    const inner = document.createElement('pre');
    box.appendChild(inner);
    follow.bind(box);
    follow.onScroll();
    inner.scrollTop = 300;               // the inner box can still scroll up, so it takes the wheel
    follow.onWheel(-100, inner);
    rise(box, 1200);
    follow.follow();
    expect(box.scrollTop).toBe(800);
  });
});