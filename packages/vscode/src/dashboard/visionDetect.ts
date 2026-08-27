/**
 * Ask a local server which of its models can see, where the server will say.
 *
 * WHY THIS EXISTS AS A LEAF. The engine defaults every config-declared model to
 * `capabilities.input.image === false` (provider.ts:1657) because the
 * OpenAI-compatible `/v1` surface reports no modalities. Anything that knows
 * better has to write the flag into origami.json before the engine spawns. LM
 * Studio has been doing that since 0.3.x through `reconcileVisionCapabilities`;
 * this file generalises the "ask the server" half so Ollama gets it too, and so
 * the mapping is testable without a DashboardPanel.
 *
 * THE ONE RULE THAT MATTERS — ABSENT IS NOT FALSE. The returned map carries an
 * entry only for a model the server actually ANSWERED for. A model missing from
 * the map is UNKNOWN, and the caller must leave its config alone. Writing
 * `false` for an unknown model would silently blind a hand-configured SGLang or
 * vLLM VLM — which is exactly the shipped bug
 * `packages/engine/test/provider/config-vision.test.ts` was written for.
 *
 * NO PROBE REQUESTS. Every call here reads a metadata endpoint. Nothing sends a
 * test image or a test completion to find out what happens.
 */

/** Best-effort JSON transport. Neither method may throw; a failure is `ok:false`. */
export type VisionProbe = {
  getJson: (url: string) => Promise<{ ok: boolean; json?: unknown }>;
  postJson: (url: string, body: unknown) => Promise<{ ok: boolean; json?: unknown }>;
};

/** modelId -> can it accept images. An ABSENT key means "the server did not say". */
export type VisionMap = Map<string, boolean>;

/** How long a metadata probe may take before it is treated as "no answer". */
const PROBE_TIMEOUT_MS = 4000;

/**
 * The real transport, on the extension host's global fetch.
 *
 * `fetch` rather than DashboardPanel's node:http helper because `/api/show` is a
 * POST and that helper is GET-only. `response.ok` carries the same 2xx guard the
 * node helper spells out by hand — needed for the same reason: a FastAPI server
 * answers an unknown route with a JSON 404 body, which must not read as success.
 */
export const fetchVisionProbe: VisionProbe = {
  getJson: (url) => request(url),
  postJson: (url, body) =>
    request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

async function request(url: string, init?: RequestInit): Promise<{ ok: boolean; json?: unknown }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return { ok: false };
    return { ok: true, json: await response.json() };
  } catch {
    // Unreachable, timed out, or a body that is not JSON. All are "no answer".
    return { ok: false };
  }
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Strip a trailing `/v1` so a native (non-OpenAI-compatible) path can be built.
 *
 * Slashes come off FIRST. The inherited order (`/\/v1\/?$/` then `/\/+$/`) only
 * ever removed one trailing slash, so a base URL saved as `.../v1//` kept its
 * `/v1` and every native probe then went to `/v1/api/tags` and 404'd — the
 * server would have been read as "no capability surface". The same pattern is
 * still inline in DashboardPanel.detectLocalFlavor; it is not this pass's to fix.
 */
export function serverRoot(apiBase: string): string {
  return apiBase.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * LM Studio: `/api/v0/models` tags every model `type: "vlm"` or `"llm"`.
 *
 * This is the mapping the shipped reconciler already used; it moved here
 * unchanged so both flavours are read the same way and tested the same way.
 */
export function lmStudioVision(body: unknown): VisionMap {
  const out: VisionMap = new Map();
  const container = body as { data?: unknown } | undefined;
  const models = asArray(container?.data ?? body);
  for (const raw of models) {
    const m = raw as { id?: unknown; type?: unknown };
    const id = String(m?.id ?? '').trim();
    const type = String(m?.type ?? '').trim();
    // No `type` means this endpoint told us nothing about this model — that is
    // UNKNOWN, not "text-only". An `/v1`-only server lands here for every model.
    if (!id || !type) continue;
    out.set(id, type === 'vlm');
  }
  return out;
}

/**
 * Ollama: `POST /api/show {"model": id}` answers with a `capabilities` array —
 * `["completion","vision"]` for a VLM, `["completion","tools"]` for a text model.
 *
 * Verified against Ollama's own `docs/api.md` ("Show Model Information"). The
 * array is the ONLY field read: `details.families` also names vision adapters on
 * some models but not others, so trusting it would produce both false positives
 * and false negatives.
 */
export function ollamaVision(body: unknown): boolean | undefined {
  const capabilities = (body as { capabilities?: unknown } | undefined)?.capabilities;
  // An Ollama too old to report capabilities omits the key entirely. That is
  // UNKNOWN — answering `false` would strip a working VLM's flag on upgrade.
  if (!Array.isArray(capabilities)) return undefined;
  return capabilities.some((c) => String(c).toLowerCase() === 'vision');
}

/**
 * Ask whichever local server is at `apiBase` about `modelIds`.
 *
 * Flavour is decided by which metadata endpoint answers, in the same order
 * `detectLocalFlavor` uses — LM Studio's `/api/v0/models` first, then Ollama's
 * `/api/tags`. A server that answers neither (vLLM, SGLang, llama.cpp, any
 * OpenAI-compatible box) has no capability surface at all, so this returns an
 * EMPTY map and every model stays at whatever the config already says.
 */
export async function detectVision(
  input: { apiBase: string; modelIds: readonly string[] },
  probe: VisionProbe,
): Promise<VisionMap> {
  const root = serverRoot(input.apiBase);

  const lms = await probe.getJson(`${root}/api/v0/models`);
  if (lms.ok) return lmStudioVision(lms.json);

  // Confirm Ollama with ONE cheap GET before spending a POST per model. Against
  // a vLLM this costs a single 404 instead of N of them.
  const tags = await probe.getJson(`${root}/api/tags`);
  if (!tags.ok) return new Map();

  const out: VisionMap = new Map();
  for (const modelId of input.modelIds) {
    const shown = await probe.postJson(`${root}/api/show`, { model: modelId });
    if (!shown.ok) continue; // model pulled away, or an error — say nothing about it
    const seen = ollamaVision(shown.json);
    if (seen !== undefined) out.set(modelId, seen);
  }
  return out;
}
