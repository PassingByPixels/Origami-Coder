/**
 * What xAI says THIS credential is served.
 *
 * IMAGE AND VIDEO MODELS MUST NOT APPEAR: xAI serves generators from the same
 * list endpoint as its chat models, and a picker row for one is a chat that
 * cannot answer. The response's own modality fields decide where present; the id
 * rule below is only the fallback. Two shapes are accepted — a bare
 * `{ data: [{ id }] }` list and richer entries carrying `input_modalities` /
 * `output_modalities`. NOT VERIFIED AGAINST A LIVE RESPONSE.
 */
import type { Model } from "../provider/provider"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"

export const XAI_MODELS_ENDPOINT = "https://api.x.ai/v1/models"

/**
 * The context window a discovered row gets when the response states none.
 *
 * xAI's list endpoints publish no window, and `limit.context = 0` is worse than
 * a missing row: session/overflow.ts sizes compaction off it. 256k is the
 * smallest window this fork's own xAI catalogue states, and it errs safe.
 */
export const XAI_FALLBACK_CONTEXT = 256_000
export const XAI_FALLBACK_OUTPUT = 32_000

/** Ids that name a generator rather than a chat model. Used ONLY when the
 *  entry declares no modalities of its own. */
const NON_CHAT_ID = /(^|[-_])(image|video|imagegen|vision-gen)([-_]|$)/i

export interface XaiCatalogEntry {
  id?: unknown
  input_modalities?: unknown
  output_modalities?: unknown
}

function names(value: unknown): Set<string> {
  return new Set((Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string"))
}

/** Is this entry a text model this fork can hold a conversation with? A declared
 *  `output_modalities` without `text` is decisive — a model that answers with an
 *  image is not a chat model. With nothing declared the id rule stands in. */
export function isXaiChatModel(entry: XaiCatalogEntry): boolean {
  const id = typeof entry.id === "string" ? entry.id : ""
  if (!id) return false
  const outputs = names(entry.output_modalities)
  if (outputs.size > 0) return outputs.has("text")
  return !NON_CHAT_ID.test(id)
}

/** `grok-4.5` -> `Grok 4.5`. xAI's list endpoint publishes no display name, and
 *  a raw id in the picker beside "GPT-5.5" reads like a bug. */
export function xaiDisplayName(id: string): string {
  return id
    .split("-")
    .map((part) => (/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ")
}

export function mapXaiCatalog(payload: unknown): Record<string, Model> {
  const entries = (payload as { data?: unknown })?.data
  if (!Array.isArray(entries)) return {}
  const result: Record<string, Model> = {}
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue
    const entry = raw as XaiCatalogEntry
    if (!isXaiChatModel(entry)) continue
    const id = entry.id as string
    const inputs = names(entry.input_modalities)
    // No declaration means "assume the family's floor", which for Grok is text
    // plus images: every id this fork's own catalogue lists takes both.
    const image = inputs.size > 0 ? inputs.has("image") : true
    result[id] = {
      id: ModelV2.ID.make(id),
      providerID: ProviderV2.ID.make("xai"),
      name: xaiDisplayName(id),
      family: "",
      api: { id, url: "", npm: "@ai-sdk/xai" },
      status: "active",
      headers: {},
      options: {},
      // Zero on purpose: the same correction xai.ts's `models` hook makes. A
      // SuperGrok turn is not metered, and this loader only runs with that credential.
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: XAI_FALLBACK_CONTEXT, output: XAI_FALLBACK_OUTPUT },
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: image,
        toolcall: true,
        input: { text: true, image, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      // Left undefined so provider.ts's variants pass runs its own table for
      // `@ai-sdk/xai`: xAI publishes no per-model effort list here.
    }
  }
  return result
}

/** GET the account's model list. `fetchImpl` is injected so this is testable
 *  with no network and no credential; a non-200 answers with nothing, which the
 *  discovery merge reads as "nothing to add". */
export async function fetchXaiCatalog(input: {
  accessToken: string
  fetchImpl?: typeof fetch
  endpoint?: string
}): Promise<Record<string, Model>> {
  if (!input.accessToken) return {}
  const doFetch = input.fetchImpl ?? fetch
  const response = await doFetch(input.endpoint ?? XAI_MODELS_ENDPOINT, {
    method: "GET",
    headers: { authorization: "Bearer " + input.accessToken, accept: "application/json" },
  })
  if (!response.ok) return {}
  return mapXaiCatalog(await response.json())
}
