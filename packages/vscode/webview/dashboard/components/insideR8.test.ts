// t-yyz5yk — Round 8 "Inside each element": what a row shows when opened, plus
// the row results those views share (Edit "+a −d"). Structure only (no <style>).
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ToolCard from './ToolCard.svelte';
import EditCard from './toolcards/EditCard.svelte';
import { lineDiff, diffStat, splitRows, ratioBlocks } from './toolcards/lineDiff';

afterEach(cleanup);

const OLD = ['a', 'b', 'c', 'd'].join('\n');
const NEW = ['a', 'B', 'c', 'x', 'd'].join('\n');

describe('lineDiff — aligned, not paired by index', () => {
  it('an inserted line leaves the lines after it unchanged', () => {
    const ops = lineDiff(OLD, NEW);
    expect(diffStat(ops)).toEqual({ add: 2, del: 1 });
    const rows = splitRows(ops);
    // a | a, b | B (changed), c | c, filler | x, d | d
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'a'], ['b', 'B'], ['c', 'c'], [null, 'x'], ['d', 'd'],
    ]);
    expect(rows[4].left?.del).toBe(false);
    expect(rows[4].right?.n).toBe(5);
  });

  it('ratio blocks: five, split by share', () => {
    expect(ratioBlocks(6, 2)).toEqual(['a', 'a', 'a', 'a', 'd']);
    expect(ratioBlocks(0, 0)).toEqual([]);
  });
});

describe('Edit — split view and unified switch', () => {
  const diff = { path: 'src/session/title.ts', oldText: OLD, newText: NEW };

  it('split: before | after rows with line numbers and filler', () => {
    const { container } = render(EditCard, { result: '', diff });
    expect(container.querySelectorAll('.sl-row')).toHaveLength(5);
    expect(container.querySelectorAll('.sl.empty')).toHaveLength(1);
    expect(container.querySelector('.sl.add .sl-n')?.textContent).toBe('2');
  });

  it('the switch goes to unified: one column, del and add lines in order', async () => {
    const { container, getByRole } = render(EditCard, { result: '', diff });
    await fireEvent.click(getByRole('button', { name: 'Unified' }));
    const lines = [...container.querySelectorAll('.ul')].map((l) => l.className.includes('del') ? `-${l.textContent}` : l.className.includes('add') ? `+${l.textContent}` : ` ${l.textContent}`);
    expect(lines.map((l) => l.replace(/\d+/g, '').trim())).toEqual(['a', '-b', '+B', 'c', '+x', 'd']);
  });

  it('the row carries +a −d and five ratio blocks', () => {
    const { container } = render(ToolCard, { title: 'Edit: src/session/title.ts', kind: 'edit', toolName: 'edit', status: 'completed', diff });
    expect(container.querySelector('.tool-stat')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('+2 −1');
    expect(container.querySelectorAll('.tool-blocks i')).toHaveLength(5);
  });
});
