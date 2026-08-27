// WHICH tab/provider ModelPicker's tier-1 has active, given a Grouping
// (modelGrouping.ts) plus the user's explicit picks and the chat's current
// model. Split out at modelGrouping.ts's introduction (round 5, t-o92558)
// rather than folded in: grouping decides WHERE a provider sits, this
// decides WHAT is selected — two questions with different callers (a pill
// click only ever touches this file) and different tests (no DOM in either).

import type { Grouping, PickerProvider } from './modelGrouping';

/** The active TOP-level selection: an explicit pick wins if it is still a
 *  real tab; else the current model's own tab, or the pill it collapsed
 *  into; else the first tab. */
export function resolveTopSelection(grouping: Grouping, topPick: string, currentProviderId: string): string {
  const ids = grouping.tabs.map((t) => t.id);
  if (topPick && ids.includes(topPick)) return topPick;
  if (currentProviderId) {
    if (ids.includes(currentProviderId)) return currentProviderId;
    const owner = grouping.tabs.find((t) => t.collapsed && t.members.some((p) => p.id === currentProviderId));
    if (owner) return owner.id;
  }
  return grouping.tabs[0]?.id ?? '';
}

/** Which member of a collapsed pill's sub-select is active: an explicit
 *  sub-pick, else the current model's provider when it belongs here, else
 *  the first. */
export function resolveGroupProvider(members: PickerProvider[], pick: string, currentProviderId: string): string {
  const ids = members.map((p) => p.id);
  if (pick && ids.includes(pick)) return pick;
  if (currentProviderId && ids.includes(currentProviderId)) return currentProviderId;
  return members[0]?.id ?? '';
}

/** The concrete provider whose model list shows: a collapsed pill resolves
 *  to its chosen sub-provider, anything else is already a concrete id. */
export function resolveSelectedProvider(grouping: Grouping, topSelection: string, groupProviderPick: string): string {
  const tab = grouping.tabs.find((t) => t.id === topSelection);
  return tab?.collapsed ? groupProviderPick : topSelection;
}
