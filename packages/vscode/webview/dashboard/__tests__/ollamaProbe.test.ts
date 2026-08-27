// Ollama had NO context probe at all.
//
// fetchModelInfo had exactly two branches: LM Studio's `/api/v0/models` and the
// generic OpenAI-compatible `/v1/models`. Ollama answers the second one — but its
// entries carry NEITHER `max_model_len` NOR `max_context_length`, so an Ollama
// provider always resolved to contextLength 0. Zero means no gauge and (once the
// window is persisted for the engine) no auto-compaction. The real window only
// exists on Ollama's NATIVE api, which nothing in the repo ever called.
//
// These run against a REAL loopback http server impersonating each server flavor,
// so the branch selection, the /api/tags gate and the parsing are all exercised
// for real rather than through a mock of our own code.
//
// HONESTY NOTE: no live Ollama was reachable when this was written (nothing was
// listening on 11434), so the /api/show REQUEST and RESPONSE shapes are taken
// from its documented API and are UNVERIFIED against a real server. The
// implementation is therefore deliberately permissive — it accepts every known
// response variant and falls back to the previous behaviour (0) on anything it
// does not recognise. The last two tests pin that fallback, which is the part
// that matters if the real shape turns out to differ.

import { describe, expect, it, afterEach } from 'vitest';
import * as http from 'node:http';
import { fetchModelInfo } from '../../../src/dashboard/localProbe';

type Routes = Record<string, { status?: number; body: unknown }>;

let server: http.Server | undefined;
/** Stand up a loopback server that answers only the routes given; anything else
 *  404s with a JSON body — exactly how a real server behaves for a route it
 *  doesn't implement (and the reason the probe requires a 2xx). */
async function serve(routes: Routes): Promise<string> {
  server = http.createServer((req, res) => {
    const route = routes[req.url ?? ''];
    // Drain the body so a POST completes even when the route ignores it.
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

const OLLAMA_MODELS = { data: [{ id: 'llama3.1:8b', object: 'model' }] };
const TAGS = { models: [{ name: 'llama3.1:8b' }] };

describe('fetchModelInfo — Ollama context window', () => {
  it('reads the window from the native /api/show model_info (the documented shape)', async () => {
    const base = await serve({
      '/api/tags': { body: TAGS },
      '/v1/models': { body: OLLAMA_MODELS },
      // Arch-prefixed key — the prefix varies per model, hence the suffix scan.
      '/api/show': { body: { model_info: { 'llama.context_length': 131072, 'llama.block_count': 32 } } },
    });
    const info = await fetchModelInfo(base);
    expect(info.ok).toBe(true);
    expect(info.modelId).toBe('llama3.1:8b');
    expect(info.contextLength).toBe(131072);
  });

  it('accepts a bare context_length and a num_ctx parameters line (older/variant shapes)', async () => {
    const flat = await serve({
      '/api/tags': { body: TAGS },
      '/v1/models': { body: OLLAMA_MODELS },
      '/api/show': { body: { context_length: 8192 } },
    });
    expect((await fetchModelInfo(flat)).contextLength).toBe(8192);
    await new Promise<void>((r) => server!.close(() => r()));

    const params = await serve({
      '/api/tags': { body: TAGS },
      '/v1/models': { body: OLLAMA_MODELS },
      '/api/show': { body: { parameters: 'stop "<|eot_id|>"\nnum_ctx 16384\n' } },
    });
    expect((await fetchModelInfo(params)).contextLength).toBe(16384);
  });

  it('does NOT touch the native api when /v1 already reported a window (vLLM keeps its own answer)', async () => {
    // /api/show is deliberately absent: reaching for it here would 404 and the
    // real max_model_len would be at risk. A vLLM must be untouched by this branch.
    const base = await serve({
      '/v1/models': { body: { data: [{ id: 'spec-test', max_model_len: 262144 }] } },
    });
    expect((await fetchModelInfo(base)).contextLength).toBe(262144);
  });

  it('is GATED on the server actually being an Ollama — no /api/tags, no native probe', async () => {
    // A loopback OpenAI-compatible server that is NOT Ollama but WOULD answer
    // /api/show with a plausible number. Without the gate we would swallow it.
    const base = await serve({
      '/v1/models': { body: { data: [{ id: 'mystery-model' }] } },
      '/api/show': { body: { model_info: { 'x.context_length': 999999 } } },
    });
    const info = await fetchModelInfo(base);
    expect(info.contextLength).toBe(0); // unknown stays unknown, never borrowed
  });

  // --- the hedge: unverified shape must degrade, never corrupt ---

  it('an UNRECOGNISED /api/show body falls back to the previous behaviour (0), never a guess', async () => {
    const base = await serve({
      '/api/tags': { body: TAGS },
      '/v1/models': { body: OLLAMA_MODELS },
      '/api/show': { body: { details: { family: 'llama' }, capabilities: ['completion'] } },
    });
    const info = await fetchModelInfo(base);
    expect(info.ok).toBe(true);          // the model itself is still reported
    expect(info.contextLength).toBe(0);  // but we do not invent a window
  });

  it('a failing/absent /api/show does not break the probe', async () => {
    const base = await serve({
      '/api/tags': { body: TAGS },
      '/v1/models': { body: OLLAMA_MODELS },
      '/api/show': { status: 500, body: { error: 'boom' } },
    });
    const info = await fetchModelInfo(base);
    expect(info.ok).toBe(true);
    expect(info.contextLength).toBe(0);
  });

  it('rejects a nonsense window rather than passing it through', async () => {
    const base = await serve({
      '/api/tags': { body: TAGS },
      '/v1/models': { body: OLLAMA_MODELS },
      '/api/show': { body: { model_info: { 'llama.context_length': -1 } } },
    });
    expect((await fetchModelInfo(base)).contextLength).toBe(0);
  });
});
