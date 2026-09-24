// todoTabs — which todo lists the panel offers, and what happens to the
// selection when one goes away.
//
// The owner's defect: a sub-agent wrote nine todos, the transcript card showed
// them as raw JSON, and the Todo panel showed the chat's own list as if nothing
// else were happening. These assert the RULE half of the fix — who earns a tab,
// what it is called, and the two ways a tab stops existing. The rendered half
// (the strip appears, switching swaps the list) is todoTabsRender.test.ts.

import { describe, expect, it } from 'vitest';
import {
  MAIN_TAB,
  activeTab,
  subagentTodoLists,
  tabTitles,
  tabWorthKeeping,
  todoTabs,
} from './todoTabs';
import { subagentRows } from '../panes/subagentRows';

const todo = (status: string) => ({ status });
const sub = (over: Partial<Parameters<typeof tabWorthKeeping>[0]> = {}) => ({
  key: 'child-1',
  label: 'general-purpose · T1 · audit the bundle',
  short: 'T1',
  settled: false,
  todos: [todo('in_progress')],
  ...over,
});

describe('todoTabs — the strip', () => {
  it('is just Main when no sub-agent is keeping a list', () => {
    // And Main is there even with nothing in it: a strip whose first tab came
    // and went as the chat's own list did would be unreadable.
    expect(todoTabs([], [])).toEqual([{ id: MAIN_TAB, label: 'Main', todos: [], settled: false }]);
  });

  it('APPEARS: a sub-agent with todos earns a tab, after Main', () => {
    const tabs = todoTabs([todo('pending')], [sub()]);
    expect(tabs.map((t) => t.id)).toEqual([MAIN_TAB, 'child-1']);
    // The T-number, not prose: the full identity is the hover (tabTitles).
    expect(tabs[1].label).toBe('T1');
    expect(tabs[1].todos).toHaveLength(1);
  });

  it('keeps the roster order for several sub-agents', () => {
    // Oldest-first, the order subagentRows.ts hands over — so the tab strip and
    // the drawer beside it list the same agents the same way round.
    const tabs = todoTabs([], [sub({ key: 'a', short: 'T1' }), sub({ key: 'b', short: 'T2' })]);
    expect(tabs.map((t) => t.id)).toEqual([MAIN_TAB, 'a', 'b']);
  });
});

describe('todoTabs — when a tab DISAPPEARS', () => {
  it('drops a sub-agent whose list is empty, running or not', () => {
    expect(tabWorthKeeping(sub({ todos: [] }))).toBe(false);
    expect(tabWorthKeeping(sub({ todos: [], settled: true }))).toBe(false);
  });

  it('KEEPS a FINISHED sub-agent that left a list behind', () => {
    // t-geo4n3, reversing t-f6u661: a child whose whole job is one todowrite
    // settles within a step of its list arriving, so a tab that died with the
    // child lived for under a second — the owner saw NO tabs at all on 0.4.144,
    // for four finished sub-agents. The finished list stays, drawn dim; the
    // owner retires it with the × on the drawer row.
    expect(tabWorthKeeping(sub({ settled: true, todos: [todo('completed'), todo('completed')] }))).toBe(true);
    expect(tabWorthKeeping(sub({ settled: true, todos: [todo('completed'), todo('pending')] }))).toBe(true);
  });

  it('KEEPS a running sub-agent whose items are all completed', () => {
    // It is still out; the next thing it writes may add to the list.
    expect(tabWorthKeeping(sub({ settled: false, todos: [todo('completed')] }))).toBe(true);
  });

  it('carries `settled` onto the tab, so the strip can draw a finished one dim', () => {
    const tabs = todoTabs([todo('pending')], [sub({ settled: true, todos: [todo('completed')] })]);
    expect(tabs.map((t) => [t.id, t.settled])).toEqual([[MAIN_TAB, false], ['child-1', true]]);
  });
});

describe('activeTab — the selection outlives its tab', () => {
  it('shows the tab the user picked', () => {
    const tabs = todoTabs([], [sub()]);
    expect(activeTab(tabs, 'child-1').id).toBe('child-1');
  });

  it('falls back to MAIN, not to "the first sub-agent", when the tab is gone', () => {
    // A sub-agent finishes its list while the user is reading it. Falling back
    // to tabs[1] would silently swap in a DIFFERENT agent's plan under the same
    // cursor; falling back to Main is visibly a change of subject.
    const tabs = todoTabs([], [sub({ key: 'other', title: 'someone else' })]);
    expect(activeTab(tabs, 'child-1').id).toBe(MAIN_TAB);
    expect(activeTab(tabs, '').id).toBe(MAIN_TAB);
  });
});

describe('subagentTodoLists — joining the roster to the pulled lists', () => {
  const rows = [
    { key: 'child-1', ordinal: 1, description: 'one', agentType: 'Explore', settled: false },
    { key: 'child-2', ordinal: 2, description: 'two', settled: true },
  ];

  it('gives a roster row with no list an empty one, rather than dropping it', () => {
    // The two halves arrive independently. A row with no list is filtered out
    // downstream by tabWorthKeeping, which is the ONE place that decision lives.
    const lists = subagentTodoLists(rows, { 'child-1': [todo('pending')] });
    expect(lists.map((l) => l.todos.length)).toEqual([1, 0]);
    expect(lists[1].settled).toBe(true);
    // Named once, by the shared helper, so the strip and the drawer agree.
    expect(lists.map((l) => [l.short, l.label]))
      .toEqual([['T1', 'Explore · T1 · one'], ['T2', 'T2 · two']]);
  });

  it('is empty when nothing has been pulled at all', () => {
    expect(subagentTodoLists(rows, undefined)).toEqual([]);
  });

  // t-geo4n3 acceptance 2: with a settled child now KEEPING its tab, the only
  // way the owner retires one is the × on its drawer row (t-h8gv8w: there is no
  // longer a bulk clear or a sweep), which adds the key to `subagentsDismissed`.
  // That set is applied by subagentRows, so the road is asserted end to end here
  // rather than trusted.
  it('a DISMISSED sub-agent has no row, so its finished list gets no tab', () => {
    const cards = [
      { taskSessionId: 'child-1', label: 'task: audit the bundle', toolStatus: 'completed', timestamp: 1 },
      { taskSessionId: 'child-2', label: 'task: read the map', toolStatus: 'completed', timestamp: 2 },
    ];
    const pulled = { 'child-1': [todo('completed')], 'child-2': [todo('completed')] };
    const tabsFor = (dismissed: string[]) =>
      todoTabs([], subagentTodoLists(subagentRows(cards, 0, new Set(dismissed)), pulled)).map((t) => t.id);

    expect(tabsFor([])).toEqual([MAIN_TAB, 'child-1', 'child-2']);
    expect(tabsFor(['child-1'])).toEqual([MAIN_TAB, 'child-2']);
    // Both rows dismissed by hand, one × each.
    expect(tabsFor(['child-1', 'child-2'])).toEqual([MAIN_TAB]);
  });

  it('ignores a list whose task card is not on the roster', () => {
    // A dismissed row, or a child whose card has not landed yet. Its list is
    // held in the pane (it may earn a tab later) but it cannot invent a tab
    // with no title to put on it.
    expect(subagentTodoLists([], { ghost: [todo('pending')] })).toEqual([]);
  });
});

describe('tabTitles — the hover behind a T-number', () => {
  it('names the chat for Main and the full identity for each child', () => {
    expect(tabTitles([sub()])).toEqual({
      [MAIN_TAB]: "This chat's own list",
      'child-1': 'general-purpose · T1 · audit the bundle',
    });
  });
});
