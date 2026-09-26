// t-w2u2ki (Elastic E6) — the window's warm spare engine (src/elastic/warmSpare.ts, warmSpareWindow.ts,
// spawnPin.ts, and the spawn env in acpClient.ts). The bugs each block catches:
//
// - S2: a spare started before a spawn-time setting changed is adopted anyway, so the new chat runs with
//   the OLD env (code mode, side quests...) and sends bytes a fresh engine would not;
// - the spare's events (or its exit) reach a chat before adoption, or reach a chat other than the one
//   that adopted it;
// - the spare is adopted by a history reopen, a fork, a headless agent session or another folder;
// - the spare runs at normal priority untrimmed while it waits, or stays idle-class after adoption;
// - the replacement spawns at adoption and competes with the new chat, or never comes;
// - an older engine that ignores ORIGAMI_SPARE is kept (it registered as a peer at boot);
// - the window still spawns and closes a throw-away boot chat.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let settings: Record<string, unknown> = {};
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section?: string) => ({ get: (key: string) => settings[section ? `${section}.${key}` : key] }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  },
  window: { createOutputChannel: () => ({ appendLine: () => undefined }) },
}));

import { bootWindow, FIRST_TRIM_MS, MAX_FAILURES, REPLACE_DELAY_MS, SPARE_ENV, switchableHandlers, WarmSpare, type SpareClient, type WarmSpareDeps } from '../../../src/elastic/warmSpare';
import { spawnDigest, warmSpareEnabled } from '../../../src/elastic/warmSpareWindow';
import { pinnedSpawnEnv } from '../../../src/elastic/spawnPin';
import { attachPanelElastic, chatTurnRunning, noteEngineStatus, onTurnSettled } from '../../../src/elastic/elasticWindow';
import type { AcpEventHandlers } from '../../../src/acpClient';

const CWD = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';

class FakeEngine implements SpareClient {
  static all: FakeEngine[] = [];
  static nextPid = 100;
  readonly pid = FakeEngine.nextPid++;
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  connected: { cwd: string; headless?: boolean; extraEnv?: Record<string, string> } | null = null;
  disposed = 0;
  /** What `_elastic_spare` answers: an older engine throws -32601. */
  spareAnswer: () => Record<string, unknown> = () => ({ spare: true, adopted: false });
  constructor(readonly handlers: AcpEventHandlers) { FakeEngine.all.push(this); }
  async connect(cwd: string, headless?: boolean, extraEnv?: Record<string, string>) { this.connected = { cwd, headless, extraEnv }; }
  async extMethod(method: string, params?: Record<string, unknown>) {
    this.calls.push({ method, params });
    if (method === '_elastic_spare') return this.spareAnswer();
    if (method === '_elastic_trim') return { trimmed: true };
    return {};
  }
  dispose() { this.disposed++; }
  methods() { return this.calls.map((c) => (c.params?.['class'] ? `${c.method}:${String(c.params['class'])}` : c.method)); }
}

/** A manual clock: timers run only when the test advances time. */
function clock() {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let id = 0;
  return {
    setTimer: (fn: () => void, ms: number) => { const t = { at: now + ms, fn, id: ++id }; timers.push(t); return t.id; },
    clearTimer: (h: unknown) => { timers = timers.filter((t) => t.id !== h); },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
        await flush();
      }
      now = end;
    },
  };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function chatHandlers(): AcpEventHandlers & { seen: string[] } {
  const seen: string[] = [];
  const h = {
    seen,
    onAgentMessageChunk: (text: string) => { seen.push(`text:${text}`); },
    onAgentImageChunk: () => { seen.push('image'); },
    onClose: (reason: string) => { seen.push(`close:${reason}`); },
    onError: (message: string) => { seen.push(`error:${message}`); },
  };
  return h as unknown as AcpEventHandlers & { seen: string[] };
}

