// elasticRestoreFailure.test.ts — t-x3a89j (Elastic E12): when a restore (or a first start) fails, the Retry card
// says WHY (the engine exited with a code or signal, it did not answer in N s, or `session/resume` was refused with
// the engine's own error text), WHEN, and carries the text for Copy details; the "Origami Elastic" channel gets a
// line. One test per failure path.
//
// The REAL AcpClient, EngineGate and park/restore code (src/elastic/park.ts). Only the engine process
// (node:child_process) and the ACP SDK are fakes, as in elasticRestoreOnShow.test.ts. The bugs caught: a card with
// no time and nothing to copy; an exit code lost because the connection closed before the exit event arrived; a
// restore or start that never answers and leaves the chat on "Starting the engine" for ever with no Retry; a
// timed-out engine left running, so Retry sends a second `session/resume` to the hung one.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, children } = vi.hoisted(() => {
  const children: Array<Record<string, any>> = [];
  const spawnMock = vi.fn((_exec: string, _args: string[], _opts: { env: Record<string, string> }) => {
    const { EventEmitter: EE } = require('node:events') as typeof import('node:events');
    const child: any = new EE();
    child.pid = 8000 + children.length;
    child.exitCode = null;
    child.signalCode = null;
    child.die = (code: number | null, signal: string | null) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('exit', code, signal);
    };
    const eof = () => queueMicrotask(() => child.die(0, null));
    child.stdin = { end: vi.fn(eof), on() {}, once() {}, write() {} };
    child.stdout = { on() {}, once() {}, pipe() {}, setEncoding() {} };
    child.stderr = null;
    child.kill = vi.fn(() => queueMicrotask(() => child.die(null, 'SIGTERM')));
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
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  window: { createOutputChannel: () => ({ appendLine: () => undefined }) },
}));

type Resume = 'ok' | 'exit-then-close' | 'close-then-exit' | 'refuse' | 'hang';
const { engine, calls } = vi.hoisted(() => ({
  engine: { resume: 'ok' as Resume, initHang: false },
  calls: [] as Array<{ method: string; params: any }>,
}));
vi.mock('@agentclientprotocol/sdk', () => {
  const opts = () => [{ id: 'model', type: 'select', currentValue: 'prov/model-a', options: [{ value: 'prov/model-a' }] }];
  class RequestError extends Error {
    constructor(public code: number, message: string) { super(message); this.name = 'RequestError'; }
    static methodNotFound(m: string) { return new RequestError(-32601, m); }
  }
  class ClientSideConnection {
    constructor(factory: (agent: unknown) => unknown) { factory(this); }
    async initialize() { calls.push({ method: 'initialize', params: {} }); if (engine.initHang) await new Promise(() => undefined); return { protocolVersion: 1, agentInfo: { version: 't' } }; }
    async loadSession(p: any) { calls.push({ method: 'loadSession', params: p }); return { configOptions: opts() }; }
    async resumeSession(p: any) {
      calls.push({ method: 'resumeSession', params: p });
      const child = children[children.length - 1]!;
      switch (engine.resume) {
        case 'ok': return { configOptions: opts() };
        case 'hang': return new Promise(() => undefined);
        case 'refuse': throw new RequestError(-32602, `Invalid params: session not found: ${p.sessionId}`);
        case 'exit-then-close': child.die(3, null); await Promise.resolve(); throw new Error('ACP connection closed');
        case 'close-then-exit': setTimeout(() => child.die(3, null), 20); throw new Error('ACP connection closed');
      }
    }
    async extMethod(method: string) {
      calls.push({ method, params: {} });
      if (method === '_elastic_park') return { parked: true, sessionIds: [] };
      return {};
    }
  }
  const ndJsonStream = () => ({});
  return { PROTOCOL_VERSION: 1, ndJsonStream, ClientSideConnection, RequestError, default: { PROTOCOL_VERSION: 1, ndJsonStream, ClientSideConnection, RequestError } };
});

import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { EngineGate, type EngineStatePost } from '../../../src/dashboard/engineGate';
import * as park from '../../../src/elastic/park';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(ms = 60) { await sleep(ms); for (let i = 0; i < 20; i++) await sleep(0); }

function newChat() {
  const posts: EngineStatePost[] = [];
  const lines: string[] = [];
  let gate!: EngineGate;
  const handlers = { onClose: (reason: string) => { gate.exited(reason); }, onError: vi.fn() } as unknown as AcpEventHandlers;
  const client = new AcpClient(handlers);
  gate = new EngineGate((p: EngineStatePost) => posts.push(p), { log: (l: string) => lines.push(l), describe: () => ['chat 1 · engine session ses_c1'] });
  return { client, gate, posts, lines };
}
type Chat = ReturnType<typeof newChat>;

