// activeSession — the stored "active" id is a HINT, not a guarantee.
//
// The regression these pin (W8-L1, live UAT): starting a session on a bot the
// engine refuses left `activeSessionId` naming a session that had just been
// deleted from the map, and the Skills pane answered "Open a chat first" with
// two healthy chats open beside it.
//
// The failing input is therefore an id that is NOT a key of the map, with live
// sessions present. Everything else here is the surrounding contract: a rule
// that answered "the newest chat" for a STILL-LIVE active id would break every
// pane in the opposite direction.

import { describe, it, expect } from 'vitest';
import { liveActiveSession, liveActiveSessionId } from '../../../src/dashboard/activeSession';

const sessions = (...ids: string[]) => new Map(ids.map((id) => [id, { id }]));

describe('liveActiveSessionId', () => {
  it('keeps the stored id while it names a live session', () => {
    expect(liveActiveSessionId(sessions('session-1', 'session-2'), 'session-1')).toBe('session-1');
  });

  it('falls to the newest survivor when the stored id names a session that is GONE', () => {
    // THE REGRESSION. `session-3` is the half-built bot chat the refusal path
    // deleted; nothing moved the active id off it, because that path is not
    // closeSession.
    expect(liveActiveSessionId(sessions('session-1', 'session-2'), 'session-3')).toBe('session-2');
  });

  it('answers null only when there is really nothing left', () => {
    expect(liveActiveSessionId(new Map(), 'session-3')).toBeNull();
    expect(liveActiveSessionId(new Map(), null)).toBeNull();
  });

  it('falls to the newest survivor when no id was ever stored', () => {
    expect(liveActiveSessionId(sessions('session-1', 'session-2'), null)).toBe('session-2');
  });
});

describe('liveActiveSession', () => {
  it('resolves a LIVE session when the active id is a corpse', () => {
    const map = sessions('session-1', 'session-2');
    expect(liveActiveSession(map, 'session-3')).toBe(map.get('session-2'));
  });

  it('resolves nothing when the window holds no sessions', () => {
    expect(liveActiveSession(new Map(), 'session-3')).toBeUndefined();
  });
});
