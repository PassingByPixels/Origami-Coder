// Pure-logic tests for sessionRowState.ts — no DOM, no component render.
// deriveRowVisualState is the seam that decides which colour a sidebar row's
// ring wears; a bug here mis-signals whether a chat needs the user at all.
import { describe, expect, it } from 'vitest';
import { deriveRowVisualState, addPendingAsk, removePendingAsk } from './sessionRowState';

describe('deriveRowVisualState', () => {
  it('busy with no open ask shows the working (amber) state', () => {
    expect(deriveRowVisualState('working', false)).toBe('working');
  });

  it('a pending approval shows waiting, regardless of the turn state under it', () => {
    expect(deriveRowVisualState('idle', true)).toBe('waiting');
  });

  it('an open question — tracked the same way as a pending approval — also shows waiting', () => {
    expect(deriveRowVisualState('ready', true)).toBe('waiting');
  });

  it('busy AND waiting together show waiting — the engine is parked on the user, not moving', () => {
    expect(deriveRowVisualState('working', true)).toBe('waiting');
  });

  it('neither busy nor waiting falls back to the plain turn state, idle and ready alike', () => {
    expect(deriveRowVisualState('idle', false)).toBe('idle');
    expect(deriveRowVisualState('ready', false)).toBe('ready');
  });
});

describe('addPendingAsk / removePendingAsk', () => {
  it('adds a fresh toolCallId', () => {
    expect(addPendingAsk(new Set(), 't1').has('t1')).toBe(true);
  });

  it('adding an id already tracked is a no-op — same Set reference back', () => {
    const first = addPendingAsk(new Set(), 't1');
    expect(addPendingAsk(first, 't1')).toBe(first);
  });

  it('removes a tracked id', () => {
    const asks = addPendingAsk(new Set(), 't1');
    expect(removePendingAsk(asks, 't1').has('t1')).toBe(false);
  });

  it('removing an id nobody is tracking is a no-op — same Set reference back', () => {
    const asks = new Set<string>();
    expect(removePendingAsk(asks, 'ghost')).toBe(asks);
  });

  it('a second, different ask keeps the first — a row can have more than one open ask', () => {
    const asks = addPendingAsk(addPendingAsk(new Set(), 't1'), 't2');
    expect(asks.has('t1')).toBe(true);
    expect(asks.has('t2')).toBe(true);
    expect(removePendingAsk(asks, 't1').has('t2')).toBe(true);
  });
});
