// Deleting a chat from its Labyrinth card, asserted through the real pane and
// only where jsdom can tell the truth: which controls are mounted, what is
// posted to the host, and what the user is TOLD. Nothing here claims anything
// about size, colour or position — vitest.config.mts does not set css:true, so
// no <style> reaches this DOM.
//
// The claim that matters is the ARM: the destructive post must not exist until
// a second, differently-labelled button is pressed. Make the ✕ call `onDelete`
// straight through in LabyrinthRunCard.svelte and the first test goes red.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import LabyrinthPane from '../panes/LabyrinthPane.svelte';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const deletes = () => posts().filter((p) => p.type === 'labDeleteSession');
const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
// SCOPED to the confirm panel on purpose: the row's swipe action is labelled
// "Delete" too (it is the control that ARMS this panel), so an unscoped search
// for a button reading "Delete" finds the swipe and disarms what it just armed.
const btn = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll('.lab-confirm button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

const RUNS = [
  { sessionId: 'ses_a', title: 'Assess the labyrinth repo', folder: 'origami-coder', cwd: 'C:/repos/origami-coder', updatedAt: '2026-08-01T14:05:00.000Z' },
  { sessionId: 'ses_m1', title: 'map the repo', folder: 'origami-coder', cwd: 'C:/repos/origami-coder', updatedAt: '2026-08-01T13:00:00.000Z', collabId: 'c1', collabTitle: 'Wave 9 sweep', agentSlug: 'cartographer' },
];

async function listed() {
  const rendered = render(LabyrinthPane);
  send({ type: 'historyList', sessions: RUNS });
  await tick();
  return rendered;
}
const arm = async (c: HTMLElement) => { await fireEvent.click(c.querySelector('.lab-del')!); await tick(); };

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('Labyrinth run index — deleting a chat is ARMED, never one click', () => {
  it('arming shows the confirmation and posts NOTHING', async () => {
    const { container } = await listed();
    await arm(container);

    // The destructive post FIRST: that is the claim, and asserting it before
    // the wording keeps the failure message about the right thing.
    expect(deletes()).toEqual([]);
    expect(container.querySelector('.lab-confirm')!.textContent).toContain(
      'Delete this chat and its messages permanently? This cannot be undone.',
    );
  });

  it('confirming posts the delete, with the RUN\u2019s own directory', async () => {
    const { container } = await listed();
    await arm(container);
    await fireEvent.click(btn(container, 'Delete'));

    expect(deletes()).toEqual([
      { type: 'labDeleteSession', sessionId: 'ses_a', cwd: 'C:/repos/origami-coder' },
    ]);
  });

  it('cancelling closes the confirmation and still posts nothing', async () => {
    const { container } = await listed();
    await arm(container);
    await fireEvent.click(btn(container, 'Cancel'));
    await tick();

    expect(container.querySelector('.lab-confirm')).toBeNull();
    expect(deletes()).toEqual([]);
  });

  // A collab HEADER's pick id is `collab:<id>` — a group, not a session. The
  // host refuses one too; this is the half that never offers it.
  it('offers no delete on a collab header', async () => {
    const { container } = await listed();
    expect(container.querySelectorAll('.lab-run')).toHaveLength(2); // plain run + collab header
    expect(container.querySelectorAll('.lab-del')).toHaveLength(1); // ...only the plain run has one
  });
});

describe('Labyrinth run index — what the host answers', () => {
  it('re-reads the index once the delete succeeded, so the row goes away', async () => {
    const { container } = await listed();
    await arm(container);
    await fireEvent.click(btn(container, 'Delete'));
    globalThis.__vscodeApiMock.postMessage.mockClear();

    send({ type: 'labDeleteSessionDone', sessionId: 'ses_a', ok: true });
    await tick();

    // `some`, not a COUNT: LabyrinthPane registers a window message listener it
    // never removes, so every pane rendered earlier in this file is still
    // listening and answers too. That leak is pre-existing and out of scope
    // here; what this test is about is that a successful delete re-reads the
    // index at all, which the refusal case below proves is not unconditional.
    expect(posts().some((p) => p.type === 'requestHistory')).toBe(true);
  });

  it('shows a REFUSAL and does not re-read the index', async () => {
    const { container } = await listed();
    await arm(container);
    await fireEvent.click(btn(container, 'Delete'));
    globalThis.__vscodeApiMock.postMessage.mockClear();

    send({
      type: 'labDeleteSessionDone',
      sessionId: 'ses_a',
      ok: false,
      error: 'Close the chat first, then delete it here.',
    });
    await tick();

    expect(container.querySelector('.lab-del-error')!.textContent).toContain('Close the chat first');
    expect(posts().filter((p) => p.type === 'requestHistory')).toEqual([]);
  });

  it('clears the deleted run off the MAP — its steps no longer exist', async () => {
    const { container } = await listed();
    await fireEvent.click(container.querySelector('.lab-run')!);
    send({ type: 'runStepsData', sessionId: 'ses_a', steps: [{ ordinal: 1, kind: 'text', label: 'hi' }] });
    await tick();
    expect(container.textContent).not.toContain('Pick a run from the index to map it.');

    send({ type: 'labDeleteSessionDone', sessionId: 'ses_a', ok: true });
    await tick();
    expect(container.textContent).toContain('Pick a run from the index to map it.');
  });

  it('a refusal about a DIFFERENT run leaves the open map alone', async () => {
    const { container } = await listed();
    await fireEvent.click(container.querySelector('.lab-run')!);
    send({ type: 'runStepsData', sessionId: 'ses_a', steps: [{ ordinal: 1, kind: 'text', label: 'hi' }] });
    await tick();

    send({ type: 'labDeleteSessionDone', sessionId: 'ses_other', ok: true });
    await tick();
    expect(container.textContent).not.toContain('Pick a run from the index to map it.');
  });
});
