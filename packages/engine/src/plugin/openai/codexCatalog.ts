/**
 * What the ChatGPT backend says THIS account is served.
 *
 * The ids a subscription can reach are decided by OpenAI and change without
 * notice; the backend publishes the list, so asking it beats codex.ts's
 * hand-maintained set. THE ENDPOINT FILTERS ON THE CLIENT VERSION YOU SEND —
 * each entry carries a `minimal_client_version` and this fork's real version is
 * below every threshold, so it must not be sent on this GET.
 */
import type { Model } from "../../provider/provider"
import { reasoningOptionVariants } from "../../provider/transform"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"

export const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models"

/**
 * The client version this GET claims to be.
 *
 * NOT `InstallationVersion`: the endpoint hides any entry whose
 * `minimal_client_version` is above the version in the query string, and this
 * fork's real numbers return an empty list. Bump this when a new model turns
 * out to need a higher floor.
 */
export const CODEX_MODELS_CLIENT_VERSION = "0.200.0"

/** One entry of the backend's `models` array. Structural and deliberately
 *  partial - the live payload carries ~49 keys per model and this reads seven.
 *  Anything not listed here is ignored, not rejected. */
export interface CodexCatalogEntry {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
  priority?: unknown
  context_window?: unknown
  max_context_window?: unknown
  max_output_tokens?: unknown
  supported_reasoning_levels?: unknown
  default_reasoning_level?: unknown
  input_modalities?: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** The effort levels an entry declares, weakest first. The backend's order IS
 *  the ranking it intends, so it is preserved rather than sorted: `xhigh`, `max`
 *  and `ultra` are all above `high` and no table in this repo knows that. */
export function catalogEfforts(entry: CodexCatalogEntry): string[] {
  const levels = entry.supported_reasoning_levels
  if (!Array.isArray(levels)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const level of levels) {
    const effort = typeof level === "string" ? level : str((level as { effort?: unknown })?.effort)
    if (!effort || seen.has(effort)) continue
    seen.add(effort)
    result.push(effort)
  }
  return result
}

/**
 * The entry's levels with its OWN default first.
 *
 * The engine has no separate field for "the tier a chat starts on": the unchosen
 * default is `variants[0]` (`acp/service.ts` selectVariant), so the front is the
 * only place `default_reasoning_level` can be honoured. The rest keep the
 * backend's order; a default naming a level the entry does not list is ignored.
 */
export function catalogDefaultFirst(entry: CodexCatalogEntry): string[] {
  const efforts = catalogEfforts(entry)
  const preferred = str(entry.default_reasoning_level)
  if (!preferred || !efforts.includes(preferred)) return efforts
  return [preferred, ...efforts.filter((effort) => effort !== preferred)]
}

/** Which of text / image / pdf this model takes. The backend names modalities in
 *  its own vocabulary, so an unknown one is DROPPED: `capabilities.input` is a
 *  fixed set of booleans. `text` is forced on — an absent array must not resolve
 *  to "takes nothing". */
export function catalogModalities(entry: CodexCatalogEntry): { image: boolean; pdf: boolean; audio: boolean } {
  const raw = Array.isArray(entry.input_modalities) ? entry.input_modalities : []
  const names = new Set(raw.filter((item): item is string => typeof item === "string"))
  return {
    image: names.has("image"),
    pdf: names.has("pdf") || names.has("file"),
    audio: names.has("audio"),
  }
}

/**
 * Turn the backend's payload into provider models.
 *
 * `visibility` is the backend's own switch and it is obeyed: `hide` entries are
 * internal rows the picker must not show, and entries with no `slug` are skipped.
 * COST IS ZERO for every row, as the `models` hook already forces: a Plus/Pro
 * subscription is not metered per token, so a price here would be a fiction.
 */
export function mapCodexCatalog(payload: unknown): Record<string, Model> {
  const entries = (payload as { models?: unknown })?.models
  if (!Array.isArray(entries)) return {}
  const ordered = [...entries].filter((entry): entry is CodexCatalogEntry => !!entry && typeof entry === "object")
  ordered.sort((a, b) => (num(a.priority) ?? Number.MAX_SAFE_INTEGER) - (num(b.priority) ?? Number.MAX_SAFE_INTEGER))

  const result: Record<string, Model> = {}
  for (const entry of ordered) {
    if (str(entry.visibility) !== "list") continue
    const id = str(entry.slug)
    if (!id) continue
    const modalities = catalogModalities(entry)
    // Two context fields come back per entry. `context_window` is the window this
    // client may use, `max_context_window` the model's ceiling, so the SMALLER is
    // the truthful session limit — sizing compaction off the ceiling would let a
    // turn run past what the backend accepts. The ceiling is only a fallback.
    const context = num(entry.context_window) ?? num(entry.max_context_window) ?? 0
    const model: Model = {
      id: ModelV2.ID.make(id),
      providerID: ProviderV2.ID.make("openai"),
      name: str(entry.display_name) ?? id,
      family: "",
      api: { id, url: "", npm: "@ai-sdk/openai" },
      status: "active",
      headers: {},
      options: {},
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context, output: num(entry.max_output_tokens) ?? 128_000 },
      capabilities: {
        // The backend refuses `temperature` for this family (withoutSampling in
        // codex.ts strips it), so declaring it would put a control the wire deletes.
        temperature: false,
        reasoning: catalogEfforts(entry).length > 0,
        attachment: modalities.image || modalities.pdf,
        toolcall: true,
        input: { text: true, image: modalities.image, audio: modalities.audio, video: false, pdf: modalities.pdf },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
    }
    // Variants are computed HERE, not left to provider.ts's variants pass, which
    // only fires for `variants === undefined` and would run an id-regex heuristic
    // that stops at `xhigh`. `reasoningOptionVariants` is the same path a declared
    // `reasoning_options` takes, so discovered and declared rows match.
    const efforts = catalogDefaultFirst(entry)
    const variants = efforts.length
      ? reasoningOptionVariants([{ type: "effort", values: efforts }], model)
      : undefined
    if (variants) model.variants = variants
    result[id] = model
  }
  return result
}

/** GET the account's model list. `fetchImpl` is injected so this can be tested
 *  without a network. A non-200 (401 on a missing or stale bearer) answers with
 *  nothing, which the discovery merge reads as "nothing to add". */
export async function fetchCodexCatalog(input: {
  accessToken: string
  accountId?: string
  fetchImpl?: typeof fetch
  endpoint?: string
}): Promise<Record<string, Model>> {
  if (!input.accessToken) return {}
  const doFetch = input.fetchImpl ?? fetch
  const base = input.endpoint ?? CODEX_MODELS_ENDPOINT
  const url = base + "?client_version=" + encodeURIComponent(CODEX_MODELS_CLIENT_VERSION)
  const headers: Record<string, string> = {
    authorization: "Bearer " + input.accessToken,
    accept: "application/json",
  }
  if (input.accountId) headers["ChatGPT-Account-Id"] = input.accountId
  const response = await doFetch(url, { method: "GET", headers })
  if (!response.ok) return {}
  return mapCodexCatalog(await response.json())
}
