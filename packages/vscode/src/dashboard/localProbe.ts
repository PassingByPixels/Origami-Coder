// HTTP probes against a self-hosted OpenAI-compatible server — LM Studio, Ollama, vLLM, SGLang,
// llama.cpp — extracted whole out of DashboardPanel.ts at its architecture cap. Every function here
// answers a question about a remote server over node:http; the lms CLI helpers (which drive a local
// process, not an endpoint) stayed behind.
//
// node:http/https, not fetch, on purpose: these are the user's own servers, and the transport is
// picked per URL since http.get throws on an https base. OpenRouter keeps its own fetch probe
// elsewhere — a policy choice about its window, not a transport gap.
//
// Every probe takes an optional apiKey: a self-hosted server may enforce auth, and no key means no
// Authorization header at all, never an empty one.

import * as http from 'node:http';
import * as https from 'node:https';
import { isLoopbackBaseUrl, detectLocalProvider, readGlobalProviders } from './firstFold';

/**
 * Query LM Studio's /api/v0/models endpoint for the real context length (the internal LM Studio
 *  API, not the OpenAI-compatible /v1 layer) — loaded_context_length for the active model.
 */
export interface ModelInfo {
  ok: boolean;
  modelId: string;
  contextLength: number;
  state: string;
  reason?: string;
  /** LM Studio model type from /api/v0/models: "vlm" (vision), "llm", … */
  type?: string;
}

/** GET + parse JSON, best-effort. apiKey is optional and the default path is unchanged: no key
 *  configured means no Authorization header at all, so a keyless server gets byte-identical
 *  requests. */
function httpGetJson(url: string, timeoutMs = 4000, apiKey?: string): Promise<{ ok: true; json: any } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const onRes = (res: http.IncomingMessage): void => {
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        // `ok` must mean the server answered THIS endpoint successfully, not merely returned
        // parseable JSON — FastAPI/Starlette servers (vLLM, LiteLLM) reply to an unknown route with
        // a 404 whose body is valid JSON, so probing /api/v0/models against vLLM would otherwise
        // mis-detect it as LM Studio. Require 2xx.
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) { resolve({ ok: false, reason: `http ${status || '?'}` }); return; }
        try { resolve({ ok: true, json: JSON.parse(body) }); }
        catch (e) { resolve({ ok: false, reason: `parse error: ${String(e)}` }); }
      });
    };
    // `get` THROWS synchronously (not an 'error' event) for a URL its own module can't handle — a
    // malformed one, or an https base for node:http. Unguarded, that would break the "best-effort,
    // never throws" contract every caller relies on, so it is resolved as a failed probe. Picking
    // the module by scheme is what makes an https self-hosted server probeable at all; certificates
    // are verified normally.
    let req: http.ClientRequest;
    try {
      const opts = { timeout: timeoutMs, ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}) };
      req = /^https:/i.test(url) ? https.get(url, opts, onRes) : http.get(url, opts, onRes);
    } catch (e) { resolve({ ok: false, reason: e instanceof Error ? e.message : String(e) }); return; }
    req.on('error', (e) => resolve({ ok: false, reason: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'request timed out' }); });
  });
}

/** POST a JSON body and parse a JSON reply. Same contract/guards as httpGetJson
 *  (2xx only, node:http ⇒ loopback/plain-HTTP servers). Ollama's `/api/show` is
 *  the only POST probe we make. */
function httpPostJson(url: string, body: unknown, timeoutMs = 4000): Promise<{ ok: true; json: any } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let payload: string;
    try { payload = JSON.stringify(body); } catch (e) { resolve({ ok: false, reason: `bad body: ${String(e)}` }); return; }
    const req = http.request(
      url,
      { method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let text = '';
        res.on('data', (chunk: string) => { text += chunk; });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) { resolve({ ok: false, reason: `http ${status || '?'}` }); return; }
          try { resolve({ ok: true, json: JSON.parse(text) }); }
          catch (e) { resolve({ ok: false, reason: `parse error: ${String(e)}` }); }
        });
      },
    );
    req.on('error', (e) => resolve({ ok: false, reason: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'request timed out' }); });
    req.end(payload);
  });
}

