// groupToolRuns — the rule behind CHANGES.md change 21's stepped strip.
//
// These are behaviour tests against the requirement ("two or more ADJACENT tool
// calls IN ONE TURN read as one strip"), not a restatement of the loop: each
// case names a transcript shape and asserts what the reader should see.
import { describe, expect, it } from 'vitest';
import { groupToolRuns, type RunnableRow } from './toolRuns';

const key = (r: RunnableRow) => String(r.id);
const row = (id: number, kind: string): RunnableRow => ({ id, kind });

describe('groupToolRuns', () => {
  it('groups two adjacent tool calls into one run', () => {
    const rows = [row(1, 'agent'), row(2, 'tool'), row(3, 'tool')];
    const blocks = groupToolRuns(rows, key);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ run: false });
    expect(blocks[1]).toMatchObject({ run: true });
    expect((blocks[1] as { rows: RunnableRow[] }).rows.map((r) => r.id)).toEqual([2, 3]);
  });

  it('leaves a LONE tool card un-grouped — a stepper around one step is a rail with nothing to connect', () => {
    const blocks = groupToolRuns([row(1, 'tool'), row(2, 'agent')], key);
    expect(blocks.every((b) => !b.run)).toBe(true);
  });

  it('a turn boundary ends the run — cards either side of an agent turn are two runs, not one', () => {
    // This is the defect a DOM-sibling grouper would ship: the four cards are
    // adjacent in the scroller but belong to two different turns.
    const rows = [row(1, 'tool'), row(2, 'tool'), row(3, 'agent'), row(4, 'tool'), row(5, 'tool')];
    const blocks = groupToolRuns(rows, key);
    expect(blocks.filter((b) => b.run)).toHaveLength(2);
    expect(blocks.map((b) => (b.run ? b.rows.map((r) => r.id) : b.row.id))).toEqual([[1, 2], 3, [4, 5]]);
  });

  it('any other row breaks a run — a thought between two calls is not inside the strip', () => {
    const rows = [row(1, 'tool'), row(2, 'thought'), row(3, 'tool')];
    expect(groupToolRuns(rows, key).every((b) => !b.run)).toBe(true);
  });

  it('every row survives, in order and by IDENTITY — the grouping is a view, never an edit', () => {
    const rows = [row(1, 'user'), row(2, 'tool'), row(3, 'tool'), row(4, 'tool'), row(5, 'agent')];
    const blocks = groupToolRuns(rows, key);
    const flat = blocks.flatMap((b) => (b.run ? b.rows : [b.row]));
    expect(flat).toHaveLength(rows.length);
    flat.forEach((r, i) => expect(r).toBe(rows[i]));
  });

  it('an empty transcript produces no blocks', () => {
    expect(groupToolRuns([], key)).toEqual([]);
  });

  it('a transcript that is ONLY tool calls is one run', () => {
    const blocks = groupToolRuns([row(1, 'tool'), row(2, 'tool'), row(3, 'tool')], key);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].run).toBe(true);
  });

  it('a block keeps its key when a lone card BECOMES a run — or an expanded card collapses mid-turn', () => {
    // The real defect this guards: a turn makes its calls one at a time. Card 1
    // lands alone; card 2 arrives beside it and the two become a run. If the
    // block's key changed at that moment, Svelte would tear the block down and
    // rebuild it, and card 1 — which the reader may have expanded to watch a
    // command run — would silently collapse.
    const lone = groupToolRuns([row(1, 'tool')], key)[0];
    const pair = groupToolRuns([row(1, 'tool'), row(2, 'tool')], key)[0];
    expect(lone.run).toBe(false);
    expect(pair.run).toBe(true);
    expect(pair.key).toBe(lone.key);
  });

  it('block keys are unique — each row is in exactly one block, so no two share a first row', () => {
    const rows = [row(1, 'tool'), row(2, 'tool'), row(3, 'agent'), row(4, 'tool'), row(5, 'user')];
    const keys = groupToolRuns(rows, key).map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
