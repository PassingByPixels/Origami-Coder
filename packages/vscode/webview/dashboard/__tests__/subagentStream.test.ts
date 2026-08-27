// A sub-agent used to be a spinner with the MODEL'S OWN INSTRUCTIONS behind it.
// The task tool's output text is what the card renders, and for a background
// launch that text is the BACKGROUND_STARTED briefing ("DO NOT sleep, poll for
// progress…") — correct guidance for the model, pure noise for the human, who
// could see nothing whatsoever of what the sub-agent was actually doing.
//
// These cover the presentation half: the briefing never reaches the DOM, the
// forwarded child stream lands under the right card, stays collapsed while live,
// and is bounded so a 10-agent fan-out can't stream the webview to death.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const SESSION = 'sess-1';
const CHILD = 'ses_child_1';
const CALL = 'call_1';
const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

// Byte-for-byte the engine's BACKGROUND_STARTED envelope (tool/task.ts).
const BACKGROUND_STARTED_ENVELOPE = [
  `<task id="${CHILD}" state="running">`,
  '<summary>Background task started</summary>',
  '<task_result>',
  'The task is working in the background. You will be notified automatically when it finishes.',
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "If it becomes unnecessary or goes wrong, cancel it with the task_stop tool using this task's id; use task_list to see what is still running.",
  'Keep working on non-overlapping tasks while it runs, or briefly tell the user what you launched; do not poll it.',
  "To send this task more information, answer a question it asks, or have it carry on, call the task tool again with task_id set to this task's id (the `id` on the task tag above).",
  'That RESUMES this same agent with everything it has already read and worked out; launching a new task instead throws all of it away.',
  '</task_result>',
  '</task>',
].join('\n');

const COMPLETED_ENVELOPE = [
  `<task id="${CHILD}" state="completed">`,
  '<task_result>',
  'Wrote story_001.md — 1000 words.',
  '</task_result>',
  '</task>',
].join('\n');

async function mountWithTaskCard(opts: { result?: string; status?: string } = {}) {
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: SESSION, sessionNumber: 1, agentName: 'Tsuru' });
  await tick();
  post({ type: 'busy', sessionId: SESSION });
  post({
    type: 'toolCall',
    sessionId: SESSION,
    toolCallId: CALL,
    title: 'write story 1',
    kind: 'think',
    status: 'in_progress',
    toolName: 'task',
    taskSessionId: CHILD,
  });
  await tick();
  if (opts.result !== undefined) {
    post({
      type: 'toolResult',
      sessionId: SESSION,
      toolCallId: CALL,
      status: opts.status ?? 'completed',
      content: opts.result,
      taskSessionId: CHILD,
    });
    await tick();
  }
  return container as HTMLElement;
}

/** The card body only renders once the tool card is expanded. */
async function expand(c: HTMLElement) {
  const header = c.querySelector('.tool-card.task .tool-header') as HTMLElement | null;
  expect(header, 'the task card must render').not.toBeNull();
  await fireEvent.click(header!);
  await tick();
}

describe('sub-agent live stream + task card presentation', () => {
  afterEach(() => cleanup());

  it('1 — the model-facing BACKGROUND_STARTED briefing never reaches the user', async () => {
    const c = await mountWithTaskCard({ result: BACKGROUND_STARTED_ENVELOPE });
    await expand(c);
    const text = c.textContent ?? '';
    expect(text).not.toContain('DO NOT sleep, poll for progress');
    expect(text).not.toContain('task_stop');
    expect(text).not.toContain('<task_result>');
    // ...including the resume instruction the briefing gained: it is guidance
    // for the model at launch, and reads as gibberish in a card.
    expect(text).not.toContain('RESUMES this same agent');
    // ...replaced by a human summary of the same fact.
    expect(text).toContain('write story 1');
    expect(text).toContain('running');
  });

  it('2 — a completed sub-agent shows its real answer, not the envelope', async () => {
    const c = await mountWithTaskCard({ result: COMPLETED_ENVELOPE });
    await expand(c);
    const text = c.textContent ?? '';
    expect(text).toContain('Wrote story_001.md');
    expect(text).toContain('completed');
    expect(text).not.toContain('<task id=');
  });

  it('3 — the forwarded child stream lands under its own card and stays COLLAPSED while live', async () => {
    const c = await mountWithTaskCard({ result: BACKGROUND_STARTED_ENVELOPE });
    post({ type: 'subagentChunk', sessionId: SESSION, childSessionId: CHILD, text: '> write: story_001.md\n' });
    await tick();
    await expand(c);

    const details = c.querySelector('details.task-stream') as HTMLDetailsElement | null;
    expect(details, 'the live stream must render under the card').not.toBeNull();
    // Collapsed while streaming — ten fan-out agents each auto-expanding would
    // blow the transcript apart (the thought-block precedent).
    expect(details!.open).toBe(false);
    expect(details!.querySelector('.task-stream-text')!.textContent).toBe('> write: story_001.md\n');
  });

  it('4 — a chunk for an unknown child session is dropped, never dumped in the transcript', async () => {
    const c = await mountWithTaskCard({ result: BACKGROUND_STARTED_ENVELOPE });
    post({ type: 'subagentChunk', sessionId: SESSION, childSessionId: 'ses_someone_else', text: 'stray output' });
    await tick();
    await expand(c);
    expect(c.textContent ?? '').not.toContain('stray output');
    expect(c.querySelector('details.task-stream')).toBeNull();
  });

  it('5 — the per-child stream is capped, keeping the TAIL (what it is doing now)', async () => {
    const c = await mountWithTaskCard({ result: BACKGROUND_STARTED_ENVELOPE });
    post({ type: 'subagentChunk', sessionId: SESSION, childSessionId: CHILD, text: 'x'.repeat(9000) });
    post({ type: 'subagentChunk', sessionId: SESSION, childSessionId: CHILD, text: 'LATEST' });
    await tick();
    await expand(c);

    const streamed = c.querySelector('.task-stream-text')!.textContent ?? '';
    expect(streamed.length).toBe(8000);
    expect(streamed.endsWith('LATEST')).toBe(true);
    expect(streamed.startsWith('x')).toBe(true);
  });

  it('6 — a still-running sub-agent with no result yet is expandable purely on its stream', async () => {
    const c = await mountWithTaskCard();
    post({ type: 'subagentChunk', sessionId: SESSION, childSessionId: CHILD, text: '> read: brief.md\n' });
    await tick();
    // Without a body the card has no expand arrow at all — a live sub-agent would
    // stay an opaque spinner even though its output is arriving.
    expect(c.querySelector('.tool-card.task .expand-arrow')).not.toBeNull();
    await expand(c);
    expect(c.querySelector('.task-stream-text')!.textContent).toBe('> read: brief.md\n');
  });
});

