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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PROVIDER_REFRESH_METHOD,
  refreshEngineProviders,
  refreshingChangeWriter,
  refreshingWriter,
  type RefreshTarget,
} from '../../../src/dashboard/providerRefresh';
import { writeModelContextLimit } from '../../../src/dashboard/firstFold';

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

// The CONTEXT-WINDOW half of the same seam.
//
// THE DEFECT (owner, this morning): the model was picked at 84k, `lms load -c
// 86016` ran, and `writeModelContextLimit` put `context: 86016` in origami.json
// — where it stayed. The running engine had frozen `limit.context` at the 36096
// a smaller earlier load left behind, so the session auto-compacted five times
// in four minutes at ~27.1k, which is `usable()` for a 36096 window. Same shape
// as the API key above: a write nothing tells the engine about.
//
// It cannot ride `refreshingWriter`, which fires after any write that did not
// throw. `writeModelContextLimit` answers `false` for its legitimate no-ops —
// the limit was already right, `onlyWhenUnset` declined to overrule a hand-set
// window, the provider is not configured — and reprobeModel runs on every model
// switch and every status tick, so an unconditional refresh would drop every
// engine's provider caches for nothing, repeatedly.
//
// These drive the REAL writer against a temp XDG dir, for configWriters.test.ts's
// reason: the writer honours XDG_CONFIG_HOME, so a mocked homedir would pass
// just as happily against a defect. The assertion is always "did the engines get
// told", paired with what actually landed in the file.
describe('refreshingChangeWriter — the probed context window', () => {
  let tmp: string;
  let cfgPath: string;
  let savedXdg: string | undefined;

  const seed = (context?: number) => {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({
      provider: {
        lmstudio: {
          name: 'LM Studio',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:1234/v1' },
          models: {
            'qwen3.5-35b': context === undefined ? { name: 'q' } : { name: 'q', limit: { context, output: 0 } },
          },
        },
      },
    }, null, 2) + '\n', 'utf8');
  };
  const persisted = () =>
    JSON.parse(fs.readFileSync(cfgPath, 'utf8')).provider.lmstudio.models['qwen3.5-35b'].limit.context;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-ctx-refresh-'));
    process.env.XDG_CONFIG_HOME = tmp;
    cfgPath = path.join(tmp, 'origami', 'origami.json');
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the owner repro: a stale 36096 rewritten to 86016 tells the engines', async () => {
    seed(36_096);
    const c = client();
    const write = refreshingChangeWriter(writeModelContextLimit, () => [{ client: c, cwd: '/work/repo' }]);

    expect(write('lmstudio', 'qwen3.5-35b', 86_016)).toBe(true);
    expect(persisted()).toBe(86_016);
    await vi.waitFor(() => expect(c.extMethod).toHaveBeenCalledWith(PROVIDER_REFRESH_METHOD, { cwd: '/work/repo' }));
  });

  it('the SECOND probe of the same window tells no one', async () => {
    // reprobeModel runs on every model switch and every status tick. Once the
    // file is right the writer answers false, and a refresh here would be pure
    // cost: dropped SDK clients and a rebuilt provider list for no change.
    seed(86_016);
    const c = client();
    const write = refreshingChangeWriter(writeModelContextLimit, () => [{ client: c, cwd: '/work/repo' }]);

    expect(write('lmstudio', 'qwen3.5-35b', 86_016)).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(c.extMethod).not.toHaveBeenCalled();
  });

  it('onlyWhenUnset declining a hand-set window tells no one either', async () => {
    // refreshModelInfoFor's remote path: the server reports its static maximum
    // and the user has deliberately capped lower. Nothing is written, so there
    // is nothing to tell the engine about.
    seed(65_536);
    const c = client();
    const write = refreshingChangeWriter(writeModelContextLimit, () => [{ client: c, cwd: '/work/repo' }]);

    expect(write('lmstudio', 'qwen3.5-35b', 1_048_576, { onlyWhenUnset: true })).toBe(false);
    expect(persisted()).toBe(65_536);
    await new Promise((r) => setTimeout(r, 10));
    expect(c.extMethod).not.toHaveBeenCalled();
  });

  it('fills a hole and tells the engines — the compaction-off case', async () => {
    // No limit block at all: the engine resolves context 0 and isOverflow()
    // hard-returns false, so auto-compaction is OFF until this lands.
    seed(undefined);
    const c = client();
    const write = refreshingChangeWriter(writeModelContextLimit, () => [{ client: c, cwd: '/work/repo' }]);

    expect(write('lmstudio', 'qwen3.5-35b', 131_072, { onlyWhenUnset: true })).toBe(true);
    expect(persisted()).toBe(131_072);
    await vi.waitFor(() => expect(c.extMethod).toHaveBeenCalledTimes(1));
  });

  it('a writer that THREW tells no one, and the throw still reaches the caller', () => {
    const c = client();
    const write = refreshingChangeWriter(() => { throw new Error('config is corrupt'); }, () => [{ client: c }]);

    expect(() => write()).toThrow('config is corrupt');
    expect(c.extMethod).not.toHaveBeenCalled();
  });
});
