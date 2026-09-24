// todoTabs.ts — WHICH todo lists the panel offers, and which one it is showing.
//
// The Todo panel used to have exactly one list: the chat's own. A strong model
// fans work out to sub-agents that keep their own lists, and until now nothing
// drew them — the owner could see nine todos rendered as raw JSON inside a
// sub-agent's transcript card and no trace of them in the panel.
//
// The tab LABELS are not this file's own invention: a sub-agent is named the
// same way on every surface (subagentLabel.ts), and the strip shows the short
// form of that one name with the full one on the hover.
//
// A pure leaf, like todoTree.ts and todoCollapse.ts beside it: what is on the
// strip is a RULE (which lists earn a tab, what a tab is called, what happens to
// the selection when the tab it named goes away) and rules are worth testing
// without a render. TodoTabs.svelte draws whatever this returns.

import { subagentLabel, subagentShort, type SubagentIdentity } from '../panes/subagentLabel';

/** The row fields this module reads. Structural, like todoTree.ts's own
 *  `TodoLike` beside it: the pane's row type is a superset and passes straight
 *  through to TodoStrip.svelte, which owns what a row LOOKS like. */
export interface TodoItem {
  status: string;
}

/** The id of the chat's OWN list. Not a session id — no sub-agent can collide
 *  with it, because a child's tab is keyed by its session id, which is never
 *  this word. */
export const MAIN_TAB = 'main';

/** A sub-agent's list as the panel receives it, joined in the pane from the
 *  drawer's roster (identity, settled) and the host's pull (todos). */
export interface SubagentTodoList {
  /** The child's own session id — the tab id. */
  key: string;
  /** `<type> · T<n> · <description>` (subagentLabel.ts) — the hover, and the
   *  only place the agent is named in words on this strip. */
  label: string;
  /** `T<n>`: what the tab itself reads. A tab is ~30px wide on a phone, and the
   *  T-number is the one part of the identity that fits and stays unique. */
  short: string;
  /** Has the sub-agent stopped? (subagentEntry.ts `isSettled`.) */
  settled: boolean;
  todos: TodoItem[];
}

export interface TodoTab {
  id: string;
  label: string;
  todos: TodoItem[];
  /** Has the agent behind this tab stopped? Main is never settled. Carried on
   *  the tab so the strip can draw a finished list DIM with its done count
   *  instead of dropping it (t-geo4n3). */
  settled: boolean;
}

/** Is this sub-agent's list still worth a tab?
 *
 *  ONE way it stops being one: an EMPTY list has nothing to show — including
 *  the child that CLEARS its todos, which is how a tab is retired from the
 *  child's own side.
 *
 *  t-geo4n3 REVERSED the other rule. Until 0.4.144 a FINISHED agent lost its
 *  tab whatever its list said (t-f6u661), on the reading that the strip answers
 *  "who is working right now". In practice a child whose whole job is one
 *  `todowrite` settles within a step of its list arriving, so the tab existed
 *  for under a second and the owner saw no tabs at all. The strip answers "what
 *  lists does this chat have", and the finished ones are drawn dim. A settled
 *  tab stays until the owner dismisses its row with the × in the Sub-agents
 *  drawer (t-h8gv8w removed every other exit) — `subagentsDismissed` drops the
 *  roster row, and a tab with no roster row is never built
 *  (`subagentTodoLists`). */
export function tabWorthKeeping(list: SubagentTodoList): boolean {
  return list.todos.length > 0;
}

/** The strip: `Main` first, then one tab per sub-agent that earns one, in the
 *  order given (the roster's, which is oldest-first).
 *
 *  Main is ALWAYS present, even with no todos of its own — it is the panel's
 *  home, and a strip whose first tab moved around as the chat's own list came
 *  and went would be unreadable. */
export function todoTabs(main: readonly TodoItem[], subagents: readonly SubagentTodoList[]): TodoTab[] {
  return [
    { id: MAIN_TAB, label: 'Main', todos: [...main], settled: false },
    ...subagents.filter(tabWorthKeeping).map((s) => ({ id: s.key, label: s.short, todos: s.todos, settled: s.settled })),
  ];
}

/** The tab actually shown, given what the user last picked.
 *
 *  The selection is a STRING the pane remembers, and the tab it names can
 *  vanish under it — the sub-agent finishes its list, or the roster is
 *  dismissed. Falling back to Main rather than to "the first tab" keeps that
 *  from silently swapping one sub-agent's list for another's. */
export function activeTab(tabs: readonly TodoTab[], selected: string): TodoTab {
  return tabs.find((t) => t.id === selected) ?? tabs[0];
}

/** The drawer's roster joined to the lists the host pulled, in roster order.
 *
 *  Joined at RENDER time rather than stored joined, because the two halves
 *  arrive independently and neither is authoritative about the other: a list
 *  can land before its `task` card does (the pull is answered off the child's
 *  own session), and a card can outlive the list when the sub-agent clears it.
 *  A roster row with no list simply has none, and is filtered out downstream by
 *  `tabWorthKeeping` rather than by a special case here. */
export function subagentTodoLists(
  rows: readonly (SubagentIdentity & { key: string; settled: boolean })[],
  byChild: Record<string, TodoItem[]> | undefined,
): SubagentTodoList[] {
  if (!byChild) return [];
  return rows.map((r) => ({
    key: r.key,
    label: subagentLabel(r),
    short: subagentShort(r),
    settled: r.settled,
    todos: byChild[r.key] ?? [],
  }));
}

/** The full identity per tab id, for the hover — `T3` alone says which agent
 *  but not what it is doing, and `Main` alone does not say whose list it is. */
export function tabTitles(subagents: readonly SubagentTodoList[]): Record<string, string> {
  return Object.fromEntries([
    [MAIN_TAB, "This chat's own list"],
    ...subagents.map((s) => [s.key, s.label]),
  ]);
}
