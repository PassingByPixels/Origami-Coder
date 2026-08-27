// sessionAnnounce — a refused session must never have been on screen.
//
// The reported defect (W8-L1 live UAT): "Start session" on a bot flashed a chat
// panel open and then removed it. The panel came from `sessionCreated`, posted
// before the ACP client had connected; the removal came from `sessionClosed` on
// the refusal path. Both posts were correct on their own — their ORDER was not.
//
// The load-bearing case is the first one. The other two are what stops the fix
// from being "announce later for everything", which would take the connecting
// chat away from every ordinary session and hide a real spawn failure.

import { describe, it, expect } from 'vitest';
import { startThenAnnounce } from '../../../src/dashboard/sessionAnnounce';

/** Records the order announce and start happened in. */
const trace = () => {
  const seen: string[] = [];
  return {
    seen,
    announce: () => { seen.push('announce'); },
    resolving: async () => { seen.push('start'); return 'ses_1'; },
    rejecting: async () => { seen.push('start'); throw new Error('engine refused the agent'); },
  };
};

describe('a PROVISIONAL session (a chat created as a bot)', () => {
  it('is never announced when the engine refuses it', async () => {
    const t = trace();

    await expect(
      startThenAnnounce({ provisional: true, announce: t.announce, start: t.rejecting }),
    ).rejects.toThrow('engine refused the agent');

    // No `sessionCreated` was posted, so there is no panel for the tear-down to
    // remove — the refusal reaches the user through the Bots pane alone.
    expect(t.seen).toEqual(['start']);
  });

  it('is announced once the engine has accepted it, and only then', async () => {
    const t = trace();

    await expect(startThenAnnounce({ provisional: true, announce: t.announce, start: t.resolving }))
      .resolves.toBe('ses_1');

    expect(t.seen).toEqual(['start', 'announce']);
  });
});

describe('an ORDINARY chat', () => {
  it('is announced before its engine connects, failure or not', async () => {
    // The panel is where a spawn failure is reported for a normal chat, so it
    // has to exist before the attempt. Bot-scoping the change is the point.
    const t = trace();

    await expect(
      startThenAnnounce({ provisional: false, announce: t.announce, start: t.rejecting }),
    ).rejects.toThrow('engine refused the agent');

    expect(t.seen).toEqual(['announce', 'start']);
  });

  it('is announced exactly once on the happy path', async () => {
    const t = trace();

    await startThenAnnounce({ provisional: false, announce: t.announce, start: t.resolving });

    expect(t.seen).toEqual(['announce', 'start']);
  });
});
