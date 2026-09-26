// t-xoenz1 (owner UAT of 0.4.178) — the Origami Elastic log tells a close from a crash, and every lifecycle line
// can be tied to a process and a chat. The REAL AcpClient, EngineGate, park mechanics, ParkHost and ActivityTracker
// run over a fake child process and a fake ACP connection (the same fakes as elasticPark.test.ts). The bugs each
// block catches:
//
// - a chat the user closes is logged "the engine stopped" with "engine session (none yet)", the same line as a
//   crash (dispose() drops the session id before the exit lands, and the gate reads the exit as a loss);
// - the window closing does the same for every chat;
// - a parked chat that is closed writes no line, so a log reader keeps it as parked;
// - a real crash on an open chat loses its engine session id from Copy details (read after the id is gone);
// - start / parked / restored / closed lines that name only "chat N" / "agent N": no pid, no engine session, and
//   a Folds agent and a headless /loop session read the same.

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


import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { EngineGate, type EngineStatePost } from '../../../src/dashboard/engineGate';
import { engineDescribe } from '../../../src/dashboard/engineLog';
import { engineKind, engineLabel, engineWho } from '../../../src/elastic/engineLabel';
import { ParkHost } from '../../../src/elastic/parkHost';
import { ActivityTracker, EVALUATE_DEBOUNCE_MS } from '../../../src/elastic/activityTracker';
import { engineViews } from '../../../src/elastic/sessionSignals';

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/dashboard/DashboardPanel.ts'), 'utf8');

/** One chat as DashboardPanel builds it: the client, and its gate logging to "Origami Elastic" with the panel's describe. */
function chat(number = 5, kind?: 'chat' | 'agent', headlessLoop?: boolean) {
  const lines: string[] = [];
  const cards: EngineStatePost[] = [];
  const closed: string[] = [];
  const handlers = {
    onUserMessageChunk: () => undefined,
    onAgentMessageChunk: () => undefined,
    onClose: (reason: string) => { if (!session.gate.exited(reason)) closed.push(reason); },
    onError: vi.fn(),
  } as unknown as AcpEventHandlers;
  const session = {
    id: `session-${number}`, number, kind, headlessLoop, turnBusy: false,
    client: new AcpClient(handlers),
    gate: null as unknown as EngineGate,
    pendingPermissions: { size: 0 }, runningChildren: { size: 0 },
  };
  // The describe DashboardPanel.createSession gives the gate (source guard below).
  session.gate = new EngineGate((p) => cards.push(p), { log: (l) => lines.push(l), describe: () => engineDescribe(engineWho(session), session.client.currentSessionId) });
  return { session, lines, cards, closed };
}

async function opened(number = 5, kind?: 'chat' | 'agent', headlessLoop?: boolean) {
  const c = chat(number, kind, headlessLoop);
  await c.session.gate.start(async () => { await c.session.client.start('/work'); });
  return c;
}