/** A chat reopened from history, then parked (the engine stopped on purpose). */
async function parkedChat(startLimitMs?: number): Promise<Chat> {
  const c = newChat();
  await c.gate.start(async () => { await c.client.start('/work', undefined, 'ses_c1'); });
  expect(await park.parkChat(c, () => undefined, startLimitMs ? { startLimitMs } : {})).toBeNull();
  expect(c.gate.current).toBe('parked');
  return c;
}

const last = (c: Chat) => c.posts[c.posts.length - 1]!;

beforeEach(() => {
  spawnMock.mockClear();
  children.length = 0;
  calls.length = 0;
  Object.assign(engine, { resume: 'ok', initHang: false });
});

describe('a restore that fails says why, when, and gives the details to copy', () => {
  for (const order of ['exit-then-close', 'close-then-exit'] as const) {
    it(`the engine exits during the restore (${order}): the card names the exit code, whichever event came first`, async () => {
      const c = await parkedChat();
      engine.resume = order;
      const t0 = Date.now();
      const up = c.gate.whenUp(); // a message or a focus starts the restore
      await settle();
      expect(c.gate.current).toBe('failed');
      const p = last(c);
      expect(p).toMatchObject({ stage: 'failed', retry: true });
      expect(p.reason).toMatch(/code=3/);
      expect(typeof p.at).toBe('number');
      expect(p.at!).toBeGreaterThanOrEqual(t0);
      expect(p.details).toContain(p.reason);
      expect(p.details).toContain(new Date(p.at!).toISOString());
      expect(p.details).toMatch(/restor/i);
      expect(p.details).toContain('engine session ses_c1');
      expect(c.lines.some((l) => l.includes('code=3'))).toBe(true);
      void up;
    });
  }

  it('session/resume is refused: the card carries the engine`s own error text', async () => {
    const c = await parkedChat();
    engine.resume = 'refuse';
    void c.gate.whenUp();
    await settle();
    const p = last(c);
    expect(p.stage).toBe('failed');
    expect(p.reason).toContain('session not found: ses_c1');
    expect(p.details).toContain('session not found: ses_c1');
    expect(typeof p.at).toBe('number');
    expect(c.lines.some((l) => l.includes('session not found: ses_c1'))).toBe(true);
  });

  it('the engine does not answer the restore in time: the card says so, the hung engine is stopped, and Retry starts a fresh one', async () => {
    const c = await parkedChat(300);
    engine.resume = 'hang';
    void c.gate.whenUp();
    await settle(500);
    expect(c.gate.current).toBe('failed');
    const p = last(c);
    expect(p.reason).toMatch(/did not answer in 0\.3 s/);
    expect(p.retry).toBe(true);
    expect(children[1]!.kill).toHaveBeenCalled();
    expect(children[1]!.signalCode).toBe('SIGTERM');
    engine.resume = 'ok';
    await c.gate.retry();
    await settle();
    expect(c.gate.current).toBe('ready');
    expect(spawnMock.mock.calls.length).toBe(3);
    expect(calls.filter((x) => x.method === 'resumeSession').length).toBe(2);
    expect(last(c).stage).toBe('ready');
  });
});

describe('a first start that does not answer in time fails with Retry (it used to say "Starting" for ever)', () => {
  it('initialize never answers: failed, the engine is stopped, Retry starts it', async () => {
    const c = newChat();
    engine.initHang = true;
    const run = () => c.gate.start(async () => { await park.startWithin(c.client.start('/work', undefined, 'ses_c1'), () => c.client.stopStart(), 300); });
    void c.gate.hold(); // a message waits: the card is shown
    await run().catch(() => undefined);
    expect(c.gate.current).toBe('failed');
    expect(last(c).reason).toMatch(/did not answer in 0\.3 s/);
    expect(last(c).details).not.toMatch(/restor/i);
    expect(children[0]!.signalCode).toBe('SIGTERM');
    engine.initHang = false;
    await c.gate.retry();
    expect(c.gate.current).toBe('ready');
    expect(spawnMock.mock.calls.length).toBe(2);
  });
});

describe('DashboardPanel wiring (source guards: the panel cannot be built in a unit test)', () => {
  const src = (require('node:fs') as typeof import('node:fs')).readFileSync(require('node:path').join(__dirname, '..', '..', '..', 'src', 'dashboard', 'DashboardPanel.ts'), 'utf8');
  it('every chat start has the time limit and stops a hung engine', () => {
    expect(src).toMatch(/await startWithin\(session\.client\.start\([^\n]*\), \(\) => session\.client\.stopStart\(\)\)/);
  });
  it('the gate logs to "Origami Elastic" and names the chat and engine session in the details', () => {
    expect(src).toMatch(/new EngineGate\([^\n]*\{ log: elasticLog, describe: \(\) => engineDescribe\(/);
  });
  it('the card`s Open engine log is routed to engineLog.ts', () => {
    expect(src).toMatch(/if \(m\.type === 'openEngineLog'\) \{ void openEngineLog\(/);
  });
});
