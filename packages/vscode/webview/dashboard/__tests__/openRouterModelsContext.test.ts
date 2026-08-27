// fetchOpenRouterModels' context_length parsing.
//
// fetchModelInfo (localProbe.ts) already parses `context_length`, but ONLY
// reaches it through node:http's `http.get`, which THROWS synchronously on an
// https: URL — caught internally and resolved as a failed probe, so it never
// actually reaches OpenRouter's real `https://openrouter.ai/api/v1`. Every
// OpenRouter session read contextLength 0 forever as a result (see
// localProbe.ts's comment on the /v1/models fallback).
//
// fetchOpenRouterModels already uses the extension host's global `fetch`
// (https-capable) for the picker's catalog/pricing, so DashboardPanel.ts's
// refreshModelInfoFor now routes OpenRouter through it too. This pins the new
// parsing that depends on: reading `context_length` off each catalog entry
// into `contextLength`, against a REAL loopback HTTP server (not a mock of
// our own code) — the same discipline openRouterContext.test.ts uses for the
// sibling localProbe.ts parse.
//
// TEST-HARNESS WORKAROUND, not a product bug: the vitest config for this
// package runs `environment: 'jsdom'`. jsdom installs its OWN `AbortSignal`
// class alongside Node's; `fetch(url, { signal: AbortSignal.timeout(...) })`
// then fails with "Expected signal to be an instance of AbortSignal" because
// undici's fetch does a strict instanceof check against ITS OWN class, not
// jsdom's — a cross-realm mismatch that ONLY exists under jsdom. The real
// extension host is plain Node (no jsdom), so this never fires in production;
// fetchOpenRouterModels is intentionally untouched (its own header explains
// why it uses the global `fetch` directly rather than an injected one). The
// fetch stub below just forwards to node:http against the same real server,
// so the request/response round-trip — and therefore the parse under test —
// is still genuine; only the AbortSignal plumbing is bypassed.

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import * as http from 'node:http';
import { fetchOpenRouterModels } from '../../../src/dashboard/DashboardPanel';

type Routes = Record<string, { status?: number; body: unknown }>;

let server: http.Server | undefined;

async function serve(routes: Routes): Promise<string> {
  server = http.createServer((req, res) => {
    const route = routes[req.url ?? ''];
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(route ? (route.status ?? 200) : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(route ? route.body : { detail: 'Not Found' }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server!.address() as { port: number }).port;
  // fetchOpenRouterModels requests `${baseURL}/models` — routes above are
  // keyed at '/models' (bare), so the returned base carries no path prefix.
  return `http://127.0.0.1:${port}`;
}

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => new Promise((resolve, reject) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body) } as Response);
      });
    });
    req.on('error', reject);
  }));
});

afterEach(async () => {
  vi.stubGlobal('fetch', realFetch);
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe('fetchOpenRouterModels — context_length parsing', () => {
  it('reads context_length for each catalog entry', async () => {
    const base = await serve({
      '/models': {
        body: {
          data: [
            { id: 'moonshotai/kimi-k3', name: 'Kimi K3', context_length: 131072, pricing: { prompt: '0', completion: '0' } },
            { id: 'inclusionai/ling-3.0-flash:free', name: 'Ling 3.0 Flash', context_length: 262144, pricing: { prompt: '0', completion: '0' } },
          ],
        },
      },
    });
    const models = await fetchOpenRouterModels('key', base);
    expect(models.find((m) => m.id === 'moonshotai/kimi-k3')?.contextLength).toBe(131072);
    // Not the first entry's value — picking the wrong row would silently
    // overstate or understate a specific model's window.
    expect(models.find((m) => m.id === 'inclusionai/ling-3.0-flash:free')?.contextLength).toBe(262144);
  });

  it('leaves contextLength undefined when an entry carries none, rather than a fabricated 0', async () => {
    const base = await serve({
      '/models': { body: { data: [{ id: 'bare/model', name: 'Bare', pricing: { prompt: '0', completion: '0' } }] } },
    });
    const models = await fetchOpenRouterModels('key', base);
    expect(models[0]?.contextLength).toBeUndefined();
  });

  it('tolerates a string-typed context_length (JSON does not guarantee the number type)', async () => {
    const base = await serve({
      '/models': { body: { data: [{ id: 'str/ctx', name: 'Str', context_length: '65536', pricing: { prompt: '0', completion: '0' } }] } },
    });
    const models = await fetchOpenRouterModels('key', base);
    expect(models[0]?.contextLength).toBe(65536);
  });

  it('treats a non-positive or unparseable context_length as absent, not as 0 or NaN', async () => {
    const base = await serve({
      '/models': {
        body: {
          data: [
            { id: 'neg/ctx', context_length: -5, pricing: { prompt: '0', completion: '0' } },
            { id: 'junk/ctx', context_length: 'not-a-number', pricing: { prompt: '0', completion: '0' } },
          ],
        },
      },
    });
    const models = await fetchOpenRouterModels('key', base);
    expect(models.find((m) => m.id === 'neg/ctx')?.contextLength).toBeUndefined();
    expect(models.find((m) => m.id === 'junk/ctx')?.contextLength).toBeUndefined();
  });

  it('still parses pricing/free correctly alongside the new field (no regression on the existing shape)', async () => {
    const base = await serve({
      '/models': {
        body: {
          data: [{ id: 'paid/model', name: 'Paid', context_length: 32768, pricing: { prompt: '0.000003', completion: '0.000006' } }],
        },
      },
    });
    const [m] = await fetchOpenRouterModels('key', base);
    expect(m.free).toBe(false);
    expect(m.cost).toEqual({ input: 3, output: 6 });
    expect(m.contextLength).toBe(32768);
  });
});
