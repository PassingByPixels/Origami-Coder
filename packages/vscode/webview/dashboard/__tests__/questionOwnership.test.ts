// The clarifying-question modal belongs to the chat that ASKED, not to the pane.
//
// Observed live (owner UAT, 0.3.65): Tsuru #5 asked a 3-question batch and the
// modal opened over Tsuru #4, the tab the owner was reading. ChatPane held ONE
// `questionAsk` slot for the whole pane and rendered it behind a bare
// `{#if questionAsk}` — no owner check — so the modal landed on whatever cell
// happened to be on screen, and a second asking session silently OVERWROTE the
// first (its engine then blocked on an answer that could never arrive).
//
// These render the REAL ChatPane and drive it through the real `requestPermission`
// post the extension sends (DashboardPanel.ts:1908, question-shaped = no
// allow_always option), then click the real tabs. They assert what the owner
// sees: the modal only over its own chat, the batch intact while it is out of
// view, and the answer landing on the asking session's toolCallId.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const A = 'sess-a';
const B = 'sess-b';

function post(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

/** A question option set: the discriminator is the ABSENCE of allow_always. */
function opts(...names: string[]) {
  return names.map((name, i) => ({
    optionId: String(i),
    name,
    kind: i === 0 ? 'allow_once' : 'reject_once',
  }));
}

/** The extension's real question-shaped `requestPermission` post, batched. */
function askQuestions(sessionId: string, toolCallId: string, titles: string[]): void {
  const questions = titles.map((title) => ({ title, options: opts('Alpha', 'Beta') }));
  post({
    type: 'requestPermission',
    sessionId,
    askSessionId: sessionId,
    toolCallId,
    title: titles[0],
    kind: 'ask',
    options: questions[0].options,
    questions,
  });
}

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const permissionPosts = () => posts().filter((p) => p.type === 'permission');

const modal = (c: HTMLElement) => c.querySelector('.qm-frame');
const counter = (c: HTMLElement) => c.querySelector('.qm-counter')?.textContent?.trim() ?? null;
const questionTitle = (c: HTMLElement) => c.querySelector('.qm-q-title')?.textContent?.trim() ?? null;
const selectedOption = (c: HTMLElement) => c.querySelector('.opt-btn.selected .opt-text')?.textContent?.trim() ?? null;
const freeText = (c: HTMLElement) => (c.querySelector('.free-text-input') as HTMLInputElement | null)?.value ?? null;

/** The tab strip, in session order. */
const tabs = (c: HTMLElement) => Array.from(c.querySelectorAll('.session-tab')) as HTMLElement[];
async function clickTab(c: HTMLElement, index: number): Promise<void> {
  await fireEvent.click(tabs(c)[index]);
  await tick();
}

async function pickOption(c: HTMLElement, label: string): Promise<void> {
  const button = Array.from(c.querySelectorAll('.opt-btn')).find((b) => b.textContent?.includes(label))!;
  await fireEvent.click(button);
  await tick();
}

async function clickByText(c: HTMLElement, selector: string, label: string): Promise<void> {
  const button = Array.from(c.querySelectorAll(selector)).find((b) => b.textContent?.trim() === label)!;
  await fireEvent.click(button);
  await tick();
}

/** Two chats, A first then B; B is active because sessionCreated promotes the new one. */
async function mountTwoSessions(): Promise<HTMLElement> {
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: A, sessionNumber: 4, agentName: 'Tsuru' });
  post({ type: 'sessionCreated', sessionId: B, sessionNumber: 5, agentName: 'Tsuru' });
  await tick();
  return container as HTMLElement;
}

