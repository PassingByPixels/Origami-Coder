// skillsGrouping.ts — SkillsPane's category grouping as a PURE projection, so
// "does an unrecognised category still get its own group?" and "does
// Uncategorised always land last?" are answerable with no DOM. Mirrors the
// flockMenuGroups.ts / modelGrouping.ts leaf pattern.

/** The shape this module needs off a skill entry — see SkillEntry in
 *  src/acpExtTypes.ts (mirrored, not imported: tsconfig.webview.json pins
 *  rootDir to `webview/`, so a cross-tree import breaks the type gate). */
export interface SkillLike {
  readonly category?: string;
}

export interface SkillGroup<T> {
  /** The category exactly as authored, or UNCATEGORISED for entries with none. */
  readonly label: string;
  readonly skills: readonly T[];
}

/** The five categories a skill author is expected to reach for, shown ahead of
 *  everything else so the common cases hold a stable, memorable position
 *  instead of being alphabetized away. */
const FIXED_ORDER = ['workflow', 'planning', 'testing', 'quality', 'reference'];

export const UNCATEGORISED = 'Uncategorised';

/**
 * Groups by `category`, preserving each group's incoming skill order. Category
 * is free-form authored frontmatter (see acpExtTypes.ts SkillEntry) — never
 * validated against FIXED_ORDER, so an unrecognised value still gets its own
 * group: it sorts after the fixed five, alphabetically among its peers, and
 * ahead of the uncategorised bucket rather than being folded into it.
 */
export function groupByCategory<T extends SkillLike>(skills: readonly T[]): SkillGroup<T>[] {
  const buckets = new Map<string, T[]>();
  const uncategorised: T[] = [];
  for (const s of skills) {
    const cat = s.category?.trim();
    if (!cat) {
      uncategorised.push(s);
      continue;
    }
    const bucket = buckets.get(cat);
    if (bucket) bucket.push(s);
    else buckets.set(cat, [s]);
  }
  const known = FIXED_ORDER.filter((c) => buckets.has(c));
  const other = [...buckets.keys()].filter((c) => !FIXED_ORDER.includes(c)).sort((a, b) => a.localeCompare(b));
  const groups: SkillGroup<T>[] = [...known, ...other].map((label) => ({ label, skills: buckets.get(label)! }));
  if (uncategorised.length > 0) groups.push({ label: UNCATEGORISED, skills: uncategorised });
  return groups;
}
