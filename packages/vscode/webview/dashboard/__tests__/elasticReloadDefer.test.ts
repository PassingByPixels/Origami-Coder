// elasticReloadDefer.test.ts — t-wypna7 (epic t-w1r73y, owner decision 2026-09-25, option A): at a window reload the
// chats of the open set come back WITHOUT their engines. Only a chat in focus (inFocus / phone, sessionSignals.ts)
// starts at once; every other one starts on its first focus, message, peer mail, /loop run or direct client call, with
// the same `session/load` a reload makes today. Until then its pane shows "Loading chat history…".
//
// The REAL DashboardPanel.createSession and rearmPersistedLoops run over the panel's own prototype (the
// pillsMountRace / remotePanelHarness pattern), with the REAL restoreOpenSet, EngineGate, AcpClient, ParkHost,
// reloadDefer and window tracker (elasticWindow.ts). Only the engine process (node:child_process), the ACP SDK and
// vscode are fakes, as in elasticRestoreOnShow.test.ts; the fake connection records every call per process.

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

// --- vscode: the elastic settings (read on every pass) and the peer-name setting ---------------------------
const { cfg } = vi.hoisted(() => ({ cfg: { elastic: {} as Record<string, unknown>, agentName: '' } }));
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section?: string) => ({
      get: (key: string) => (section === 'origamicoder.elastic' ? cfg.elastic[key] : section === 'origami' && key === 'agentName' ? cfg.agentName : undefined),
    }),
  },
  window: { createOutputChannel: () => ({ appendLine: () => undefined }), showWarningMessage: () => Promise.resolve(undefined), showInformationMessage: () => Promise.resolve(undefined) },
}));

