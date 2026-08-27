// The todowrite list read, extracted from acpClient.ts and — until now —
// uncovered. The bug its two-source rule exists to prevent is recorded in that
// file's own comment: the COMPLETED frame carries no `rawInput.todos`, so a
// reader that only looked there starved the strip of the FINAL snapshot, while
// a reader that only parsed the text lost every in-progress update.

import { describe, expect, it } from 'vitest';
import { todosFromUpdate } from '../../../src/acpTodoWrite';

const textFrame = (text: string) => ({ content: [{ type: 'content', content: { type: 'text', text } }] });

describe('todosFromUpdate', () => {
  it('reads the structured payload of an in-progress frame', () => {
    const todos = todosFromUpdate({
      rawInput: { todos: [{ content: 'ship it', activeForm: 'shipping it', status: 'in_progress' }] },
    });
    expect(todos).toEqual([{ id: 0, content: 'ship it', activeForm: 'shipping it', status: 'in_progress' }]);
  });

  it('reads the COMPLETED frame, whose list arrives as JSON text and NOT as rawInput', () => {
    const todos = todosFromUpdate(textFrame(JSON.stringify([{ content: 'ship it', status: 'completed' }])));
    expect(todos).toEqual([{ id: 0, content: 'ship it', activeForm: 'ship it', status: 'completed' }]);
  });

  it('prefers the structured payload when a frame somehow carries both', () => {
    const todos = todosFromUpdate({
      rawInput: { todos: [{ content: 'from rawInput', status: 'pending' }] },
      ...textFrame(JSON.stringify([{ content: 'from text', status: 'completed' }])),
    });
    expect(todos![0].content).toBe('from rawInput');
  });

  it('returns null for a status-only frame — a todowrite with nothing new to show', () => {
    expect(todosFromUpdate({})).toBeNull();
    expect(todosFromUpdate({ rawInput: null, content: [] })).toBeNull();
  });

  it('ignores a text block that is not JSON, and one whose JSON is not a list', () => {
    expect(todosFromUpdate(textFrame('3 todos'))).toBeNull();
    expect(todosFromUpdate(textFrame('{"todos":1}'))).toBeNull();
  });

  it('coerces every field a model can get wrong rather than dropping the row', () => {
    const todos = todosFromUpdate({ rawInput: { todos: [{}, { status: 'nonsense' }, { content: 7 }] } })!;
    expect(todos.map((t) => t.status)).toEqual(['pending', 'pending', 'pending']);
    expect(todos.map((t) => t.id)).toEqual([0, 1, 2]);
    expect(todos[2].content).toBe('7');
    // activeForm falls back to content, so a row can never render blank.
    expect(todos[2].activeForm).toBe('7');
  });
});