function setup(over: Partial<WarmSpareDeps<FakeEngine>> = {}) {
  const c = clock();
  const state = { enabled: true, lower: true, digest: 'd1', busy: false, raised: [] as number[], log: [] as string[] };
  const spare = new WarmSpare<FakeEngine>({
    make: (h) => new FakeEngine(h),
    enabled: () => state.enabled,
    turnRunning: () => state.busy,
    lower: () => state.lower,
    digest: () => state.digest,
    retrimMs: () => 600_000,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    raise: (pid) => { state.raised.push(pid); },
    log: (l) => { state.log.push(l); },
    ...over,
  });
  return { spare, clock: c, state };
}

beforeEach(() => {
  FakeEngine.all = [];
  settings = {};
});

describe('the spare while it waits', () => {
  it('connects with ORIGAMI_SPARE as a chat engine, drops to idle and is trimmed, then re-trimmed', async () => {
    const { spare, clock } = setup();
    const client = await spare.start(CWD);
    expect(client).toBe(FakeEngine.all[0]);
    expect(client!.connected).toEqual({ cwd: CWD, headless: false, extraEnv: { ...SPARE_ENV } });
    expect(client!.methods()).toEqual(['_elastic_spare', '_elastic_class:idle']);
    await clock.advance(FIRST_TRIM_MS);
    expect(client!.methods().filter((m) => m === '_elastic_trim')).toHaveLength(1);
    await clock.advance(600_000);
    expect(client!.methods().filter((m) => m === '_elastic_trim')).toHaveLength(2);
  });

  it('with the elastic classes off it waits at normal priority and is never trimmed', async () => {
    const { spare, clock, state } = setup();
    state.lower = false;
    const client = await spare.start(CWD);
    await clock.advance(FIRST_TRIM_MS * 100);
    expect(client!.methods()).toEqual(['_elastic_spare']);
  });

  it('an older engine that does not wait as a spare is stopped, and no spare is tried again in this window', async () => {
    const { spare, clock } = setup({ make: (h) => { const e = new FakeEngine(h); e.spareAnswer = () => { throw Object.assign(new Error('Method not found'), { code: -32601 }); }; return e; } });
    expect(await spare.start(CWD)).toBeUndefined();
    expect(FakeEngine.all[0].disposed).toBe(1);
    spare.turnSettled();
    await clock.advance(REPLACE_DELAY_MS * 10);
    expect(FakeEngine.all).toHaveLength(1);
  });

  it('a spare whose engine exits while it waits is dropped, and the exit reaches no chat', async () => {
    const { spare } = setup();
    const client = (await spare.start(CWD))!;
    client.handlers.onClose('origami-acp exited (code=1, signal=null)');
    const chat = chatHandlers();
    expect(spare.take({ cwd: CWD }, chat)).toBeUndefined();
    expect(chat.seen).toEqual([]);
  });

  it('spares that keep failing stop after MAX_FAILURES in a row (no respawn after every turn)', async () => {
    const { spare, clock } = setup({ make: (h) => { const e = new FakeEngine(h); e.connect = async () => { throw new Error('spawn ENOENT'); }; return e; } });
    await spare.start(CWD);
    for (let i = 0; i < 10; i++) { spare.turnSettled(); await clock.advance(REPLACE_DELAY_MS); }
    expect(FakeEngine.all).toHaveLength(MAX_FAILURES);
  });

  it('the setting OFF starts no spare, and turning it off drops the one that waits', async () => {
    const { spare, state } = setup();
    state.enabled = false;
    expect(await spare.start(CWD)).toBeUndefined();
    expect(FakeEngine.all).toHaveLength(0);
    state.enabled = true;
    const client = (await spare.start(CWD))!;
    state.enabled = false;
    spare.refresh();
    expect(client.disposed).toBe(1);
    expect(spare.current()).toBeUndefined();
  });
});

