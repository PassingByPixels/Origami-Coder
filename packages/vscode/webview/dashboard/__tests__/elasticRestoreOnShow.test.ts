// elasticRestoreOnShow.test.ts — t-wy2jj3 (epic t-w1r73y, Elastic E10): a parked chat's engine starts again
// the moment the chat comes on screen (its editor tab is shown, the sidebar shows it, the phone opens it), not
// only on the next message, so the restore overlaps typing. Owner decision 2026-09-25.
// t-x3a89j (E12): "on screen" is now FOCUS: the active editor tab, the sidebar's active chat (single view, or the
// grid while the sidebar has keyboard focus), or the phone. A grid tile or a tab that is only visible stays parked.
//
// The REAL window wiring (src/elastic/elasticWindow.ts: the tracker singleton, the sidebar view, the phone focus),
// the REAL tracker, engine views, ParkHost, park/restore mechanics, EngineGate and AcpClient. Only the engine
// process (node:child_process), the ACP SDK and the vscode settings are fakes, as in elasticPark.test.ts. The fake
// connection records every call per process, so "one restore" is counted as spawns and `session/resume` calls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- the engine processes: one fake child per spawn; closing stdin makes it exit ---------------------------
const { spawnMock, children } = vi.hoisted(() => {
  const children: Array<Record<string, any>> = [];
  const spawnMock = vi.fn((_exec: string, _args: string[], _opts: { env: Record<string, string> }) => {
    const { EventEmitter: EE } = require('node:events') as typeof import('node:events');
    const child: any = new EE();
    child.pid = 7000 + children.length;
    child.exitCode = null;
    child.signalCode = null;
    const exit = () => { if (child.exitCode !== null) return; child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0, null)); };
    child.stdin = { end: vi.fn(exit), on() {}, once() {}, write() {} };
    child.stdout = { on() {}, once() {}, pipe() {}, setEncoding() {} };
    child.stderr = null;
    child.kill = vi.fn(exit);
    children.push(child);
    return child;
  });
  return { spawnMock, children };
});
vi.mock('node:child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));
vi.mock('node:stream', () => {
  const Readable = { toWeb: () => ({}) };
  const Writable = { toWeb: () => ({}) };
  return { Readable, Writable, default: { Readable, Writable } };
});

// --- vscode: the elastic settings (read on every pass) and the code-mode setting a spawn reads -------------
const { cfg } = vi.hoisted(() => ({ cfg: { elastic: {} as Record<string, unknown>, codeMode: false } }));
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section?: string) => ({
      get: (key: string) => (section === 'origamicoder.elastic' ? cfg.elastic[key] : key === 'experimentalCodeMode' ? cfg.codeMode : undefined),
    }),
  },
  window: { createOutputChannel: () => ({ appendLine: () => undefined }) },
}));

