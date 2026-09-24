/**
 * A config-declared OpenAI-compatible provider (vLLM, sglang, a raw "Other"
 * connection through a tunnel or a tailnet forward) carries no models.dev row,
 * so `provider.ts`'s config pass leaves `limit.context` at 0 unless the
 * operator typed a number in. These servers publish their real window on GET
 * /v1/models: vLLM and sglang answer `max_model_len`, some LM-Studio-alike
 * servers `max_context_length`, OpenRouter-style aggregators `context_length`.
 * Reading it here makes a bare config block behave like a named provider,
 * without the operator hand-writing the number (t-d94t8t).
 *
 * Wired into `provider/provider.ts` as a `discoverModels` loader; the merge
 * rule that only backfills a model already sitting at 0 lives in
 * `provider/discovery.ts` — a declared window always wins here too.
 */
import type { Model } from "../provider/provider"

/** One row of a GET /v1/models response, as far as this cares. */
export interface OpenAICompatModelRow {
  id?: unknown
  model?: unknown
  max_model_len?: unknown
  max_context_length?: unknown
  context_length?: unknown
}

function toPositiveInt(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** modelID -> context window, for every row that published a positive one.
 *  Accepts both `{ data: [...] }` (the OpenAI shape every known server uses)
 *  and a bare array, so a fixture need not wrap itself either. */
export function mapOpenAICompatContext(payload: unknown): Record<string, number> {
  const entries = Array.isArray(payload) ? payload : ((payload as { data?: unknown })?.data ?? [])
  if (!Array.isArray(entries)) return {}
  const out: Record<string, number> = {}
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue
    const row = raw as OpenAICompatModelRow
    const id = typeof row.id === "string" ? row.id : typeof row.model === "string" ? row.model : undefined
    if (!id) continue
    const ctx = toPositiveInt(row.max_model_len) || toPositiveInt(row.max_context_length) || toPositiveInt(row.context_length)
    if (ctx) out[id] = ctx
  }
  return out
}

/** GET the endpoint's own model list. `fetchImpl` is injected so this is
 *  testable with no network; any failure (unreachable, non-200, bad JSON)
 *  answers with nothing, which the discovery merge reads as "nothing to add". */
export async function fetchOpenAICompatContext(
  baseURL: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, number>> {
  const url = baseURL.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/models"
  try {
    const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" } })
    if (!response.ok) return {}
    return mapOpenAICompatContext(await response.json())
  } catch {
    return {}
  }
}

/**
 * Build the `Record<string, Model>` a `discoverModels` loader returns. Only
 * `targetModelIDs` are ever candidates — every one of them is already a model
 * the config declared — so this never introduces a row the operator did not
 * name; it only ever patches `limit.context` onto one that is already there.
 */
export async function discoverOpenAICompatContext(
  baseURL: string,
  models: Record<string, Model>,
  targetModelIDs: readonly string[],
  fetchImpl?: typeof fetch,
): Promise<Record<string, Model>> {
  const contexts = await fetchOpenAICompatContext(baseURL, fetchImpl)
  const out: Record<string, Model> = {}
  for (const modelID of targetModelIDs) {
    const context = contexts[modelID]
    const model = models[modelID]
    if (!context || !model) continue
    out[modelID] = { ...model, limit: { ...model.limit, context } }
  }
  return out
}
