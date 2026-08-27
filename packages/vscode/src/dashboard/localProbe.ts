// HTTP PROBES against a self-hosted OpenAI-compatible server — LM Studio,
// Ollama, vLLM, SGLang, llama.cpp. Extracted WHOLE out of DashboardPanel.ts,
// which sat at 6335/6336 — one line under its cap — so this was extract-or-stop,
// not a preference (docs/WORKING_ON_ORIGAMI_CODER.md Part 4).
//
// The cluster is cohesive on its own terms: every function here answers a
// question about a REMOTE SERVER over node:http, and none of them touch vscode,
// the webview wire, or a session. The lms CLI helpers stayed behind in
// DashboardPanel.ts on purpose — those drive a LOCAL PROCESS, not an endpoint.
//
// node:http/node:https, not fetch, is deliberate: these are the user's OWN
// servers, and the raw request puts the Authorization header below literally on
// the wire. The transport is picked PER URL because http.get THROWS on an https:
// base — swallowed here, so every https endpoint read as unreachable, window 0.
// OpenRouter keeps its own fetch probe in DashboardPanel.ts: a policy decision
// about its window (see refreshModelInfoFor), not a transport gap.
//
// EVERY PROBE TAKES AN OPTIONAL apiKey. A self-hosted server MAY enforce auth,
// and before this existed a key-protected LM Studio answered 401 to all of
// them: the pill read 'no model reachable', the model list came back empty and
// the context gauge read 0, while the very same endpoint served chat turns
// fine. The keyless path is unchanged and must stay so — no key means no
// Authorization header at all, not an empty one. selfHostedKeyProbe.test.ts
// pins both directions against a real loopback server.

import * as http from 'node:http';
import * as https from 'node:https';
import { isLoopbackBaseUrl, detectLocalProvider, readGlobalProviders } from './firstFold';

/**
 * Query LM Studio's /api/v0/models endpoint for the real context length.
 * This is the internal LM Studio API (not the OpenAI-compatible /v1 layer).
 * Returns loaded_context_length for the active model, matching the Rust
 * harness approach in crates/api/src/client.rs.
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

/** GET + parse JSON, best-effort. `apiKey` is OPTIONAL and the default path is
 *  unchanged: a self-hosted server usually enforces no auth, and when no key is
 *  configured NO Authorization header is sent at all — not an empty one — so a
 *  keyless LM Studio receives byte-identical requests to before this argument
 *  existed. A key is only threaded through when the user actually set one
 *  (selfHostedKeyProbe.test.ts pins both directions against a real server). */
function httpGetJson(url: string, timeoutMs = 4000, apiKey?: string): Promise<{ ok: true; json: any } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const onRes = (res: http.IncomingMessage): void => {
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        // `ok` must mean "the server answered THIS endpoint successfully", not
        // merely "returned parseable JSON" — FastAPI/Starlette servers (vLLM,
        // LiteLLM) reply to an unknown route with a 404 whose body is valid JSON
        // ({"detail":"Not Found"}). Without a status guard, probing /api/v0/models
        // against a loopback vLLM would parse that 404 as success and mis-detect it
        // as LM Studio. Require 2xx.
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) { resolve({ ok: false, reason: `http ${status || '?'}` }); return; }
        try { resolve({ ok: true, json: JSON.parse(body) }); }
        catch (e) { resolve({ ok: false, reason: `parse error: ${String(e)}` }); }
      });
    };
    // `get` THROWS synchronously — it does not emit 'error' — for a URL its own
    // module can't handle: a malformed one (ERR_INVALID_URL), or (for node:http)
    // an `https:` base (ERR_INVALID_PROTOCOL). Unguarded, that throw escapes the
    // executor and REJECTS this promise, breaking the "best-effort, never
    // throws" contract every caller here relies on. Resolve it as a failed probe.
    // Picking the module by scheme is what makes an https self-hosted server (a
    // tailnet box behind TLS) probeable at all. Certificates are verified
    // normally: a self-signed one fails as a reason'd probe, never silently.
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
 * Ollama's context window for one model, from its NATIVE `/api/show` (the
 * OpenAI-compat `/v1/models` reports no window at all, which is why an Ollama
 * provider always read as 0).
 *
 * DEFENSIVE BY DESIGN — the exact request/response shape could not be verified
 * against a live server (nothing was listening on 11434 when this was written),
 * so every known variant is tolerated and ANY mismatch falls back to 0, i.e. the
 * previous behaviour. Nothing here can make the result worse than it was:
 *   · request  — sends BOTH `model` (current) and `name` (older builds); an
 *                unknown extra key is ignored by either.
 *   · response — accepts `model_info["<arch>.context_length"]` (the documented
 *                shape, arch prefix unknown up front so we scan for the suffix),
 *                a bare `context_length`, or a `num_ctx` line in the `parameters`
 *                text block. First plausible positive integer wins.
 * Returns 0 when unreachable, unparseable, or shaped differently than any of the
 * above — never a guess.
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
 * Probe the configured inference server for a loaded model. Strategy:
 *   1. Try LM Studio's internal `/api/v0/models` — richest data (state, ctx length).
 *   2. Fall back to the OpenAI-compatible `/v1/models` — works for any provider
 *      and for older LM Studio builds that lack /api/v0.
 * If either returns at least one model we mark the connection `ok` even if we
 * can't determine a real context length (contextLength stays 0).
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
      // Only trust loaded_context_length when a model is ACTUALLY loaded — never
      // fall back to max_context_length (e.g. 262144), which then gets fed to
      // `lms load -c` and OOMs (gemma-31b at 256k wants ~86 GB). Nothing loaded
      // ⇒ 0 ⇒ a sane default is used at load time.
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
      // vLLM (and many OpenAI-compatible servers) report the window as
      // `max_model_len` — surface it so the gauge/window are REAL for a remote
      // provider instead of 0 (which then fell back to LM Studio's window).
      // OpenRouter uses a third spelling, `context_length`, and publishes it for
      // every model it routes. Reading it makes an aggregator's window LIVE and
      // self-correcting, instead of relying on the models.dev snapshot baked into
      // the engine binary at build time — which is accurate on the day it ships
      // and drifts from then on (a shrunk window read as the old larger one means
      // compaction fires too late and the turn dies mid-task). Safe to add last:
      // neither LM Studio's nor vLLM's /v1/models carries this key, so it can
      // only fire for servers that actually publish it.
      //
      // httpGetJson speaks https now, so this branch is live for an https
      // self-hosted server too. OpenRouter is still NOT routed here:
      // DashboardPanel's refreshModelInfoFor sends it through fetchOpenRouterModels
      // and deliberately does not write its window back to config — that is a
      // policy decision, not a transport gap, and it stays as it is.
      const win = target.max_model_len ?? target.max_context_length ?? target.context_length ?? 0;
      let contextLength = typeof win === 'number' ? win : parseInt(String(win)) || 0;
      const modelId = String(target.id || target.model || '');
      // Ollama's OpenAI-compat /v1/models carries NEITHER field, so it always came
      // out 0 — no gauge, and (once the window is persisted) no auto-compaction.
      // Its real window only lives on its NATIVE API, so fall through to that when
      // the generic probe learned nothing AND the server is actually an Ollama.
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

