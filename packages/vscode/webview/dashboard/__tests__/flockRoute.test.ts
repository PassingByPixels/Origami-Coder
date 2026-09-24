// flockRoute.test.ts — pickFlockClient, the leaf that decides whether a Flock
// call reaches a SIBLING CHAT's engine instead of the active one.
//
// The scenario: a workspace runs one engine per chat. `flock-owner.json` names
// which one holds the relay sockets by OS pid. When that pid belongs to one of
// THIS window's other open chats, routing there — rather than to the active
// chat, which merely happens to be open — is the whole fix for the false
// "running in another window" banner (the holder is really a tab over) and
// for `flock_decide`/`flock_send` silently doing nothing (only the holder's
// engine has a transport to send on).
import { describe, expect, it } from 'vitest';
import { flockRouteCandidates, holderPidOf, pickFlockClient, readFlockState } from '../../../src/dashboard/flockRoute';

describe('pickFlockClient', () => {
  it('OURS — the holder pid matches one of our sessions: that session\'s client is picked', () => {
    const holder = { id: 'client-A' };
    const other = { id: 'client-B' };
    const picked = pickFlockClient(
      [
        { pid: 101, client: other },
        { pid: 202, client: holder },
      ],
      202,
    );
    expect(picked).toBe(holder);
  });

  it('NOT OURS — the holder pid belongs to nobody here: falls back to undefined (the active client, at the call site)', () => {
    const picked = pickFlockClient([{ pid: 101, client: { id: 'client-A' } }], 999);
    expect(picked).toBeUndefined();
  });

  it('OURS BUT GONE — the session that held it has since closed: falls back the same way as "not ours"', () => {
    // The chat that had pid 202 closed; the current session list no longer
    // carries it at all (flockRouteCandidates only lists LIVE chats).
    const picked = pickFlockClient([{ pid: 101, client: { id: 'client-A' } }], 202);
    expect(picked).toBeUndefined();
  });

  it('no lease at all (holderPid undefined): never matches, even a session with an undefined pid', () => {
    const picked = pickFlockClient([{ pid: undefined, client: { id: 'client-A' } }], undefined);
    expect(picked).toBeUndefined();
  });
});

describe('flockRouteCandidates', () => {
  it('pairs each session\'s id with its live client and pid, skipping a chat with no client yet', () => {
    const clientA = { id: 'A' };
    const candidates = flockRouteCandidates({
      sessions: () => [
        { id: 'local-1', pid: 111 },
        { id: 'local-2', pid: 222 },
      ],
      chat: (localId) => (localId === 'local-1' ? { client: clientA, pid: 111 } : { pid: 222 }), // local-2 has no client: still starting
    });
    expect(candidates).toEqual([{ pid: 111, client: clientA }]);
  });

  it('with no sessions() or chat() at all, the candidate list is empty rather than a throw', () => {
    expect(flockRouteCandidates({})).toEqual([]);
  });
});

describe('holderPidOf', () => {
  it('reads a numeric holder.pid off the raw flock_state response', () => {
    expect(holderPidOf({ holder: { pid: 4242, httpBase: 'http://127.0.0.1:1' } })).toBe(4242);
  });

  it('is undefined when there is no holder, or its pid is not a number', () => {
    expect(holderPidOf({})).toBeUndefined();
    expect(holderPidOf({ holder: {} })).toBeUndefined();
    expect(holderPidOf({ holder: { pid: '4242' } })).toBeUndefined();
  });
});

// t-vbj03h. The owner saw the banner with ONE window open. The lease holder was
// this window's HOST engine (hostEngine.ts, t-sh7cog: a headless engine with no
// chat, started when a surface reads the engine before any chat has one). It is
// not in `sessions()`, so the route never found it and the chat engine's own
// `other-engine` reached the banner.
describe('readFlockState - who holds the lease (t-vbj03h)', () => {
  type Reply = Record<string, unknown>;
  const engine = (reply: Reply) => {
    const calls: string[] = [];
    return { calls, extMethod: async (method: string) => (calls.push(method), reply) };
  };
  const otherEngine = (pid: number): Reply => ({ transport: 'other-engine', holder: { pid, httpBase: 'http://127.0.0.1:4096' } });

  it('the holder is this window\'s host engine: state is read through it and shown as `relay`', async () => {
    const active = engine(otherEngine(35304));
    const host = engine({ transport: 'relay', holder: { pid: 35304, httpBase: 'http://127.0.0.1:4096' } });
    const state = await readFlockState(active, {
      sessions: () => [{ id: 'local-1', pid: 54788 }],
      chat: () => ({ client: active, pid: 54788 }),
      hostEngine: () => ({ client: host, pid: 35304 }),
    });
    expect(state['transport']).toBe('relay');
    expect(host.calls).toEqual(['flock_state']);
  });

  it('the holder process is gone: no `other-engine` (this engine takes the lease on its next beat)', async () => {
    const active = engine(otherEngine(4242));
    const state = await readFlockState(active, { sessions: () => [], chat: () => undefined }, () => false);
    expect(state['transport']).not.toBe('other-engine');
  });

  it('a LIVE holder that is not one of ours still reads `other-engine`, with its pid kept for the banner', async () => {
    const active = engine(otherEngine(4242));
    const state = await readFlockState(active, { sessions: () => [], chat: () => undefined }, () => true);
    expect(state['transport']).toBe('other-engine');
    expect(holderPidOf(state)).toBe(4242);
  });
});
