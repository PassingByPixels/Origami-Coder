// A self-hosted server MAY require an API key ("I could require an API for LM
// studio if i wanted"). Storing one is only half a feature — if the endpoint
// probes stay keyless, a key-protected LM Studio answers 401 to every one of
// them, `fetchLmStudioModels` returns [], and the provider reads "no model
// reachable" FOREVER while the model itself answers chat turns fine. The pill
// never lights, the model list stays empty, and the context gauge reads 0.
//
// So these tests assert the header on the WIRE, not a config field: a real
// loopback http server records what arrived. Two directions matter equally —
//
//   keyed   -> Authorization: Bearer <key> is present and exact
//   keyless -> NO Authorization header AT ALL (not empty, not "Bearer ")
//
// The second is the one that protects the overwhelmingly common case. An
// unauthenticated LM Studio must receive a byte-identical request to the one it
// received before this feature existed.
//
// The server harness mirrors ollamaProbe.test.ts / openRouterContext.test.ts —
// a real node:http server rather than a mock of our own fetch, so the node:http
// header plumbing is genuinely exercised.

import { describe, expect, it, afterEach } from 'vitest';
import * as http from 'node:http';
import { fetchModelInfo, fetchLmStudioModels, detectLocalFlavor } from '../../../src/dashboard/localProbe';

type Recorded = { url: string; auth: string | undefined; hadAuthHeader: boolean };

let server: http.Server | undefined;
let recorded: Recorded[] = [];

/** A loopback server that records every request's Authorization header and,
 *  when `requireKey` is set, 401s anything that does not carry the right one —
 *  which is exactly how a key-protected LM Studio / vLLM behaves. */
async function serve(
  routes: Record<string, { status?: number; body: unknown }>,
  requireKey?: string,
): Promise<string> {
  server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    recorded.push({
      url: req.url ?? '',
      auth,
      // Distinguish "absent" from "present but empty" — an empty-but-present
      // header would still be a change on the wire for a keyless server.
      hadAuthHeader: 'authorization' in req.headers,
    });
    req.on('data', () => {});
    req.on('end', () => {
      if (requireKey && auth !== `Bearer ${requireKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const route = routes[req.url ?? ''];
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
  recorded = [];
});

const V0_MODELS = { data: [{ id: 'qwen/qwen3-coder-30b', type: 'llm', state: 'loaded', loaded_context_length: 32768 }] };
const V1_MODELS = { data: [{ id: 'qwen/qwen3-coder-30b', max_model_len: 32768 }] };

describe('fetchLmStudioModels — the add-flow + status probe', () => {
  it('sends Authorization: Bearer when a key is configured', async () => {
    const base = await serve({ '/api/v0/models': { body: V0_MODELS } }, 'lms-secret-123');
    const ids = await fetchLmStudioModels(base, 'lms-secret-123');

    expect(ids, 'a keyed server must be readable').toEqual(['qwen/qwen3-coder-30b']);
    expect(recorded[0].auth).toBe('Bearer lms-secret-123');
  });

  it('a key-protected server is UNREADABLE without the key — the bug this fixes', async () => {
    // Proves the 401 path is real rather than assumed: same server, no key.
    const base = await serve({ '/api/v0/models': { body: V0_MODELS } }, 'lms-secret-123');
    expect(await fetchLmStudioModels(base)).toEqual([]);
    expect(recorded.every((r) => !r.hadAuthHeader)).toBe(true);
  });

  it('sends NO Authorization header at all when keyless (the unchanged default)', async () => {
    const base = await serve({ '/api/v0/models': { body: V0_MODELS } });
    expect(await fetchLmStudioModels(base)).toEqual(['qwen/qwen3-coder-30b']);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].hadAuthHeader, 'a keyless probe must be byte-identical to before').toBe(false);
    expect(recorded[0].auth).toBeUndefined();
  });

  it('an EMPTY-STRING key is treated as no key, never as "Bearer "', async () => {
    const base = await serve({ '/api/v0/models': { body: V0_MODELS } });
    await fetchLmStudioModels(base, '');
    expect(recorded[0].hadAuthHeader).toBe(false);
  });

  it('carries the key onto the /v1/models FALLBACK too, not just /api/v0', async () => {
    // A vLLM/SGLang has no /api/v0, so the fallback is the only path that runs —
    // if the key were threaded onto the first probe only, this would 401.
    const base = await serve({ '/v1/models': { body: V1_MODELS } }, 'sk-spark');
    expect(await fetchLmStudioModels(base, 'sk-spark')).toEqual(['qwen/qwen3-coder-30b']);
    expect(recorded.map((r) => r.auth)).toEqual(['Bearer sk-spark', 'Bearer sk-spark']);
  });
});

describe('fetchModelInfo — the chat-pane context/liveness probe', () => {
  it('reads a keyed server, reporting the real loaded model and window', async () => {
    const base = await serve({ '/api/v0/models': { body: V0_MODELS } }, 'lms-secret-123');
    const info = await fetchModelInfo(base, undefined, 'lms-secret-123');

    expect(info.ok).toBe(true);
    expect(info.modelId).toBe('qwen/qwen3-coder-30b');
    expect(info.contextLength).toBe(32768);
    expect(recorded[0].auth).toBe('Bearer lms-secret-123');
  });

  it('keyless stays keyless — no header added to the existing call shape', async () => {
    const base = await serve({ '/api/v0/models': { body: V0_MODELS } });
    expect((await fetchModelInfo(base)).ok).toBe(true);
    expect(recorded[0].hadAuthHeader).toBe(false);
  });
});

describe('detectLocalFlavor — the lms-vs-Ollama capability probe', () => {
  it('still identifies a keyed LM Studio (it would read as "other" unauthenticated)', async () => {
    const base = await serve({ '/api/v0/models': { body: V0_MODELS } }, 'lms-secret-123');
    expect(await detectLocalFlavor(base, 'lms-secret-123')).toBe('lmstudio');
  });

  it('still identifies a keyed Ollama off /api/tags', async () => {
    const base = await serve({ '/api/tags': { body: { models: [{ name: 'llama3.1:8b' }] } } }, 'ollama-key');
    expect(await detectLocalFlavor(base, 'ollama-key')).toBe('ollama');
  });

  it('keyless detection is unchanged', async () => {
    const base = await serve({ '/api/v0/models': { body: V0_MODELS } });
    expect(await detectLocalFlavor(base)).toBe('lmstudio');
    expect(recorded[0].hadAuthHeader).toBe(false);
  });
});
