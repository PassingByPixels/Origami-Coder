// Ask a local server which of its models can see, where the server will say. The engine defaults
// every config-declared model to no image input (OpenAI-compatible /v1 reports no modalities), so
// anything that knows better must write the flag into origami.json before the engine spawns.
// LM Studio's reconciler already did this; this generalises it so Ollama gets it too and the
// mapping is testable without a DashboardPanel.
// Absent is not false: the map carries an entry only for a model the server actually answered for.
// A model missing from the map is UNKNOWN, and the caller must leave its config alone — writing
// false for an unknown model would blind a hand-configured VLM. No probe requests: every call reads
// a metadata endpoint, never a test completion.

/** Best-effort JSON transport. Neither method may throw; a failure is `ok:false`. */
export type VisionProbe = {
  getJson: (url: string) => Promise<{ ok: boolean; json?: unknown }>;
  postJson: (url: string, body: unknown) => Promise<{ ok: boolean; json?: unknown }>;
};

/** modelId -> can it accept images. An ABSENT key means "the server did not say". */
export type VisionMap = Map<string, boolean>;

/** How long a metadata probe may take before it is treated as "no answer". */
const PROBE_TIMEOUT_MS = 4000;

/** The real transport, on the extension host's global fetch — used instead of DashboardPanel's
 *  node:http helper since `/api/show` is a POST. `response.ok` guards the same way: a FastAPI 404
 *  body must not read as success. */
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

/** Strip a trailing `/v1`. Slashes come off FIRST — the old order only ever removed one trailing
 *  slash, so a base URL saved as `.../v1//` kept its `/v1` and every native probe 404'd. */
export function serverRoot(apiBase: string): string {
  return apiBase.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** LM Studio: `/api/v0/models` tags every model `type: "vlm"` or `"llm"` — the mapping the shipped
 *  reconciler already used, moved here unchanged. */
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

/** Ollama: `POST /api/show` answers with a `capabilities` array. Only that array is read —
 *  `details.families` also names vision adapters on some models but not others, so trusting it
 *  would give both false positives and negatives. */
export function ollamaVision(body: unknown): boolean | undefined {
  const capabilities = (body as { capabilities?: unknown } | undefined)?.capabilities;
  // An Ollama too old to report capabilities omits the key entirely. That is
  // UNKNOWN — answering `false` would strip a working VLM's flag on upgrade.
  if (!Array.isArray(capabilities)) return undefined;
  return capabilities.some((c) => String(c).toLowerCase() === 'vision');
}

/** Ask whichever local server is at `apiBase` about `modelIds`. Flavour is decided by which
 *  metadata endpoint answers, LM Studio's first then Ollama's — a server answering neither returns
 *  an EMPTY map and every model keeps its config value. */
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
