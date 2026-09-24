// t-l1d0yq — the collapsed drawer's leftover box (TodoStrip only translates
// off-screen; it never leaves layout) kept `.todo-overlay`'s default
// `pointer-events: auto` + `overflow-y: auto`, so a wheel over the former todo
// region scrolled the overlay's own (empty) scroll container instead of
// reaching the chat transcript underneath. Fix: collapsed drops out of
// hit-testing (pointer-events: none), with the pull-tab opting back in.

import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import TodoOverlay from './TodoOverlay.svelte';

const TODOS = [
  { id: 1, content: 'write the parser', activeForm: 'Writing the parser', status: 'in_progress' as const },
];

// jsdom does not resolve the CSS cascade for scoped Svelte stylesheets
// reliably (no layout engine), so these assert the DOM contract the fix's
// CSS rule (`.todo-overlay.collapsed { pointer-events: none }`, see the
// component's <style>) is keyed off: whether `.collapsed` lands on the rail.
// Reading that stylesheet rule alongside this test is what proves the wheel
// fix; the two together are the checked behaviour.
describe('TodoOverlay — collapsed drawer gives wheel/pointer events back to the chat scroller', () => {
  it('expanded: the rail has no .collapsed class (pointer-events stays auto, per the component stylesheet)', () => {
    const { container } = render(TodoOverlay, {
      props: { todos: TODOS, source: 'model_write', collapsed: false, onToggleCollapse: () => {} },
    });
    const rail = container.querySelector('.todo-overlay')!;
    expect(rail.classList.contains('collapsed')).toBe(false);
  });

  it('collapsed: the rail gets .collapsed, which the stylesheet keys pointer-events: none off of', () => {
    const { container } = render(TodoOverlay, {
      props: { todos: TODOS, source: 'model_write', collapsed: true, onToggleCollapse: () => {} },
    });
    const rail = container.querySelector('.todo-overlay')!;
    expect(rail.classList.contains('collapsed')).toBe(true);
  });

  it('collapsed: the pull-tab handle is still present and reachable to reopen the drawer', () => {
    const { container } = render(TodoOverlay, {
      props: { todos: TODOS, source: 'model_write', collapsed: true, onToggleCollapse: () => {} },
    });
    expect(container.querySelector('.todo-tab')).not.toBeNull();
  });
});
