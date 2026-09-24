// taskParallelCard.test.ts — t-q910fo: a `task_parallel` card has NO header of
// its own.
//
// The card used to print a tab strip above the children. ToolCard.svelte already
// draws the frame header (title, the sub-agent badge, the status tick) for this
// card exactly as it does for a `task` card, so the strip was a second heading
// on one card — and it put every child but one behind a click.
//
// What is asserted is ABSENCE of that chrome plus PRESENCE of every child's
// text: "no header" must not be bought by dropping content.
import { render, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach } from 'vitest';
import TaskParallelCard from './TaskParallelCard.svelte';

afterEach(() => cleanup());

const TWO = [
  '── child 1: explore ──',
  'found the loader',
  '── child 2: general ──',
  'patched the loader',
].join('\n');

describe('TaskParallelCard (t-q910fo)', () => {
  it('draws no tab strip and no tab buttons', () => {
    const { container } = render(TaskParallelCard, { result: TWO });
    expect(container.querySelector('.parallel-tabs')).toBeNull();
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('shows BOTH children at once — each one a row, in order', () => {
    const { container } = render(TaskParallelCard, { result: TWO });
    const bodies = container.querySelectorAll('.parallel-body');
    expect(bodies.length).toBe(2);
    expect(container.textContent).toContain('found the loader');
    expect(container.textContent).toContain('patched the loader');
    expect(container.textContent).toContain('Child 1 — explore');
  });

  it('a single unsplit result is drawn bare, like a task card — no label over it', () => {
    const { container } = render(TaskParallelCard, { result: 'one merged answer' });
    expect(container.querySelectorAll('.parallel-body').length).toBe(1);
    expect(container.textContent).toContain('one merged answer');
    // The generic 'Sub-agent output' name would be exactly the heading this card lost.
    expect(container.textContent).not.toContain('Sub-agent output');
  });
});
