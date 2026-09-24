// `establishSession` — which ACP call a chat's session comes from.
//
// This is the seam `/btw` added: a THIRD way to get a session, alongside
// history recall and a fresh one. The bug class it guards is a mis-routed
// branch, and every version of that bug is silent — a `/btw` that quietly calls
// `newSession` opens an EMPTY tab that looks exactly like a working fork until
// the user reads it, and a fork that reports the SOURCE session id points two
// tabs at one conversation. Both are asserted here by naming what must NOT have
// been called, not just what was.
//
// Driven against a fake connection: the real `AcpClient.start()` spawns the
// engine child before it reaches this call, so this function is the only point
// at which the choice is testable without a binary.

import { describe, expect, it, vi } from 'vitest';
import { establishSession, type SessionConnection } from '../../../src/acpFork';

/** Three spies, one per way in. Each records its args and answers with an id
 *  that names which one ran, so a test can never mistake one for another. */
function fakeConnection(over: Partial<Record<keyof SessionConnection, unknown>> = {}) {
  const conn = {
    unstable_forkSession: vi.fn(async () => ({
      sessionId: 'ses_fork',
      configOptions: [{ id: 'model', currentValue: 'lmstudio/qwen' }],
    })),
    loadSession: vi.fn(async () => ({ sessionId: 'ignored', configOptions: [{ id: 'mode' }] })),
    newSession: vi.fn(async () => ({ sessionId: 'ses_new', configOptions: [{ id: 'effort' }] })),
    ...over,
  };
  return conn as unknown as SessionConnection & typeof conn;
}

describe('establishSession — the fork branch (/btw)', () => {
  it('forks the SOURCE session and never opens a fresh or recalled one', async () => {
    const conn = fakeConnection();

    const result = await establishSession(conn, { cwd: '/work', forkFromSessionId: 'ses_parent' });

    expect(conn.unstable_forkSession).toHaveBeenCalledWith({
      sessionId: 'ses_parent',
      cwd: '/work',
      mcpServers: [],
    });
    // The whole point of the feature: a fork is not a new chat and not a reopen.
    expect(conn.newSession).not.toHaveBeenCalled();
    expect(conn.loadSession).not.toHaveBeenCalled();
    expect(result.how).toBe('forked');
  });

  it("answers with the FORK's session id, not the source's", async () => {
    // The bug: reading the source id back would point the new tab's prompts at
    // the chat the user forked away from — two tabs writing one conversation.
    const result = await establishSession(fakeConnection(), { cwd: '/work', forkFromSessionId: 'ses_parent' });
    expect(result.sessionId).toBe('ses_fork');
    expect(result.sessionId).not.toBe('ses_parent');
  });

  it("carries the fork's own configOptions through (the tab's model/mode pickers)", async () => {
    const result = await establishSession(fakeConnection(), { cwd: '/work', forkFromSessionId: 'ses_parent' });
    expect(result.configOptions).toEqual([{ id: 'model', currentValue: 'lmstudio/qwen' }]);
  });

  it('reports an engine that answers with no session id, instead of returning an unusable chat', async () => {
    const conn = fakeConnection({ unstable_forkSession: vi.fn(async () => ({ configOptions: [] })) });
    await expect(establishSession(conn, { cwd: '/work', forkFromSessionId: 'ses_parent' })).rejects.toThrow(
      /no sessionId/,
    );
  });

  it('takes precedence over a load id, so a fork is never also a reopen', async () => {
    const conn = fakeConnection();
    const result = await establishSession(conn, {
      cwd: '/work',
      forkFromSessionId: 'ses_parent',
      loadSessionId: 'ses_old',
    });
    expect(result.sessionId).toBe('ses_fork');
    expect(conn.loadSession).not.toHaveBeenCalled();
  });
});

// The two pre-existing ways in, pinned so the extraction that made room for the
// fork branch cannot have changed them.
describe('establishSession — recall and fresh are unchanged by the fork branch', () => {
  it('recall loads the named session and reports THAT id (the engine echoes none)', async () => {
    const conn = fakeConnection();
    const result = await establishSession(conn, { cwd: '/work', loadSessionId: 'ses_old' });

    expect(conn.loadSession).toHaveBeenCalledWith({ sessionId: 'ses_old', cwd: '/work', mcpServers: [] });
    expect(conn.unstable_forkSession).not.toHaveBeenCalled();
    expect(conn.newSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sessionId: 'ses_old', how: 'loaded' });
  });

  it('a fresh session carries `_meta.agent` when one was requested, and omits it otherwise', async () => {
    const withAgent = fakeConnection();
    await establishSession(withAgent, { cwd: '/work', agent: 'scout' });
    expect(withAgent.newSession).toHaveBeenCalledWith({ cwd: '/work', mcpServers: [], _meta: { agent: 'scout' } });

    const plain = fakeConnection();
    const result = await establishSession(plain, { cwd: '/work' });
    expect(plain.newSession).toHaveBeenCalledWith({ cwd: '/work', mcpServers: [] });
    expect(result).toMatchObject({ sessionId: 'ses_new', how: 'created' });
  });

  it('treats absent/null configOptions as none rather than crashing the chat', async () => {
    const conn = fakeConnection({ newSession: vi.fn(async () => ({ sessionId: 'ses_new', configOptions: null })) });
    expect((await establishSession(conn, { cwd: '/work' })).configOptions).toEqual([]);
  });
});