describe('question modal ownership — the batch belongs to the asking chat', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());
  afterEach(() => cleanup());

  it('(a) a question for chat B while chat A is on screen shows NO modal', async () => {
    const c = await mountTwoSessions();
    await clickTab(c, 0); // read Tsuru #4
    expect(tabs(c)[0].classList.contains('active')).toBe(true);

    askQuestions(B, 'tc-b', ['Rebuild or patch?', 'Which target?', 'Run the tests?']);
    await tick();

    // The reported defect: this modal used to open OVER Tsuru #4.
    expect(modal(c)).toBeNull();
    // ...and nothing was answered on B's behalf — the ask is held, not decided.
    expect(permissionPosts()).toHaveLength(0);
  });

  it('(b) activating chat B surfaces ITS batch, with the true 1 of N counter', async () => {
    const c = await mountTwoSessions();
    await clickTab(c, 0);
    askQuestions(B, 'tc-b', ['Rebuild or patch?', 'Which target?', 'Run the tests?']);
    await tick();
    expect(modal(c)).toBeNull();

    await clickTab(c, 1); // switch to Tsuru #5, the asker
    expect(modal(c)).not.toBeNull();
    expect(counter(c)).toBe('1 of 3');
    expect(questionTitle(c)).toBe('Rebuild or patch?');
  });

  it('(c) answers entered before a tab switch are still there when the tab comes back', async () => {
    const c = await mountTwoSessions();
    askQuestions(B, 'tc-b', ['Rebuild or patch?', 'Which target?', 'Run the tests?']);
    await tick();
    expect(modal(c)).not.toBeNull(); // B is active — its own modal

    await pickOption(c, 'Beta'); // answer question 1
    await clickByText(c, '.qm-nav-btn', 'Next'); // step to question 2
    const input = c.querySelector('.free-text-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'the staging target' } });
    await tick();
    expect(counter(c)).toBe('2 of 3');

    await clickTab(c, 0); // look at Tsuru #4 for a moment
    expect(modal(c)).toBeNull();

    await clickTab(c, 1); // ...and back
    expect(modal(c)).not.toBeNull();
    expect(counter(c)).toBe('2 of 3'); // still on question 2, not reset to 1
    expect(freeText(c)).toBe('the staging target'); // typed text kept

    await clickByText(c, '.qm-nav-btn', 'Back');
    expect(selectedOption(c)).toBe('Beta'); // the earlier selection kept
  });

  it('(d) two chats asking at once keep separate batches; each tab shows only its own', async () => {
    const c = await mountTwoSessions();
    askQuestions(A, 'tc-a', ['A only']);
    askQuestions(B, 'tc-b', ['B one', 'B two']);
    await tick();

    await clickTab(c, 0);
    expect(questionTitle(c)).toBe('A only');
    expect(counter(c)).toBe('1 of 1');

    await clickTab(c, 1);
    expect(questionTitle(c)).toBe('B one');
    expect(counter(c)).toBe('1 of 2'); // B's batch was NOT overwritten by A's ask
  });

  it('(e) submitting answers the asking session, and cancelling cancels it — never the tab on screen', async () => {
    const c = await mountTwoSessions();
    askQuestions(A, 'tc-a', ['A only']);
    askQuestions(B, 'tc-b', ['B one', 'B two']);
    await tick();

    await clickTab(c, 1); // answer B
    await pickOption(c, 'Beta');
    await clickByText(c, '.qm-nav-btn', 'Next');
    await pickOption(c, 'Alpha');
    await clickByText(c, '.qm-submit-btn', 'Submit');

    const answered = permissionPosts();
    expect(answered).toHaveLength(1);
    expect(answered[0].toolCallId).toBe('tc-b');
    expect(answered[0].sessionId).toBe(B);
    expect(answered[0].optionId).toBe('1'); // head answer keeps the single-question wire shape
    expect(answered[0].answers).toEqual([{ optionId: '1' }, { optionId: '0' }]);
    expect(modal(c)).toBeNull(); // B's batch is done

    await clickTab(c, 0); // A's batch is untouched and still answerable
    expect(questionTitle(c)).toBe('A only');
    await clickByText(c, '.qm-cancel-btn', 'Cancel');

    const cancelled = permissionPosts()[1];
    expect(cancelled.toolCallId).toBe('tc-a');
    expect(cancelled.sessionId).toBe(A);
    expect(cancelled.optionId).toBeNull(); // the engine must hear the cancel or the turn hangs
    expect(modal(c)).toBeNull();
  });

  it('(f) a popped-out solo tab shows its OWN chat\'s batch and never another chat\'s', async () => {
    const { container } = render(ChatPane, { props: { soloSessionId: A } });
    const c = container as HTMLElement;
    post({ type: 'sessionCreated', sessionId: A, sessionNumber: 4, agentName: 'Tsuru' });
    post({ type: 'sessionCreated', sessionId: B, sessionNumber: 5, agentName: 'Tsuru' });
    await tick();
    expect(tabs(c)).toHaveLength(0); // a solo tab has no tab strip to switch with

    askQuestions(B, 'tc-b', ['B one']);
    await tick();
    expect(modal(c)).toBeNull(); // the other chat's question is not this tab's business

    askQuestions(A, 'tc-a', ['A only']);
    await tick();
    expect(questionTitle(c)).toBe('A only');
  });

  it('(g) in the grid every cell is on screen, so answering one chat hands over to the other cleanly', async () => {
    const c = await mountTwoSessions();
    post({ type: 'setChatLayout', grid: true });
    await tick();

    askQuestions(A, 'tc-a', ['A only']);
    askQuestions(B, 'tc-b', ['B one', 'B two']);
    await tick();
    expect(questionTitle(c)).toBe('B one'); // B is active, so B's batch is the one shown

    await pickOption(c, 'Beta');
    await clickByText(c, '.qm-nav-btn', 'Next');
    expect(counter(c)).toBe('2 of 2'); // B is on its second of two
    await pickOption(c, 'Alpha');
    await clickByText(c, '.qm-submit-btn', 'Submit');

    // A's batch takes over the same modal — at ITS OWN start, not B's position.
    expect(questionTitle(c)).toBe('A only');
    expect(counter(c)).toBe('1 of 1');
    expect(selectedOption(c)).toBeNull(); // B's answers did not bleed into A's draft
  });
});
