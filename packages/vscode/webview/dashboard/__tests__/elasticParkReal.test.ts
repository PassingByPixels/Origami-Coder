// elasticParkReal.test.ts — t-w2txb2 end to end, OPT-IN (ELASTIC_REAL=1): the REAL AcpClient, EngineGate and
// park mechanics against a REAL engine process run from this checkout's source (origami.devEngineSource),
// on an isolated home and store in a temp folder, with a fake OpenAI-compatible model served here. Nothing
// is mocked between the extension and the engine: the ACP SDK, `_elastic_park`, the stdin EOF stop and
// `session/resume` are the real ones. Off by default because it starts engine processes (about 20 s).
//
//   ELASTIC_REAL=1 npx vitest run webview/dashboard/__tests__/elasticParkReal.test.ts

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ENGINE_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../engine');
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: (key: string) => (key === 'devEngineSource' ? ENGINE_SRC : undefined) }) },
}));

import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';
import { EngineGate } from '../../../src/dashboard/engineGate';
import { parkChat } from '../../../src/elastic/park';
import { deferChat } from '../../../src/elastic/reloadDefer';

const REAL = !!process.env['ELASTIC_REAL'];
const ROOT = REAL ? mkdtempSync(path.join(os.tmpdir(), 'origami-park-real-')) : '';
const WORK = path.join(ROOT, 'work');
const bodies: Array<{ sha: string; body: string }> = [];
let server: http.Server | undefined;

const SECRET = /KEY|TOKEN|SECRET|PASSWORD|ANTHROPIC|OPENAI|CLAUDE|GEMINI|OPENROUTER|AZURE|AWS_|GOOGLE|HF_|GITHUB|GITEA/i;
const LIVE = /\.local[\\/]+share[\\/]+origami|\.config[\\/]+origami|[\\/]\.origami(?:[\\/;]|$)/i;

/** This test process's env becomes the engine's (AcpClient spawns with process.env): every home and store
 *  path inside ROOT, no secrets, no proxy off the machine. Throws when isolation does not hold. */
function isolate(port: number): void {
  for (const k of Object.keys(process.env)) if (SECRET.test(k) || k.startsWith('XDG_') || k.startsWith('ORIGAMI_') || /proxy/i.test(k)) delete process.env[k];
  const home = path.join(ROOT, 'home');
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(ROOT, 'xdg', 'data'), XDG_CONFIG_HOME: path.join(ROOT, 'xdg', 'config'), XDG_CACHE_HOME: path.join(ROOT, 'xdg', 'cache'), XDG_STATE_HOME: path.join(ROOT, 'xdg', 'state'),
    ORIGAMI_TEST_HOME: home, TEMP: path.join(ROOT, 'tmp'), TMP: path.join(ROOT, 'tmp'),
    ORIGAMI_DISABLE_FLOCK: '1', ORIGAMI_DISABLE_AUTOUPDATE: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
  });
  for (const d of ['xdg/data', 'xdg/config/origami', 'xdg/cache', 'xdg/state', 'home/AppData/Roaming', 'home/AppData/Local', 'tmp']) mkdirSync(path.join(ROOT, d), { recursive: true });
  for (const [k, v] of Object.entries(process.env)) if (v && LIVE.test(v)) throw new Error(`isolation: ${k} names a live path`);
  writeFileSync(path.join(ROOT, 'xdg', 'config', 'origami', 'origami.json'), JSON.stringify({
    model: 'fake/m', small_model: 'fake/m', enabled_providers: ['fake'],
    provider: { fake: { npm: '@ai-sdk/openai-compatible', name: 'Fake', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x' }, models: { m: { name: 'm', tool_call: true, limit: { context: 1_000_000, output: 8192 } } } } },
    permission: { bash: 'allow', edit: 'allow', read: 'allow', external_directory: 'allow' },
  }));
}

function chat() {
  const rows: string[] = [];
  const closed: string[] = [];
  const own: Record<string, unknown> = {
    onUserMessageChunk: (t: string) => rows.push(`user:${t}`),
    onAgentMessageChunk: (t: string) => rows.push(`agent:${t}`),
    onClose: (reason: string) => { if (!gate.exited(reason)) closed.push(reason); },
  };
  // Every other handler is a no-op here, as the panel's are for this test's purpose.
  const handlers = new Proxy(own, { get: (t, k: string) => t[k] ?? (() => undefined) }) as unknown as AcpEventHandlers;
  const client = new AcpClient(handlers);
  const gate = new EngineGate(() => undefined);
  return { client, gate, rows, closed };
}

beforeAll(async () => {
  if (!REAL) return;
  server = http.createServer((req, res) => {
    if (req.url?.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'm' }] })); return; }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw) as { tools?: unknown[]; messages?: Array<{ role?: string }> };
      const users = (body.messages ?? []).filter((m) => m.role === 'user').length; // t-wypna7: the answer depends on the conversation only, so two chats with the same history hold the same bytes
      if ((body.tools?.length ?? 0) > 0) bodies.push({ sha: createHash('sha256').update(raw).digest('hex'), body: raw });
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(chunk({ role: 'assistant', content: `answer ${users}` }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  isolate((server.address() as { port: number }).port);
  mkdirSync(WORK, { recursive: true });
  writeFileSync(path.join(WORK, 'README.md'), '# work\n');
  execFileSync('git', ['init', '-q'], { cwd: WORK });
}, 60_000);

