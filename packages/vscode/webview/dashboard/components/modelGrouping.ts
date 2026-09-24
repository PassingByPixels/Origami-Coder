// The provider-tab GROUPING for ModelPicker's tier-1: which section each
// provider belongs to, and how sections collapse into tabs.
//
// Sections mirror the sidebar's connection picker (connectionSection.ts):
// Self Hosted, Providers, Labs (+ Other fallback), decided off the same
// baseURL/id signal, so a provider buckets the same way in both places.
//
// Each section collapses behind ONE pill when it holds 2+ providers (a
// second-level sub-select reveals the individual ones). A LONE provider
// renders as its own top-level tab instead of hiding behind a one-item
// pill. WHICH tab/provider is selected is a separate concern — see
// modelSelection.ts — this file only decides where a pill sits.

import { classifySection, SECTION_ORDER, SECTION_LABEL, type ConnectionSection } from '../../sidebar/connectionSection';

export interface PickerProvider {
  id: string;
  name: string;
  live: boolean;
  baseURL?: string;
}

const GROUP_PREFIX = '__group_';

/** The synthetic id for a collapsed section's pill (never a real provider id). */
export function groupId(section: ConnectionSection): string {
  return `${GROUP_PREFIX}${section}`;
}

export interface GroupTab {
  /** A real provider id (the section's lone member) or a groupId() pill. */
  id: string;
  name: string;
  /** True if ANY member is live — the dot the tab wears. */
  live: boolean;
  section: ConnectionSection;
  /** This section's own providers — length 1 for a lone tab, 2+ for a pill. */
  members: PickerProvider[];
  /** True when `id` is a groupId() pill, i.e. this section had 2+ members. */
  collapsed: boolean;
}

export interface Grouping {
  /** One entry per non-empty section, in SECTION_ORDER. */
  tabs: GroupTab[];
}

/** classifySection with one addition: the modelOptions bootstrap fallback
 *  carries an id but no baseURL, which classifySection reads as an
 *  unrecognised cloud preset. That shape is uniquely the transient case,
 *  so it defaults to selfhosted instead of Other. */
function sectionOf(p: PickerProvider): ConnectionSection {
  const section = classifySection({ id: p.id, baseURL: p.baseURL });
  return section === 'other' && !p.baseURL ? 'selfhosted' : section;
}

/** Split the tier-1 providers into one tab per section: a lone member is its
 *  own tab, 2+ members collapse behind a group pill. */
export function groupProviders(providers: PickerProvider[]): Grouping {
  const bySection: Record<ConnectionSection, PickerProvider[]> = { selfhosted: [], providers: [], labs: [], other: [] };
  for (const p of providers) bySection[sectionOf(p)].push(p);
  const tabs: GroupTab[] = [];
  for (const section of SECTION_ORDER) {
    const members = bySection[section];
    if (members.length === 0) continue;
    const live = members.some((p) => p.live);
    tabs.push(
      members.length === 1
        ? { id: members[0].id, name: members[0].name, live, section, members, collapsed: false }
        : { id: groupId(section), name: SECTION_LABEL[section], live, section, members, collapsed: true },
    );
  }
  return { tabs };
}

/** Float the already-loaded model to the head of the list.
 *
 *  Reselecting what is already loaded costs nothing — no unload, no
 *  reload, no eviction of the model another open chat is using. Order
 *  only: nothing is added, removed or filtered. */
export function promoteLoaded<T extends { value: string }>(list: T[], loadedValue: string): T[] {
  if (!loadedValue) return list;
  const i = list.findIndex((m) => m.value === loadedValue);
  return i <= 0 ? list : [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
}
