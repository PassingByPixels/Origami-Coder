// todoClearPanel.test.ts — t-h8gv8w half B, driven through the REAL pane.
//
// Owner, 0.4.149: "what would be handy is a clear on the todos so you can clear
// away completed todos on the todo pull tab." The list belongs to the model, so
// this is a VIEW FILTER and the whole risk is in the wiring, not in the rule:
// todoClear.test.ts asserts which keys a click takes, and what only a render
// can show is that the panel hides those rows, that the header count does NOT
// move with them, that each TAB keeps its own hidden set, and that the click is
// pure webview state — nothing goes to the host, which is also why the phone
// (same ChatPane) gets the control with no new wire message.
//
// ChatPane rather than TodoOverlay alone, on childTodoRoad.test.ts's precedent:
// the hidden set lives on the SESSION, so a test that held it itself would be
// asserting its own harness.

import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';
import TodoOverlay from '../components/TodoOverlay.svelte';
import { MAIN_TAB, type SubagentTodoList } from '../components/todoTabs';

afterEach(() => cleanup());

const SESSION = 'sess-todo-clear';
const CHILD = 'ses_child_todo_clear';
const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

const item = (id: number, content: string, status = 'pending') => ({ id, content, activeForm: content, status });

/** The chat's own list, as the host posts it (acpTodoWrite.ts's shape). */
async function paneWithTodos(todos: ReturnType<typeof item>[]) {
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: SESSION, sessionNumber: 1, agentName: 'Tsuru' });
  await tick();
  post({ type: 'todoUpdate', sessionId: SESSION, source: 'model_write', todos });
  await tick();
  return container as HTMLElement;
}

const rows = (c: HTMLElement) => [...c.querySelectorAll('.todo-content')].map((t) => t.textContent?.trim());
const counts = (c: HTMLElement) => c.querySelector('.todo-counts')?.textContent?.replace(/\s+/g, ' ').trim();
const clearBtn = (c: HTMLElement) => c.querySelector('.todo-clear') as HTMLButtonElement;

const LIST = [item(0, 'read the map', 'completed'), item(1, 'draw the route'), item(2, 'check it', 'completed')];

describe('Clear completed — the Todo panel, through the pane', () => {
  it('hides the items completed at the click and leaves the open ones', async () => {
    const c = await paneWithTodos(LIST);
    expect(rows(c)).toEqual(['read the map', 'draw the route', 'check it']);

    await fireEvent.click(clearBtn(c));
    await tick();
    expect(rows(c)).toEqual(['draw the route']);
  });

  it('does NOT move the header count — the model’s list is untouched', async () => {
    // The count is the whole reason this is a filter and not a write: the owner
    // still has to be able to read what the agent actually got done.
    const c = await paneWithTodos(LIST);
    expect(counts(c)).toBe('2/3 done');
    await fireEvent.click(clearBtn(c));
    await tick();
    expect(counts(c)).toBe('2/3 done');
  });

  it('posts NOTHING to the host', async () => {
    // Pure webview state. A wire message here would also mean a new phone verb
    // for a control the phone renders through this very component.
    const c = await paneWithTodos(LIST);
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(clearBtn(c));
    await tick();
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();
  });

  it('is DISABLED while nothing on the tab has finished, and live once something has', async () => {
    const c = await paneWithTodos([item(0, 'draw the route'), item(1, 'check it', 'in_progress')]);
    expect(clearBtn(c).disabled).toBe(true);

    post({
      type: 'todoUpdate', sessionId: SESSION, source: 'model_write',
      todos: [item(0, 'draw the route'), item(1, 'check it', 'completed')],
    });
    await tick();
    expect(clearBtn(c).disabled).toBe(false);
  });

  it('goes dead again once everything completed has been cleared', async () => {
    const c = await paneWithTodos(LIST);
    await fireEvent.click(clearBtn(c));
    await tick();
    expect(clearBtn(c).disabled).toBe(true);
  });

  it('SHOWS a cleared item again when the model reopens it', async () => {
    const c = await paneWithTodos(LIST);
    await fireEvent.click(clearBtn(c));
    await tick();
    expect(rows(c)).toEqual(['draw the route']);

    // The agent takes the finished step back up. Its key changes with its
    // status, so the row returns without the owner doing anything.
    post({
      type: 'todoUpdate', sessionId: SESSION, source: 'model_write',
      todos: [item(0, 'read the map', 'in_progress'), item(1, 'draw the route'), item(2, 'check it', 'completed')],
    });
    await tick();
    expect(rows(c)).toEqual(['read the map', 'draw the route']);
  });

  it('SHOWS a new item that repeats a cleared one word for word', async () => {
    const c = await paneWithTodos(LIST);
    await fireEvent.click(clearBtn(c));
    await tick();
    post({
      type: 'todoUpdate', sessionId: SESSION, source: 'model_write',
      todos: [...LIST, item(3, 'read the map')],
    });
    await tick();
    // The cleared `read the map · completed` stays hidden; the fresh pending
    // one with the same words is a different key and is drawn.
    expect(rows(c)).toEqual(['draw the route', 'read the map']);
  });

  it('survives the panel being pulled shut and opened again', async () => {
    const c = await paneWithTodos(LIST);
    await fireEvent.click(clearBtn(c));
    await tick();
    const tab = c.querySelector('.todo-tab') as HTMLElement;
    await fireEvent.click(tab); // shut
    await tick();
    await fireEvent.click(c.querySelector('.todo-tab') as HTMLElement); // open again
    await tick();
    expect(rows(c)).toEqual(['draw the route']);
  });
});

