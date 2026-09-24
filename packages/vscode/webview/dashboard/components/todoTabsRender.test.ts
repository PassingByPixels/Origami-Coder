// The todo panel's tab strip, DRAWN — the half todoTabs.test.ts cannot assert.
//
// The rule module says which tabs exist; this says the overlay actually puts
// them on screen, that clicking one swaps the list under it, and that a tab
// which stops earning its place leaves without taking the panel with it.
//
// Direct-render on the overlay rather than the strip alone: the thing that was
// broken for the owner was the PANEL showing one list while a sub-agent kept
// another, and the wiring between the two components is where that lives.
// (jsdom has no layout engine here — nothing below asserts size or position.)

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TodoOverlay from './TodoOverlay.svelte';
import { MAIN_TAB, type SubagentTodoList } from './todoTabs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ids are the list's own array indices on the wire (acpTodoWrite.ts), and
// TodoStrip keys its rows on them — so a fixture that reuses one is a fixture
// that cannot render, not a bug in the strip.
let nextId = 0;
const todo = (content: string, status: 'pending' | 'in_progress' | 'completed' = 'pending') => ({
  id: nextId++, content, activeForm: content, status,
});

const MAIN = [todo('the chat’s own plan')];

function draw(subagents: SubagentTodoList[], selected = MAIN_TAB) {
  let picked = selected;
  const { container, rerender } = render(TodoOverlay, {
    todos: MAIN, source: 'model_write', collapsed: false, onToggleCollapse: () => {},
    subagents, selectedTab: picked, onSelectTab: (id: string) => { picked = id; },
  });
  return {
    container,
    tabs: () => [...container.querySelectorAll('.todo-listtab-label')].map((t) => t.textContent),
    items: () => [...container.querySelectorAll('.todo-content')].map((t) => t.textContent?.trim()),
    click: async (label: string) => {
      const btn = [...container.querySelectorAll('.todo-listtab')]
        .find((b) => b.querySelector('.todo-listtab-label')?.textContent === label) as HTMLElement;
      await fireEvent.click(btn);
      return picked;
    },
    show: (id: string, subs: SubagentTodoList[]) =>
      rerender({
        todos: MAIN, source: 'model_write', collapsed: false, onToggleCollapse: () => {},
        subagents: subs, selectedTab: id, onSelectTab: () => {},
      }),
  };
}

const child = (over: Partial<SubagentTodoList> = {}): SubagentTodoList => ({
  key: 'child-1', label: 'Explore · T1 · audit the bundle', short: 'T1', settled: false,
  todos: [todo('read the manifest'), todo('diff the bundles')],
  ...over,
});

afterEach(cleanup);

