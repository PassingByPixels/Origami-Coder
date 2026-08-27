// modelList.ts — ModelPicker's TIER-2 projection: which model rows show for the
// selected provider, in which order.
//
// EXTRACTED from ModelPicker.svelte (589/590, no room) when the picker gained a
// second pick TARGET (this chat vs the chat's sub-agents). Same split
// modelGrouping.ts made for tier 1: the component keeps the interaction, the
// leaf keeps the projection — and the projection is the part with rules worth
// testing (which catalogue a provider reads, what the filter matches, and that
// the already-loaded model floats to the top where it costs nothing to pick).

import { promoteLoaded } from './modelGrouping';

/** Cap on RENDERED rows — OpenRouter's catalogue is ~343 and the filter is the
 *  browse tool; the picker notes how many are hidden. */
export const MODEL_CAP = 60;

export interface ModelRow {
  value: string;
  name: string;
}

export interface ModelListInput {
  /** The concrete provider whose models to list ('' = none selected). */
  providerId: string;
  /** The configured catalogue, `<provider>/<id>` values. */
  modelOptions: ReadonlyArray<{ value: string; name: string }>;
  /** OpenRouter's live catalogue (bare ids — it is fetched, not configured). */
  openRouterModels: ReadonlyArray<{ id: string; name: string }>;
  filter: string;
  /** `<provider>/<id>` the local server currently holds ('' = none). */
  loadedValue: string;
}

/**
 * The rows to render for the selected provider, filtered and ordered.
 *
 * The filter matches the display name OR the full value: a user who knows the
 * id ("qwen3-30b") and a user who knows the label ("Qwen3 30B") both find it,
 * and neither has to guess which one the picker indexes.
 */
export function visibleModels(input: ModelListInput): ModelRow[] {
  if (!input.providerId) return [];
  let list: ModelRow[] =
    input.providerId === 'openrouter'
      ? input.openRouterModels.map((m) => ({ value: `openrouter/${m.id}`, name: m.name || m.id }))
      : input.modelOptions
          .filter((o) => o.value.startsWith(input.providerId + '/'))
          .map((o) => ({ value: o.value, name: o.name }));
  const q = input.filter.trim().toLowerCase();
  if (q) list = list.filter((m) => m.name.toLowerCase().includes(q) || m.value.toLowerCase().includes(q));
  return promoteLoaded(list, input.loadedValue);
}
