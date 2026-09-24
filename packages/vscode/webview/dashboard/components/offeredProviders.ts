// offeredProviders.ts — tier-1 tabs for providers the host OFFERS but nobody
// configured.
//
// Every provider in the picker's first tier comes from `providerStatus`: a
// block in origami.json with a baseURL or a key, probed for a green dot. Claude
// Code is not one. It is a HARNESS the user already has installed — no
// endpoint, no key, nothing to probe — so it can never appear in that list, and
// without a tab its model rows would be unreachable however correctly the host
// broadcast them.
//
// The host says so on the ROWS instead: a row that names a `group` is asking
// for a tab under that name (see src/claudeCode/models.ts, which builds them).
// This module turns those rows into providers and merges them in, LAST, and
// only for ids `providerStatus` did not already claim — a real configured
// provider always wins, so nothing here can shadow one.
//
// Deliberately NOT "derive a provider from every id in modelOptions": that is
// the reshuffle ModelPicker's own `providers` comment warns about, where an
// engine-side catalog id paints a tab that vanishes when the probe answers.
// Only an explicit `group` opts a row in.

export interface OfferedRow {
  value: string;
  /** The tab NAME this row wants. Absent on every ordinary model row. */
  group?: string;
  /** What the tab's TOOLTIP says instead of the bare name — the CLI version,
   *  for Claude Code. Split from `group` because a label and an identification
   *  are different jobs: the label must survive upgrades, and a tab reading
   *  "Claude Code 2.1.198" parses as a product name, not as "this install". */
  groupDetail?: string;
}

export interface OfferedProvider {
  id: string;
  name: string;
  live: boolean;
  baseURL?: string;
  detail?: string;
}

/**
 * `base` with one extra provider per distinct `group` found in `rows`.
 *
 * `live: true` is honest here rather than optimistic: these rows exist only
 * because the host's own detection found the thing installed — the host sends
 * none when it did not (models.ts returns [] for a null CLI), so a row on
 * screen IS the probe's positive answer.
 */
export function withOffered<T extends OfferedProvider>(
  base: T[],
  rows: readonly OfferedRow[],
): Array<T | OfferedProvider> {
  const taken = new Set(base.map((p) => p.id));
  const extra: OfferedProvider[] = [];
  for (const row of rows) {
    if (!row.group) continue;
    const id = String(row.value).split('/')[0];
    if (!id || taken.has(id)) continue;
    taken.add(id);
    extra.push({ id, name: row.group, live: true, ...(row.groupDetail ? { detail: row.groupDetail } : {}) });
  }
  return extra.length === 0 ? base : [...base, ...extra];
}

/**
 * Tooltip text for a tab or sub-tab: the row's `groupDetail` when it named one,
 * otherwise the label itself.
 *
 * It reads from `rows` rather than from the provider because `modelGrouping`
 * projects providers into `GroupTab`s and drops any field it does not know —
 * threading one more through four shapes to reach a tooltip is more coupling
 * than a tooltip is worth.
 */
export function groupTooltip(rows: readonly OfferedRow[], name: string): string {
  for (const row of rows) {
    if (row.group === name && row.groupDetail) return row.groupDetail;
  }
  return name;
}