describe('the todo panel’s tab strip', () => {
  it('draws NO strip when the chat is the only list there is', () => {
    // One tab reading "Main" over the only list spends a line of a narrow
    // panel saying nothing. The list itself must still be there.
    const p = draw([]);
    expect(p.container.querySelector('.todo-listtabs')).toBeNull();
    expect(p.items()).toEqual(['the chat’s own plan']);
  });

  it('APPEARS when a sub-agent writes a list, showing Main by default', () => {
    const p = draw([child()]);
    expect(p.tabs()).toEqual(['Main', 'T1']);
    // Default selection unchanged — a sub-agent starting work must not yank the
    // panel away from the list the user was reading.
    expect(p.items()).toEqual(['the chat’s own plan']);
  });

  it('SWITCHES the list when its tab is picked', async () => {
    const p = draw([child()]);
    expect(await p.click('T1')).toBe('child-1');
    // The pane owns the selection, so prove the swap by drawing at the id the
    // click reported — the same round trip the real pane makes.
    await p.show('child-1', [child()]);
    expect(p.items()).toEqual(['read the manifest', 'diff the bundles']);
  });

  it('STAYS when the sub-agent finishes everything, drawn dim with its done count', async () => {
    // t-geo4n3, the owner's defect on 0.4.144: four sub-agents finished and the
    // strip was empty. A child whose whole job is one todowrite settles within a
    // step of its list arriving, so a tab that died with the child was never
    // seen. It stays, and says what the child got done.
    const p = draw([child()], MAIN_TAB);
    await p.show('child-1', [child()]);
    expect(p.items()).toEqual(['read the manifest', 'diff the bundles']);

    await p.show('child-1', [child({
      settled: true,
      todos: [todo('read the manifest', 'completed'), todo('diff the bundles', 'completed')],
    })]);
    expect(p.tabs()).toEqual(['Main', 'T1']);
    // Still readable, on the tab the user had picked — not yanked back to Main.
    expect(p.items()).toEqual(['read the manifest', 'diff the bundles']);
    const tab = [...p.container.querySelectorAll('.todo-listtab')][1];
    expect(tab.classList.contains('todo-listtab-settled')).toBe(true);
    // The DONE count, not the open one: an abandoned item is not pending work.
    expect(tab.querySelector('.todo-listtab-count')?.textContent).toBe('2');
  });

  it('KEEPS a stopped sub-agent that left work open, counting only what it DID', async () => {
    const p = draw([child({ settled: true, todos: [todo('read the manifest', 'completed'), todo('diff the bundles')] })]);
    expect(p.tabs()).toEqual(['Main', 'T1']);
    const tab = [...p.container.querySelectorAll('.todo-listtab')][1];
    expect(tab.classList.contains('todo-listtab-settled')).toBe(true);
    expect(tab.querySelector('.todo-listtab-count')?.textContent).toBe('1');
    // Main is first, and never wears the settled dimming.
    const main = [...p.container.querySelectorAll('.todo-listtab')][0];
    expect(main.querySelector('.todo-listtab-label')?.textContent).toBe('Main');
    expect(main.classList.contains('todo-listtab-settled')).toBe(false);
  });

  it('DISAPPEARS when the child CLEARS its list, and Main comes back', async () => {
    // The one way a tab still goes on its own: an empty list has nothing to show.
    const p = draw([child()], MAIN_TAB);
    await p.show('child-1', [child()]);
    expect(p.items()).toEqual(['read the manifest', 'diff the bundles']);

    await p.show('child-1', [child({ settled: true, todos: [] })]);
    expect(p.container.querySelector('.todo-listtabs')).toBeNull();
    expect(p.items()).toEqual(['the chat’s own plan']);
  });

  it('names the tab T<n> and hangs the FULL identity on the hover', async () => {
    // Never the word `task`: a fan-out used to draw one tab per agent all
    // reading the same thing. `T1` fits a 150px phone panel; the hover says who.
    const p = draw([child()]);
    const tab = [...p.container.querySelectorAll('.todo-listtab')][1];
    expect(tab.textContent?.trim().startsWith('T1')).toBe(true);
    expect(tab.getAttribute('title')).toBe('Explore · T1 · audit the bundle');
  });

  it('counts the OPEN items on each tab, and nothing when there are none', () => {
    const p = draw([child(), child({ key: 'c2', short: 'T2', label: 'T2 · quiet one', todos: [todo('done it', 'completed')] })]);
    const counts = [...p.container.querySelectorAll('.todo-listtab')].map((b) => b.querySelector('.todo-listtab-count')?.textContent ?? '');
    expect(counts).toEqual(['1', '2', '']);
  });

  // t-f9jxl1, acceptance 1: Main is never lost, even with nothing of its own
  // to show and a sub-agent's tab picked.
  it('keeps Main present and selectable with an EMPTY main list and a sub-agent tab outstanding', async () => {
    const emptyMain = [] as const;
    const { container, rerender } = render(TodoOverlay, {
      todos: [...emptyMain], source: 'model_write', collapsed: false, onToggleCollapse: () => {},
      subagents: [child()], selectedTab: 'child-1', onSelectTab: () => {},
    });
    const labels = () => [...container.querySelectorAll('.todo-listtab-label')].map((t) => t.textContent);
    expect(labels()).toEqual(['Main', 'T1']);
    const mainTab = [...container.querySelectorAll('.todo-listtab')]
      .find((b) => b.querySelector('.todo-listtab-label')?.textContent === 'Main') as HTMLButtonElement;
    expect(mainTab).not.toBeUndefined();
    expect(mainTab.disabled).toBe(false);

    // And falls back to Main correctly when the selected sub-agent tab drops,
    // rather than going blank with the empty list it never had a tab for.
    await rerender({
      todos: [...emptyMain], source: 'model_write', collapsed: false, onToggleCollapse: () => {},
      subagents: [], selectedTab: 'child-1', onSelectTab: () => {},
    });
    expect(container.querySelector('.todo-listtabs')).toBeNull();
    expect([...container.querySelectorAll('.todo-content')]).toHaveLength(0);
  });
});

