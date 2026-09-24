// sessionDelete — the host side of the Labyrinth card's delete.
//
// The bug this file exists to catch is the one the feature ships with: a chat
// that is OPEN in a tab and a row in the run index are the SAME engine session,
// so a delete driven from the index can pull the store rows out from under a
// live cell. The first describe below is that guard; drop the `openSessionIds`
// check in sessionDelete.ts and it goes red on the client call, not just on the
// wording.
//
// Everything is asserted through a fake host, so no engine, no extension host
// and — deliberately — no session store of any kind is involved.

import { describe, it, expect } from 'vitest';
import {
  SESSION_DELETE_MESSAGE_TYPES,
  handleSessionDeleteMessage,
  OPEN_CHAT_REFUSAL,
  NO_ENGINE_REFUSAL,
  COLLAB_REFUSAL,
  type SessionDeleteHost,
} from '../../../src/dashboard/sessionDelete';

interface FakeHost extends SessionDeleteHost {
  posts: Array<Record<string, unknown>>;
  deleted: Array<[string, string | undefined]>;
}
function fakeHost(open: string[] = [], opts: { engine?: boolean; fail?: string } = {}): FakeHost {
  const posts: Array<Record<string, unknown>> = [];
  const deleted: Array<[string, string | undefined]> = [];
  const client = {
    deleteSession: async (sessionId: string, cwd?: string) => {
      deleted.push([sessionId, cwd]);
      if (opts.fail) throw new Error(opts.fail);
    },
  };
  return {
    posts,
    deleted,
    ...(opts.engine === false ? {} : { client }),
    openSessionIds: () => open,
    post: (msg) => posts.push(msg),
  };
}
const last = (h: FakeHost) => h.posts[h.posts.length - 1]!;

describe('SESSION_DELETE_MESSAGE_TYPES — exactly the one message this leaf owns', () => {
  it('names the case handled below, nothing else', () => {
    expect([...SESSION_DELETE_MESSAGE_TYPES]).toEqual(['labDeleteSession']);
  });
});

describe('handleSessionDeleteMessage — a chat OPEN in this window is never deleted', () => {
  it('refuses, tells the user what to do about it, and never reaches the engine', async () => {
    const host = fakeHost(['ses_open']);
    await handleSessionDeleteMessage(host, { type: 'labDeleteSession', sessionId: 'ses_open' });

    // The call is the assertion that matters: a guard that only changed the
    // wording would still have deleted the session out from under the tab.
    expect(host.deleted).toEqual([]);
    expect(last(host)).toEqual({
      type: 'labDeleteSessionDone',
      sessionId: 'ses_open',
      ok: false,
      error: OPEN_CHAT_REFUSAL,
    });
  });

  it('checks EVERY open cell, not just the active one', async () => {
    // The active chat is ses_a; the target is open in a second, background tab.
    const host = fakeHost(['ses_a', 'ses_b']);
    await handleSessionDeleteMessage(host, { type: 'labDeleteSession', sessionId: 'ses_b' });

    expect(host.deleted).toEqual([]);
    expect(last(host)).toMatchObject({ ok: false, error: OPEN_CHAT_REFUSAL });
  });

  it('deletes a run that no tab is bound to, and passes the run OWN cwd', async () => {
    const host = fakeHost(['ses_a']);
    await handleSessionDeleteMessage(host, {
      type: 'labDeleteSession',
      sessionId: 'ses_old',
      cwd: 'C:/repos/other-workspace',
    });

    expect(host.deleted).toEqual([['ses_old', 'C:/repos/other-workspace']]);
    expect(last(host)).toEqual({ type: 'labDeleteSessionDone', sessionId: 'ses_old', ok: true });
  });
});

describe('handleSessionDeleteMessage — the other refusals', () => {
  it('refuses a collab HEADER: its pick id names a group, not one session', async () => {
    const host = fakeHost();
    await handleSessionDeleteMessage(host, { type: 'labDeleteSession', sessionId: 'collab:c1' });

    expect(host.deleted).toEqual([]);
    expect(last(host)).toMatchObject({ ok: false, error: COLLAB_REFUSAL });
  });

  it('refuses with an actionable message when no chat has a live engine', async () => {
    const host = fakeHost([], { engine: false });
    await handleSessionDeleteMessage(host, { type: 'labDeleteSession', sessionId: 'ses_old' });

    expect(last(host)).toMatchObject({ ok: false, error: NO_ENGINE_REFUSAL });
  });

  it('reports the STORE\u2019s own refusal instead of claiming the row is gone', async () => {
    const host = fakeHost([], { fail: 'database is locked' });
    await handleSessionDeleteMessage(host, { type: 'labDeleteSession', sessionId: 'ses_old' });

    expect(host.deleted).toEqual([['ses_old', undefined]]);
    expect(last(host)).toMatchObject({ ok: false, error: 'database is locked' });
  });

  it('always answers, so a card left in its armed confirm is never stranded', async () => {
    for (const sessionId of ['', 'collab:c1', 'ses_open']) {
      const host = fakeHost(['ses_open']);
      await handleSessionDeleteMessage(host, { type: 'labDeleteSession', sessionId });
      expect(host.posts).toHaveLength(1);
      expect(last(host)).toMatchObject({ type: 'labDeleteSessionDone', ok: false });
    }
  });

  it('ignores a message it does not own', async () => {
    const host = fakeHost();
    await handleSessionDeleteMessage(host, { type: 'requestHistory', sessionId: 'ses_old' });
    expect(host.posts).toEqual([]);
    expect(host.deleted).toEqual([]);
  });
});