// task_id RESUMPTION works and is prescribed in the tool guidance — but a resumed
// sub-agent and a brand-new one rendered IDENTICALLY. That is exactly how a
// "multi-turn" review silently became two different agents with no shared memory,
// and nothing on screen said so. Presentation only; no engine change.
describe('sub-agent continuity — resumed vs freshly spawned', () => {
  afterEach(() => cleanup());

  /** Spawn a task card, then hand it its task session id the way the engine does
   *  (the child session only exists AFTER the pending tool_call went out, so the
   *  id lands on the RESULT update, not the start). */
  async function spawn(callId: string, title: string, childId: string) {
    post({ type: 'toolCall', sessionId: SESSION, toolCallId: callId, title, kind: 'think', status: 'in_progress', toolName: 'task' });
    await tick();
    post({ type: 'toolResult', sessionId: SESSION, toolCallId: callId, status: 'completed', content: 'done', taskSessionId: childId });
    await tick();
  }

  const cards = (c: HTMLElement) => Array.from(c.querySelectorAll('.tool-card.task')) as HTMLElement[];

  it('flags only the SECOND card for the same task session as a continuation', async () => {
    const { container } = render(ChatPane, { props: {} });
    post({ type: 'sessionCreated', sessionId: SESSION, sessionNumber: 1, agentName: 'Tsuru' });
    await tick();
    post({ type: 'busy', sessionId: SESSION });

    await spawn('call_a', 'review the diff', CHILD);
    await spawn('call_b', 'review the diff again', CHILD); // SAME child ⇒ resumed

    const [first, second] = cards(container as HTMLElement);
    expect(first.querySelector('.tool-resumed'), 'the first spawn is not a resumption').toBeNull();
    expect(second.querySelector('.tool-resumed')?.textContent).toBe('resumed');
    // Both are still plainly sub-agent delegations.
    expect(first.querySelector('.tool-badge')?.textContent).toBe('sub-agent');
    expect(second.querySelector('.tool-badge')?.textContent).toBe('sub-agent');
  });

  it('two DIFFERENT sub-agents are never marked resumed — this is the case the owner could not see', async () => {
    const { container } = render(ChatPane, { props: {} });
    post({ type: 'sessionCreated', sessionId: SESSION, sessionNumber: 1, agentName: 'Tsuru' });
    await tick();
    post({ type: 'busy', sessionId: SESSION });

    await spawn('call_a', 'review the diff', 'ses_child_a');
    await spawn('call_b', 'review the diff again', 'ses_child_b'); // a WHOLLY NEW agent

    for (const card of cards(container as HTMLElement)) {
      expect(card.querySelector('.tool-resumed')).toBeNull();
    }
  });

  it('a non-task tool never gets the chip even if it somehow carries an id', async () => {
    const { container } = render(ChatPane, { props: {} });
    post({ type: 'sessionCreated', sessionId: SESSION, sessionNumber: 1, agentName: 'Tsuru' });
    await tick();
    post({ type: 'busy', sessionId: SESSION });
    await spawn('call_a', 'review', CHILD);
    post({ type: 'toolCall', sessionId: SESSION, toolCallId: 'call_read', title: 'read brief.md', kind: 'read', status: 'in_progress', toolName: 'read' });
    await tick();
    post({ type: 'toolResult', sessionId: SESSION, toolCallId: 'call_read', status: 'completed', content: 'x', taskSessionId: CHILD });
    await tick();

    const readCard = Array.from((container as HTMLElement).querySelectorAll('.tool-card')).find(
      (el) => el.textContent?.includes('read brief.md'),
    ) as HTMLElement;
    expect(readCard.querySelector('.tool-resumed')).toBeNull();
  });
});
