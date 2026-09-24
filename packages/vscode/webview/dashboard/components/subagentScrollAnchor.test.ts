// subagentScrollAnchor.test.ts — the state transitions, against the real
// scroll-metrics leaves (chatScrollRearm.ts), not a mock of them: a jsdom
// element's scrollTop/scrollHeight/clientHeight are all writable, so the
// real "is this near the bottom" rule can run without a browser.
import { describe, expect, it } from 'vitest';
import {
  anchorPillLabel, initialAnchorState, jumpToLatest, onAnchorScroll, onAnchorWheel,
} from './subagentScrollAnchor';
import type { Message } from '../panes/chatMessage';

function scroller(top: number, height: number, client: number): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true });
  Object.defineProperty(el, 'scrollHeight', { value: height, writable: true });
  Object.defineProperty(el, 'clientHeight', { value: client, writable: true });
  return el;
}

const msg = (id: number, kind: Message['kind'] = 'agent'): Message =>
  ({ id, kind, label: '', text: '' }) as Message;

describe('subagentScrollAnchor', () => {
  it('starts stuck to the bottom, with no pill', () => {
    const s = initialAnchorState();
    expect(s.stuckToBottom).toBe(true);
    expect(anchorPillLabel(s, [msg(1)])).toBe('');
  });

  it('scrolling away from the bottom unsticks and remembers the last-seen row', () => {
    const el = scroller(0, 2000, 400); // far from the bottom (2000 - 400 = 1600 away)
    const s = onAnchorScroll(initialAnchorState(), el, 7);
    expect(s.stuckToBottom).toBe(false);
    expect(s.unseenFromId).toBe(7);
  });

  it('a scroll back to the bottom re-sticks and drops the unseen marker', () => {
    const el = scroller(0, 2000, 400);
    let s = onAnchorScroll(initialAnchorState(), el, 7);
    // move the same element to its bottom and scroll again
    Object.defineProperty(el, 'scrollTop', { value: 1600, writable: true });
    s = onAnchorScroll(s, el, 9);
    expect(s.stuckToBottom).toBe(true);
    expect(anchorPillLabel(s, [msg(9)])).toBe('');
  });

  it('an upward wheel on a scrollable body unsticks, a downward one does not', () => {
    const el = scroller(500, 2000, 400);
    const up = onAnchorWheel(initialAnchorState(), el, -50, 3);
    expect(up.stuckToBottom).toBe(false);
    expect(up.unseenFromId).toBe(3);

    const down = onAnchorWheel(initialAnchorState(), el, 50, 3);
    expect(down.stuckToBottom).toBe(true);
  });

  it('the pill label counts everything after the unseen marker, by family', () => {
    const messages = [msg(1, 'user'), msg(2, 'tool'), msg(3, 'agent')];
    const s = { stuckToBottom: false, unseenFromId: 1 };
    expect(anchorPillLabel(s, messages)).toContain('tool');
    expect(anchorPillLabel(s, messages)).toContain('message');
  });

  it('jumping to latest re-sticks and clears the marker', () => {
    const el = scroller(0, 2000, 400);
    const jumped = jumpToLatest(el);
    expect(jumped.stuckToBottom).toBe(true);
    expect(jumped.unseenFromId).toBeNull();
  });
});
