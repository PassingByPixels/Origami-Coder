// The round-3 Todo panel facelift (t-qn0lpl, CHANGES.md 52): the tab strip
// scrolls on a THIN scrollbar instead of clipping, the status glyph is a DOT,
// a finished task is muted rather than struck through, depth is a hairline,
// and the header carries a progress bar.
//
// WHAT IS ASSERTED WHERE, and why. jsdom has no layout engine and this suite
// never loads a <style>, so `getComputedStyle` returns '' for every one of
// these rules — a test that read one would assert nothing while looking
// rigorous (docs/WORKING_ON_ORIGAMI_CODER.md, part 6). So:
//   * anything the DOM really owns (which elements exist, which classes they
//     carry, the bar's inline width) is asserted by rendering;
//   * anything that is a CSS DECISION (thin-not-hidden scrollbar, no
//     strike-through, the depth hairline) is asserted against the component's
//     own SOURCE, the technique todoTabsRender.test.ts already uses.

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TodoOverlay from './TodoOverlay.svelte';
import TodoStrip from './TodoStrip.svelte';
import type { SubagentTodoList } from './todoTabs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(path.resolve(__dirname, file), 'utf8');

afterEach(cleanup);

let nextId = 0;
const todo = (content: string, status: 'pending' | 'in_progress' | 'completed' = 'pending') => ({
  id: nextId++, content, activeForm: content, status,
});

describe('the tab strip overflows on a thin scrollbar, never clipped', () => {
  // The owner's addition to the ticket: eight sub-agents keeping lists must not
  // cost a tab. The DOM half — every tab is rendered, inside ONE scroll box.
  it('eight sub-agent lists draw nine tabs in a single strip', () => {
    const subagents: SubagentTodoList[] = Array.from({ length: 8 }, (_, i) => ({
      key: `sa-${i}`, label: `explore · T${i + 1}`, short: `T${i + 1}`,
      todos: [todo(`child task ${i}`)], settled: false,
    }));
    const { container } = render(TodoOverlay, {
      todos: [todo('the chat’s own plan')], source: 'model_write',
      collapsed: false, onToggleCollapse: () => {}, subagents,
      selectedTab: 'main', onSelectTab: () => {},
    });
    expect(container.querySelectorAll('.todo-listtabs')).toHaveLength(1);
    expect(container.querySelectorAll('.todo-listtab')).toHaveLength(9);
  });

  // The CSS half: the strip scrolls sideways AND shows a thin scrollbar while
  // doing it. Before this the strip hid its scrollbar outright
  // (`scrollbar-width: none` + a display:none webkit rule), so an overflowing
  // strip gave the reader no sign that tabs existed off the right edge.
  //
  // WHY THIS IS A REMOVAL AND NOT A NEW RULE, and why the assertion reads TWO
  // files. shared/theme.css already gives `*` a thin bar in `var(--og-scrollbar)`;
  // the strip was opting OUT of it. Measured in the webview's own engine
  // (headless Chromium 1243, nine tabs, scrollWidth 353 against clientWidth 235)
  // a local `::-webkit-scrollbar` would change nothing either way — Chromium
  // ignores those pseudo-elements wherever `scrollbar-width` is set, and the
  // house rule sets it on everything. So the component must declare NOTHING, and
  // the house rule must still exist: the pair of them is the behaviour.
  //
  // UPDATE (t-ru0p04): "declares nothing" bought a bar that only paints while
  // an actual scroll gesture is in flight, not at rest. The first fix added the
  // three rules locally to this file; on review that moved to a REUSABLE
  // utility, `.og-scrollbar-visible` (shared/theme.css), with the class named
  // on `.todo-listtabs`'s own markup — so this file is back to declaring
  // nothing of its own, same as this comment always said, and the assertion
  // below still holds unchanged.
  it('.todo-listtabs no longer opts out of the house scrollbar', () => {
    const src = source('TodoTabs.svelte');
    const start = src.indexOf('.todo-listtabs {');
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, src.indexOf('}', start))).toMatch(/overflow-x:\s*auto/);
    // Nowhere in the component, not just in that one rule — and the COMMENTS are
    // stripped first, so the note that records the old rule is not read as the
    // rule. (An anchored regex was tried and could not fail: the suppression
    // re-added mid-line, which is how it was written originally, slipped past.)
    const css = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/scrollbar-width:\s*none/);
    expect(css).not.toMatch(/-webkit-scrollbar\s*\{\s*display:\s*none/);
  });

  // t-ru0p04 — jsdom never loads a <style> (no layout engine), so this is a
  // CSS-source check, not a computed-style one. Two files: the markup names the
  // reusable class, and theme.css defines it — scoped to `.og-scrollbar-visible`,
  // never to `*` or another selector, which is what keeps every other scroller
  // in the app on the house rule. Confirmed painting for real with a standalone
  // Chromium build of this component (screenshot, 9 tabs, scrollWidth 687 >
  // clientWidth 216 — reports/polish_theme_2026-09-22/).
  it('the strip carries the og-scrollbar-visible class', () => {
    const src = source('TodoTabs.svelte');
    expect(src).toMatch(/class="todo-listtabs\s+og-scrollbar-visible"/);
  });

  it('og-scrollbar-visible (shared/theme.css) resets scrollbar-width and paints a 4px bar', () => {
    const raw = readFileSync(path.resolve(__dirname, '../../shared/theme.css'), 'utf8');
    // Comments stripped first: a `*/` inside the class's own explanatory
    // comment otherwise reads as a `*` selector to the "not global" regex below.
    const theme = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(theme).toMatch(/\.og-scrollbar-visible\s*\{\s*scrollbar-width:\s*auto;\s*\}/);
    expect(theme).toMatch(/\.og-scrollbar-visible::-webkit-scrollbar\s*\{\s*height:\s*4px;\s*\}/);
    expect(theme).toMatch(/\.og-scrollbar-visible::-webkit-scrollbar-thumb\s*\{\s*background:\s*var\(--og-scrollbar\);\s*\}/);
    // Scoped, not global: the reset must not appear on `*` or `html, body`.
    expect(theme).not.toMatch(/\*[^{]*\{\s*scrollbar-width:\s*auto/);
  });

  it('...and the house rule it now relies on is still there', () => {
    const theme = readFileSync(path.resolve(__dirname, '../../shared/theme.css'), 'utf8');
    // The SECOND `*` block — the first is the box-sizing reset.
    const start = theme.indexOf('*, *::before, *::after {', theme.indexOf('Scrollbar styling'));
    expect(start).toBeGreaterThan(-1);
    const rule = theme.slice(start, theme.indexOf('}', start));
    expect(rule).toMatch(/scrollbar-width:\s*thin/);
    expect(rule).toMatch(/scrollbar-color:\s*var\(--og-scrollbar\)/);
  });
});

