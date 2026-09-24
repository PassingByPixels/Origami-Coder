import { describe, expect, it } from 'vitest';
import { postApproveModeFailure } from '../../../src/dashboard/approveModeFailure';

describe('a failed approve-mode write answers the phone as well as the pane', () => {
  it('posts a system line AND an unsigned ask-mode revert for the chat named', () => {
    const posted: Record<string, unknown>[] = [];
    postApproveModeFailure((m) => posted.push(m), 'session-7', 'bypass', 'no such chat: session-7');
    expect(posted).toEqual([
      { type: 'system', text: 'Couldn\'t set approve mode "bypass" — no such chat: session-7', sessionId: 'session-7' },
      { type: 'remote/set-mode', v: 1, mode: 'ask', sessionId: 'session-7', reason: 'no such chat: session-7' },
    ]);
  });

  it('with no chat named there is nothing for the phone to revert — the system line alone', () => {
    const posted: Record<string, unknown>[] = [];
    postApproveModeFailure((m) => posted.push(m), undefined, 'auto', 'engine refused');
    expect(posted.map((m) => m.type)).toEqual(['system']);
    expect(posted[0]!.sessionId).toBe('');
  });
});
