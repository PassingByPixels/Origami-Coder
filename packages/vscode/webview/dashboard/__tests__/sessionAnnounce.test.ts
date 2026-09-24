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

/** Records the order announce, the pane open, start and settle happened in. */
const trace = () => {
  const seen: string[] = [];
  return {
    seen,
    announce: () => { seen.push('announce'); },
    open: () => { seen.push('open'); },
    settled: () => { seen.push('settled'); },
    resolving: async () => { seen.push('start'); return 'ses_1'; },
    rejecting: async () => { seen.push('start'); throw new Error('engine refused the agent'); },
    /** A start that has NOT answered yet — the 2.4-2.5 s the engine really takes. */
    hanging: () => { seen.push('start'); return new Promise<string>(() => {}); },
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

// t-hb1b7e. The chat's editor TAB used to be created after the awaited `start()`, so
// "New chat" left the screen unchanged for the whole engine start-up (2.4-2.5 s of
// engine on this PC, more on the Mac, where the owner saw no pane at all until they
// clicked the sidebar row). The tab is a surface, not a consequence of the engine
// answering, so it is opened with the announce.
describe('the chat pane', () => {
  it('is opened BEFORE start() resolves — a start that never answers still has a pane', async () => {
    const t = trace();

    // Deliberately not awaited: this start never settles, which is the whole point.
    void startThenAnnounce({ provisional: false, announce: t.announce, open: t.open, start: t.hanging });
    await Promise.resolve();

    expect(t.seen, 'the pane exists while the engine is still starting').toEqual(['announce', 'open', 'start']);
  });

  it('is opened once, and stays open when start() rejects', async () => {
    const t = trace();

    await expect(
      startThenAnnounce({ provisional: false, announce: t.announce, open: t.open, settled: t.settled, start: t.rejecting }),
    ).rejects.toThrow('engine refused the agent');

    // No second open, and nothing closes it: the failure is reported INSIDE the pane.
    expect(t.seen).toEqual(['announce', 'open', 'start', 'settled']);
  });

  it('settles the starting state on the happy path too', async () => {
    const t = trace();

    await startThenAnnounce({ provisional: false, announce: t.announce, open: t.open, settled: t.settled, start: t.resolving });

    expect(t.seen).toEqual(['announce', 'open', 'start', 'settled']);
  });

  it('is NOT opened for a refused bot chat — a provisional session shows nothing', async () => {
    const t = trace();

    await expect(
      startThenAnnounce({ provisional: true, announce: t.announce, open: t.open, settled: t.settled, start: t.rejecting }),
    ).rejects.toThrow('engine refused the agent');

    expect(t.seen, 'no tab for a chat the engine refused').toEqual(['start', 'settled']);
  });

  it('opens no tab for a headless agent session, which passes none', async () => {
    const t = trace();

    await startThenAnnounce({ provisional: false, announce: t.announce, settled: t.settled, start: t.resolving });

    expect(t.seen).toEqual(['announce', 'start', 'settled']);
  });
});