// t-f9jxl1, acceptance 1: every tab shares one height and baseline, whether
// selected or not. jsdom has no layout engine — it echoes back only the
// LITERAL declared values, not a computed box, so a getComputedStyle diff
// between the selected/unselected class reads equal ('') either way and
// proves nothing (confirmed: this false-passed against the pre-fix CSS too).
// The real, breakable check is a SOURCE-level snapshot of the two rules —
// the same technique subagentTokens.test.ts's mirror guard already uses —
// asserting `.todo-listtab` sets an explicit box (height + box-sizing) and
// `.todo-listtab-on` touches ONLY colour and an inset box-shadow, never a
// box-affecting property.
describe('the todo panel\'s tab strip — shared height and baseline (CSS source)', () => {
  it('.todo-listtab declares an explicit, box-sized height', () => {
    const src = readFileSync(path.resolve(__dirname, 'TodoTabs.svelte'), 'utf8');
    const rule = src.slice(src.indexOf('.todo-listtab {'), src.indexOf('.todo-listtab:hover'));
    expect(rule).toMatch(/box-sizing:\s*border-box/);
    expect(rule).toMatch(/height:\s*\d/);
  });

  // t-geo4n3: a settled tab has to LOOK finished, and jsdom cannot tell us that
  // 0.55 opacity reads as dim — so the source check is that the rule exists, is
  // a colour-only rule, and therefore cannot break the equal-height guarantee
  // the two assertions either side of it exist to protect.
  it('.todo-listtab-settled dims by COLOUR only, never by a box property', () => {
    const src = readFileSync(path.resolve(__dirname, 'TodoTabs.svelte'), 'utf8');
    const start = src.indexOf('.todo-listtab-settled {');
    expect(start).toBeGreaterThan(-1);
    const rule = src.slice(start, src.indexOf('}', start));
    expect(rule).toMatch(/opacity:\s*0?\.\d/);
    expect(rule).not.toMatch(/\bheight:|\bpadding|border-width|\bmargin|display:/);
  });

  it('.todo-listtab-on never touches height, padding or border-width — only colour and an inset shadow', () => {
    const src = readFileSync(path.resolve(__dirname, 'TodoTabs.svelte'), 'utf8');
    const start = src.indexOf('.todo-listtab-on {');
    const rule = src.slice(start, src.indexOf('}', start));
    expect(rule).not.toMatch(/\bheight:/);
    expect(rule).not.toMatch(/\bpadding/);
    expect(rule).not.toMatch(/border-width/);
    // border-COLOR is fine (it already varies today); the shadow is the accent.
    expect(rule).toMatch(/box-shadow:\s*inset/);
  });
});

