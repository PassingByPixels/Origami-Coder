// secondOpinionModels.ts: which models may give a second opinion, and how
// the flyout arranges them. Separate from modelList.ts for one reason: the
// current model is excluded, in a tested pure function rather than a
// dimmed row, so asking the model that just did the work to review itself
// is impossible, not just discouraged.
//
// Providers group under the same three sections the connections picker
// uses (classifySection, connectionSection.ts). This leaf may not import
// from src/, so the catalogue arrives on `modelOptions`.

import { classifySection, SECTION_ORDER, SECTION_LABEL, type ConnectionSection } from '../../sidebar/connectionSection';

/** Cap on rendered rows in one flat run. Lower than modelList.ts's
 *  MODEL_CAP: this is a one-shot pick from a compact flyout, not a browse. */
export const REVIEWER_MODEL_CAP = 40;

export interface ReviewerModel {
  /** `<provider>/<id>` — what the host is asked to review with. */
  value: string;
  name: string;
}

export interface ReviewerGroup {
  /** The provider id, as it appears before the first `/` in the value. */
  provider: string;
  /** Rows offered when this group expands, capped at REVIEWER_MODEL_CAP. */
  models: ReviewerModel[];
  /** True model count: what tells the flyout an expanded list was cut. */
  count: number;
}

export interface ReviewerTierGroup {
  tier: ConnectionSection;
  /** The section's face, verbatim from the connections picker. */
  label: string;
  providers: ReviewerGroup[];
}

export interface ReviewerListInput {
  /** The configured catalogue: `<provider>/<id>` values, same as `modelOptions`. */
  modelOptions: ReadonlyArray<{ value: string; name: string }>;
  /** `<provider>/<id>` this chat is running now. Empty when the chat has no
   *  model yet, in which case nothing is excluded. */
  currentModel: string;
  filter: string;
  /** The host's `providerStatus` rows: baseURL is the tier signal. Empty
   *  before the probe answers; unrecognised ids default to selfhosted. */
  providerStatus?: ReadonlyArray<{ id: string; baseURL?: string }>;
}

export interface ReviewerList {
  /** True while the filter is non-empty — `matches` is the answer, flat. */
  searching: boolean;
  /** Filter empty: one entry per non-empty section, in SECTION_ORDER. */
  tiers: ReviewerTierGroup[];
  /** Filter non-empty: matching rows, best match first, capped. */
  matches: ReviewerModel[];
  /** Rows a flat render would show vs rows that qualified, for the hidden count. */
  shown: number;
  total: number;
}

/** classifySection with a fallback: an unrecognised id with no baseURL is
 *  the transient pre-probe case, and reads as selfhosted. */
function tierOf(provider: string, baseURL: string | undefined): ConnectionSection {
  const section = classifySection({ id: provider, baseURL });
  return section === 'other' && !baseURL ? 'selfhosted' : section;
}

/** Match quality: name prefix beats name hit beats id-only hit; -1 = no
 *  match. Ranks "qwen" above a longer id merely serving a distillate. */
function rankOf(name: string, value: string, query: string): number {
  const n = name.toLowerCase();
  if (n.startsWith(query)) return 0;
  if (n.includes(query)) return 1;
  if (value.toLowerCase().includes(query)) return 2;
  return -1;
}

/** Reviewer candidates: tiered tree (browse) or ranked rows (search).
 *  Providers keep catalogue order so a list can't reorder itself between menus. */
export function reviewerModels(input: ReviewerListInput): ReviewerList {
  const query = input.filter.trim().toLowerCase();
  const seen = new Set<string>();
  const order: string[] = [];
  const byProvider = new Map<string, ReviewerModel[]>();
  const ranked: Array<{ model: ReviewerModel; rank: number; at: number }> = [];

  for (const option of input.modelOptions) {
    const value = option?.value ?? '';
    const slash = value.indexOf('/');
    // A value with no provider half is dropped rather than offered and refused.
    if (slash <= 0 || slash === value.length - 1) continue;
    if (value === input.currentModel) continue;
    if (seen.has(value)) continue;
    seen.add(value);

    const name = option.name || value.slice(slash + 1);
    if (query) {
      const rank = rankOf(name, value, query);
      if (rank >= 0) ranked.push({ model: { value, name }, rank, at: ranked.length });
      continue;
    }

    const provider = value.slice(0, slash);
    if (!byProvider.has(provider)) {
      byProvider.set(provider, []);
      order.push(provider);
    }
    byProvider.get(provider)!.push({ value, name });
  }

  if (query) {
    ranked.sort((a, b) => a.rank - b.rank || a.at - b.at);
    const matches = ranked.slice(0, REVIEWER_MODEL_CAP).map((r) => r.model);
    return { searching: true, tiers: [], matches, shown: matches.length, total: ranked.length };
  }

  const statusById = new Map((input.providerStatus ?? []).map((p) => [p.id, p.baseURL]));
  const byTier = new Map<ConnectionSection, ReviewerGroup[]>();
  let total = 0;
  for (const provider of order) {
    const models = byProvider.get(provider)!;
    total += models.length;
    const tier = tierOf(provider, statusById.get(provider));
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier)!.push({ provider, models: models.slice(0, REVIEWER_MODEL_CAP), count: models.length });
  }
  const tiers = SECTION_ORDER.filter((t) => byTier.has(t)).map((tier) => ({
    tier,
    label: SECTION_LABEL[tier],
    providers: byTier.get(tier)!,
  }));
  return { searching: false, tiers, matches: [], shown: total, total };
}