// --- the ACP connection: one per spawn, recording every call ------------------------------------------------
type Call = { conn: number; method: string; params: any };
const { conns, calls, engine } = vi.hoisted(() => ({
  conns: [] as Array<{ client: any }>,
  calls: [] as Call[],
  engine: { failLoad: false },
}));
vi.mock('@agentclientprotocol/sdk', () => {
  const opts = () => [
    { id: 'model', type: 'select', currentValue: 'prov/model-a', options: [{ value: 'prov/model-a' }] },
    { id: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build' }, { value: 'plan' }] },
  ];
  class ClientSideConnection {
    private readonly n: number;
    constructor(factory: (agent: unknown) => unknown) {
      this.n = conns.length;
      conns.push({ client: factory(this) });
    }
    private rec(method: string, params: any) { calls.push({ conn: this.n, method, params }); }
    async initialize() { this.rec('initialize', {}); return { protocolVersion: 1, agentInfo: { version: 't', _meta: { peerName: 'work-1234' } } }; }
    async newSession(p: any) { this.rec('newSession', p); return { sessionId: 'ses_new', configOptions: opts() }; }
    async loadSession(p: any) {
      this.rec('loadSession', p);
      if (engine.failLoad) throw new Error('load refused');
      const client = conns[this.n]!.client; // a real load replays the transcript
      await client.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `question in ${p.sessionId}` } } });
      await client.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer in ${p.sessionId}` } } });
      return { configOptions: opts() };
    }
    async resumeSession(p: any) { this.rec('resumeSession', p); return { configOptions: opts() }; }
    async setSessionConfigOption(p: any) { this.rec('setSessionConfigOption', p); return { configOptions: opts() }; }
    async prompt(p: any) { this.rec('prompt', p); return { stopReason: 'end_turn' }; }
    async cancel(p: any) { this.rec('cancel', p); }
    async extMethod(method: string, params: any) {
      this.rec(method, params);
      if (method === '_elastic_idle_report') return { parkable: false, reasons: ['turn-running'] };
      return { ok: true };
    }
  }
  const ndJsonStream = () => ({});
  class RequestError extends Error { static methodNotFound(m: string) { return new RequestError(m); } }
  return { PROTOCOL_VERSION: 1, ndJsonStream, ClientSideConnection, RequestError, default: { PROTOCOL_VERSION: 1, ndJsonStream, ClientSideConnection, RequestError } };
});

import { DashboardPanel } from '../../../src/dashboard/DashboardPanel';
import { restoreOpenSet, computeOpenSet } from '../../../src/dashboard/agentManager/sessionRestore';
import { ParkHost } from '../../../src/elastic/parkHost';
import type { StandIn } from '../../../src/elastic/parkedMail';
import { deferAtReload } from '../../../src/elastic/reloadDefer';
import * as elasticWindow from '../../../src/elastic/elasticWindow';
import { attachPanelElastic, elastic, pokeElastic, setPhoneFocus, setSidebarFocus, watchChatView } from '../../../src/elastic/elasticWindow';
import type { PanelSignals } from '../../../src/elastic/sessionSignals';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One tracker pass (debounced 250 ms after a poke) and the start steps after it. */
async function pass() {
  await sleep(320);
  for (let i = 0; i < 30; i++) await sleep(0);
}
async function settle() {
  for (let i = 0; i < 30; i++) await sleep(0);
}

const spawns = () => spawnMock.mock.calls.length;
const loads = (sid?: string) => calls.filter((c) => c.method === 'loadSession' && (!sid || c.params.sessionId === sid)).length;

type Post = Record<string, any>;
type AnySession = Record<string, any>;

function memento(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  return { get: <T>(k: string, d?: T) => (store.has(k) ? (store.get(k) as T) : d), update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); }, keys: () => [...store.keys()], store };
}

// --- the window around the panel: tabs, sidebar view, stand-ins and mail (no real ~/.origami) ---------------
let tabs: Map<string, { visible: boolean; active: boolean }>;
let standIns: StandIn[];
let removedStandIns: string[];
let mailbox: Set<string>;
let onMail: (sid: string) => void;
let detach: { dispose(): void };
const sidebar = { visible: false, fire: [] as Array<() => void>, gone: [] as Array<() => void> };
const sidebarView = {
  get visible() { return sidebar.visible; },
  onDidChangeVisibility: (l: () => void) => { sidebar.fire.push(l); return { dispose: () => undefined }; },
  onDidDispose: (l: () => void) => { sidebar.gone.push(l); return { dispose: () => undefined }; },
};

/** DashboardPanel over its own prototype, with what createSession / rearmPersistedLoops read. */
function panelRig(workspace: Record<string, unknown> = {}) {
  const posts: Post[] = [];
  const p = Object.create(DashboardPanel.prototype) as Record<string, any>;
  Object.defineProperty(p, 'cwd', { value: '/work/proj' });
  p['sessions'] = new Map<string, AnySession>();
  p['activeSessionId'] = null;
  p['pendingRestoreSessionId'] = null;
  p['pendingQuestionPermissions'] = new Map();
  p['subagentTodoPullers'] = new Map();
  p['sidebarGridMode'] = false;
  p['restoring'] = false;
  p['context'] = { extensionUri: { fsPath: process.cwd() }, extension: { packageJSON: { version: 'harness' } }, globalState: memento(), workspaceState: memento(workspace) };
  p['post'] = (m: Post) => { posts.push(m); pokeElastic(); }; // the real post() pokes the tracker too
  p['broadcastModelStatus'] = () => undefined;
  p['sessionValidWindow'] = () => 0;
  p['resolveEngineUrl'] = () => undefined;
  p['adoptLoadedModel'] = async () => undefined;
  p['pollControllerState'] = async () => undefined;
  p['parking'] = new ParkHost({
    sessions: () => (p['sessions'] as Map<string, AnySession>).values() as never,
    log: () => undefined,
    changed: pokeElastic,
    watch: (cb) => { onMail = cb; return { dispose: () => undefined }; },
    mail: (sid) => mailbox.has(sid),
    removeStandIn: (sid) => void removedStandIns.push(sid),
    writeStandIn: (s) => { standIns.push({ version: 1, parked: true, ...s }); return true; },
  });
  // MIRROR of DashboardPanel's constructor `elasticPanel` (the constructor does not run over a prototype).
  const signals: PanelSignals = {
    sessions: () => (p['sessions'] as Map<string, AnySession>).values() as never,
    activeId: () => p['activeSessionId'],
    grid: () => p['sidebarGridMode'],
    solo: (id) => tabs.get(id),
    question: () => false,
    park: (id) => p['parking'].park(id),
    parkSoon: (id) => p['parking'].parkSoon(id),
    booting: () => p['restoring'],
  };
  detach = attachPanelElastic(signals);
  const sessions = () => [...(p['sessions'] as Map<string, AnySession>).entries()];
  const byEngine = (sid: string) => sessions().find(([, s]) => s.client.currentSessionId === sid)?.[1];
  return {
    p, posts, sessions, byEngine,
    /** MIRROR of DashboardPanel.initialize's reopen loop (bootWindow → restoreOpenSet with the probe's listing). */
    async reload(ids: string[], active: string | null, grid = false) {
      p['restoring'] = true;
      const probe = { listSessions: async () => ids.map((id) => ({ sessionId: id, title: `Title of ${id}` })) };
      const ok = await restoreOpenSet({ open: ids, active, grid }, probe, {
        reopen: (id, title) => (p['createSession'] as Function).call(p, undefined, undefined, id, { defer: deferAtReload(), title }),
        setGrid: (g) => { p['sidebarGridMode'] = g; },
        activate: (localId) => { p['activeSessionId'] = localId; },
      });
      p['restoring'] = false;
      pokeElastic();
      return ok;
    },
    rearmLoops: () => (p['rearmPersistedLoops'] as Function).call(p),
    close: (localId: string) => (p['closeSession'] as Function).call(p, localId),
    postsFor: (localId: string, type: string) => posts.filter((m) => m.sessionId === localId && m.type === type),
  };
}

let rig: ReturnType<typeof panelRig>;

beforeEach(() => {
  spawnMock.mockClear();
  children.length = 0;
  conns.length = 0;
  calls.length = 0;
  engine.failLoad = false;
  cfg.elastic = {};
  cfg.agentName = '';
  tabs = new Map();
  standIns = [];
  removedStandIns = [];
  mailbox = new Set();
  onMail = () => undefined;
  sidebar.visible = false;
  sidebar.fire = [];
  sidebar.gone = [];
  vi.spyOn(DashboardPanel, 'openSessionInEditor').mockResolvedValue(undefined);
  watchChatView(sidebarView);
});

afterEach(() => {
  for (const l of sidebar.gone) l();
  setPhoneFocus(null);
  setSidebarFocus(false);
  sidebarDisplays(null);
  detach?.dispose();
  elastic.dispose();
  rig?.p['parking'].dispose();
  for (const [, s] of rig?.sessions() ?? []) { if (s.loopSchedule) { s.loopSchedule.stopped = true; clearTimeout(s.loopSchedule.timer); } s.client.dispose(); }
  vi.restoreAllMocks();
});

const IDS = ['ses_a', 'ses_b', 'ses_c', 'ses_d'];

/** The sidebar view is visible. */
function sidebarShowsActive() {
  sidebar.visible = true;
  for (const l of sidebar.fire) l();
}
/** The sidebar webview displays chat `localId` (the persisted active one it restores). Today inFocus reads the panel's
 *  active chat; lane t-xp0dzr makes it the chat the webview says it displays (`setSidebarChat`). Both are set here. */
function sidebarDisplays(localId: string | null) {
  (elasticWindow as { setSidebarChat?: (id: string | null) => void }).setSidebarChat?.(localId);
  pokeElastic();
}

describe('reload with N open chats of which 1 is on screen', () => {
  it('starts EXACTLY ONE chat engine: the one in focus, with session/load of its own session', async () => {
    rig = panelRig();
    sidebarShowsActive();
    expect(await rig.reload(IDS, 'ses_b')).toBe(true);
    sidebarDisplays(rig.p['activeSessionId']);
    await pass();
    await pass();
    expect(spawns()).toBe(1);
    expect(loads()).toBe(1);
    expect(loads('ses_b')).toBe(1);
    const b = rig.byEngine('ses_b')!;
    expect(b.gate.current).toBe('ready');
    for (const sid of ['ses_a', 'ses_c', 'ses_d']) expect(rig.byEngine(sid)!.gate.current).toBe('parked');
    // More passes start nothing more while nothing else comes into focus.
    pokeElastic();
    await pass();
    expect(spawns()).toBe(1);
  });

  it('a chat with no view in focus at all: no chat engine starts', async () => {
    rig = panelRig();
    await rig.reload(IDS, 'ses_b'); // sidebar hidden, no editor tab active
    await pass();
    expect(spawns()).toBe(0);
  });

  it('grid console (sidebar visible, keyboard focus elsewhere): the visible tiles stay without an engine', async () => {
    rig = panelRig();
    sidebarShowsActive();
    await rig.reload(IDS, 'ses_c', true);
    sidebarDisplays(rig.p['activeSessionId']);
    await pass();
    expect(spawns()).toBe(0);
    setSidebarFocus(true); // the user clicks into the grid: its active chat is the one worked in
    await pass();
    expect(spawns()).toBe(1);
    expect(loads('ses_c')).toBe(1);
  });

  it('nothing starts DURING the reopen loop, although each new chat is the active one for a moment', async () => {
    rig = panelRig();
    rig.p['restoring'] = true;
    // Each reopened chat opens its editor tab in the active column (openSessionInEditor: createWebviewPanel,
    // ViewColumn.Active), so each is the active editor until the next one opens. The loop is slow (a slow disk):
    // a pass runs between two reopens.
    for (const id of IDS.slice(0, 2)) {
      const localId = await (rig.p['createSession'] as Function).call(rig.p, undefined, undefined, id, { defer: true });
      for (const t of tabs.values()) t.active = false;
      tabs.set(localId, { visible: true, active: true });
      pokeElastic();
      await pass();
    }
    expect(spawns()).toBe(0);
    rig.p['restoring'] = false;
    pokeElastic();
    await pass();
    expect(spawns()).toBe(1); // only the chat active at the end
    expect(loads('ses_b')).toBe(1);
  });

  it('elastic engines off: every chat starts at the reload, as in 0.4.175', async () => {
    cfg.elastic = { enabled: false };
    rig = panelRig();
    await rig.reload(IDS, 'ses_b');
    await settle();
    expect(spawns()).toBe(4);
    expect(loads()).toBe(4);
  });
});

describe('a deferred chat until its engine starts', () => {
  it('shows "Loading chat history…" (history restoring, no rows), is not "starting", and keeps its title', async () => {
    rig = panelRig();
    await rig.reload(IDS, 'ses_b');
    await pass();
    const [localA, a] = rig.sessions().find(([, s]) => s.client.currentSessionId === 'ses_a')!;
    const created = rig.postsFor(localA, 'sessionCreated');
    expect(created.length).toBe(1);
    expect(created[0]!.starting).toBe(false); // the composer does not say "starting": nothing starts yet
    const history = rig.postsFor(localA, 'historyState');
    expect(history.length).toBeGreaterThan(0);
    expect(history.at(-1)!.restoring).toBe(true); // ChatHistoryBar: restoring + no rows = ChatReopenLoading
    expect(a.messageLog).toEqual([]);
    expect(rig.postsFor(localA, 'engineState')).toEqual([]); // no card: not an error
    expect(rig.postsFor(localA, 'system')).toEqual([]);
    expect(rig.postsFor(localA, 'sessionTitle').at(-1)!.title).toBe('Title of ses_a');
    expect(a.title).toBe('Title of ses_a');
  });

  it('keeps its engine session id on the client: the open set still lists every chat, in order', async () => {
    rig = panelRig();
    await rig.reload(IDS, 'ses_b');
    await pass();
    const state = computeOpenSet(rig.sessions() as never, rig.p['activeSessionId'], false);
    expect(state.open).toEqual(IDS);
    expect(state.active).toBe('ses_b');
  });

  it('after its first focus the transcript is complete (the session/load replay) and the loading state ends', async () => {
    rig = panelRig();
    await rig.reload(IDS, 'ses_b');
    await pass();
    const [localC, c] = rig.sessions().find(([, s]) => s.client.currentSessionId === 'ses_c')!;
    tabs.set(localC, { visible: true, active: true });
    pokeElastic();
    await pass();
    expect(c.gate.current).toBe('ready');
    expect(loads('ses_c')).toBe(1);
    expect(c.messageLog.map((m: any) => `${m.kind}:${m.text}`)).toEqual(['user:question in ses_c', 'agent:answer in ses_c']);
    expect(rig.postsFor(localC, 'historyState').at(-1)!.restoring).toBe(false);
    expect(rig.postsFor(localC, 'sessionStarting').at(-1)!.starting).toBe(false);
    // The same start line as today's reload of that chat.
    expect(rig.postsFor(localC, 'system').map((m) => m.text)).toEqual(['Recalled session ses_c. Continue the conversation below.']);
    expect(c.client.wake).toBeNull();
  });

  it('a started chat tells its pane its peer name (the "· Cortex-1234" in the chat header; UAT 0.4.179: it was lost)', async () => {
    rig = panelRig();
    await rig.reload(IDS, 'ses_b');
    await pass();
    const [localC] = rig.sessions().find(([, s]) => s.client.currentSessionId === 'ses_c')!;
    tabs.set(localC, { visible: true, active: true });
    pokeElastic();
    await pass();
    expect(rig.postsFor(localC, 'peerName').map((m) => m.peerName)).toEqual(['work-1234']);
  });

  it('a failed first start shows the reconnect card with Retry, and Retry loads the same session', async () => {
    rig = panelRig();
    await rig.reload(IDS, 'ses_b');
    await pass();
    const [localA, a] = rig.sessions().find(([, s]) => s.client.currentSessionId === 'ses_a')!;
    engine.failLoad = true;
    const turn = a.gate.turn(() => a.client.prompt('hello'));
    await settle();
    expect(a.gate.current).toBe('failed');
    const card = rig.postsFor(localA, 'engineState').at(-1)!;
    expect(card.stage).toBe('failed');
    expect(card.retry).toBe(true);
    expect(a.client.currentSessionId).toBe('ses_a'); // kept through the failure: Retry and the open set need it
    engine.failLoad = false;
    await a.gate.retry();
    expect((await turn).sent).toBe(true);
    expect(loads('ses_a')).toBe(2);
    const prompts = calls.filter((c) => c.method === 'prompt');
    expect(prompts.length).toBe(1);
    expect(prompts[0]!.params.sessionId).toBe('ses_a');
  });
});

describe('a deferred chat starts on a message, peer mail, a /loop run or a direct call', () => {
  it('a message: ONE spawn, ONE session/load, then the prompt ONCE on that engine', async () => {
    rig = panelRig();
    await rig.reload(IDS, 'ses_b');
    await pass();
    const d = rig.byEngine('ses_d')!;
    const turn = await d.gate.turn(() => d.client.prompt('typed into a hidden chat'));
    expect(turn.sent).toBe(true);
    expect(spawns()).toBe(1);
    expect(loads('ses_d')).toBe(1);
    const onD = calls.filter((c) => c.conn === 0).map((c) => c.method).filter((m) => !m.startsWith('_elastic_'));
    expect(onD).toEqual(['initialize', 'loadSession', 'prompt']);
  });

  it('peer mail: a stand-in is written for every deferred chat; mail starts that chat ONCE, however many events land', async () => {
    rig = panelRig();
    await rig.reload(IDS, 'ses_b');
    await pass();
    expect(standIns.map((s) => s.sessionId).sort()).toEqual([...IDS].sort());
    for (const s of standIns) {
      expect(s).toMatchObject({ version: 1, parked: true, name: 'proj', cwd: '/work/proj', kind: 'interactive', hostPid: process.pid });
      expect(typeof s.parkedAt).toBe('number');
    }
    onMail('ses_c');
    onMail('ses_c'); // the watcher fires per file event
    await settle();
    onMail('ses_c');
    await settle();
    expect(spawns()).toBe(1);
    expect(loads('ses_c')).toBe(1); // the engine drains the mailbox once, on this load (engine agent-mailbox.ts restore)
    expect(rig.byEngine('ses_c')!.gate.current).toBe('ready');
    expect(rig.byEngine('ses_a')!.gate.current).toBe('parked');
  });

  it('mail that waited from before the reload starts its chat at the reload', async () => {
    rig = panelRig();
    mailbox.add('ses_d');
    await rig.reload(IDS, 'ses_b');
    await pass();
    expect(spawns()).toBe(1);
    expect(loads('ses_d')).toBe(1);
  });

  it('the origami.agentName setting names the stand-in (the name the engine will register)', async () => {
    cfg.agentName = 'Desk';
    rig = panelRig();
    await rig.reload(['ses_a'], null);
    expect(standIns[0]!.name).toBe('Desk');
  });

  it('closing a deferred chat removes its stand-in and starts nothing', async () => {
    rig = panelRig();
    await rig.reload(IDS, 'ses_b');
    await pass();
    const [localA] = rig.sessions().find(([, s]) => s.client.currentSessionId === 'ses_a')!;
    rig.p['permBanner'] = { forget: () => undefined, modeForView: () => 'build' };
    rig.p['paintPermissionBanner'] = () => undefined;
    rig.close(localA);
    await pass();
    expect(removedStandIns).toEqual(['ses_a']);
    expect(spawns()).toBe(0);
  });

  it('a direct client call (not through the gate) starts it first and then runs', async () => {
    rig = panelRig();
    await rig.reload(IDS, 'ses_b');
    await pass();
    const a = rig.byEngine('ses_a')!;
    await a.client.extMethod('list_skills', {});
    expect(spawns()).toBe(1);
    expect(loads('ses_a')).toBe(1);
    expect(calls.filter((c) => c.method === '_list_skills').length).toBe(1);
  });
});

describe('/loop across the reload', () => {
  for (const persistent of [false, true]) {
    it(`an armed ${persistent ? 'PERSISTENT ' : ''}loop re-arms on its deferred chat, and its run starts the engine and prompts once`, async () => {
      const loop = { sessionId: 'ses_c', intervalMs: 1500, prompt: 'check the build', runs: 3, createdAt: Date.now() - 60_000, ...(persistent ? { persistent: true } : {}) };
      rig = panelRig({ 'origami.loopSchedules': [loop] });
      await rig.reload(IDS, 'ses_b');
      await pass();
      rig.rearmLoops();
      const [localC, c] = rig.sessions().find(([, s]) => s.client.currentSessionId === 'ses_c')!;
      expect(c.loopSchedule).toMatchObject({ intervalMs: 1500, prompt: 'check the build', stopped: false });
      expect(rig.postsFor(localC, 'system').some((m) => /Loop re-armed after reload/.test(m.text))).toBe(true);
      expect(spawns()).toBe(0); // armed, not run: no burst at the reload
      // No headless copy of the chat was recalled for a persistent loop: its chat is here.
      expect(rig.sessions().filter(([, s]) => s.kind === 'agent')).toEqual([]);
      await sleep(300);
      expect(spawns()).toBe(0); // not before its interval
      const ran = () => calls.filter((x) => x.method === 'prompt');
      for (let i = 0; i < 250 && ran().length === 0; i++) await sleep(20); // the first run, at 1.5 s
      c.loopSchedule.stopped = true; // one run is the check; the next would be 1.5 s after this one ends
      clearTimeout(c.loopSchedule.timer);
      await settle();
      expect(spawns()).toBe(1);
      expect(loads('ses_c')).toBe(1);
      const prompts = ran();
      expect(prompts.length).toBe(1);
      expect(prompts[0]!.params.sessionId).toBe('ses_c');
      expect(prompts[0]!.params.prompt[0].text).toContain('check the build');
    });
  }
});
