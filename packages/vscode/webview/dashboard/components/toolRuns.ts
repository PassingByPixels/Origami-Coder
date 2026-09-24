// toolRuns.ts — WHICH TOOL CARDS BELONG TO ONE RUN.
//
// CHANGES.md change 21: two or more adjacent tool calls in one turn read as a
// single stepped strip — one rail, one node per step — instead of a stack of
// separate boxes that says nothing about the order they ran in.
//
// The grouping is done HERE, on the ordered message list, rather than in the
// DOM. The mock has to infer a run from sibling elements and re-derive it every
// frame, because a card spliced in by a later delta has to join the group it
// belongs to; the product already has the list in order, so a run is just a
// maximal stretch of adjacent `tool` rows.
//
// A run never crosses a turn: any other row — prose, a thought, a verdict, a
// focus gap — ends it, and an agent or user row is what a turn boundary IS.
//
// Pure, and takes only the two fields it reads, so it is testable with no DOM
// and cannot drift into caring about the rest of a Message.

/** The least a row must carry to be grouped: its identity and whether it is a
 *  tool call. `Message` satisfies this structurally. */
export interface RunnableRow {
  id?: number;
  kind?: string;
}

/** One drawn block: either a single row, passed through by identity, or a run
 *  of two-or-more adjacent tool rows to be drawn inside one stepper. */
export type ToolBlock<T> =
  | { run: false; row: T; key: string }
  | { run: true; rows: T[]; key: string };

/** Splits an ordered row list into blocks. Every input row appears in exactly
 *  one block, in its original order and BY IDENTITY — this is a view, never an
 *  edit, so a caller can still key on the row it gets back.
 *
 *  A LONE tool card is deliberately left un-grouped: a stepper drawn around one
 *  step is a rail with nothing to connect, which is the mock's finding too (the
 *  third card on the Tsuru transcript stays ungrouped and keeps its own tick).
 *
 *  `keyOf` supplies each row's loop key, because a focus gap is keyed by its
 *  `key` field and a message by `id` — this leaf should not know that rule. */
export function groupToolRuns<T extends RunnableRow>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): ToolBlock<T>[] {
  const out: ToolBlock<T>[] = [];
  let run: T[] = [];
  const flush = () => {
    // A block is keyed by its FIRST row, whether or not it turned out to be a
    // run — NOT by a `run:`-prefixed key. A turn makes its calls one at a time:
    // card A lands alone, then card B arrives beside it and the two become a
    // run. If the block's key changed at that moment, Svelte would tear the
    // block down and build a new one, and card A — which the reader may have
    // expanded to watch a command — would silently collapse mid-turn. Keeping
    // the key makes that transition a prop update, so A's instance survives and
    // B is simply added next to it. Keys stay unique because each row belongs
    // to exactly one block, so no two blocks can share a first row.
    if (run.length >= 2) out.push({ run: true, rows: run, key: keyOf(run[0]) });
    else for (const row of run) out.push({ run: false, row, key: keyOf(row) });
    run = [];
  };
  for (const row of rows) {
    if (row.kind === 'tool') { run.push(row); continue; }
    flush();
    out.push({ run: false, row, key: keyOf(row) });
  }
  flush();
  return out;
}
