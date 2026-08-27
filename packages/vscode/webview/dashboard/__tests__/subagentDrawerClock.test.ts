// The sub-agent drawer's AGE, end to end through the real pane.
//
// `subagentRows` has always taken `now` as a parameter and `subagentFormat`
// has always formatted it, and both were unit-tested — while the drawer on
// screen showed every agent frozen at the age it was born with, because the
// pane read `Date.now()` inline once per render and nothing re-rendered on the
// passage of time. Two green leaf suites and a broken feature: the age is only
// true if something ticks, so this drives the mounted component (SubagentDock)
// and watches the rendered text change.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import ChatPane from '../panes/ChatPane.svelte';

const SESSION = 'sess-clock';
const CHILD = 'ses_child_clock';
const post = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));

/** A chat with ONE sub-agent still out, its roster list expanded. */
async function mountWithRunningSubagent(container: () => HTMLElement) {
  post({ type: 'sessionCreated', sessionId: SESSION, sessionNumber: 1, agentName: 'Tsuru' });
  await tick();
  post({ type: 'busy', sessionId: SESSION });
  post({
    type: 'toolCall',
    sessionId: SESSION,
    toolCallId: 'call_clock',
    title: 'write story 1',
    kind: 'think',
    status: 'in_progress',
    toolName: 'task',
    taskSessionId: CHILD,
    // DETACHED, the ordinary case: the launcher card completes at spawn, so
    // only the engine's terminal marker ever retires this row.
    taskBackground: true,
  });
  await tick();
  const head = container().querySelector('.sa-head') as HTMLElement | null;
  expect(head, 'the drawer must render for a sub-agent that is still out').not.toBeNull();
  await fireEvent.click(head!);
  await tick();
}

const age = (c: HTMLElement) => c.querySelector('.sa-age')?.textContent ?? '';

describe('sub-agent drawer — the age is live, not a snapshot', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('ages a running sub-agent as time passes', async () => {
    vi.useFakeTimers();
    const { container } = render(ChatPane, { props: {} });
    const c = () => container as HTMLElement;
    await mountWithRunningSubagent(c);

    // A brand-new row prints NO age (subagentFormat's rule: "0s" would read as
    // "it just started" on an agent that has been out for a minute).
    expect(age(c())).toBe('');

    vi.advanceTimersByTime(5000);
    await tick();
    expect(age(c())).toBe('5s');

    vi.advanceTimersByTime(60000);
    await tick();
    expect(age(c())).toBe('1m 05s');
  });

  it('stops ticking once the last agent comes home', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { container } = render(ChatPane, { props: {} });
    const c = () => container as HTMLElement;
    await mountWithRunningSubagent(c);

    vi.advanceTimersByTime(3000);
    await tick();
    expect(age(c())).toBe('3s');

    // The engine's terminal marker retires the row — and with the roster empty
    // the drawer unmounts, so an idle chat must not be left holding a 1s timer.
    post({ type: 'subagentDone', sessionId: SESSION, taskSessionId: CHILD, state: 'completed' });
    await tick();
    // The ROW stays — it moved to Complete, which is where the finished child's
    // transcript is read from. What must stop is the TICKING: a settled row has
    // no age left to age, and an interval per historical fan-out is a leak.
    expect(c().querySelector('.sa-head'), 'the drawer stays for the Complete group').not.toBeNull();
    expect(clearSpy).toHaveBeenCalled();
  });
});
