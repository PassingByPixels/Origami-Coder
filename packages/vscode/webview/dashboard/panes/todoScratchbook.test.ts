// todoScratchbook — WHEN the todo panel is on screen.
//
// Two defects live behind this one predicate. The first (0.3.x): the pane threw
// the list away at every turn end, so a chat that fanned work out to background
// children blinked its checklist out seconds after each spawn — fixed by keying
// on OPEN WORK rather than on the turn. The second (t-geo4n3, owner UAT on
// 0.4.144): the predicate read the chat's OWN list only, so a main list that was
// empty or finished took every sub-agent's list off the screen with it, tabs and
// all. The rule now: any list that earns a tab keeps the panel up.

import { describe, expect, it } from 'vitest';
import { hasOpenWork, todoOverlayVisible } from './todoScratchbook';
import type { SubagentTodoList } from '../components/todoTabs';

const row = (status: 'pending' | 'in_progress' | 'completed') => ({ status });
const DONE = [row('completed')];
const OPEN = [row('completed'), row('in_progress')];

const child = (over: Partial<SubagentTodoList> = {}): SubagentTodoList => ({
  key: 'child-1', label: 'Explore · T1 · audit the bundle', short: 'T1',
  settled: false, todos: [{ status: 'pending' }],
  ...over,
});

describe('hasOpenWork — what keeps a list alive', () => {
  it('is true while anything is pending or in progress', () => {
    expect(hasOpenWork([row('completed'), row('pending')])).toBe(true);
    expect(hasOpenWork([row('in_progress')])).toBe(true);
  });

  it('is false for an all-done list and for no list at all', () => {
    expect(hasOpenWork(DONE)).toBe(false);
    expect(hasOpenWork([])).toBe(false);
  });
});

describe('todoOverlayVisible — the chat’s own list', () => {
  it('shows a list with open work, whatever the turn is doing', () => {
    expect(todoOverlayVisible(false, false, OPEN)).toBe(true);
  });

  it('shows a FINISHED list only while in flight or lingering', () => {
    // The linger is what lets a just-completed list be seen before it retires
    // into the transcript; in flight covers a model that writes its whole list
    // at the very end of a turn.
    expect(todoOverlayVisible(false, false, DONE)).toBe(false);
    expect(todoOverlayVisible(true, false, DONE)).toBe(true);
    expect(todoOverlayVisible(false, true, DONE)).toBe(true);
  });

  it('never shows an EMPTY panel, even in flight or lingering', () => {
    expect(todoOverlayVisible(true, true, [])).toBe(false);
  });
});

// t-geo4n3 acceptance 3. The owner's screenshot: main 1/1 done, four sub-agents
// done, no panel and no tabs. Each case below is a state that used to hide a
// sub-agent's list.
describe('todoOverlayVisible — a sub-agent’s list holds the panel up', () => {
  it('shows the panel for a sub-agent list with an EMPTY main list', () => {
    expect(todoOverlayVisible(false, false, [], [child()])).toBe(true);
  });

  it('shows the panel for a sub-agent list with a COMPLETE main list', () => {
    expect(todoOverlayVisible(false, false, DONE, [child()])).toBe(true);
  });

  it('keeps it up for a SETTLED child — the case the owner actually saw', () => {
    // The child finished; its list is now history, and history is exactly what
    // the owner was looking for when the panel was blank.
    expect(todoOverlayVisible(false, false, DONE, [child({ settled: true, todos: [{ status: 'completed' }] })]))
      .toBe(true);
  });

  it('does NOT count a child that has no list, or one that cleared it', () => {
    // Same rule as the strip's, imported rather than restated: no list, no tab,
    // no panel. Otherwise a roster of finished children would pin an empty
    // panel open for the rest of the session.
    expect(todoOverlayVisible(false, false, [], [child({ todos: [] })])).toBe(false);
    expect(todoOverlayVisible(false, false, DONE, [child({ settled: true, todos: [] })])).toBe(false);
  });

  it('leaves the linger to cover the case where NOTHING is left', () => {
    // Main finished, the last child's list cleared: this is the one path back
    // to a hidden panel, and it still runs through the 1.8s linger.
    expect(todoOverlayVisible(false, true, DONE, [child({ settled: true, todos: [] })])).toBe(true);
    expect(todoOverlayVisible(false, false, DONE, [child({ settled: true, todos: [] })])).toBe(false);
  });

  it('defaults to the old behaviour when no sub-agent argument is given', () => {
    expect(todoOverlayVisible(false, false, DONE, [])).toBe(false);
  });
});
