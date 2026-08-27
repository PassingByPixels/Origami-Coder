// The provider-tab GROUPING for ModelPicker's tier-1: which section each
// provider belongs to, and how sections collapse into tabs.
//
// Round 5 (t-o92558) replaced the old two-way split — local providers as
// their own tabs, every non-local provider folded behind ONE "Lab" catch-all
// decided by the host's local/compat/cloud `kind` — with the SAME section
// the sidebar's connection picker uses (connectionSection.ts): Local/Self
// Hosted, Providers, Labs (+ the visible Other fallback). A provider now
// buckets the SAME way in both places, off the SAME baseURL/id signal —
// the bug this fixes: a tailnet vLLM read as a "local" tab here while the
// sidebar already called it Hosted, and OpenCode Zen/Go read Labs here after
// the sidebar had already moved them to Providers.
//
// Local and Hosted have since MERGED into one 'selfhosted' bucket (see
// connectionSection.ts). No logic changed here — this file iterates
// SECTION_ORDER and never named the two, which is what that rewrite bought.
//
// Each section collapses behind ONE pill when it holds 2+ providers (a
// second-level sub-select reveals the individual ones — the mechanic every
// group shares, mirroring the old Lab tab exactly). A LONE provider in a
// section renders as its own top-level tab instead of hiding behind a
// one-item pill. WHICH tab/provider is actually selected is a separate
// concern — see modelSelection.ts — this file only decides where a pill
// sits.

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
 *  (used before providerStatus has landed) carries an id but no baseURL, and
 *  classifySection reads that shape as an unrecognised cloud preset — losing
 *  it to Other. Every REAL host probe carries a baseURL for a self-hosted
 *  provider, so "no baseURL and unrecognised" is uniquely that transient case;
 *  it defaults to selfhosted, same as the old "no kind" default did. */
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
 *  Reselecting what is already loaded is the one pick that costs nothing — no
 *  unload, no reload, no eviction of the model every other open chat is using.
 *  Leaving it buried alphabetically among sixty-odd rows (and past the render
 *  cap on a big catalogue) pushes the user toward the expensive choice instead.
 *  Order only: nothing is added, removed or filtered, and with nothing loaded —
 *  or the loaded model absent from this provider's list — the list is returned
 *  untouched. */
export function promoteLoaded<T extends { value: string }>(list: T[], loadedValue: string): T[] {
  if (!loadedValue) return list;
  const i = list.findIndex((m) => m.value === loadedValue);
  return i <= 0 ? list : [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
}
