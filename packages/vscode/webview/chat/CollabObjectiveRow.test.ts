// CollabObjectiveRow — the standing objective, editable in place (report 1.5 /
// S8). It used to be a read-only line with `/objective <text>` in the composer
// as its only writer, and an UNSET objective drew nothing at all — so the one
// screen that most needed the control had no control on it.

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CollabObjectiveRow from './CollabObjectiveRow.svelte';

function mount(over: Record<string, unknown> = {}) {
  const saved: string[] = [];
  render(CollabObjectiveRow, {
    props: { objective: 'Ship the storm plan', archived: false, onSetObjective: (t: string) => saved.push(t), ...over },
  });
  return saved;
}

const editBox = () => screen.getByRole('textbox', { name: /objective/i });

describe('CollabObjectiveRow — reading', () => {
  it('shows the standing objective', () => {
    mount();
    expect(screen.getByText('Ship the storm plan')).toBeInTheDocument();
  });

  it('offers a way to SET one when the collab has none — the empty state is the one that needs the control', () => {
    mount({ objective: null });
    expect(screen.getByRole('button', { name: /objective/i })).toBeInTheDocument();
  });

  it('an archived collab offers no edit control — nothing more can be posted to it', () => {
    mount({ archived: true });
    expect(screen.queryByRole('button', { name: /objective/i })).toBeNull();
    // The objective itself is still readable.
    expect(screen.getByText('Ship the storm plan')).toBeInTheDocument();
  });
});

describe('CollabObjectiveRow — editing', () => {
  it('opens pre-filled with the current objective, so an edit is an edit and not a retype', async () => {
    mount();
    await fireEvent.click(screen.getByRole('button', { name: /objective/i }));
    expect((editBox() as HTMLInputElement).value).toBe('Ship the storm plan');
  });

  it('Enter commits the new text', async () => {
    const saved = mount();
    await fireEvent.click(screen.getByRole('button', { name: /objective/i }));
    await fireEvent.input(editBox(), { target: { value: 'Ship it by Friday' } });
    await fireEvent.keyDown(editBox(), { key: 'Enter' });

    expect(saved).toEqual(['Ship it by Friday']);
    // Committed rows go back to reading — the engine owns the result and the
    // next poll paints it, so nothing is spliced in here.
    expect(screen.queryByRole('textbox', { name: /objective/i })).toBeNull();
  });

  it('Escape discards the edit and sends nothing', async () => {
    const saved = mount();
    await fireEvent.click(screen.getByRole('button', { name: /objective/i }));
    await fireEvent.input(editBox(), { target: { value: 'wrong' } });
    await fireEvent.keyDown(editBox(), { key: 'Escape' });

    expect(saved).toEqual([]);
    expect(screen.getByText('Ship the storm plan')).toBeInTheDocument();
  });

  it('a BLANK objective is not an objective — it closes the editor instead of storing an empty one', async () => {
    const saved = mount();
    await fireEvent.click(screen.getByRole('button', { name: /objective/i }));
    await fireEvent.input(editBox(), { target: { value: '   ' } });
    await fireEvent.keyDown(editBox(), { key: 'Enter' });

    expect(saved).toEqual([]);
    expect(screen.queryByRole('textbox', { name: /objective/i })).toBeNull();
  });

  it('re-opening after a discarded edit shows the stored objective again, not the abandoned draft', async () => {
    mount();
    await fireEvent.click(screen.getByRole('button', { name: /objective/i }));
    await fireEvent.input(editBox(), { target: { value: 'abandoned' } });
    await fireEvent.keyDown(editBox(), { key: 'Escape' });
    await fireEvent.click(screen.getByRole('button', { name: /objective/i }));

    expect((editBox() as HTMLInputElement).value).toBe('Ship the storm plan');
  });
});