// --- the ACP connection: one per spawn, recording every call ------------------------------------------------
type Call = { conn: number; method: string; params: any };
const { conns, calls, engine } = vi.hoisted(() => ({
  conns: [] as Array<{ client: any }>,
  calls: [] as Call[],
  /** `resumeHold`: a restore waits here (between the spawn and the end of `session/resume`) until released. */
  engine: { mode: 'build', resumeHold: null as Promise<void> | null },
}));
vi.mock('@agentclientprotocol/sdk', () => {
  const opts = (mode: string) => [
    { id: 'model', type: 'select', currentValue: 'prov/model-a', options: [{ value: 'prov/model-a' }] },
    { id: 'mode', type: 'select', currentValue: mode, options: [{ value: 'build' }, { value: 'plan' }] },
  ];
  class ClientSideConnection {
    private readonly n: number;
    private mode = 'build';
    constructor(factory: (agent: unknown) => unknown) {
      this.n = conns.length;
      conns.push({ client: factory(this) });
    }
    private rec(method: string, params: any) { calls.push({ conn: this.n, method, params }); }
    async initialize() { this.rec('initialize', {}); return { protocolVersion: 1, agentInfo: { version: 't', _meta: { peerName: 'work-1234' } } }; }
    async newSession(p: any) { this.rec('newSession', p); this.mode = engine.mode; return { sessionId: 'ses_new', configOptions: opts(this.mode) }; }
    async loadSession(p: any) {
      this.rec('loadSession', p);
      this.mode = engine.mode;
      const client = conns[this.n]!.client; // a real load replays the transcript
      await client.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } } });
      return { configOptions: opts(this.mode) };
    }
    async resumeSession(p: any) {
      this.rec('resumeSession', p);
      if (engine.resumeHold) await engine.resumeHold;
      this.mode = engine.mode; // resume takes the mode from history, not what the chat switched to
      return { configOptions: opts(this.mode) };
    }
    async setSessionMode(p: any) { this.rec('setSessionMode', p); this.mode = p.modeId; return {}; }
    async setSessionConfigOption(p: any) { this.rec('setSessionConfigOption', p); if (p.configId === 'mode') this.mode = p.value; return { configOptions: opts(this.mode) }; }
    async prompt(p: any) { this.rec('prompt', p); return { stopReason: 'end_turn' }; }
    async cancel(p: any) { this.rec('cancel', p); }
    async extMethod(method: string, params: any) {
      this.rec(method, params);
      if (method === '_elastic_park') return { parked: true, sessionIds: [] };
      if (method === '_elastic_idle_report') return { parkable: false, reasons: ['turn-running'] };
      return { ok: true };
    }
  }
  const ndJsonStream = () => ({});
  class RequestError extends Error { static methodNotFound(m: string) { return new RequestError(m); } }
  return { PROTOCOL_VERSION: 1, ndJsonStream, ClientSideConnection, RequestError, default: { PROTOCOL_VERSION: 1, ndJsonStream, ClientSideConnection, RequestError } };
});

import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { EngineGate } from '../../../src/dashboard/engineGate';
import { ParkHost } from '../../../src/elastic/parkHost';
import { attachPanelElastic, elastic, pokeElastic, setPhoneFocus, setSidebarChat, setSidebarFocus, watchChatView } from '../../../src/elastic/elasticWindow';
import type { PanelSignals } from '../../../src/elastic/sessionSignals';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One tracker pass (debounced 250 ms after a poke) and the restore steps after it. */
async function pass() {
  await sleep(320);
  for (let i = 0; i < 30; i++) await sleep(0);
}

/** One chat as DashboardPanel builds it (the Session fields the tracker and ParkHost read). */
function newChat(id: string, n: number) {
  const rows: string[] = [];
  const handlers = {
    onUserMessageChunk: (t: string) => rows.push(`user:${t}`),
    onAgentMessageChunk: (t: string) => rows.push(`agent:${t}`),
    onClose: (reason: string) => { gate.exited(reason); },
    onError: vi.fn(),
  } as unknown as AcpEventHandlers;
  const client = new AcpClient(handlers);
  const gate = new EngineGate(() => undefined);
  return { id, number: n, kind: 'chat' as const, client, gate, rows, turnBusy: false, pendingPermissions: new Set<string>(), runningChildren: new Set<string>() };
}
type Chat = ReturnType<typeof newChat>;

// --- the window: chats, their tabs, the sidebar view, and the panel signals DashboardPanel hands the tracker ---
let sessions: Map<string, Chat>;
let tabs: Map<string, { visible: boolean; active: boolean }>;
let active: string | null;
let grid: boolean;
let removedStandIns: string[];
let host: ParkHost;
let detach: { dispose(): void };
const sidebar = { visible: false, fire: [] as Array<() => void>, gone: [] as Array<() => void> };
const sidebarView = {
  get visible() { return sidebar.visible; },
  onDidChangeVisibility: (l: () => void) => { sidebar.fire.push(l); return { dispose: () => undefined }; },
  onDidDispose: (l: () => void) => { sidebar.gone.push(l); return { dispose: () => undefined }; },
};
const panel: PanelSignals = {
  sessions: () => sessions.values(),
  activeId: () => active,
  grid: () => grid,
  solo: (id) => tabs.get(id),
  question: () => false,
  park: (id) => host.park(id),
  parkSoon: (id) => host.parkSoon(id),
};

