// Tweak 2 (0.2.176) — the pinned last-user-message selector. The 0.2.174 pin
// was inFlight-gated and vanished when the stream ended; the pin persists and is
// driven purely off the latest user message. These assert that observable rule:
// pick the MOST-RECENT user message's text; update when a new user message is
// appended (through the intervening agent/tool rows); empty when there is none.
// The selector takes no inFlight flag — proof the pin no longer depends on it.
//
// Send-echo UAT (0.4.18) adds the other half: a pin with NOTHING under it is not
// a mirror, it is the user's own words printed twice, one line apart. It appears
// once there is output for it to stay above.

import { describe, expect, it } from 'vitest';
import { pinnedMirrorText } from './pinnedUser';

describe('pinnedMirrorText — the pinned-message selector', () => {
  it('returns the text of the most-recent user message, ignoring later non-user rows', () => {
    const messages = [
      { kind: 'system', text: 'Connected.' },
      { kind: 'user', text: 'add rate limiting' },
      { kind: 'agent', text: 'on it' },
      { kind: 'tool', text: 'read_file' },
      // A settled turn: the pin must still show the user ask AFTER the response,
      // i.e. it is not gated on the turn being in flight.
    ];
    expect(pinnedMirrorText(messages)).toBe('add rate limiting');
  });

  it('updates to the NEW user message once the agent answers under it', () => {
    const base = [
      { kind: 'user', text: 'first ask' },
      { kind: 'agent', text: 'done' },
    ];
    expect(pinnedMirrorText(base)).toBe('first ask');
    const next = [...base, { kind: 'user', text: 'second ask' }, { kind: 'agent', text: 'ok' }];
    expect(pinnedMirrorText(next)).toBe('second ask');
  });

  it('mirrors NOTHING while the user message is still the last row — the row itself is on screen', () => {
    expect(pinnedMirrorText([
      { kind: 'system', text: 'Connected.' },
      { kind: 'user', text: 'who are you' },
    ])).toBe('');
    // ...and the moment the agent puts anything under it, the pin has a job.
    expect(pinnedMirrorText([
      { kind: 'system', text: 'Connected.' },
      { kind: 'user', text: 'who are you' },
      { kind: 'thought', text: 'reasoning' },
    ])).toBe('who are you');
  });

  it('returns empty string when the session has no user message yet', () => {
    expect(pinnedMirrorText([])).toBe('');
    expect(pinnedMirrorText([{ kind: 'system', text: 'Connected.' }, { kind: 'agent', text: 'hi' }])).toBe('');
  });
});
