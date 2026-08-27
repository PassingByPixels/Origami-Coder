// The generic model probe has to speak https, not just http.
//
// THE HOLE: httpGetJson (localProbe.ts) was node:http only, and `http.get`
// THROWS synchronously — ERR_INVALID_PROTOCOL — on an https: URL. That throw was
// caught inside the probe and resolved as a failed probe, so the failure was
// completely silent: any non-OpenRouter provider on an https base (the
// opencode-go gateway at https://opencode.ai/zen/go/v1, a tailnet box behind
// TLS) read window 0 forever, and nothing anywhere said why. OpenRouter had
// already been special-cased AROUND this exact hole rather than through it.
//
// The transport is now chosen per URL. These tests pin the choice from the
// outside: node:https is replaced with a recording stand-in, node:http is left
// completely alone, and the two directions are asserted against each other —
// an https base must reach the https transport, an http base must never.
//
// A stand-in rather than a real TLS server on purpose: a self-signed cert would
// make the probe fail for a REASON THIS CHANGE DOES NOT ADDRESS (certificates
// are verified normally, deliberately), so the test would prove the wrong thing.
// Everything below the transport — the 2xx guard, the { ok, reason } contract,
// the Authorization header, the field precedence — is the same code the
// plain-http suites (selfHostedKeyProbe / openRouterContext / ollamaProbe) drive
// against real loopback servers.

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import * as http from 'node:http';

/** What the fake https server will answer, keyed by path, plus the log of what
 *  it was asked. Hoisted so the vi.mock factory below can close over them. */
const wire = vi.hoisted(() => ({
  routes: new Map<string, { status: number; body: unknown }>(),
  calls: [] as Array<{ url: string; auth: string | undefined; hadAuthHeader: boolean }>,
}));

vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events');
  const get = (url: string, opts: { headers?: Record<string, string> }, cb: (res: unknown) => void) => {
    const headers = opts?.headers ?? {};
    wire.calls.push({
      url,
      auth: headers.Authorization,
      // "absent" and "present but empty" are different things on the wire.
      hadAuthHeader: 'Authorization' in headers,
    });
    const req = new EventEmitter() as EventEmitter & { destroy: () => void };
    req.destroy = () => {};
    const route = wire.routes.get(new URL(url).pathname);
    // Answer on a later tick, exactly as a socket would: the caller attaches its
    // 'data'/'end' listeners inside the callback, so emitting inline would drop
    // the body and make a broken probe look like an empty one.
    queueMicrotask(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = route ? route.status : 404;
      cb(res);
      res.emit('data', JSON.stringify(route ? route.body : { detail: 'Not Found' }));
      res.emit('end');
    });
    return req;
  };
  return { get, default: { get } };
});

import { fetchModelInfo, fetchModelWindowFor } from '../../../src/dashboard/localProbe';

/** The Spark's real reply shape and its real window. */
const SERVED = { data: [{ id: 'deepseek-v4-flash-0731-ablit', max_model_len: 1048576 }] };
const HTTPS_BASE = 'https://s1.example-tailnet.ts.net/v1';

beforeEach(() => {
  wire.routes.clear();
  wire.calls.length = 0;
});

let server: http.Server | undefined;

/** A real loopback http server, so the unchanged half is genuinely exercised. */
async function servePlain(routes: Record<string, unknown>): Promise<string> {
  server = http.createServer((req, res) => {
    const body = routes[req.url ?? ''];
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? { detail: 'Not Found' }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as { port: number }).port}/v1`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe('fetchModelInfo over https', () => {
  it('reads the real window off an https server instead of reporting 0', async () => {
    // The defect in one line: before the transport was chosen per URL, this came
    // back { ok: false, contextLength: 0 } for every https endpoint, forever.
    wire.routes.set('/v1/models', { status: 200, body: SERVED });
    const info = await fetchModelInfo(HTTPS_BASE, 'deepseek-v4-flash-0731-ablit');
    expect(info.ok).toBe(true);
    expect(info.modelId).toBe('deepseek-v4-flash-0731-ablit');
    expect(info.contextLength).toBe(1048576);
  });

  it('probes the same two endpoints, in the same order, as it does over http', async () => {
    wire.routes.set('/v1/models', { status: 200, body: SERVED });
    await fetchModelInfo(HTTPS_BASE);
    expect(wire.calls.map((c) => new URL(c.url).pathname))
      .toEqual(['/api/v0/models', '/v1/models']);
  });

  it('carries an API key onto an https probe', async () => {
    wire.routes.set('/v1/models', { status: 200, body: SERVED });
    await fetchModelInfo(HTTPS_BASE, undefined, 'sk-spark');
    expect(wire.calls.map((c) => c.auth)).toEqual(['Bearer sk-spark', 'Bearer sk-spark']);
  });

  it('sends NO Authorization header at all when there is no key', async () => {
    wire.routes.set('/v1/models', { status: 200, body: SERVED });
    await fetchModelInfo(HTTPS_BASE);
    expect(wire.calls.every((c) => !c.hadAuthHeader)).toBe(true);
  });

  it('keeps the { ok, reason } failure contract — a refusing https server is a failed probe, not a throw', async () => {
    wire.routes.set('/v1/models', { status: 500, body: { error: 'boom' } });
    const info = await fetchModelInfo(HTTPS_BASE);
    expect(info.ok).toBe(false);
    expect(info.state).toBe('unreachable');
    expect(info.reason).toContain('s1.example-tailnet.ts.net');
  });

  it('an unparseable URL is still a failed probe, not a rejected promise', async () => {
    await expect(fetchModelInfo('https://')).resolves.toMatchObject({ ok: false, contextLength: 0 });
  });
});

// The window that gets PERSISTED has a stricter bar than the one that gets
// displayed: a wrong number written into limit.context is acted on by the engine
// for the life of the connection, whereas a wrong gauge is looked at once.
describe('fetchModelWindowFor — only a window the server answered ABOUT THIS MODEL', () => {
  it('returns the window when the server answered about the model asked for', async () => {
    const base = await servePlain({ '/v1/models': SERVED });
    expect(await fetchModelWindowFor(base, 'deepseek-v4-flash-0731-ablit')).toBe(1048576);
  });

  it('refuses a window that belongs to a DIFFERENT model', async () => {
    // LM Studio's /api/v0/models answers about whatever is LOADED, while the
    // connect flow auto-picks the first id in the library — which need not be the
    // same model. Baking the loaded model's 65536 onto the picked one would be a
    // fabricated pairing, and 0 (honest unknown) is the right answer instead.
    const base = await servePlain({
      '/api/v0/models': { data: [{ id: 'other/model-loaded', type: 'llm', state: 'loaded', loaded_context_length: 65536 }] },
    });
    expect(await fetchModelWindowFor(base, 'qwen/qwen3-coder-30b')).toBe(0);
  });

  it('an unreachable server is 0, never a throw', async () => {
    expect(await fetchModelWindowFor('http://127.0.0.1:1/v1', 'm')).toBe(0);
  });
});

describe('http is untouched by the https path', () => {
  it('a plain-http server is served by node:http — the https transport is never reached', async () => {
    const base = await servePlain({ '/v1/models': SERVED });
    const info = await fetchModelInfo(base, 'deepseek-v4-flash-0731-ablit');
    expect(info.contextLength).toBe(1048576);
    // The regression this guards: routing everything through https, which would
    // break every loopback LM Studio / vLLM in the process.
    expect(wire.calls).toEqual([]);
  });
});
