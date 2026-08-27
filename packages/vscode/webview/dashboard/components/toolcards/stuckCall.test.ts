// The age rule, tested without a DOM. Two components read it — ToolCard's
// header strip and nothing else, now — and the boundary cases (exactly 30s, a
// clock that has gone backwards, a finished call) are the ones a rendered test
// states least clearly.

import { describe, expect, it } from 'vitest';
import { STUCK_AFTER_S, stuckState } from './stuckCall';

const at = (secondsAgo: number) => ({ running: true, startedAt: 1_000_000, now: 1_000_000 + secondsAgo * 1000 });

describe('stuckState', () => {
  it('reports the whole seconds a running call has been going', () => {
    expect(stuckState(at(45)).elapsed).toBe(45);
  });

  it('is not stuck below the threshold and IS stuck exactly on it', () => {
    expect(stuckState(at(STUCK_AFTER_S - 1)).stuck).toBe(false);
    expect(stuckState(at(STUCK_AFTER_S)).stuck).toBe(true);
  });

  it('ages nothing once the call has stopped running', () => {
    expect(stuckState({ ...at(600), running: false })).toEqual({ elapsed: 0, stuck: false });
  });

  it('ages nothing when the call carries no start stamp', () => {
    expect(stuckState({ running: true, startedAt: undefined, now: 1_000_000 })).toEqual({ elapsed: 0, stuck: false });
  });

  it('never reports a negative age when the stamp is in the future', () => {
    // A card can be stamped by the webview while `now` came from a frame
    // rendered a moment earlier; "-3s elapsed" is worse than saying nothing.
    expect(stuckState(at(-5))).toEqual({ elapsed: 0, stuck: false });
  });
});