/**
 * Ollama's context window for one model, from its native /api/show (the OpenAI-compat /v1/models
 *  reports no window at all).
 * Defensive by design — every known request/response variant is tolerated and any mismatch falls
 *  back to 0, i.e. the previous behaviour: sends both `model` and `name` keys, accepts
 *  `model_info["<arch>.context_length"]`, a bare `context_length`, or a `num_ctx` line in
 *  `parameters`. Never a guess.
 */
async function fetchOllamaContextLength(base: string, modelId: string): Promise<number> {
  const res = await httpPostJson(`${base}/api/show`, { model: modelId, name: modelId });
  if (!res.ok) return 0;
  const toCtx = (v: unknown): number => {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const json = res.json;
  if (!json || typeof json !== 'object') return 0;
  const info = json.model_info;
  if (info && typeof info === 'object') {
    for (const [k, v] of Object.entries(info as Record<string, unknown>)) {
      if (k === 'context_length' || k.endsWith('.context_length')) {
        const n = toCtx(v);
        if (n) return n;
      }
    }
  }
  const flat = toCtx(json.context_length);
  if (flat) return flat;
  if (typeof json.parameters === 'string') {
    const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(json.parameters);
    if (m) return toCtx(m[1]);
  }
  return 0;
}

/**
 * Probe the configured inference server for a loaded model: try LM Studio's internal /api/v0/models
 *  first (richest data), then fall back to the OpenAI-compatible /v1/models. Either returning at
 *  least one model marks the connection ok, even with no real context length.
 */
export async function fetchModelInfo(apiBase: string, targetModelId?: string, apiKey?: string): Promise<ModelInfo> {
  const base = apiBase.replace(/\/v1\/?$/, '').replace(/\/+$/, '');

  // --- Primary: LM Studio /api/v0 ---
  const v0 = await httpGetJson(`${base}/api/v0/models`, undefined, apiKey);
  if (v0.ok) {
    const models = v0.json?.data ?? v0.json;
    if (Array.isArray(models) && models.length > 0) {
      const loaded = models.find((m: any) => m.state === 'loaded');
      const target = loaded ?? models[0];
      // Only trust loaded_context_length when a model is ACTUALLY loaded — falling back to
      // max_context_length instead would feed an oversized window to `lms load -c` and OOM the box.
      const ctxLen = (target.state === 'loaded' && target.loaded_context_length) ? target.loaded_context_length : 0;
      const contextLength = typeof ctxLen === 'number' ? ctxLen : parseInt(String(ctxLen)) || 0;
      const ok = target.state === 'loaded';
      return {
        ok,
        modelId: String(target.id || ''),
        contextLength,
        state: String(target.state || 'unknown'),
        reason: ok ? undefined : `Model "${target.id}" is ${target.state}, not loaded`,
        type: String(target.type || ''), // "vlm" = vision-capable (live, from the connection)
      };
    }
  }

  // --- Fallback: OpenAI-compatible /v1/models ---
  const v1 = await httpGetJson(`${base}/v1/models`, undefined, apiKey);
  if (v1.ok) {
    const models = v1.json?.data ?? v1.json;
    if (Array.isArray(models) && models.length > 0) {
      // Match the requested model when given (a remote server can serve several);
      // else the first entry.
      const target = (targetModelId && models.find((m: any) => (m.id || m.model) === targetModelId)) || models[0];
      // vLLM (and many OpenAI-compatible servers) report the window as `max_model_len`; OpenRouter
      // uses `context_length`. Reading these makes an aggregator's window live and self-correcting
      // instead of relying on a models.dev snapshot baked in at build time, which drifts (a shrunk
      // window read as the old larger one means compaction fires too late and the turn dies
      // mid-task). Safe to add last: neither LM Studio's nor vLLM's /v1/models carries this key.
      const win = target.max_model_len ?? target.max_context_length ?? target.context_length ?? 0;
      let contextLength = typeof win === 'number' ? win : parseInt(String(win)) || 0;
      const modelId = String(target.id || target.model || '');
      // Ollama's OpenAI-compat /v1/models carries neither field, so it always read 0 — its real
      // window only lives on its native API, so fall through to that when the generic probe learned
      // nothing and the server is actually Ollama.
      if (contextLength === 0 && modelId && (await detectLocalFlavor(apiBase)) === 'ollama') {
        contextLength = await fetchOllamaContextLength(base, modelId);
      }
      return {
        ok: true,
        modelId,
        contextLength,
        state: 'loaded',
      };
    }
  }

  const reason = !v0.ok && !v1.ok
    ? `Could not reach inference server at ${base} (${v0.reason})`
    : 'No models available';
  return { ok: false, modelId: '', contextLength: 0, state: 'unreachable', reason };
}

/** The window this server publishes for ONE named model, baked into config at connect time. 0
 *  unless the server answered about THAT model — pairing a different id's window would persist a
 *  fabricated number. */
export async function fetchModelWindowFor(apiBase: string, modelId: string, apiKey?: string): Promise<number> {
  const info = await fetchModelInfo(apiBase, modelId, apiKey);
  return !info.modelId || info.modelId === modelId ? info.contextLength : 0;
}

/**
 * List every model id the LM Studio server currently knows (downloaded/available, not just loaded),
 *  for re-polling the model dropdown. Best-effort: [] if unreachable.
 */
export async function fetchLmStudioModels(apiBase: string, apiKey?: string): Promise<string[]> {
  const base = apiBase.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const ids: string[] = [];
  const v0 = await httpGetJson(`${base}/api/v0/models`, undefined, apiKey);
  if (v0.ok) {
    const models = v0.json?.data ?? v0.json;
    if (Array.isArray(models)) {
      for (const m of models) {
        // An "embeddings" model cannot serve a chat turn, so listing it in a model picker only
        // offers a pick that breaks the session — chat/vision types and any untyped entry are kept.
        if (String(m?.type ?? '') === 'embeddings') continue;
        const id = String(m?.id ?? '').trim();
        if (id) ids.push(id);
      }
    }
  }
  if (ids.length === 0) {
    const v1 = await httpGetJson(`${base}/v1/models`, undefined, apiKey);
    if (v1.ok) {
      const models = v1.json?.data ?? v1.json;
      if (Array.isArray(models)) {
        for (const m of models) {
          const id = String(m?.id ?? m?.model ?? '').trim();
          if (id) ids.push(id);
        }
      }
    }
  }
  return ids;
}

/**
 * The API key of the primary local provider, if it has one. The engine-URL probes resolve their URL
 *  from a setting rather than the provider block, so they have no key in hand — a key-protected LM
 *  Studio would otherwise 401 those probes while chat worked normally.
 */
export function primaryLocalApiKey(): string | undefined {
  try {
    const id = detectLocalProvider()?.id;
    return id ? readGlobalProviders()[id]?.options?.apiKey : undefined;
  } catch { return undefined; }
}

/**
 * Detect a local server's flavor so the UI offers only controls that actually work: LM Studio
 *  (`/api/v0/models`, driven by the `lms` CLI), Ollama (`/api/tags`, its own load/unload API), or
 *  'other' (honest display only). A non-loopback URL short-circuits to 'other', since the local
 *  CLIs can't drive a remote server. Best-effort.
 */
export async function detectLocalFlavor(baseURL?: string, apiKey?: string): Promise<'lmstudio' | 'ollama' | 'other'> {
  if (!baseURL || !isLoopbackBaseUrl(baseURL)) return 'other';
  const base = baseURL.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const lms = await httpGetJson(`${base}/api/v0/models`, undefined, apiKey);
  if (lms.ok) return 'lmstudio';
  const ollama = await httpGetJson(`${base}/api/tags`, undefined, apiKey);
  if (ollama.ok) return 'ollama';
  return 'other';
}
