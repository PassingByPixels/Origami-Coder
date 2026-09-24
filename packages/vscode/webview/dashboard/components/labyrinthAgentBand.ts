// The sub-agent band: one row per delegated run, nested spawns indented
// under the parent that made them. This leaf answers only which rows
// exist and in what order.
//
// It does not allocate lanes of its own — labyrinthBranches.ts owns that
// ledger — but adds a parent/child tree on top of its flat columns.
// Nesting resolves through `parentOrdinal`, never through the branch
// column: columns are recycled as branches merge, so matching on a column
// would parent a late delegate onto an unrelated earlier one.
//
// The extent is the span's own `startedAt` -> `endedAt`, never the last
// child step, since a child's steps are inlined after its spawn. Pure, no DOM.

import { branchModel, type BranchStep } from './labyrinthBranches';
import { normDepth } from './labyrinthLanes';
import { finiteTime, spanIsOpen } from './labyrinthSpans';

/** The part of a step the band reads. `LayoutStep` satisfies it. */
export interface BandStep extends BranchStep {
  title: string;
  agent?: string;
  model?: string;
}

export interface AgentRow {
  /** The spawning step's INDEX — the render key, unique by construction. */
  first: number;
  /** The spawning step's `ordinal`, for selection and for the inspector. */
  ordinal: number;
  /** Row order, top to bottom. A nested row always follows its parent. */
  order: number;
  /** 0 for a top-level delegate, 1 for one it spawned in turn. */
  indent: number;
  /** Short row label: the agent name, or the spawn's title when it has none. */
  label: string;
  /** Long form for the row's native tooltip — agent, model, status. */
  detail: string;
  /** Wall clock the delegate ran between. `endMs` is undefined when `open`. */
  startMs?: number;
  endMs?: number;
  /** It had not reported back when the run was captured. */
  open: boolean;
  /** Tri-state; undefined = the engine did not say (never read as foreground). */
  background?: boolean;
  /** Indices of the steps this delegate produced ITSELF — its own ticks. */
  steps: number[];
}

/**
 * The band's rows, in draw order. Only a real spawn opens a row — a
 * synthesised branch has no clock or agent, so it would assert an
 * unrecorded delegation.
 */
export function agentRows(steps: readonly BandStep[]): AgentRow[] {
  const { host, spans } = branchModel(steps);
  const own = new Map<number, number[]>();
  host.forEach((h, i) => {
    if (h < 0) return;
    const list = own.get(h) ?? [];
    list.push(i);
    own.set(h, list);
  });

  const real = spans.filter((s) => steps[s.first]?.kind === 'subagent');
  /** Spawn ordinal -> its span index, for the parentOrdinal lookup below. */
  const byOrdinal = new Map<number, number>(real.map((s) => [steps[s.first]!.ordinal, s.first]));

  const children = new Map<number, number[]>();
  const roots: number[] = [];
  for (const span of real) {
    const head = steps[span.first]!;
    const parent = normDepth(head) > 0 && typeof head.parentOrdinal === 'number'
      ? byOrdinal.get(head.parentOrdinal)
      : undefined;
    // An unresolvable parent is drawn at the top level rather than guessed
    // onto a neighbour, since a wrong nesting misstates who delegated to whom.
    if (parent === undefined || parent === span.first) roots.push(span.first);
    else children.set(parent, [...(children.get(parent) ?? []), span.first]);
  }

  const rows: AgentRow[] = [];
  const push = (first: number, indent: number): void => {
    const span = real.find((s) => s.first === first)!;
    const head = steps[first]!;
    const open = spanIsOpen(head);
    const end = finiteTime(head.endedAt);
    const label = head.agent || head.title;
    rows.push({
      first,
      ordinal: head.ordinal,
      order: rows.length,
      indent,
      label,
      detail: [label, head.model, open ? 'still running — never rejoined' : head.status]
        .filter((part): part is string => !!part).join(' · '),
      ...(finiteTime(head.startedAt) === undefined ? {} : { startMs: finiteTime(head.startedAt) }),
      ...(open || end === undefined ? {} : { endMs: end }),
      open,
      ...(span.background === undefined ? {} : { background: span.background }),
      steps: own.get(first) ?? [],
    });
    // Pushed immediately after its parent, so an indent always sits right below it.
    for (const child of children.get(first) ?? []) push(child, Math.min(indent + 1, 1));
  };
  for (const root of roots) push(root, 0);
  return rows;
}

/** How many delegates never reported back — the band's own headline count. */
export function openRows(rows: readonly AgentRow[]): number {
  return rows.filter((r) => r.open).length;
}
