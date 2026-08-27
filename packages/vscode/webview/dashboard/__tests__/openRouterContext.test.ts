// An aggregator's context window must come from the aggregator, not from a
// snapshot baked into the engine binary at build time.
//
// The engine carries a models.dev snapshot compiled in at build time. It is
// accurate on the day a build ships (measured against the live OpenRouter
// catalogue: 365 of 367 models correct) and drifts from then on. For a shipped
// marketplace release that drift is unbounded: a model added after the build is
// absent (window 0 => no gauge, no auto-compaction), and a model whose window
// SHRANK is read at its old larger value, so compaction fires too late and the
// turn dies mid-task with a context-length error.
//
// OpenRouter publishes `context_length` for every model it routes, in the same
// /v1/models call the probe already makes. Reading it makes the window live and
// self-correcting regardless of how old the binary is.
//
// These run against a real loopback server rather than a mock of our own code,
// so the field precedence and the parse are genuinely exercised.

import { describe, expect, it, afterEach } from 'vitest';
import * as http from 'node:http';
import { fetchModelInfo } from '../../../src/dashboard/localProbe';

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
  return `http://127.0.0.1:${port}/v1`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

// Shape taken from the live OpenRouter catalogue: `context_length` at the top
// level, no max_model_len and no max_context_length anywhere.
const OPENROUTER_MODELS = {
  data: [
    { id: 'inclusionai/ling-3.0-flash:free', name: 'Ling 3.0 Flash', context_length: 262144 },
    { id: 'moonshotai/kimi-k3', name: 'Kimi K3', context_length: 131072 },
  ],
};

describe('fetchModelInfo — aggregator (OpenRouter) context window', () => {
  it('reads context_length for the requested model, not the first in the list', async () => {
    const base = await serve({ '/v1/models': { body: OPENROUTER_MODELS } });
    const info = await fetchModelInfo(base, 'moonshotai/kimi-k3');
    expect(info.ok).toBe(true);
    expect(info.modelId).toBe('moonshotai/kimi-k3');
    // 131072, not the 262144 of the first entry — picking the wrong row would
    // overstate the window by 2x and delay compaction past the real ceiling.
    expect(info.contextLength).toBe(131072);
  });

  it('resolves a variant-suffixed id (:free) exactly', async () => {
    const base = await serve({ '/v1/models': { body: OPENROUTER_MODELS } });
    expect((await fetchModelInfo(base, 'inclusionai/ling-3.0-flash:free')).contextLength).toBe(262144);
  });

  it('prefers max_model_len when a server publishes both', async () => {
    // A self-hosted server's own runtime limit is the real ceiling; a catalogue
    // figure alongside it describes the model, not what this server will accept.
    const base = await serve({
      '/v1/models': { body: { data: [{ id: 'local/m', max_model_len: 32768, context_length: 262144 }] } },
    });
    expect((await fetchModelInfo(base, 'local/m')).contextLength).toBe(32768);
  });

  it('still reports 0 when a server publishes no window at all', async () => {
    // The honest-unknown path: better no number than a fabricated one. (Ollama
    // is the one exception and has its own native probe.)
    const base = await serve({ '/v1/models': { body: { data: [{ id: 'bare/model' }] } } });
    expect((await fetchModelInfo(base, 'bare/model')).contextLength).toBe(0);
  });
});