/** The window this server publishes for ONE named model — the number baked into
 *  config at connect time (ModelChoice.servedContext). 0 unless the server
 *  answered ABOUT THAT MODEL: a single-model server reports whatever it has
 *  LOADED, and pairing that window with a different id would persist a
 *  fabricated number, which is worse than the 0 this fix exists to remove. */
export async function fetchModelWindowFor(apiBase: string, modelId: string, apiKey?: string): Promise<number> {
  const info = await fetchModelInfo(apiBase, modelId, apiKey);
  return !info.modelId || info.modelId === modelId ? info.contextLength : 0;
}

/**
 * List EVERY model id the LM Studio server currently knows (downloaded /
 * available, not just the loaded one). Used to re-poll the live library for the
 * model dropdown so newly-added models show up without hand-editing origami.json.
 * Best-effort: returns [] if the server is unreachable.
 */
export async function fetchLmStudioModels(apiBase: string, apiKey?: string): Promise<string[]> {
  const base = apiBase.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const ids: string[] = [];
  const v0 = await httpGetJson(`${base}/api/v0/models`, undefined, apiKey);
  if (v0.ok) {
    const models = v0.json?.data ?? v0.json;
    if (Array.isArray(models)) {
      for (const m of models) {
        // /api/v0/models types each entry; an "embeddings" model cannot serve a
        // chat turn, so listing it in a MODEL picker only offers a pick that
        // breaks the session. Chat/vision types ("llm"/"vlm") and any untyped
        // entry are kept — the filter drops only what is known-unusable.
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

/** The API key of the primary local provider, if it has one.
 *
 *  The engine-URL probes (`fetchModelInfo(resolveEngineUrl())`) target the same
 *  server the primary local provider block describes, but they resolve their URL
 *  from a SETTING rather than from that block, so they have no key in hand. A
 *  key-protected LM Studio would 401 those probes and report "no model loaded"
 *  on the pill while chat worked normally. Best-effort and almost always
 *  undefined — an unkeyed server is unaffected. */
export function primaryLocalApiKey(): string | undefined {
  try {
    const id = detectLocalProvider()?.id;
    return id ? readGlobalProviders()[id]?.options?.apiKey : undefined;
  } catch { return undefined; }
}

/** Detect a LOCAL server's flavor so the UI offers only management controls that
 *  actually work against it. LM Studio answers `/api/v0/models` and is driven by
 *  the `lms` CLI (eject + context-length-on-load). Ollama answers `/api/tags` and
 *  has its own native load/unload API. Anything else — a loopback server that is
 *  neither, or ANY remote server (e.g. a fixed vLLM served model) — is 'other':
 *  honest display only, no phantom controls. The `lms`/Ollama CLIs+APIs manage a
 *  server on THIS machine, so a non-loopback URL short-circuits to 'other' (a
 *  remote LM Studio can't be driven by the local `lms` CLI either). Best-effort:
 *  any probe failure falls through to 'other'. */
export async function detectLocalFlavor(baseURL?: string, apiKey?: string): Promise<'lmstudio' | 'ollama' | 'other'> {
  if (!baseURL || !isLoopbackBaseUrl(baseURL)) return 'other';
  const base = baseURL.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const lms = await httpGetJson(`${base}/api/v0/models`, undefined, apiKey);
  if (lms.ok) return 'lmstudio';
  const ollama = await httpGetJson(`${base}/api/tags`, undefined, apiKey);
  if (ollama.ok) return 'ollama';
  return 'other';
}