describe('a todo row says its state with a dot', () => {
  it('each row draws a status dot carrying its state', () => {
    const { container } = render(TodoStrip, {
      todos: [todo('pending one'), todo('running one', 'in_progress'), todo('finished one', 'completed')],
      source: 'model_write',
    });
    const dots = [...container.querySelectorAll('.todo-status-dot')];
    expect(dots).toHaveLength(3);
    expect(dots.map((d) => d.className)).toEqual([
      expect.stringContaining('todo-dot-pending'),
      expect.stringContaining('todo-dot-in_progress'),
      expect.stringContaining('todo-dot-completed'),
    ]);
  });

  // The glyph column is GONE, not hidden behind font-size: 0 — the product owns
  // the state and the dot reads it (porting index row 52).
  it('no ☐ / ▶ / ✓ glyph is rendered any more', () => {
    const { container } = render(TodoStrip, {
      todos: [todo('one'), todo('two', 'completed')], source: 'model_write',
    });
    expect(container.textContent).not.toMatch(/[☐▶✓]/);
  });

  it('a finished task is muted, never struck through', () => {
    const rule = source('TodoRow.svelte');
    const start = rule.indexOf('.todo-item.completed {');
    expect(start).toBeGreaterThan(-1);
    expect(rule.slice(start, rule.indexOf('}', start))).not.toMatch(/line-through/);
    expect(rule).not.toMatch(/line-through/);
  });

  it('depth is drawn as a hairline down the indent', () => {
    const src = source('TodoRow.svelte');
    const start = src.indexOf(".todo-item[data-depth]:not([data-depth='0'])");
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, src.indexOf('}', start))).toMatch(/border-left:\s*1px solid/);
  });
});

describe('the header carries a progress bar', () => {
  it('the bar fills to completed ÷ total and says so', () => {
    const { container } = render(TodoStrip, {
      todos: [todo('a', 'completed'), todo('b', 'completed'), todo('c'), todo('d')],
      source: 'model_write',
    });
    const bar = container.querySelector('.todo-bar');
    expect(bar).not.toBeNull();
    expect((bar!.querySelector('.todo-bar-fill') as HTMLElement).style.width).toBe('50%');
    expect(bar!.getAttribute('title')).toBe('2 of 4 done');
  });

  it('no rows, no bar', () => {
    const { container } = render(TodoStrip, { todos: [], source: 'model_write' });
    expect(container.querySelector('.todo-bar')).toBeNull();
  });
});