afterAll(async () => {
  server?.close();
  if (!REAL || process.env['ELASTIC_KEEP']) return;
  // The last engine exits after its 2 s grace (engineShutdown.ts); until then Windows holds its files.
  for (let i = 0; i < 10; i++) {
    try { rmSync(ROOT, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
}, 30_000);

describe.skipIf(!REAL)('park and restore against a real engine', () => {
  it('parks on the engine\'s word, restores the same session silently, and the next turn continues the chat', async () => {
    const c = chat();
    await c.gate.start(async () => { await c.client.start(WORK); });
    const sid = c.client.currentSessionId!;
    const firstPid = c.client.pid;
    expect((await c.gate.turn(() => c.client.prompt('REAL-1 first message'))).sent).toBe(true);
    const rowsAfterTurn1 = [...c.rows];
    expect(rowsAfterTurn1.some((r) => r.startsWith('agent:answer'))).toBe(true);

    const t0 = Date.now();
    expect(await parkChat(c, () => undefined)).toBeNull();
    const parkMs = Date.now() - t0;
    expect(c.gate.current).toBe('parked');
    expect(c.client.pid).toBeUndefined();
    expect(c.closed).toEqual([]);
    expect(c.client.currentSessionId).toBe(sid);
    // the engine left a peer stand-in for the chat, in the ISOLATED home
    const parkedDir = path.join(ROOT, 'home', '.origami', 'agents', 'parked');
    expect(existsSync(parkedDir) ? readdirSync(parkedDir) : []).toEqual([`${sid}.json`]);

    const t1 = Date.now();
    const turn2 = await c.gate.turn(() => c.client.prompt('REAL-2 after the park'));
    const restoreAndTurnMs = Date.now() - t1;
    expect(turn2.sent).toBe(true);
    expect(c.client.pid).not.toBe(firstPid);
    expect(c.client.currentSessionId).toBe(sid);
    // silent: no replayed history rows, only the new turn's own
    expect(c.rows.slice(0, rowsAfterTurn1.length)).toEqual(rowsAfterTurn1);
    const added = c.rows.slice(rowsAfterTurn1.length);
    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((r) => r.startsWith('user:') || rowsAfterTurn1.includes(r))).toEqual([]);
    // the second engine continued the SAME conversation: turn 1 is in the request it sent
    const last = bodies.at(-1)!.body;
    expect(last).toContain('REAL-1 first message');
    expect(last).toContain('REAL-2 after the park');
    // the stand-in went when the engine resumed the session
    expect(existsSync(parkedDir) ? readdirSync(parkedDir) : []).toEqual([]);
    console.log(`[elasticParkReal] park ${parkMs} ms; restore + turn ${restoreAndTurnMs} ms; engine pids ${firstPid} -> ${c.client.pid}`);
    c.client.dispose();
  }, 180_000);

  it('t-wdyi2t: an _elastic_* call does not wake a parked engine, and a /plan switch survives a real park and restore', async () => {
    const c = chat();
    await c.gate.start(async () => { await c.client.start(WORK); });
    expect((await c.gate.turn(() => c.client.prompt('REAL-3 in build'))).sent).toBe(true);
    expect(c.client.getModeOption()?.options.map((o) => o.value)).toContain('plan');
    await c.client.setSessionMode('plan'); // the /plan command path (DashboardPanel MODE_COMMANDS), no prompt since
    expect(await parkChat(c, () => undefined)).toBeNull();
    await expect(c.client.extMethod('_elastic_trim', {})).rejects.toThrow();
    expect(c.client.pid).toBeUndefined();
    expect(c.gate.current).toBe('parked');
    expect((await c.gate.turn(() => c.client.prompt('REAL-4 after the park'))).sent).toBe(true);
    expect(c.client.getModeOption()?.current).toBe('plan'); // the restored engine's own answer
    c.client.dispose();
  }, 180_000);

  it('t-wypna7: a chat reopened at a reload WITHOUT its engine starts on its first message with the same request bytes as a reload today', async () => {
    // Two chats with the same history, as a window left them (their engines end with the window).
    const make = async (tag: string) => {
      const c = chat();
      await c.gate.start(async () => { await c.client.start(WORK); });
      expect((await c.gate.turn(() => c.client.prompt('REAL-5 same history'))).sent).toBe(true);
      const sid = c.client.currentSessionId!;
      c.client.dispose();
      await new Promise((r) => setTimeout(r, 2500)); // engineShutdown.ts grace
      return { sid, tag };
    };
    const today = await make('today');
    const later = await make('deferred');
    // Today's reload: the reopen starts the engine at once (DashboardPanel createSession -> session/load).
    const t = chat();
    await t.gate.start(async () => { await t.client.start(WORK, undefined, today.sid); });
    expect(t.rows).toContain('user:REAL-5 same history'); // the load replays the transcript
    const n0 = bodies.length;
    expect((await t.gate.turn(() => t.client.prompt('REAL-6 after the reload'))).sent).toBe(true);
    const todayBody = bodies.slice(n0).map((b) => b.body);
    // Deferred: no engine at the reopen; the first message starts it with the same load.
    const d = chat();
    const standIns: string[] = [];
    await deferChat({ client: d.client, gate: d.gate, cwd: WORK, number: 2 }, later.sid, { run: async () => { await d.client.start(WORK, undefined, later.sid); } }, { deferred: (sid) => void standIns.push(sid) }, () => undefined);
    expect(d.client.pid).toBeUndefined();
    expect(d.client.currentSessionId).toBe(later.sid);
    expect(standIns).toEqual([later.sid]);
    const n1 = bodies.length;
    expect((await d.gate.turn(() => d.client.prompt('REAL-6 after the reload'))).sent).toBe(true);
    expect(d.rows).toContain('user:REAL-5 same history');
    const deferredBody = bodies.slice(n1).map((b) => b.body);
    // Byte identity, with each chat's own session id (and message ids made from it) written as one token.
    const norm = (raw: string[], sid: string) => raw.map((b) => b.split(sid).join('<SID>'));
    expect(deferredBody.length).toBe(todayBody.length);
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(norm(deferredBody, later.sid).map(sha)).toEqual(norm(todayBody, today.sid).map(sha));
    console.log(`[elasticParkReal] t-wypna7: ${todayBody.length} request(s), sha ${sha(norm(todayBody, today.sid)[0]!).slice(0, 12)} both paths`);
    t.client.dispose();
    d.client.dispose();
  }, 240_000);
});