const spawns = () => spawnMock.mock.calls.length;
const resumes = (sid: string) => calls.filter((c) => c.method === 'resumeSession' && c.params.sessionId === sid).length;
const methodsOn = (conn: number) => calls.filter((c) => c.conn === conn).map((c) => c.method);

/** A chat reopened from history (session/load), then parked by ParkHost as the tracker does. */
async function parkedChat(id: string, n: number): Promise<Chat> {
  const c = newChat(id, n);
  sessions.set(id, c);
  await c.gate.start(async () => { await c.client.start('/work', undefined, `ses_${id}`); });
  expect(await host.park(id)).toBeNull();
  expect(c.gate.current).toBe('parked');
  return c;
}

/** DashboardPanel.closeSession's order: ParkHost.closed, drop everything held, dispose the client. */
function close(c: Chat) {
  host.closed(c);
  c.gate.drop(true);
  c.client.dispose();
  sessions.delete(c.id);
  tabs.delete(c.id);
  pokeElastic();
}

const show = {
  tab: (c: Chat) => { tabs.set(c.id, { visible: true, active: true }); pokeElastic(); }, // DashboardPanel: onDidChangeViewState -> pokeElastic
  sidebar: (c: Chat) => { active = c.id; setSidebarChat(c.id); sidebar.visible = true; for (const l of sidebar.fire) l(); },
  phone: (c: Chat) => setPhoneFocus(c.id),
};

beforeEach(() => {
  spawnMock.mockClear();
  children.length = 0;
  conns.length = 0;
  calls.length = 0;
  Object.assign(engine, { mode: 'build', resumeHold: null });
  cfg.elastic = {};
  cfg.codeMode = false;
  sessions = new Map();
  tabs = new Map();
  active = null;
  grid = false;
  removedStandIns = [];
  sidebar.visible = false;
  sidebar.fire = [];
  sidebar.gone = [];
  host = new ParkHost({ sessions: () => sessions.values(), log: () => undefined, changed: pokeElastic, watch: () => ({ dispose: () => undefined }), mail: () => false, removeStandIn: (sid) => void removedStandIns.push(sid) });
  watchChatView(sidebarView);
  detach = attachPanelElastic(panel);
});

afterEach(() => {
  for (const l of sidebar.gone) l();
  setPhoneFocus(null);
  setSidebarFocus(false);
  detach.dispose();
  elastic.dispose();
  host.dispose();
  for (const c of sessions.values()) c.client.dispose();
});