describe('Clear completed — one hidden set PER TAB', () => {
  /** The chat's own list, plus a sub-agent keeping one of its own. */
  async function paneWithChild() {
    const c = await paneWithTodos(LIST);
    post({
      type: 'toolCall', sessionId: SESSION, toolCallId: 'call_1', title: 'task', kind: 'think',
      status: 'in_progress', toolName: 'task', taskSessionId: CHILD,
      rawInput: { description: 'audit the bundle', subagent_type: 'Explore', prompt: 'go' },
    });
    await tick();
    post({
      type: 'subagentTodos', sessionId: SESSION, childSessionId: CHILD,
      todos: [item(0, 'read the manifest', 'completed'), item(1, 'diff the bundles')],
    });
    await tick();
    return c;
  }
  const pick = async (c: HTMLElement, label: string) => {
    const t = [...c.querySelectorAll('.todo-listtab')]
      .find((b) => b.querySelector('.todo-listtab-label')?.textContent === label) as HTMLElement;
    await fireEvent.click(t);
    await tick();
  };

  it('clearing Main leaves the sub-agent’s finished item on its own tab', async () => {
    const c = await paneWithChild();
    await fireEvent.click(clearBtn(c));
    await tick();
    expect(rows(c)).toEqual(['draw the route']);

    await pick(c, 'T1');
    expect(rows(c)).toEqual(['read the manifest', 'diff the bundles']);
  });

  it('clearing the sub-agent’s tab leaves Main’s own hidden set alone', async () => {
    const c = await paneWithChild();
    await fireEvent.click(clearBtn(c));       // Main
    await tick();
    await pick(c, 'T1');
    await fireEvent.click(clearBtn(c));       // T1
    await tick();
    expect(rows(c)).toEqual(['diff the bundles']);

    await pick(c, 'Main');
    expect(rows(c)).toEqual(['draw the route']);
  });
});

describe('Clear completed — the hidden set is the PANE’s, not the overlay’s', () => {
  // The overlay is unmounted and remounted every turn (its own header comment).
  // Held inside it, every clear would be undone by the next turn — so the proof
  // is that a remount with the same pane state draws the same filtered list.
  const props = (hidden: Record<string, string[]>) => ({
    todos: LIST, source: 'model_write', collapsed: false, onToggleCollapse: () => {},
    subagents: [] as SubagentTodoList[], selectedTab: MAIN_TAB, onSelectTab: () => {},
    hidden, onClearCompleted: () => {},
  });

  it('draws the filtered list on a FRESH mount, from the record alone', async () => {
    let held: Record<string, string[]> = {};
    const first = render(TodoOverlay, {
      ...props(held),
      onClearCompleted: (id: string, keys: string[]) => { held = { [id]: keys }; },
    });
    await fireEvent.click(first.container.querySelector('.todo-clear') as HTMLElement);
    cleanup();

    const second = render(TodoOverlay, props(held));
    expect(rows(second.container as HTMLElement)).toEqual(['draw the route']);
  });
});
