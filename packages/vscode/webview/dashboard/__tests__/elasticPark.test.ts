// elasticPark.test.ts — t-w2txb2 (epic t-w1r73y, option D3): a chat's engine is PARKED (stopped on purpose)
// and restored for the same engine session on the next use.
//
// The REAL AcpClient (src/acpClient.ts), the REAL EngineGate (src/dashboard/engineGate.ts) and the REAL park
// mechanics (src/elastic/park.ts), over a fake child process and a fake ACP connection: node:child_process
// and the ACP SDK are mocked so no engine starts. The fake connection REPLAYS the stored transcript on
// `session/load` as a real engine does (engine acp/service.ts loadSession), and replays nothing on
// `session/resume` (service.ts resumeSession) — which is what the silent restore rests on.

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- the engine processes: one fake child per spawn; closing stdin makes it exit ---------------------------
const { spawnMock, children } = vi.hoisted(() => {
  const children: Array<Record<string, any>> = [];
  const spawnMock = vi.fn((_exec: string, _args: string[], _opts: { env: Record<string, string> }) => {
    const { EventEmitter: EE } = require('node:events') as typeof import('node:events');
    const child: any = new EE();
    child.pid = 5000 + children.length;
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

// --- the settings a spawn reads (engineEnv.ts): code mode can be switched between two spawns --------------
const { settings } = vi.hoisted(() => ({ settings: { codeMode: false } }));
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (key: string) => (key === 'experimentalCodeMode' ? settings.codeMode : undefined) }),
  },
}));

// --- the ACP connection: one per spawn, recording every call ------------------------------------------------
type Call = { conn: number; method: string; params: any };
const { conns, calls, engine } = vi.hoisted(() => ({
  conns: [] as Array<{ client: any }>,
  calls: [] as Call[],
  /** What the fake engine answers. `model`/`effort` are the stored session's (what load/resume restore). */
  engine: { model: 'prov/model-a', effort: 'medium', mode: 'build', park: { parked: true, sessionIds: ['ses_1'] } as Record<string, unknown> | Error, unpark: { unparked: true, delivered: 0 } as Record<string, unknown> | Error, resumeFails: 0, exitAfterResume: 0 },
}));
vi.mock('@agentclientprotocol/sdk', () => {
  const opts = (s: { model: string; effort: string; mode: string }) => [
    { id: 'model', type: 'select', currentValue: s.model, options: [{ value: 'prov/model-a' }, { value: 'prov/model-b' }] },
    { id: 'effort', type: 'select', currentValue: s.effort, options: [{ value: 'medium' }, { value: 'high' }] },
    { id: 'mode', type: 'select', currentValue: s.mode, options: [{ value: 'build' }, { value: 'plan' }] },
  ];
  class ClientSideConnection {
    private readonly n: number;
    private readonly live = { model: '', effort: '', mode: '' };
    constructor(factory: (agent: unknown) => unknown) {
      this.n = conns.length;
      conns.push({ client: factory(this) });
    }
    private rec(method: string, params: any) { calls.push({ conn: this.n, method, params }); }
    async initialize() { this.rec('initialize', {}); return { protocolVersion: 1, agentInfo: { version: 't', _meta: { peerName: 'work-1234' } } }; }
    async newSession(p: any) { this.rec('newSession', p); Object.assign(this.live, engine); return { sessionId: 'ses_1', configOptions: opts(this.live) }; }
    async loadSession(p: any) {
      this.rec('loadSession', p);
      Object.assign(this.live, engine);
      // A real load replays the stored transcript into the live handlers.
      const client = conns[this.n]!.client;
      await client.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } } });
      await client.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } } });
      return { configOptions: opts(this.live) };
    }
    async resumeSession(p: any) {
      this.rec('resumeSession', p);
      if (engine.resumeFails > 0) { engine.resumeFails--; throw new Error('database is locked'); }
      if (engine.exitAfterResume > 0) { engine.exitAfterResume--; children[this.n]!.kill(); }
      Object.assign(this.live, engine);
      return { configOptions: opts(this.live) };
    }
    async setSessionMode(p: any) { this.rec('setSessionMode', p); this.live.mode = p.modeId; return {}; }
    async prompt(p: any) { this.rec('prompt', p); return { stopReason: 'end_turn' }; }
    async cancel(p: any) { this.rec('cancel', p); }
    async setSessionConfigOption(p: any) {
      this.rec('setSessionConfigOption', p);
      if (p.configId in this.live) (this.live as any)[p.configId] = p.value;
      if (p.configId === 'model') this.live.effort = 'medium'; // a model switch resets effort, as the engine does
      return { configOptions: opts(this.live) };
    }
    async extMethod(method: string, params: any) {
      this.rec(method, params);
      if (method === '_elastic_park') { if (engine.park instanceof Error) throw engine.park; return engine.park; }
      if (method === '_elastic_unpark') { if (engine.unpark instanceof Error) throw engine.unpark; return engine.unpark; }
      return { ok: true };
    }
  }
  const ndJsonStream = () => ({});
  class RequestError extends Error { static methodNotFound(m: string) { return new RequestError(m); } }
  return { PROTOCOL_VERSION: 1, ndJsonStream, ClientSideConnection, RequestError, default: { PROTOCOL_VERSION: 1, ndJsonStream, ClientSideConnection, RequestError } };
});