describe('a parked chat that comes on screen starts its engine at once (no message needed)', () => {
  for (const where of ['tab', 'sidebar', 'phone'] as const) {
    it(`shown in its ${where === 'tab' ? 'editor tab' : where === 'sidebar' ? 'sidebar view' : 'phone view'}: ONE spawn, ONE session/resume of the same session`, async () => {
      const c = await parkedChat('c1', 1);
      await pass();
      expect(spawns()).toBe(1); // hidden and parked: nothing starts it
      show[where](c);
      await pass();
      expect(spawns()).toBe(2);
      expect(resumes('ses_c1')).toBe(1);
      expect(c.gate.current).toBe('ready');
      expect(c.client.pid).toBeDefined();
      expect(c.client.wake).toBeNull();
      expect(c.rows).toEqual(['user:old question']); // resume replays nothing: the transcript is not doubled
      // More passes while it is on screen start nothing more.
      pokeElastic();
      await pass();
      expect(spawns()).toBe(2);
    });
  }

  it('a message typed during that restore is held, and sent ONCE after it; no second restore', async () => {
    const c = await parkedChat('c1', 1);
    let release: () => void = () => undefined;
    engine.resumeHold = new Promise<void>((r) => { release = r; });
    show.tab(c);
    await pass();
    expect(c.gate.current).toBe('starting'); // the restore runs before any message
    expect(resumes('ses_c1')).toBe(1);
    const turn = c.gate.turn(() => c.client.prompt('typed while it started'));
    await pass();
    expect(calls.filter((x) => x.method === 'prompt')).toEqual([]); // held
    release();
    expect((await turn).sent).toBe(true);
    expect(spawns()).toBe(2);
    expect(resumes('ses_c1')).toBe(1);
    const prompts = calls.filter((x) => x.method === 'prompt');
    expect(prompts.length).toBe(1);
    expect(prompts[0]!.params.sessionId).toBe('ses_c1');
    expect(methodsOn(prompts[0]!.conn).filter((m) => m !== '_elastic_class' && m !== '_elastic_idle_report' && m !== '_elastic_trim')).toEqual(['initialize', 'resumeSession', 'prompt']);
  });

  it('uses the same restore as a message: the env the chat started with, and the /plan mode it had is set again', async () => {
    const c = newChat('c1', 1);
    sessions.set('c1', c);
    await c.gate.start(async () => { await c.client.start('/work', undefined, 'ses_c1'); });
    await c.client.setSessionMode('plan');
    expect(await host.park('c1')).toBeNull();
    cfg.codeMode = true; // changed while parked: a restore keeps the chat's recorded env
    calls.length = 0;
    show.tab(c);
    await pass();
    const env = (i: number) => spawnMock.mock.calls[i]![2].env as Record<string, string>;
    expect(env(1)['ORIGAMI_EXPERIMENTAL_CODE_MODE']).toBeUndefined();
    expect(env(1)['ORIGAMI_AGENT_NAME']).toBe('work-1234');
    expect(calls.find((x) => x.method === 'resumeSession')?.params).toMatchObject({ sessionId: 'ses_c1', cwd: '/work' });
    expect(calls.filter((x) => x.method === 'setSessionConfigOption').map((x) => `${x.params.configId}=${x.params.value}`)).toEqual(['mode=plan']);
    expect(c.client.getModeOption()?.current).toBe('plan');
  });

  it('works with the elastic setting off too (a chat parked before it was turned off)', async () => {
    const c = await parkedChat('c1', 1);
    cfg.elastic = { enabled: false };
    show.phone(c);
    await pass();
    expect(spawns()).toBe(2);
    expect(c.gate.current).toBe('ready');
  });
});

describe('shown, then hidden or closed before the restore ends: no stray engine, no stand-in', () => {
  it('hidden again mid-restore: the restore ends once and the engine is an ordinary tracked chat (background class)', async () => {
    const c = await parkedChat('c1', 1);
    let release: () => void = () => undefined;
    engine.resumeHold = new Promise<void>((r) => { release = r; });
    show.tab(c);
    await pass();
    expect(c.gate.current).toBe('starting');
    tabs.set('c1', { visible: false, active: false });
    pokeElastic();
    await pass();
    release();
    await pass();
    expect(c.gate.current).toBe('ready');
    expect(spawns()).toBe(2);
    expect(resumes('ses_c1')).toBe(1);
    // The tracker owns it again: hidden = background, told to the NEW process; it parks again only after
    // the usual idle + park delay.
    expect(elastic.classOf(c.client)).toBe('background');
    expect(calls.filter((x) => x.method === '_elastic_class' && x.conn === 1).map((x) => x.params.class)).toEqual(['background']);
  });

  it('closed mid-restore: the new engine is stopped, the stand-in removed, nothing starts again', async () => {
    const c = await parkedChat('c1', 1);
    let release: () => void = () => undefined;
    engine.resumeHold = new Promise<void>((r) => { release = r; });
    show.tab(c);
    await pass();
    expect(spawns()).toBe(2);
    close(c);
    release();
    await pass();
    expect(children[1]!.exitCode).not.toBeNull(); // the restored process is gone
    expect(removedStandIns).toContain('ses_c1');
    expect(c.gate.current).not.toBe('ready');
    pokeElastic();
    await pass();
    expect(spawns()).toBe(2);
  });

  it('closed after it was shown but before the tracker pass ran: nothing starts, the stand-in is removed', async () => {
    const c = await parkedChat('c1', 1);
    show.tab(c);
    close(c);
    await pass();
    expect(spawns()).toBe(1);
    expect(removedStandIns).toContain('ses_c1');
  });
});