describe('adoption', () => {
  it('a new chat in the folder adopts the ready spare; it is raised to active from outside and told, and trims stop', async () => {
    const { spare, clock, state } = setup();
    const client = (await spare.start(CWD))!;
    const chat = chatHandlers();
    expect(spare.take({ cwd: CWD, kind: 'chat' }, chat)).toBe(client);
    expect(state.raised).toEqual([client.pid]);
    expect(client.methods()).toContain('_elastic_class:active');
    const before = client.methods().length;
    await clock.advance(FIRST_TRIM_MS * 100);
    expect(client.methods().length).toBe(before);
  });

  // t-y4x518: in the 0.4.179 UAT the pane's first call reached the spare before session/new adopted it;
  // that call booted an instance which the adoption then disposed. The engine starts the adoption at
  // `_elastic_adopt` and holds the chat's calls until it ends, so take() must send it before it hands out
  // the client, after the class (the class answers at once; the adoption waits for its held work).
  it('take() sends the class and then the adoption signal before the chat can send anything', async () => {
    const { spare } = setup();
    const client = (await spare.start(CWD))!;
    const sent = client.methods().length;
    spare.take({ cwd: CWD, kind: 'chat' }, chatHandlers());
    expect(client.methods().slice(sent)).toEqual(['_elastic_class:active', '_elastic_adopt']);
  });

  it('with the elastic classes off, take() still sends the adoption signal (and no class)', async () => {
    const { spare, state } = setup();
    state.lower = false;
    const client = (await spare.start(CWD))!;
    spare.take({ cwd: CWD, kind: 'chat' }, chatHandlers());
    expect(client.methods()).toEqual(['_elastic_spare', '_elastic_adopt']);
  });

  it('routes events to the adopting chat only: nothing before adoption, nothing to a later chat', async () => {
    const { spare } = setup();
    const client = (await spare.start(CWD))!;
    // Before adoption: the sink swallows, nothing throws.
    expect(() => client.handlers.onAgentMessageChunk('early')).not.toThrow();
    const a = chatHandlers();
    const b = chatHandlers();
    spare.take({ cwd: CWD }, a);
    expect(spare.take({ cwd: CWD }, b)).toBeUndefined(); // one spare, one chat
    client.handlers.onAgentMessageChunk('hello');
    client.handlers.onClose('exit');
    expect(a.seen).toEqual(['text:hello', 'close:exit']);
    expect(b.seen).toEqual([]);
    // A handler the chat does not have reads as absent, as on a client built with it.
    expect(client.handlers.onUsageUpdate).toBeUndefined();
  });

  it.each([
    ['a history reopen', { cwd: CWD, load: true }],
    ['a fork', { cwd: CWD, fork: true }],
    ['a headless agent session', { cwd: CWD, kind: 'agent' as const }],
    ['a chat in another folder', { cwd: process.platform === 'win32' ? 'C:\\work\\other' : '/work/other' }],
  ])('%s does not adopt the spare, and the spare keeps waiting', async (_name, req) => {
    const { spare } = setup();
    const client = (await spare.start(CWD))!;
    expect(spare.take(req, chatHandlers())).toBeUndefined();
    expect(spare.current()).toBe(client);
    expect(client.disposed).toBe(0);
  });

  it('a spare still starting is not adopted (the chat spawns its own engine)', async () => {
    let release!: () => void;
    const { spare } = setup({ make: (h) => { const e = new FakeEngine(h); e.connect = (cwd, headless, extraEnv) => new Promise<void>((r) => { release = () => { e.connected = { cwd, headless, extraEnv }; r(); }; }); return e; } });
    const pending = spare.start(CWD);
    expect(spare.take({ cwd: CWD }, chatHandlers())).toBeUndefined();
    release();
    expect(await pending).toBe(FakeEngine.all[0]);
  });

  it('S2: a spawn-time setting changed since the spare started refuses adoption and replaces the spare', async () => {
    const { spare, clock, state } = setup();
    const old = (await spare.start(CWD))!;
    state.digest = 'd2'; // e.g. origami.experimentalCodeMode turned on
    expect(spare.take({ cwd: CWD }, chatHandlers())).toBeUndefined();
    expect(old.disposed).toBe(1);
    // Replaced lazily: after the new chat's turn settles, not while it starts.
    expect(FakeEngine.all).toHaveLength(1);
    spare.turnSettled();
    await clock.advance(REPLACE_DELAY_MS);
    const next = FakeEngine.all[1];
    expect(next.connected?.extraEnv).toEqual({ ...SPARE_ENV });
    expect(spare.take({ cwd: CWD }, chatHandlers())).toBe(next);
  });

  it('a settings change drops a spare the new values no longer match and starts its replacement', async () => {
    const { spare, clock, state } = setup();
    const old = (await spare.start(CWD))!;
    spare.refresh(); // an unrelated change: kept
    expect(old.disposed).toBe(0);
    state.digest = 'd2';
    spare.refresh();
    expect(old.disposed).toBe(1);
    await clock.advance(REPLACE_DELAY_MS);
    expect(FakeEngine.all).toHaveLength(2);
    expect(spare.take({ cwd: CWD }, chatHandlers())).toBe(FakeEngine.all[1]);
  });
});

