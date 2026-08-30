// Tweak 1 (0.2.176) — TodoStrip is now a SIDE-DRAWER. The run-time overlay strip
// gains a keyboard-focusable pull-tab; collapsing slides the whole panel off
// toward the docked edge but keeps the item list MOUNTED (hidden by the slide,
// not dropped) so reopening is instant and preserves items. These assert that
// observable contract: the tab is always present and reports aria-expanded
// honestly, the strip flips its .collapsed class, the rows stay in the DOM in
// both states, and clicking the tab asks the parent to toggle.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TodoStrip from './TodoStrip.svelte';

const TODOS = [
  { id: 1, content: 'write the parser', activeForm: 'Writing the parser', status: 'in_progress' as const },
  { id: 2, content: 'run the tests', activeForm: 'Running the tests', status: 'pending' as const },
];

describe('TodoStrip — collapsible side drawer', () => {
  it('expanded: items shown, strip NOT collapsed, tab reports aria-expanded=true', () => {
    const { container } = render(TodoStrip, {
      props: { todos: TODOS, source: 'model_write', collapsible: true, collapsed: false },
    });
    expect(screen.getByText('write the parser')).toBeInTheDocument();
    expect(screen.getByText('run the tests')).toBeInTheDocument();
    const strip = container.querySelector('.todo-strip')!;
    expect(strip.classList.contains('drawer')).toBe(true);
    expect(strip.classList.contains('collapsed')).toBe(false);
    const tab = screen.getByRole('button', { name: /hide task list/i });
    expect(tab.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapsed: strip gets .collapsed + tab flips to Show/aria-expanded=false, but the rows STAY mounted', () => {
    const { container } = render(TodoStrip, {
      props: { todos: TODOS, source: 'model_write', collapsible: true, collapsed: true },
    });
    const strip = container.querySelector('.todo-strip')!;
    expect(strip.classList.contains('collapsed')).toBe(true);
    // The item list is only slid off (CSS), never removed — a collapsed drawer
    // still holds its items so reopen is instant.
    expect(screen.getByText('write the parser')).toBeInTheDocument();
    expect(screen.getByText('run the tests')).toBeInTheDocument();
    const tab = screen.getByRole('button', { name: /show task list/i });
    expect(tab.getAttribute('aria-expanded')).toBe('false');
  });

  it('the pull-tab is present in BOTH states (a hidden drawer can always be reopened)', () => {
    const open = render(TodoStrip, { props: { todos: TODOS, source: 'model_write', collapsible: true, collapsed: false } });
    expect(open.container.querySelector('.todo-tab')).not.toBeNull();
    open.unmount();
    const shut = render(TodoStrip, { props: { todos: TODOS, source: 'model_write', collapsible: true, collapsed: true } });
    expect(shut.container.querySelector('.todo-tab')).not.toBeNull();
  });

  it('clicking the tab asks the parent to toggle (parent owns the persisted flag)', async () => {
    const onToggleCollapse = vi.fn();
    render(TodoStrip, { props: { todos: TODOS, source: 'model_write', collapsible: true, collapsed: false, onToggleCollapse } });
    await fireEvent.click(screen.getByRole('button', { name: /hide task list/i }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('reopening shows the same items (they were never discarded)', async () => {
    const { rerender } = render(TodoStrip, { props: { todos: TODOS, source: 'model_write', collapsible: true, collapsed: true } });
    expect(screen.getByText('write the parser')).toBeInTheDocument();
    await rerender({ todos: TODOS, source: 'model_write', collapsible: true, collapsed: false });
    expect(screen.getByText('write the parser')).toBeInTheDocument();
    expect(screen.getByText('run the tests')).toBeInTheDocument();
  });

  it('non-collapsible mode renders no drawer tab (unchanged legacy behaviour)', () => {
    render(TodoStrip, { props: { todos: TODOS, source: 'model_write' } });
    expect(screen.getByText('write the parser')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /task list/i })).toBeNull();
  });
});

// Nested todos (0.4.64). STRUCTURAL assertions only: vitest.config.mts does not
// set `css: true`, so no <style> element ever reaches the test DOM and a check
// on computed style would pass while asserting nothing. What is checked here is
// that the depth reaches the row's own attributes at all; that the NUMBER is
// right is todoTree.test.ts's job, and how it looks is the owner's.
describe('TodoStrip — nesting', () => {
  const NESTED = [
    { id: 1, content: 'Add the export button', activeForm: 'Adding it', status: 'in_progress' as const, depth: 0 },
    { id: 2, content: 'Wire the click handler', activeForm: 'Wiring it', status: 'completed' as const, depth: 1 },
    { id: 3, content: 'Write the file', activeForm: 'Writing it', status: 'pending' as const, depth: 1 },
    { id: 4, content: 'Update the docs', activeForm: 'Updating them', status: 'pending' as const, depth: 0 },
  ];

  const rows = (container: HTMLElement) => [...container.querySelectorAll('.todo-item')];

  it('indents each row by its depth and stamps the depth on the row', () => {
    const { container } = render(TodoStrip, { props: { todos: NESTED, source: 'model_write' } });
    const items = rows(container);
    expect(items).toHaveLength(4);
    expect(items.map((li) => li.getAttribute('data-depth'))).toEqual(['0', '1', '1', '0']);
    // 14px per level — the step todoTree.ts owns.
    expect(items.map((li) => li.getAttribute('style'))).toEqual([
      'padding-left: 0px;',
      'padding-left: 14px;',
      'padding-left: 14px;',
      'padding-left: 0px;',
    ]);
  });

  it('shows a done/total chip on a row that HAS children, and on no other row', () => {
    const { container } = render(TodoStrip, { props: { todos: NESTED, source: 'model_write' } });
    const chips = rows(container).map((li) => li.querySelector('.todo-child-count')?.textContent ?? null);
    expect(chips).toEqual(['1/2', null, null, null]);
  });

  it('normalises a list the model got wrong instead of dropping any of it', () => {
    // A first row claiming depth 2, then a jump. Every task must still appear.
    const wrong = [
      { id: 1, content: 'first', activeForm: '', status: 'pending' as const, depth: 2 },
      { id: 2, content: 'second', activeForm: '', status: 'pending' as const, depth: 9 },
      { id: 3, content: 'third', activeForm: '', status: 'pending' as const, depth: -1 },
    ];
    const { container } = render(TodoStrip, { props: { todos: wrong, source: 'model_write' } });
    expect(rows(container).map((li) => li.getAttribute('data-depth'))).toEqual(['0', '1', '0']);
    for (const text of ['first', 'second', 'third']) expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('BACK-COMPAT: a list with no depth anywhere renders flat, with no chip on any row', () => {
    const { container } = render(TodoStrip, { props: { todos: TODOS, source: 'model_write' } });
    const items = rows(container);
    expect(items.map((li) => li.getAttribute('data-depth'))).toEqual(['0', '0']);
    expect(items.map((li) => li.getAttribute('style'))).toEqual(['padding-left: 0px;', 'padding-left: 0px;']);
    expect(container.querySelector('.todo-child-count')).toBeNull();
  });
});

// A major is a CONTAINER, not a work item: it can be shut like a folder, and it
// is not counted as a task in its own right. STRUCTURAL assertions only — what
// is asserted is which rows are in the DOM and what the twisty reports, never a
// computed style (no <style> reaches the test DOM at all).
describe('TodoStrip — majors are containers', () => {
  const rows = (container: HTMLElement) => [...container.querySelectorAll('.todo-item')];
  const texts = (container: HTMLElement) => rows(container).map((li) => li.querySelector('.todo-content')!.textContent);

  const OPEN_BRANCH = [
    { id: 1, content: 'Add the export button', activeForm: 'Adding it', status: 'in_progress' as const, depth: 0 },
    { id: 2, content: 'Wire the click handler', activeForm: 'Wiring it', status: 'completed' as const, depth: 1 },
    { id: 3, content: 'Write the file', activeForm: 'Writing it', status: 'pending' as const, depth: 1 },
    { id: 4, content: 'Update the docs', activeForm: 'Updating them', status: 'pending' as const, depth: 0 },
  ];

  const SETTLED_BRANCH = [
    { id: 1, content: 'Add the export button', activeForm: 'Adding it', status: 'completed' as const, depth: 0 },
    { id: 2, content: 'Wire the click handler', activeForm: 'Wiring it', status: 'completed' as const, depth: 1 },
    { id: 3, content: 'Update the docs', activeForm: 'Updating them', status: 'pending' as const, depth: 0 },
  ];

  it('gives a row with children a twisty, and a leaf none', () => {
    const { container } = render(TodoStrip, { props: { todos: OPEN_BRANCH, source: 'model_write' } });
    const twisties = rows(container).map((li) => li.querySelector('.todo-twisty') !== null);
    expect(twisties).toEqual([true, false, false, false]);
  });

  it('starts an open branch EXPANDED and reports it on the twisty', () => {
    const { container } = render(TodoStrip, { props: { todos: OPEN_BRANCH, source: 'model_write' } });
    expect(texts(container)).toHaveLength(4);
    expect(container.querySelector('.todo-twisty')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('clicking the twisty hides the whole branch, and clicking again brings it back', async () => {
    const { container } = render(TodoStrip, { props: { todos: OPEN_BRANCH, source: 'model_write' } });
    const twisty = container.querySelector('.todo-twisty')!;
    await fireEvent.click(twisty);
    expect(texts(container)).toEqual(['Add the export button', 'Update the docs']);
    expect(container.querySelector('.todo-twisty')!.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(container.querySelector('.todo-twisty')!);
    expect(texts(container)).toHaveLength(4);
  });

  // Nothing under it will change again, so it opens as a one-line summary —
  // and the user can still look inside.
  it('starts a branch whose children are ALL terminal collapsed, and re-opens it on click', async () => {
    const { container } = render(TodoStrip, { props: { todos: SETTLED_BRANCH, source: 'model_write' } });
    expect(texts(container)).toEqual(['Add the export button', 'Update the docs']);
    await fireEvent.click(container.querySelector('.todo-twisty')!);
    expect(texts(container)).toEqual(['Add the export button', 'Wire the click handler', 'Update the docs']);
  });

  it('keeps the done/total chip on a collapsed parent — that is the whole point of shutting it', () => {
    const { container } = render(TodoStrip, { props: { todos: SETTLED_BRANCH, source: 'model_write' } });
    expect(rows(container)[0]!.querySelector('.todo-child-count')!.textContent).toBe('1/1');
  });

  // The header answers "how much work is left", so a container must not be a
  // task in it: OPEN_BRANCH is 3 leaves (one done), not 4 items.
  it('counts LEAVES in the header, not containers', () => {
    render(TodoStrip, { props: { todos: OPEN_BRANCH, source: 'model_write' } });
    expect(screen.getByText(/1\/3 done/)).toBeInTheDocument();
  });

  it('the twisty is not announced as the drawer tab (they are different buttons)', () => {
    render(TodoStrip, { props: { todos: OPEN_BRANCH, source: 'model_write' } });
    expect(screen.queryByRole('button', { name: /task list/i })).toBeNull();
    expect(screen.getByRole('button', { name: /sub-tasks/i })).toBeInTheDocument();
  });
});

describe('TodoStrip — nesting (back-compat)', () => {
  const rows = (container: HTMLElement) => [...container.querySelectorAll('.todo-item')];

  it('BACK-COMPAT: a list with no depth anywhere renders flat, with no chip on any row', () => {
    const { container } = render(TodoStrip, { props: { todos: TODOS, source: 'model_write' } });
    const items = rows(container);
    expect(items.map((li) => li.getAttribute('data-depth'))).toEqual(['0', '0']);
    expect(items.map((li) => li.getAttribute('style'))).toEqual(['padding-left: 0px;', 'padding-left: 0px;']);
    expect(container.querySelector('.todo-child-count')).toBeNull();
  });
});
