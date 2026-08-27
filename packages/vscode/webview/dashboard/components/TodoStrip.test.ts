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
