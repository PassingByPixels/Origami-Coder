// The five FIXED pillars, and the grouping a map column needs, as a pure leaf.
// The map's colour tables are the sibling mirror, repoMapPalette.ts.
//
// PILLARS is MIRRORED from src/dashboard/agentManager/mapSchema.ts rather than
// imported: tsconfig.webview.json pins rootDir to `webview/`, so the webview
// cannot import a runtime value out of src/. That is the same reason
// modelBanner.ts and permissionOptions.ts mirror their host modules, and it
// carries the same obligation — repoMapPillars.test.ts reads BOTH files and
// fails if the two lists drift apart.
//
// Extracted from RepoMapScreen.svelte when the v2 pillar work pushed that pane
// past its cap. Grouping is the part worth testing on its own: a node with no
// `section` must still appear in its column, which is easy to lose in markup
// and invisible in a screenshot.

export interface PillarDef {
  number: number;
  name: string;
  purpose: string;
}

export const PILLARS: ReadonlyArray<PillarDef> = [
  { number: 1, name: 'Entry Points & Interfaces', purpose: 'CLI commands, API endpoints, UI entry points, public APIs' },
  { number: 2, name: 'Core Logic / Processing Pipeline', purpose: 'Business logic, data processing, orchestration, renderers' },
  { number: 3, name: 'Validation, Trust & Policy Gates', purpose: 'Schema checks, auth, evidence gates, path resolution' },
  { number: 4, name: 'External Dependencies & Infrastructure', purpose: 'CLI tools, databases, runtimes, third-party services' },
  { number: 5, name: 'Artifacts & Outputs', purpose: 'Generated files, build output, browser artifacts, reports' },
];

/** The shape the grouping needs — the screen's own Node satisfies it. */
export interface PillarNode {
  id: string;
  pillar: number;
  section?: string;
}

/** The theme defines success/warning/error. There is no --og-green/yellow/red,
 *  so those names fell through to a hardcoded hex on every theme. */
export const STATUS_COLOR: Readonly<Record<string, string>> = {
  new: 'var(--og-success)',
  modified: 'var(--og-warning)',
  removed: 'var(--og-error)',
};

export function nodesInPillar<T extends PillarNode>(nodes: readonly T[], pillar: number): T[] {
  return nodes.filter((n) => n.pillar === pillar);
}

/** Section names present in a pillar, sorted, with blanks treated as absent. */
export function sectionsInPillar(nodes: readonly PillarNode[], pillar: number): string[] {
  const found = new Set<string>();
  for (const n of nodes) {
    if (n.pillar === pillar && n.section && n.section.trim() !== '') found.add(n.section);
  }
  return [...found].sort();
}

export function nodesInSection<T extends PillarNode>(nodes: readonly T[], pillar: number, section: string): T[] {
  return nodes.filter((n) => n.pillar === pillar && n.section === section);
}

/** Nodes the cartographer left ungrouped. They must still render, above the
 *  section headings — a node with no `section` is not a node with no column. */
export function nodesWithoutSection<T extends PillarNode>(nodes: readonly T[], pillar: number): T[] {
  return nodes.filter((n) => n.pillar === pillar && (!n.section || n.section.trim() === ''));
}

/** Scale that fits `stageWidth` into `wrapWidth`, or 1 when it already fits or
 *  either measurement is not in yet. Never enlarges: fit-to-width shrinks. */
export function fitScale(stageWidth: number, wrapWidth: number): number {
  if (stageWidth <= 0 || wrapWidth <= 0) return 1;
  return stageWidth > wrapWidth ? wrapWidth / stageWidth : 1;
}