describe('replacement', () => {
  it('starts only after a turn settles, once, in the window folder', async () => {
    const { spare, clock } = setup();
    await spare.start(CWD);
    spare.take({ cwd: CWD }, chatHandlers());
    await clock.advance(60 * 60_000);
    expect(FakeEngine.all).toHaveLength(1); // adoption alone spawns nothing
    spare.turnSettled();
    spare.turnSettled();
    await clock.advance(REPLACE_DELAY_MS - 1);
    expect(FakeEngine.all).toHaveLength(1);
    await clock.advance(1);
    expect(FakeEngine.all).toHaveLength(2);
    expect(FakeEngine.all[1].connected?.cwd).toBe(CWD);
    spare.turnSettled(); // one waits already
    await clock.advance(REPLACE_DELAY_MS * 10);
    expect(FakeEngine.all).toHaveLength(2);
  });

  it('a turn that ends (busy -> idle on the host copy of sessionStatus) is what calls turnSettled', () => {
    const settled = vi.fn();
    const sub = onTurnSettled(settled);
    const engine = {};
    noteEngineStatus(engine, 'idle'); // a status that was never busy is not a turn end
    noteEngineStatus(engine, 'busy');
    expect(settled).not.toHaveBeenCalled();
    noteEngineStatus(engine, 'idle');
    expect(settled).toHaveBeenCalledTimes(1);
    sub.dispose();
    noteEngineStatus(engine, 'busy');
    noteEngineStatus(engine, 'idle');
    expect(settled).toHaveBeenCalledTimes(1);
  });
});

