// What KIND OF WORK a step was — the seven categories the analytics Flight
// view counts, bars and swim-lanes by.
//
// `labyrinthTone.ts` already answers "what kind is this step" (the right
// axis for a marker's colour); this file answers "where did the time go",
// since every tool call is one kind and this view splits them.
//
// The ids are the engine's own, read off each tool's `Tool.define` id, not
// guessed from a title. An id this table does not know falls to `Other`
// rather than a neighbouring category, so a tool added later is counted
// honestly.
//
// Two deliberate divergences from the mock: `Inspect Git` is the real
// `git_diff` tool id, not a `bash` title sniffed for "git"; and there is
// no `Compaction` category, since a compaction is the engine rewriting
// context between turns, not tool time — it is drawn on the chart's spine
// instead.

/** The part of a step the category rules read. `LayoutStep` satisfies it. */
export interface CategoryStep {
  kind: 'prompt' | 'reply' | 'tool' | 'thinking' | 'subagent' | 'compaction' | 'error';
  tool?: string;
}

export type Category =
  | 'Read & search' | 'Edit files' | 'Run command' | 'Inspect Git' | 'Web' | 'Plan' | 'Delegate' | 'Other';

/** Bar order, and row order on the chart. `Delegate` is last: it is a spawn,
 *  not work of its own, and the band below the chart is where it really lives. */
export const CATEGORY_ORDER: readonly Category[] = [
  'Read & search', 'Edit files', 'Run command', 'Inspect Git', 'Web', 'Plan', 'Delegate',
];

/** Tool id -> category. Ids verified against packages/engine/src/tool/*.ts. */
const BY_TOOL: Readonly<Record<string, Category>> = {
  read: 'Read & search', glob: 'Read & search', grep: 'Read & search', file: 'Read & search',
  lsp: 'Read & search', session_search: 'Read & search', wiki_search: 'Read & search',
  wiki_related: 'Read & search',
  edit: 'Edit files', write: 'Edit files', apply_patch: 'Edit files',
  bash: 'Run command', process: 'Run command',
  git_diff: 'Inspect Git',
  webfetch: 'Web', websearch: 'Web', browser: 'Web', webmcp_list: 'Web', webmcp_launch: 'Web',
  webmcp_tools: 'Web', webmcp_call: 'Web', webmcp_note: 'Web',
  todowrite: 'Plan', plan_exit: 'Plan', skill: 'Plan', goal: 'Plan', remember: 'Plan',
  task: 'Delegate',
};

/** The category a step belongs to. KIND outranks tool for a spawn: a
 *  `subagent` step is a delegation whatever tool made it; everything else
 *  is decided by the recorded tool id alone. */
export function toolCategory(step: CategoryStep): Category {
  if (step.kind === 'subagent') return 'Delegate';
  const id = step.tool;
  if (!id) return 'Other';
  return BY_TOOL[id.toLowerCase()] ?? 'Other';
}

/** One `--og-*` name per category, as a var reference, so bars/ticks/legend
 *  resolve against the live theme together. KNOWN COLLISION (from the mock):
 *  in Harbour, accent-2 and warning share a hex, so Edit files, Inspect Git
 *  and Delegate are separated by row and shape instead of hue. */
const VAR_BY_CATEGORY: Readonly<Record<Category, string>> = {
  'Read & search': '--og-chat',
  'Edit files': '--og-accent-2',
  'Run command': '--og-success',
  'Inspect Git': '--og-warning',
  Web: '--og-status-waiting',
  Plan: '--og-accent',
  Delegate: '--og-accent-2',
  Other: '--og-text-secondary',
};

export function categoryVar(category: Category): string {
  return `var(${VAR_BY_CATEGORY[category]})`;
}

/** How many depth-0 tool/error steps each category took; `Delegate` counts subagent spawns. */
export function categoryCounts(steps: readonly (CategoryStep & { depth?: number })[]): Array<{ category: Category; count: number }> {
  const tally = new Map<Category, number>(CATEGORY_ORDER.map((c) => [c, 0]));
  for (const step of steps) {
    if ((step.depth ?? 0) !== 0) continue;
    const counts = step.kind === 'subagent' || step.kind === 'tool' || step.kind === 'error';
    if (!counts) continue;
    const category = toolCategory(step);
    if (tally.has(category)) tally.set(category, tally.get(category)! + 1);
  }
  return CATEGORY_ORDER.map((category) => ({ category, count: tally.get(category) ?? 0 }));
}