describe('no restore storm', () => {
  it('ten parked chats: only the ones on screen (tab, sidebar, phone) start, and later passes start no more', async () => {
    const chats: Chat[] = [];
    for (let i = 0; i < 10; i++) chats.push(await parkedChat(`c${i}`, i));
    pokeElastic();
    await pass();
    expect(spawns()).toBe(10); // the ten first starts; none restored while all are hidden
    tabs.set('c3', { visible: true, active: true });
    active = 'c5'; setSidebarChat('c5'); // t-xp0dzr: the sidebar webview displays c5 (its sidebarChat post)
    sidebar.visible = true;
    setPhoneFocus('c8');
    pokeElastic();
    await pass();
    expect(spawns()).toBe(13);
    expect(chats.filter((c) => c.gate.current === 'parked').map((c) => c.id)).toEqual(['c0', 'c1', 'c2', 'c4', 'c6', 'c7', 'c9']);
    for (let i = 0; i < 3; i++) { pokeElastic(); await pass(); }
    expect(spawns()).toBe(13);
  });

  it('a panel attached to a window of parked chats (the tracker starting over) restores only the one on screen', async () => {
    for (let i = 0; i < 6; i++) await parkedChat(`c${i}`, i);
    detach.dispose();
    elastic.dispose();
    tabs.set('c2', { visible: true, active: true });
    detach = attachPanelElastic(panel);
    await pass();
    expect(spawns()).toBe(7);
    expect(sessions.get('c2')!.gate.current).toBe('ready');
    expect([...sessions.values()].filter((c) => c.gate.current === 'parked').length).toBe(5);
  });
});

describe('t-x3a89j: the grid console (sidebar open in grid mode all day): restore on FOCUS, never for a visible tile', () => {
  it('a grid of 6 parked chats restores none while the sidebar has no focus; focusing the sidebar restores its active tile; a click on another tile restores that one', async () => {
    for (let i = 0; i < 6; i++) await parkedChat(`c${i}`, i);
    grid = true;
    active = 'c2'; setSidebarChat('c2'); // t-xp0dzr: the grid's active tile, as the sidebar webview reports it
    sidebar.visible = true;
    for (const l of sidebar.fire) l();
    await pass();
    expect(spawns()).toBe(6); // every tile visible, none focused: nothing restored
    setSidebarFocus(true); // DashboardPanel: `chatFocus` from the sidebar webview
    await pass();
    expect(spawns()).toBe(7);
    expect(sessions.get('c2')!.gate.current).toBe('ready');
    active = 'c4'; setSidebarChat('c4'); // a click on tile c4: activeSessionChanged + sidebarChat (t-xp0dzr), then a pass
    pokeElastic();
    await pass();
    expect(spawns()).toBe(8);
    expect([...sessions.values()].filter((c) => c.gate.current === 'parked').map((c) => c.id)).toEqual(['c0', 'c1', 'c3', 'c5']);
    expect(resumes('ses_c2')).toBe(1);
    expect(resumes('ses_c4')).toBe(1);
  });

  it('an editor tab that is visible in another group but is not the active editor does not restore; making it active does', async () => {
    const c = await parkedChat('c1', 1);
    tabs.set('c1', { visible: true, active: false });
    pokeElastic();
    await pass();
    expect(spawns()).toBe(1);
    show.tab(c);
    await pass();
    expect(spawns()).toBe(2);
    expect(c.gate.current).toBe('ready');
  });
});