describe('window boot (the throw-away boot chat is gone)', () => {
  function boot(hasOpenSet: boolean, restored: boolean, enabled = true) {
    const { spare, state } = setup();
    state.enabled = enabled;
    const chats: string[] = [];
    const closed: string[] = [];
    const probes: Array<FakeEngine | undefined> = [];
    const run = bootWindow({
      spare,
      cwd: CWD,
      hasOpenSet,
      newChat: async () => {
        const id = `session-${chats.length + 1}`;
        chats.push(id);
        // createSession: a new chat adopts the spare when one waits, else spawns.
        spare.take({ cwd: CWD }, chatHandlers()) ?? new FakeEngine(chatHandlers());
        return id;
      },
      clientOf: () => FakeEngine.all.at(-1),
      restore: async (probe) => { probes.push(probe); return hasOpenSet && restored; },
      close: (id) => { closed.push(id); },
    });
    return { run, chats, closed, probes, spare };
  }

  it('with a persisted open set: the spare is the probe, no chat is spawned or closed, and the spare stays', async () => {
    const b = boot(true, true);
    expect(await b.run).toBe(true);
    expect(b.chats).toEqual([]);
    expect(b.closed).toEqual([]);
    expect(FakeEngine.all).toHaveLength(1); // the spare, and nothing else, at window start
    expect(b.probes).toEqual([FakeEngine.all[0]]);
    expect(b.spare.current()).toBe(FakeEngine.all[0]);
  });

  it('with an open set that restores nothing: one new chat, which adopts the spare (still one engine)', async () => {
    const b = boot(true, false);
    expect(await b.run).toBe(false);
    expect(b.chats).toEqual(['session-1']);
    expect(FakeEngine.all).toHaveLength(1);
    expect(b.spare.current()).toBeUndefined();
  });

  it('with no open set: the first chat is a real one and no spare starts at window start', async () => {
    const b = boot(false, false);
    await b.run;
    expect(b.chats).toEqual(['session-1']);
    expect(b.closed).toEqual([]);
    expect(FakeEngine.all).toHaveLength(1);
    expect(b.spare.current()).toBeUndefined();
  });

  it('with the setting off: the old path (boot chat as the probe, closed after a clean restore)', async () => {
    const b = boot(true, true, false);
    expect(await b.run).toBe(true);
    expect(b.chats).toEqual(['session-1']);
    expect(b.closed).toEqual(['session-1']);
  });
});

describe('spawn values', () => {
  it('the digest moves when a spawn-time setting moves, and only then', () => {
    const a = spawnDigest(CWD);
    expect(spawnDigest(CWD)).toBe(a);
    settings['origami.experimentalCodeMode'] = true;
    const b = spawnDigest(CWD);
    expect(b).not.toBe(a);
    settings['origami.experimentalSideQuests'] = false; // side quests off: another overlay flag
    expect(spawnDigest(CWD)).not.toBe(b);
    expect(spawnDigest(CWD + 'x')).not.toBe(spawnDigest(CWD));
  });

  it('the digest covers the host env the engine inherits (LANG, TZ)', () => {
    const a = spawnDigest(CWD);
    const saved = process.env['LANG'];
    process.env['LANG'] = saved === 'sv_SE.UTF-8' ? 'en_US.UTF-8' : 'sv_SE.UTF-8';
    try {
      expect(spawnDigest(CWD)).not.toBe(a);
    } finally {
      if (saved === undefined) delete process.env['LANG']; else process.env['LANG'] = saved;
    }
    expect(spawnDigest(CWD)).toBe(a);
  });

  it('TZ is pinned to the host zone unless the host env already sets one', () => {
    expect(pinnedSpawnEnv({}, 'Europe/Amsterdam')).toEqual({ TZ: 'Europe/Amsterdam' });
    expect(pinnedSpawnEnv({}, 'UTC')).toEqual({ TZ: 'UTC' });
    expect(pinnedSpawnEnv({ TZ: 'Asia/Tokyo' }, 'Europe/Amsterdam')).toEqual({});
    expect(pinnedSpawnEnv({}, 'Etc/Unknown')).toEqual({});
    expect(pinnedSpawnEnv({}, '')).toEqual({});
  });

  it('origamicoder.elastic.warmSpare is on by default', () => {
    expect(warmSpareEnabled()).toBe(true);
    settings['origamicoder.elastic.warmSpare'] = false;
    expect(warmSpareEnabled()).toBe(false);
  });

  it('switchableHandlers: the sink answers before the switch, the target after', () => {
    const closes: string[] = [];
    const route = switchableHandlers({ onClose: (r) => { closes.push(r); } });
    route.handlers.onClose('a');
    expect(() => route.handlers.onToolCallStart({} as never)).not.toThrow();
    const chat = chatHandlers();
    route.to(chat);
    route.handlers.onClose('b');
    expect(closes).toEqual(['a']);
    expect(chat.seen).toEqual(['close:b']);
  });
});

