// todoClear — what "Clear completed" hides, and the two cases the key exists
// to get right: a row the model REOPENS comes back, and a row that merely
// shares its words with a cleared one is not hidden with it.
import { describe, expect, it } from 'vitest';
import { clearKey, completedKeys, hasCompleted, hiddenAfterClear, hiddenSet, withCleared } from './todoClear';

const todo = (content: string, status = 'pending') => ({ content, status });

describe('hasCompleted — when the control is offered as live', () => {
  it('is true only when something on the list has actually finished', () => {
    expect(hasCompleted([todo('a'), todo('b', 'completed')])).toBe(true);
    expect(hasCompleted([todo('a'), todo('b', 'in_progress')])).toBe(false);
    expect(hasCompleted([])).toBe(false);
  });
});

describe('completedKeys — what one click takes', () => {
  it('takes the completed rows and leaves everything still open', () => {
    const list = [todo('read it', 'completed'), todo('write it'), todo('ship it', 'completed')];
    expect(completedKeys(list)).toEqual([clearKey(todo('read it', 'completed')), clearKey(todo('ship it', 'completed'))]);
  });

  it('takes nothing from a list with nothing done', () => {
    expect(completedKeys([todo('a'), todo('b', 'in_progress')])).toEqual([]);
  });
});

describe('hiddenAfterClear — the view the panel draws', () => {
  it('drops exactly the cleared rows, in order, and keeps the rest', () => {
    const list = [todo('read it', 'completed'), todo('write it'), todo('ship it', 'completed')];
    const shown = hiddenAfterClear(list, new Set(completedKeys(list)));
    expect(shown.map((t) => t.content)).toEqual(['write it']);
  });

  it('SHOWS a cleared row again once the model reopens it', () => {
    // The case the key exists for. Clearing hides `done · completed`; the model
    // then takes the item back up, which is a different key, so it returns.
    const before = [todo('done', 'completed')];
    const hidden = new Set(completedKeys(before));
    expect(hiddenAfterClear(before, hidden)).toEqual([]);

    const after = [todo('done', 'in_progress')];
    expect(hiddenAfterClear(after, hidden).map((t) => t.status)).toEqual(['in_progress']);
  });

  it('SHOWS a NEW row that happens to repeat a cleared row word for word', () => {
    // Not yet completed, so not the key that was cleared. A model that retries
    // a step under the same title must not have it vanish.
    const hidden = new Set(completedKeys([todo('retry the build', 'completed')]));
    expect(hiddenAfterClear([todo('retry the build')], hidden).map((t) => t.content)).toEqual(['retry the build']);
  });

  it('is a copy, never the caller’s array, and is a no-op with nothing hidden', () => {
    const list = [todo('a'), todo('b')];
    const out = hiddenAfterClear(list, new Set());
    expect(out).toEqual(list);
    expect(out).not.toBe(list);
  });

  it('cannot be forged by a content string that looks like another row’s key', () => {
    // The keys are JSON, so a row whose CONTENT is the serialised form of
    // another row still gets its own key and is not hidden by it.
    const real = todo('ship it', 'completed');
    const impostor = todo(JSON.stringify(['completed', 'ship it']), 'completed');
    expect(clearKey(impostor)).not.toBe(clearKey(real));
  });
});

describe('the per-list record the pane keeps', () => {
  it('reads an empty set for a list nobody has cleared', () => {
    expect(hiddenSet(undefined, 'main').size).toBe(0);
    expect(hiddenSet({ 'child-1': ['k'] }, 'main').size).toBe(0);
  });

  it('adds keys to ONE list and leaves every other list alone', () => {
    const before = { main: ['a'], 'child-1': ['x'] };
    const after = withCleared(before, 'main', ['b']);
    expect(after).toEqual({ main: ['a', 'b'], 'child-1': ['x'] });
    // Fresh object: the pane re-assigns its session to re-render, and a mutated
    // record would make the before/after indistinguishable.
    expect(after).not.toBe(before);
    expect(before.main).toEqual(['a']);
  });

  it('never repeats a key that is already hidden', () => {
    expect(withCleared({ main: ['a'] }, 'main', ['a', 'b'])).toEqual({ main: ['a', 'b'] });
  });

  it('starts a list that has no entry yet', () => {
    expect(withCleared(undefined, 'child-2', ['k'])).toEqual({ 'child-2': ['k'] });
  });
});