import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { EngineGate } from '../../../src/dashboard/engineGate';
import { parkChat } from '../../../src/elastic/park';
import { computeOpenSet } from '../../../src/dashboard/agentManager/sessionRestore';
import { splitPersistedLoops } from '../../../src/dashboard/agentManager/loopRearm';

/** One chat as DashboardPanel builds it: the client, its gate, and the transcript rows its handlers log. */
function chat() {
  const rows: string[] = [];
  const closed: string[] = [];
  const handlers = {
    onUserMessageChunk: (t: string) => rows.push(`user:${t}`),
    onAgentMessageChunk: (t: string) => rows.push(`agent:${t}`),
    onClose: (reason: string) => { if (!gate.exited(reason)) closed.push(reason); },
    onError: vi.fn(),
  } as unknown as AcpEventHandlers;
  const client = new AcpClient(handlers);
  const gate = new EngineGate(() => undefined);
  return { client, gate, rows, closed };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const log = () => undefined;
const methods = (conn: number) => calls.filter((c) => c.conn === conn).map((c) => c.method);

beforeEach(() => {
  spawnMock.mockClear();
  children.length = 0;
  conns.length = 0;
  calls.length = 0;
  settings.codeMode = false;
  Object.assign(engine, { model: 'prov/model-a', effort: 'medium', mode: 'build', park: { parked: true, sessionIds: ['ses_1'] }, unpark: { unparked: true, delivered: 0 }, resumeFails: 0, exitAfterResume: 0 });
});

/** A reopened chat (history recall): the engine replays two rows, as it does today. */
async function reopened() {
  const c = chat();
  await c.gate.start(async () => { await c.client.start('/work', undefined, 'ses_1'); });
  return c;
}

describe('park: the engine stops on purpose, the chat keeps its session', () => {
  it('stops the process after the engine said parked, posts no "closed", keeps the engine session id', async () => {
    const c = await reopened();
    expect(await parkChat(c, log)).toBeNull();
    expect(children[0]!.stdin.end).toHaveBeenCalledTimes(1); // the park path: stdin EOF, the engine's finalizers run
    expect(c.gate.current).toBe('parked');
    expect(c.closed).toEqual([]); // not the crash card
    expect(c.client.currentSessionId).toBe('ses_1');
    expect(calls.find((x) => x.method === '_elastic_park')?.params).toEqual({ hostPid: process.pid });
  });

  it('a parked chat stays in the open-set and keeps its /loop (reload restore and loop persistence key on the engine id)', async () => {
    const c = await reopened();
    await parkChat(c, log);
    const sessions: Array<[string, { kind?: 'chat' | 'agent'; client: { currentSessionId: string | null } }]> = [['session-1', { client: c.client }]];
    expect(computeOpenSet(sessions, 'session-1', false)).toEqual({ open: ['ses_1'], active: 'ses_1', grid: false });
    const loop = { sessionId: 'ses_1', intervalMs: 60_000, prompt: 'check', runs: 3, createdAt: 1 };
    const live = new Set([c.client.currentSessionId!].filter(Boolean));
    expect(splitPersistedLoops([loop], live)).toEqual({ rearm: [loop], needsAttention: [] });
  });

  it('a crash is still a crash: the gate stops, the id goes, the pane gets the card', async () => {
    const c = await reopened();
    children[0]!.kill();
    await tick();
    expect(c.gate.current).toBe('stopped');
    expect(c.client.currentSessionId).toBeNull();
    expect(c.closed.length).toBe(1);
  });

  it('the engine refusing the park (work started) keeps it up, and the chat works as before', async () => {
    const c = await reopened();
    engine.park = { parked: false, reasons: ['permission-pending'] };
    expect(await parkChat(c, log)).toMatch(/refused: permission-pending/);
    expect(children[0]!.stdin.end).not.toHaveBeenCalled();
    expect(c.gate.current).toBe('ready');
    expect(c.client.wake).toBeNull();
    await c.gate.turn(() => c.client.prompt('go on'));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('an engine older than _elastic_park (-32601) is still parked', async () => {
    const c = await reopened();
    engine.park = Object.assign(new Error('Method not found'), { code: -32601 });
    expect(await parkChat(c, log)).toBeNull();
    expect(c.gate.current).toBe('parked');
  });

  it('is refused while a turn is in flight: nothing reaches the engine', async () => {
    const c = await reopened();
    const slot = await c.gate.hold();
    expect(await parkChat(c, log)).toMatch(/work in flight/);
    expect(calls.some((x) => x.method === '_elastic_park')).toBe(false);
    if (typeof slot !== 'string') slot.done();
  });

  it('a prompt that arrives while the engine is being asked keeps the engine up (no stop behind its back)', async () => {
    const c = await reopened();
    let answer: (v: unknown) => void = () => undefined;
    const conn = (c.client as unknown as { connection: { extMethod: (m: string, p: unknown) => Promise<unknown> } }).connection;
    const real = conn.extMethod.bind(conn);
    conn.extMethod = (m, p) => (m === '_elastic_park' ? new Promise((r) => { answer = r; }) : real(m, p));
    const parking = parkChat(c, log);
    await tick();
    const turn = c.gate.turn(() => c.client.prompt('arrived during the park'));
    answer({ parked: true, sessionIds: ['ses_1'] });
    expect(await parking).toBe('woken during the park');
    expect((await turn).sent).toBe(true);
    expect(children[0]!.stdin.end).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // t-wdyi2t: the engine had already parked its peer side; the kept engine is told to undo that BEFORE the
    // prompt that woke it, so mail queued meanwhile is delivered first and peers reach the live engine again.
    expect(methods(0).slice(-2)).toEqual(['_elastic_unpark', 'prompt']); // (this test answers _elastic_park itself)
  });
});

describe('restore: the next use starts the engine again for the same session, silently', () => {
  it('the next prompt spawns once, resumes the SAME engine session and replays nothing into the transcript', async () => {
    const c = await reopened();
    expect(c.rows).toEqual(['user:old question', 'agent:old answer']); // the recall itself replays, as today
    await parkChat(c, log);
    const turn = await c.gate.turn(() => c.client.prompt('next message'));
    expect(turn.sent).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(methods(1)).toEqual(['initialize', 'resumeSession', 'prompt']); // no load, no new session
    expect(calls.find((x) => x.conn === 1 && x.method === 'resumeSession')?.params).toMatchObject({ sessionId: 'ses_1', cwd: '/work' });
    expect(calls.find((x) => x.conn === 1 && x.method === 'prompt')?.params.sessionId).toBe('ses_1');
    expect(c.rows).toEqual(['user:old question', 'agent:old answer']); // not doubled
    expect(c.gate.current).toBe('ready');
    expect(c.client.wake).toBeNull();
  });

  it('spawns with the env the chat STARTED with, not the setting changed while it was parked', async () => {
    const c = await reopened();
    await parkChat(c, log);
    settings.codeMode = true; // the user turns code mode on while the chat is stopped
    await c.gate.turn(() => c.client.prompt('next'));
    const env = (i: number) => spawnMock.mock.calls[i]![2].env as Record<string, string>;
    expect(env(1)['ORIGAMI_EXPERIMENTAL_CODE_MODE']).toBeUndefined();
    expect(env(1)['ORIGAMI_EXPERIMENTAL_BACKGROUND_SUBAGENTS']).toBe(env(0)['ORIGAMI_EXPERIMENTAL_BACKGROUND_SUBAGENTS']);
    // ... and under the peer name it had, so a reply to that address still finds it.
    expect(env(1)['ORIGAMI_AGENT_NAME']).toBe('work-1234');
    // A NEW chat reads the current setting.
    const fresh = chat();
    await fresh.gate.start(async () => { await fresh.client.start('/work'); });
    expect(env(2)['ORIGAMI_EXPERIMENTAL_CODE_MODE']).toBe('true');
  });

  it('sets again the model, effort and sampling the chat had in engine memory; nothing it already has', async () => {
    const c = await reopened();
    await c.gate.whenUp();
    await c.client.setModel('prov/model-b'); // picked with no prompt: engine memory only
    await c.client.setConfigOption('effort', 'high');
    await c.client.setConfigOption('temperature', '0.3');
    await parkChat(c, log);
    calls.length = 0;
    await c.gate.turn(() => c.client.prompt('next'));
    // resume restored model-a / medium from history; the chat had model-b / high / 0.3; mode already matches
    expect(calls.filter((x) => x.method === 'setSessionConfigOption').map((x) => `${x.params.configId}=${x.params.value}`)).toEqual([
      'model=prov/model-b',
      'effort=high',
      'temperature=0.3',
    ]);
    expect(calls.map((x) => x.method).indexOf('prompt')).toBeGreaterThan(calls.map((x) => x.method).lastIndexOf('setSessionConfigOption'));
    expect(c.client.getModelOption()?.current).toBe('prov/model-b');
    expect(c.client.getEffortOption()?.current).toBe('high');
  });

  it('a direct client call (a Folds prompt, a plan action, a host read) wakes it through the gate', async () => {
    const c = await reopened();
    await parkChat(c, log);
    await c.client.extMethod('plan_action', { action: 'approve' });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(methods(1)).toEqual(['initialize', 'resumeSession', '_plan_action']);
    expect(c.gate.current).toBe('ready');
  });

  it('cancel on a parked chat is a no-op: nothing to cancel, nothing started', async () => {
    const c = await reopened();
    await parkChat(c, log);
    await c.client.cancel();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(c.gate.current).toBe('parked');
  });

  it('many calls at once start ONE engine, and prompts keep their order', async () => {
    const c = await reopened();
    await parkChat(c, log);
    const a = c.gate.turn(() => c.client.prompt('first'));
    const b = c.gate.turn(() => c.client.prompt('second'));
    const read = c.client.extMethod('list_tools', {});
    await Promise.all([a, b, read]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(calls.filter((x) => x.conn === 1 && x.method === 'prompt').map((x) => x.params.prompt[0].text)).toEqual(['first', 'second']);
  });

  it('parks and restores again (the second cycle is the same as the first)', async () => {
    const c = await reopened();
    await parkChat(c, log);
    await c.gate.turn(() => c.client.prompt('one'));
    expect(await parkChat(c, log)).toBeNull();
    await c.gate.turn(() => c.client.prompt('two'));
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(methods(2)).toEqual(['initialize', 'resumeSession', 'prompt']);
    expect(c.rows).toEqual(['user:old question', 'agent:old answer']);
  });
});

// t-wdyi2t (review_extension-lifecycle.md): the park/restore failure paths, against the real client and gate.
describe('review fixes: nothing wakes a parked engine by accident, and every failure ends somewhere safe', () => {
  const within = <T,>(p: Promise<T>, ms = 1500) => Promise.race([p, new Promise<'timed out'>((r) => setTimeout(() => r('timed out'), ms))]);
  const setOptions = () => calls.filter((x) => x.method === 'setSessionConfigOption').map((x) => `${x.params.configId}=${x.params.value}`);
  type Conn = { extMethod: (m: string, p: unknown) => Promise<unknown> };
  /** Replace the live connection's ext call for `_elastic_park` only. */
  const onPark = (c: { client: AcpClient }, park: () => Promise<unknown>) => {
    const conn = (c.client as unknown as { connection: Conn }).connection;
    const real = conn.extMethod.bind(conn);
    conn.extMethod = (m, p) => (m === '_elastic_park' ? park() : real(m, p));
  };

  it('#1 an _elastic_* call on a parked chat fails fast and starts no engine', async () => {
    const c = await reopened();
    await parkChat(c, log);
    for (const m of ['_elastic_trim', '_elastic_idle_report', 'elastic_class']) {
      await expect(within(c.client.extMethod(m, {}))).rejects.toThrow();
    }
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(c.gate.current).toBe('parked');
  });

  it('#2 a /plan switch (setSessionMode, no prompt since) survives park and restore', async () => {
    const c = await reopened();
    await c.client.setSessionMode('plan');
    expect(c.client.getModeOption()?.current).toBe('plan');
    await parkChat(c, log);
    calls.length = 0;
    await c.gate.turn(() => c.client.prompt('next'));
    // resume restored "build" from history; the chat had switched to "plan"
    expect(setOptions()).toEqual(['mode=plan']);
    expect(c.client.getModeOption()?.current).toBe('plan');
  });

  it('#3 a park the engine did not answer (an error) keeps the engine up and unparks it', async () => {
    const c = await reopened();
    engine.park = new Error('stdin closed');
    expect(await parkChat(c, log)).toMatch(/did not answer the park/);
    expect(methods(0).slice(-2)).toEqual(['_elastic_park', '_elastic_unpark']);
    expect(c.gate.current).toBe('ready');
    expect(c.client.wake).toBeNull();
    expect(children[0]!.stdin.end).not.toHaveBeenCalled();
    await c.gate.turn(() => c.client.prompt('go on'));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('#3 a park that times out is treated the same way', async () => {
    const c = await reopened();
    onPark(c, () => new Promise(() => undefined));
    expect(await within(parkChat(c, log, { limitMs: 30 }))).toMatch(/did not answer the park/);
    expect(methods(0).at(-1)).toBe('_elastic_unpark');
    expect(c.gate.current).toBe('ready');
  });

  it('#3 when the unpark fails too (an engine with no _elastic_unpark), the engine is stopped and the next use resumes it', async () => {
    const c = await reopened();
    engine.park = new Error('stdin closed');
    engine.unpark = Object.assign(new Error('Method not found'), { code: -32601 });
    await parkChat(c, log);
    expect(children[0]!.stdin.end).toHaveBeenCalledTimes(1);
    expect(c.client.currentSessionId).toBe('ses_1');
    expect(await within(c.gate.turn(() => c.client.prompt('next')))).toMatchObject({ sent: true });
    expect(methods(1)).toEqual(['initialize', 'resumeSession', 'prompt']);
  });

  it('#3 woken during the park + a failed unpark: the prompt goes to a resumed engine, not the half-parked one', async () => {
    const c = await reopened();
    engine.unpark = new Error('broken pipe');
    let answer: (v: unknown) => void = () => undefined;
    onPark(c, () => new Promise((r) => { answer = r; }));
    const parking = parkChat(c, log);
    await tick();
    const turn = c.gate.turn(() => c.client.prompt('arrived during the park'));
    answer({ parked: true, sessionIds: ['ses_1'] });
    await parking;
    expect(await within(turn)).toMatchObject({ sent: true });
    expect(methods(0)).not.toContain('prompt');
    expect(methods(1)).toEqual(['initialize', 'resumeSession', 'prompt']);
  });

  it('#4 a chat closed while its park request is out starts no engine afterwards', async () => {
    const c = await reopened();
    let fail: (e: Error) => void = () => undefined;
    onPark(c, () => new Promise((_, rej) => { fail = rej; }));
    const parking = parkChat(c, log);
    await tick();
    c.gate.drop(true); // DashboardPanel.closeSession
    c.client.dispose();
    fail(new Error('connection closed'));
    await within(parking);
    await tick();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('#6a the restored engine exits during the restore: the card offers Retry (not "starting" forever), and Retry resumes', async () => {
    const c = await reopened();
    await c.gate.whenUp();
    await c.client.setModel('prov/model-b'); // forces a re-apply after the resume
    await parkChat(c, log);
    engine.exitAfterResume = 1; // the restored engine exits right after it answered session/resume
    const turn = c.gate.turn(() => c.client.prompt('next'));
    for (let i = 0; i < 40 && c.gate.current !== 'failed'; i++) await tick();
    expect(c.gate.current).toBe('failed');
    await c.gate.retry();
    expect(await within(turn)).toMatchObject({ sent: true });
    expect(methods(2)).toEqual(['initialize', 'resumeSession', 'setSessionConfigOption', 'prompt']);
  });

  it('#6b the engine crashing during the park request does not leave the chat "ready" with no engine', async () => {
    const c = await reopened();
    onPark(c, async () => {
      children[0]!.kill();
      await tick();
      throw new Error('connection closed');
    });
    await parkChat(c, log);
    expect(c.gate.current).not.toBe('ready');
    expect(c.client.currentSessionId).toBe('ses_1');
    expect(await within(c.gate.turn(() => c.client.prompt('next')))).toMatchObject({ sent: true });
    expect(methods(1)).toEqual(['initialize', 'resumeSession', 'prompt']);
  });

  it('#7 a chat that adopted a spare (another spelling of the folder) resumes with its OWN cwd', async () => {
    const c = chat();
    await c.client.connect('c:\\work'); // the warm spare (elastic/warmSpare.ts)
    await c.gate.start(async () => { await c.client.start('C:/work'); });
    await parkChat(c, log);
    await c.gate.turn(() => c.client.prompt('next'));
    expect(calls.find((x) => x.method === 'newSession')?.params.cwd).toBe('C:/work');
    expect(calls.find((x) => x.method === 'resumeSession')?.params.cwd).toBe('C:/work');
  });

  it('#8 Retry after a failed resume (the spawn worked) sends session/resume again', async () => {
    const c = await reopened();
    await parkChat(c, log);
    engine.resumeFails = 1;
    const turn = c.gate.turn(() => c.client.prompt('next'));
    for (let i = 0; i < 20 && c.gate.current !== 'failed'; i++) await tick();
    expect(c.gate.current).toBe('failed');
    await c.gate.retry();
    expect(await within(turn)).toMatchObject({ sent: true });
    expect(calls.filter((x) => x.method === 'resumeSession').length).toBe(2);
    expect(spawnMock).toHaveBeenCalledTimes(2); // the engine that failed the resume is reused
  });
});