// t-xmulzj (owner UAT of 0.4.178): turning the setting back on started no spare until some turn settled, and the drop
// line said "pid ?". The bugs: a window with no working chat keeps cold-starting its next chat after a re-enable; a
// re-enable while a chat works starts a spare that competes with it; the drop line cannot be tied to a process.
describe('t-xmulzj: the setting turned back on, and the drop line', () => {
  /** An engine whose pid goes when it is disposed, as AcpClient's does (`child` is cleared). */
  class GoneEngine extends FakeEngine {
    constructor(handlers: AcpEventHandlers) {
      super(handlers);
      const own = this.pid;
      Object.defineProperty(this, 'pid', { get: () => (this.disposed > 0 ? undefined : own) });
    }
  }

  it('off -> on while no chat turn runs: one spare starts within REPLACE_DELAY_MS, with no message sent', async () => {
    const { spare, clock, state } = setup();
    await spare.start(CWD);
    state.enabled = false;
    spare.refresh();
    expect(spare.current()).toBeUndefined();
    state.enabled = true;
    spare.refresh();
    spare.refresh(); // a second settings event in the same burst starts no second spare
    await clock.advance(REPLACE_DELAY_MS);
    expect(FakeEngine.all).toHaveLength(2);
    expect(spare.current()).toBe(FakeEngine.all[1]);
    expect(state.log.at(-1)).toBe(`[spare] pid ${FakeEngine.all[1].pid} waits for a new chat in ${CWD}`);
  });

  it('off -> on while a chat turn runs: no spare until that turn settles', async () => {
    const { spare, clock, state } = setup();
    await spare.start(CWD);
    state.enabled = false;
    spare.refresh();
    state.busy = true;
    state.enabled = true;
    spare.refresh();
    await clock.advance(60 * 60_000);
    expect(FakeEngine.all).toHaveLength(1); // nothing competes with the working chat
    state.busy = false;
    spare.turnSettled();
    await clock.advance(REPLACE_DELAY_MS);
    expect(FakeEngine.all).toHaveLength(2);
  });

  it('a settings change while the setting stays on starts nothing: after an adoption the replacement still waits for a turn', async () => {
    const { spare, clock } = setup();
    await spare.start(CWD);
    spare.take({ cwd: CWD }, chatHandlers());
    spare.refresh(); // some other origamicoder.* setting moved while the new chat starts
    await clock.advance(60 * 60_000);
    expect(FakeEngine.all).toHaveLength(1);
  });

  it('the window reads "a chat turn runs" off the attached panel: a host-awaited prompt or an engine-reported turn', () => {
    const quiet = { id: 'session-1', client: { extMethod: async () => ({}) }, gate: { current: 'ready' }, pendingPermissions: { size: 0 }, runningChildren: { size: 0 } };
    const working = { ...quiet, id: 'session-2', client: { extMethod: async () => ({}) } };
    const list: Array<typeof quiet & { turnBusy?: boolean }> = [quiet, working];
    const sub = attachPanelElastic({ sessions: () => list, activeId: () => null, grid: () => false, solo: () => undefined, question: () => false });
    expect(chatTurnRunning()).toBe(false);
    noteEngineStatus(working.client, 'busy');
    expect(chatTurnRunning()).toBe(true);
    noteEngineStatus(working.client, 'idle');
    list[0] = { ...quiet, turnBusy: true };
    expect(chatTurnRunning()).toBe(true);
    sub.dispose();
    expect(chatTurnRunning()).toBe(false); // no panel: no chat can be working
  });

  it('the drop line names the real pid of the dropped spare, never "pid ?"', async () => {
    const { spare, state } = setup({ make: (h) => new GoneEngine(h) });
    const client = (await spare.start(CWD))!;
    const pid = client.pid!;
    expect(pid).toBeTypeOf('number');
    state.enabled = false;
    spare.refresh();
    expect(client.disposed).toBe(1);
    expect(state.log.at(-1)).toBe(`[spare] pid ${pid} dropped: the warm spare setting is off`);
  });
});
