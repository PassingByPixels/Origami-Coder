/**
 * What Anthropic says THIS API key is served.
 *
 * The provider is a `custom()` entry in provider.ts, so the only Claude ids the picker
 * has offered are the ones baked into the extension's `CLAUDE_MODELS` table. It does NOT
 * state effort levels: the response carries no reasoning fields, so a discovered row
 * leaves `variants` undefined and provider.ts's own table decides.
 */
import type { Model } from "../provider/provider"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"

export const ANTHROPIC_MODELS_ENDPOINT = "https://api.anthropic.com/v1/models"
export const ANTHROPIC_VERSION = "2023-06-01"

/** Pages are 20 entries by default; this caps how many the loader walks. Five is
 *  far more than the catalogue has held and stops a broken `has_more` looping. */
const MAX_PAGES = 5

/**
 * The window a discovered Claude row gets when nothing states one.
 *
 * `/v1/models` publishes no context window, and `limit.context = 0` would make
 * session/overflow.ts compact against nothing. 200k is the minimum across every Claude
 * model served, so a bigger row is under-reported (an early compaction) rather than
 * over-reported (a refused turn). A declaration always wins.
 */
export const ANTHROPIC_FALLBACK_CONTEXT = 200_000
export const ANTHROPIC_FALLBACK_OUTPUT = 32_000

export interface AnthropicCatalogEntry {
  id?: unknown
  display_name?: unknown
  type?: unknown
}

export function mapAnthropicCatalog(payload: unknown): Record<string, Model> {
  const entries = (payload as { data?: unknown })?.data
  if (!Array.isArray(entries)) return {}
  const result: Record<string, Model> = {}
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as AnthropicCatalogEntry
    const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined
    if (!id) continue
    // `type` is `"model"` for every row today. Checked rather than assumed so a
    // future non-model row is skipped instead of becoming an unusable picker entry.
    if (typeof entry.type === "string" && entry.type !== "model") continue
    result[id] = {
      id: ModelV2.ID.make(id),
      providerID: ProviderV2.ID.make("anthropic"),
      name: typeof entry.display_name === "string" && entry.display_name ? entry.display_name : id,
      family: "",
      api: { id, url: "", npm: "@ai-sdk/anthropic" },
      status: "active",
      headers: {},
      options: {},
      // An API key IS metered, unlike the two subscription backends, and this
      // response carries no prices — so zero here is not "free", it is "this fork
      // does not know". A priced row must come from a declaration or models.dev.
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: ANTHROPIC_FALLBACK_CONTEXT, output: ANTHROPIC_FALLBACK_OUTPUT },
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, image: true, audio: false, video: false, pdf: true },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: true,
      },
      release_date: "",
    }
  }
  return result
}

/**
 * GET the key's model list, following `has_more` with `after_id`. `fetchImpl` is injected
 * so this is testable with no network and no key. A non-200 on the FIRST page answers
 * with nothing; a non-200 later keeps the pages already read, because the merge never
 * deletes anything.
 */
export async function fetchAnthropicCatalog(input: {
  apiKey: string
  fetchImpl?: typeof fetch
  endpoint?: string
}): Promise<Record<string, Model>> {
  if (!input.apiKey) return {}
  const doFetch = input.fetchImpl ?? fetch
  const base = input.endpoint ?? ANTHROPIC_MODELS_ENDPOINT
  const headers = {
    "x-api-key": input.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    accept: "application/json",
  }
  const result: Record<string, Model> = {}
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = after ? base + "?after_id=" + encodeURIComponent(after) : base
    const response = await doFetch(url, { method: "GET", headers })
    if (!response.ok) return result
    const payload = (await response.json()) as { has_more?: unknown; last_id?: unknown }
    Object.assign(result, mapAnthropicCatalog(payload))
    if (payload?.has_more !== true) break
    const last = typeof payload?.last_id === "string" ? payload.last_id : undefined
    if (!last || last === after) break
    after = last
  }
  return result
}
