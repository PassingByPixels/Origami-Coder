// Reasoning blocks stay COLLAPSED while streaming. The live thought used to bind
// `open={isLiveThought}`, so every reasoning burst threw a wall of model chatter over
// the answer mid-turn and the transcript jumped as it grew. The file's own CSS comment
// already stated the intent ("Default-collapsed so the answer stays front and centre")
// and the sibling .compaction-block is the working precedent (class only, no `open`).
//
// Restore the `open` binding and test 1 goes red.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const SESSION = 'sess-1';
const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

async function mountStreamingThought(): Promise<HTMLElement> {
  const { container } = render(ChatPane, { props: {} });
  post({ type: 'sessionCreated', sessionId: SESSION, sessionNumber: 1, agentName: 'Tsuru' });
  await tick();
  post({ type: 'busy', sessionId: SESSION }); // host-driven in-flight, same flag a send sets
  post({ type: 'agentThought', sessionId: SESSION, text: 'weighing the options' });
  await tick();
  return container as HTMLElement;
}

describe('thought block — collapsed while live', () => {
  afterEach(() => cleanup());

  it('1 — a streaming thought renders CLOSED (the answer stays front and centre)', async () => {
    const c = await mountStreamingThought();
    const details = c.querySelector('details.thought-block') as HTMLDetailsElement | null;
    expect(details, 'the thought block must render').not.toBeNull();
    expect(details!.open).toBe(false);
  });

  it('2 — it is still expandable, and its text is intact', async () => {
    const c = await mountStreamingThought();
    const details = c.querySelector('details.thought-block') as HTMLDetailsElement;
    expect(details.querySelector('summary')).not.toBeNull(); // the user can open it
    expect(details.querySelector('.thought-text')!.textContent).toBe('weighing the options');
  });

  it('3 — a thought the user opens by hand STAYS OPEN through further deltas', async () => {
    // The bug this guards: appendToMessage replaces the message object on every
    // delta, re-firing the <details> node's attribute effect; if the caller does
    // not track what the user did, that reassertion silently re-closes a block
    // the user just expanded (thoughtOpenState.ts).
    const c = await mountStreamingThought();
    const summary = c.querySelector('details.thought-block summary') as HTMLElement;
    await fireEvent.click(summary); // native open, same as a user click
    // The browser queues the 'toggle' event as a task, not a microtask — give
    // it a real turn of the loop so ChatPane's onToggle handler has run before
    // the next delta lands, exactly as it would for a real user click.
    await new Promise((r) => setTimeout(r, 0));
    const details = c.querySelector('details.thought-block') as HTMLDetailsElement;
    expect(details.open, 'sanity: the click opened it').toBe(true);

    post({ type: 'agentThought', sessionId: SESSION, text: ' — weighing further' });
    await tick();

    expect(details.open).toBe(true);
    expect(details.querySelector('.thought-text')!.textContent).toBe('weighing the options — weighing further');
  });
});