/** What DashboardPanel.closeSession does to the engine (source guard below). */
function closeLikeThePanel(c: ReturnType<typeof chat>) {
  c.session.gate.close();
  c.session.client.dispose();
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

beforeEach(() => {
  spawnMock.mockClear();
  children.length = 0;
  conns.length = 0;
  calls.length = 0;
  Object.assign(engine, { model: 'prov/model-a', effort: 'medium', mode: 'build', park: { parked: true, sessionIds: ['ses_1'] }, unpark: { unparked: true, delivered: 0 }, resumeFails: 0, exitAfterResume: 0 });
});

describe('t-xoenz1: a close is logged as a close, a crash as a crash', () => {
  it('closing a chat writes ONE "closed" line with its pid and engine session, and no "the engine stopped"', async () => {
    const c = await opened();
    closeLikeThePanel(c);
    await settle();
    expect(children[0]!.exitCode).toBe(0); // the engine did exit
    expect(c.lines).toEqual(['[engine] chat 5 · kind chat · pid 5000 · engine session ses_1: closed']);
    expect(c.closed).toEqual([]); // and no crash card was posted for it
  });

  it('the window closing: every chat is logged closed, with why', async () => {
    const c = await opened();
    c.session.gate.close('the window closed');
    c.session.client.dispose();
    await settle();
    expect(c.lines).toEqual(['[engine] chat 5 · kind chat · pid 5000 · engine session ses_1: closed (the window closed)']);
  });

  it('a real exit on an open chat still says "the engine stopped", with its engine session and pid; Copy details keeps the session after the id is gone', async () => {
    const c = await opened();
    children[0]!.kill();
    await settle();
    expect(c.session.client.currentSessionId).toBeNull(); // the client dropped it with the exit
    expect(c.lines).toEqual(['[engine] chat 5 · kind chat · pid 5000 · engine session ses_1: the engine stopped: origami-acp exited (code=0, signal=null)']);
    expect(c.closed).toHaveLength(1); // the pane gets the card
    expect(await c.session.gate.whenUp()).toBe(false); // the user acts: the card is posted with its Copy details
    expect(c.cards.at(-1)?.details).toContain('chat 5 · kind chat · pid 5000 · engine session ses_1');
    expect(c.cards.at(-1)?.details).not.toContain('(none yet)');
  });
});

describe('t-xoenz1: parked, restored and closed while parked (ParkHost, the path the tracker uses)', () => {
  const host = (c: ReturnType<typeof chat>, lines: string[]) => new ParkHost({ sessions: () => [c.session], log: (l) => lines.push(l), watch: () => ({ dispose: () => undefined }), mail: () => false });

  it('parked and restored lines carry kind and pid (the stopped process, then the new one); a close while parked says so', async () => {
    const c = await opened(15, 'agent');
    const park = host(c, c.lines);
    expect(await park.park('session-15')).toBeNull();
    expect(c.lines).toContain('[elastic] parked engine session ses_1 · agent 15 · kind Folds agent · pid 5000');
    await c.session.gate.turn(() => c.session.client.prompt('next'));
    expect(c.lines.find((l) => l.startsWith('[elastic] restored engine session ses_1 in '))).toMatch(/ ms · agent 15 · kind Folds agent · pid 5001$/);
    expect(await park.park('session-15')).toBeNull();
    park.closed(c.session);
    closeLikeThePanel(c);
    await settle();
    expect(c.lines.at(-1)).toBe('[engine] agent 15 · kind Folds agent · engine session ses_1: closed while parked');
    expect(c.lines.some((l) => l.includes('the engine stopped'))).toBe(false);
  });
});

describe('t-xoenz1: every tracker line names kind, pid and engine session', () => {
  it('start -> ... for a chat, a Folds agent and a headless /loop session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const chats = [await opened(5), await opened(15, 'agent'), await opened(3, 'agent', true)];
      const log: string[] = [];
      const tracker = new ActivityTracker({
        setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), now: () => Date.now(),
        settings: () => ({ enabled: true, idleAfterMs: 5 * 60_000, trimAfterMs: 0, retrimMs: 10 * 60_000 }), log: (l) => void log.push(l),
      });
      const win = { sidebarVisible: () => false, sidebarFocused: () => false, sidebarChat: (): string | null => null, phoneFocus: () => null, engineBusy: () => false };
      tracker.attach({ engines: () => engineViews({ sessions: () => chats.map((c) => c.session), activeId: () => null, grid: () => false, solo: () => undefined, question: () => false }, win, undefined) });
      await vi.advanceTimersByTimeAsync(EVALUATE_DEBOUNCE_MS);
      expect(log).toEqual([
        '[elastic] chat 5 · kind chat · pid 5000 · engine session ses_1: start -> background',
        '[elastic] agent 15 · kind Folds agent · pid 5001 · engine session ses_1: start -> background',
        '[elastic] agent 3 · kind headless loop · pid 5002 · engine session ses_1: start -> background',
      ]);
      tracker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('engineLabel / engineKind: no pid while no process runs; "(none yet)" before the engine session exists', () => {
    expect(engineKind({ id: 'a' })).toBe('chat');
    expect(engineKind({ id: 'a', kind: 'agent' })).toBe('Folds agent');
    expect(engineKind({ id: 'a', kind: 'agent', headlessLoop: true })).toBe('headless loop');
    expect(engineLabel({ id: 'session-2', number: 2, client: { pid: 7, currentSessionId: 'ses_x' } })).toBe('chat 2 · kind chat · pid 7 · engine session ses_x');
    expect(engineLabel({ id: 'session-2', number: 2, kind: 'agent', client: { currentSessionId: null } })).toBe('agent 2 · kind Folds agent · engine session (none yet)');
  });
});

describe('t-xoenz1: DashboardPanel wiring (source guards)', () => {
  it('closeSession closes the gate (not drop) before it disposes the client; the window close does the same', () => {
    expect(src).toMatch(/this\.parking\.closed\(session\);[^\n]*\n\s*session\.gate\.close\(\);[^\n]*\n\s*session\.client\.dispose\(\);/);
    expect(src).toMatch(/saveSession\(session\);\s*\n\s*session\.gate\.close\('the window closed'\);[^\n]*\n\s*session\.client\.dispose\(\);/);
  });

  it('the gate describes the chat with engineWho (kind, pid); a recalled headless /loop is marked', () => {
    expect(src).toMatch(/describe: \(\) => engineDescribe\(engineWho\(session\), session\.client\?\.currentSessionId\)/);
    expect(src).toMatch(/session\.headlessLoop = true; session\.loopSchedule = \{[^\n]*persistent: true \};/);
  });
});