// t-fh4zpc: the tabs and the panel are ONE piece. On 0.4.143 the owner shut the
// Todo panel and the "Main 3 | T1 3" strip stayed on screen by itself, because
// TodoTabs was a SIBLING of the strip that carries the collapse. The tabs are
// now the first row inside `.todo-panel` — the box the collapse transform moves
// — so one state governs both.
//
// What the DOM can prove here and what it cannot: exactly as with the item list
// (TodoStrip.test.ts), the tabs are HIDDEN BY THE SLIDE, never dropped, so
// reopening is instant and the selection survives. jsdom has no layout engine,
// so "hidden" is asserted STRUCTURALLY — the tabs sit inside the element that
// takes `.collapsed`, and nothing draws them outside it — plus a source check
// that the collapsed rule really transforms that same element.
describe('the todo panel’s tab strip — one piece with the panel (t-fh4zpc)', () => {
  const overlay = (collapsed: boolean): HTMLElement =>
    render(TodoOverlay, {
      todos: MAIN, source: 'model_write', collapsed, onToggleCollapse: () => {},
      subagents: [child()], selectedTab: MAIN_TAB, onSelectTab: () => {},
    }).container;

  it('open: the tabs AND the list are drawn inside the panel box, tabs first', () => {
    const c = overlay(false);
    const panel = c.querySelector('.todo-strip.drawer .todo-panel')!;
    expect(panel).not.toBeNull();
    expect([...panel.querySelectorAll('.todo-listtab-label')].map((t) => t.textContent)).toEqual(['Main', 'T1']);
    expect(panel.querySelector('.todo-list')).not.toBeNull();
    // Nothing draws a tab strip outside the panel any more.
    expect(c.querySelectorAll('.todo-listtabs')).toHaveLength(1);
    expect(panel.firstElementChild!.classList.contains('todo-listtabs')).toBe(true);
  });

  it('closed: the tabs ride the collapse inside the panel; only the pull-tab is left outside', () => {
    const c = overlay(true);
    const strip = c.querySelector('.todo-strip')!;
    expect(strip.classList.contains('collapsed')).toBe(true);
    const tabs = c.querySelector('.todo-listtabs')!;
    expect(tabs.closest('.todo-strip.collapsed')).toBe(strip);
    expect(tabs.closest('.todo-panel')).not.toBeNull();
    // The pull-tab is the one thing that stays out of the panel, so a shut
    // drawer can always be pulled back open.
    expect(c.querySelector('.todo-tab')!.closest('.todo-panel')).toBeNull();
  });

  it('the collapsed rule moves the element the tabs are inside (CSS source)', () => {
    const src = readFileSync(path.resolve(__dirname, 'TodoStrip.svelte'), 'utf8');
    const start = src.indexOf('.todo-strip.drawer.collapsed {');
    expect(src.slice(start, src.indexOf('}', start))).toMatch(/transform:\s*translateX/);
  });
});

// t-fdw9nh / t-ffjr3h, RE-PINNED for t-fh4zpc. Both tickets existed only because
// the strip was outside the panel: the left inset re-created the panel's own
// three lefts by hand (pull-tab gutter 16 + accent border 4 + panel padding 12 =
// 32) and the right one re-created its right padding, so that the `border-bottom`
// — drawn at the BOX edge, which is why it is a margin and not a padding — ended
// where the panel ended. Inside the panel those numbers would indent the tabs
// twice; the panel's padding is now the single source of both ends.
describe('the todo panel’s tab strip — underline matches the panel box (CSS source)', () => {
  const tabsSrc = readFileSync(path.resolve(__dirname, 'TodoTabs.svelte'), 'utf8');

  // Slices one named rule block out of a stylesheet source string.
  const rule = (src: string, selector: string): string => {
    const start = src.indexOf(selector);
    if (start < 0) throw new Error(`${selector} not found`);
    return src.slice(start, src.indexOf('}', start));
  };

  it('carries no horizontal inset of its own — only the gap under the rule', () => {
    const tabsRule = rule(tabsSrc, '.todo-listtabs {');
    // Shorthand `margin: <top> <right> <bottom> <left>`.
    const [, top, right, bottom, left] = tabsRule.match(/margin:\s*(\S+)\s+(\S+)\s+(\S+)\s+([^;]+);/) ?? [];
    expect([top, right, left]).toEqual(['0', '0', '0']);
    expect(bottom).toBe('4px');
    // The rule itself is still drawn: it is what the bookmarks break.
    expect(tabsRule).toMatch(/border-bottom:\s*1px solid/);
  });

  it('keeps no stale 32/12 inset anywhere in the file', () => {
    expect(tabsSrc).not.toMatch(/margin:[^;]*\b(32|12)px/);
  });
});
