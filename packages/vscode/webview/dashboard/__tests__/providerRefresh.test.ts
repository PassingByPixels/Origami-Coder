// The message seam between a provider-config write and the running engines.
//
// The defect these pin: a key pasted into the connect form landed in
// origami.json and then did nothing until the user reloaded the window, because
// nothing told the engine to re-read it. The fix is one ext method fired after
// every write, and the things worth asserting are all about the EDGES — a write
// that failed must not claim a refresh, a panel with no chat open must not
// throw, a dead engine must not turn a successful connect into an error, and a
// second open chat must not be left holding the old key.
//
// The method name is asserted literally on purpose. It is a wire contract with
// `packages/engine/src/acp/agent.ts`'s `case "provider_refresh"`; a rename on
// either side has to break something, and this is the something.

import { describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_REFRESH_METHOD,
  refreshEngineProviders,
  refreshingWriter,
  type RefreshTarget,
} from '../../../src/dashboard/providerRefresh';

const client = (extMethod = vi.fn().mockResolvedValue({ ok: true })) => ({ extMethod });

describe('refreshEngineProviders', () => {
  it('calls provider_refresh with the session cwd', async () => {
    const c = client();
    await refreshEngineProviders([{ client: c, cwd: '/work/repo' }]);
    expect(c.extMethod).toHaveBeenCalledWith(PROVIDER_REFRESH_METHOD, { cwd: '/work/repo' });
    expect(PROVIDER_REFRESH_METHOD).toBe('provider_refresh');
  });

  it('tells EVERY live chat, each about its own cwd', async () => {
    // Each chat holds its own AcpClient and therefore its own engine caches; an
    // Agent-Manager chat runs in a worktree. Telling only the active one leaves
    // the others sending the old key — the same defect, quieter.
    const chat = client();
    const worktree = client();
    await refreshEngineProviders([
      { client: chat, cwd: '/work/repo' },
      { client: worktree, cwd: '/work/repo.wt/agent-1' },
    ]);
    expect(chat.extMethod).toHaveBeenCalledWith(PROVIDER_REFRESH_METHOD, { cwd: '/work/repo' });
    expect(worktree.extMethod).toHaveBeenCalledWith(PROVIDER_REFRESH_METHOD, { cwd: '/work/repo.wt/agent-1' });
  });

  it('one dead chat does not stop the others being told', async () => {
    const dead = client(vi.fn().mockRejectedValue(new Error('connection closed')));
    const alive = client();
    await expect(refreshEngineProviders([{ client: dead }, { client: alive }])).resolves.toBeUndefined();
    expect(alive.extMethod).toHaveBeenCalled();
  });

  it('omits cwd rather than sending an empty one', async () => {
    const c = client();
    await refreshEngineProviders([{ client: c }]);
    // The engine falls back to its own process cwd; a '' would resolve a
    // DIFFERENT instance than the session's and invalidate the wrong caches.
    expect(c.extMethod).toHaveBeenCalledWith(PROVIDER_REFRESH_METHOD, {});
  });

  it('is a no-op before any chat has opened an engine', async () => {
    // No chats at all — the pre-connect case. Must resolve, not throw: the
    // config write it follows already succeeded.
    await expect(refreshEngineProviders([])).resolves.toBeUndefined();
  });

  it('swallows an engine that refuses because it predates the method', async () => {
    const c = client(vi.fn().mockRejectedValue(new Error('method_not_found')));
    await expect(refreshEngineProviders([{ client: c }])).resolves.toBeUndefined();
    expect(c.extMethod).toHaveBeenCalled();
  });
});

describe('refreshingWriter', () => {
  it('writes first, then tells the engines, and returns the write result untouched', async () => {
    const order: string[] = [];
    const c = client(vi.fn().mockImplementation(async () => { order.push('refresh'); return {}; }));
    const write = vi.fn().mockImplementation((choice: { providerId: string }) => {
      order.push('write');
      return { path: '/cfg/origami.json', model: `${choice.providerId}/m` };
    });

    const wrapped = refreshingWriter(write, () => [{ client: c, cwd: '/work/repo' }]);
    const result = wrapped({ providerId: 'openrouter' });

    expect(result).toEqual({ path: '/cfg/origami.json', model: 'openrouter/m' });
    await vi.waitFor(() => expect(c.extMethod).toHaveBeenCalledTimes(1));
    // Order matters: refreshing BEFORE the write would re-read the old file and
    // leave the new key just as invisible as it was.
    expect(order).toEqual(['write', 'refresh']);
  });

  it('does not tell the engines when the write threw', async () => {
    const c = client();
    const wrapped = refreshingWriter(() => { throw new Error('config is corrupt'); }, () => [{ client: c }]);

    expect(() => wrapped({})).toThrow('config is corrupt');
    // Nothing changed on disk, so there is nothing to refresh — and a refresh
    // here would drop the engine's caches for no reason at all.
    expect(c.extMethod).not.toHaveBeenCalled();
  });

  it('reads the engine list at write time, not at wire-up time', async () => {
    // The panel wires this once, in its constructor, when no chat exists yet.
    // A list captured then would be empty forever and the whole path dead.
    let targets: RefreshTarget[] = [];
    const c = client();
    const wrapped = refreshingWriter(() => ({ path: 'p', model: 'm' }), () => targets);

    wrapped({});
    expect(c.extMethod).not.toHaveBeenCalled();

    targets = [{ client: c, cwd: '/work/repo' }];
    wrapped({});
    await vi.waitFor(() => expect(c.extMethod).toHaveBeenCalledWith(PROVIDER_REFRESH_METHOD, { cwd: '/work/repo' }));
  });

  it('a refusing engine does not turn a successful write into a failure', async () => {
    const c = client(vi.fn().mockRejectedValue(new Error('connection closed')));
    const wrapped = refreshingWriter(() => ({ path: 'p', model: 'openrouter/m' }), () => [{ client: c }]);

    expect(wrapped({})).toEqual({ path: 'p', model: 'openrouter/m' });
    await vi.waitFor(() => expect(c.extMethod).toHaveBeenCalled());
  });
});
