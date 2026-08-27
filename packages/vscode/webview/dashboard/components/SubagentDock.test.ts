// SubagentDock.test.ts — the dock's two lifecycle decisions.
//
// 1. WHAT ↗ OPENS. Every child with a session of its own — running or settled
//    — opens the read-only chat view, because the engine projects a child's
//    STORED session throughout its life, not only after it ends. A running one
//    used to get the flat `task.log` tab off the forwarded chunk buffer
//    instead, which is transient and never logged: in a reopened chat it was
//    empty, so the tab read "(no output yet)" for a whole multi-hour run and
//    never changed. The decision is HERE, not in the row — SubagentRow.svelte
//    is presentation and holds no lifecycle rules, by its own header comment.
// 2. WHAT KEEPS THE CLOCK RUNNING. Settled rows now stay on the roster for the
//    Complete group, so the 1s tick must gate on the RUNNING ones alone.
//    Gating on row COUNT would leave an interval running forever in every chat
//    that ever spawned a sub-agent, ageing rows whose age stopped moving.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SubagentDock from './SubagentDock.svelte';
import type { SubagentMessage } from '../panes/subagentRows';

const live: SubagentMessage = {
  taskSessionId: 'child-live', label: 'still going', toolStatus: 'in_progress',
  toolName: 'task', taskStream: '> read: a.ts\n', timestamp: Date.now(),
};
const settled: SubagentMessage = {
  taskSessionId: 'child-done', label: 'finished', toolStatus: 'completed',
  toolName: 'task', taskStream: '> read: b.ts\n', timestamp: Date.now(),
};

/** A spawn the engine refused — no child session, so nothing to read. */
const denied: SubagentMessage = {
  label: 'denied', toolName: 'task', toolStatus: 'failed', toolCallId: 'tc-9', timestamp: Date.now(),
};

async function openDrawer(messages: SubagentMessage[]) {
  const { container } = render(SubagentDock, {
    messages, dismissed: [], open: true, onToggle: () => {}, onDismiss: () => {},
  });
  await fireEvent.click(container.querySelector('.sa-head') as HTMLElement);
  return container;
}

/** The ↗ on the row whose name matches. */
const popFor = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll('.sa-row')]
    .find((r) => r.querySelector('.sa-name')?.textContent === name)!
    .querySelector('.sa-pop') as HTMLElement;

describe('SubagentDock — expanding a row', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('opens the read-only TRANSCRIPT for a settled child', async () => {
    const c = await openDrawer([settled]);
    await fireEvent.click(popFor(c, 'finished'));
    await tick();
    expect(c.querySelector('.sat-overlay'), 'the transcript panel mounts').not.toBeNull();
  });

  it('opens the SAME transcript for a child that is still mid-run', async () => {
    // The owner-reported defect, at its seam: a running child used to route to
    // the flat stream tab, whose content is a one-shot snapshot of a buffer
    // that is empty after a reload — "(no output yet)", for hours. Its stored
    // session is readable the whole time, so it reads the same way.
    const c = await openDrawer([live]);
    await fireEvent.click(popFor(c, 'still going'));
    await tick();
    expect(c.querySelector('.sat-overlay'), 'a running child is inspectable too').not.toBeNull();
    // And it ASKS for that child, rather than mounting an empty shell.
    expect(globalThis.__vscodeApiMock.postMessage)
      .toHaveBeenCalledWith({ type: 'requestSubagentTranscript', sessionId: 'child-live' });
  });

  it('offers NO ↗ on a spawn that never created a child', async () => {
    // A denied ask has no session to read. A control that opens an empty panel
    // is worse than no control: it says there is something to look at.
    const c = await openDrawer([denied]);
    const row = [...c.querySelectorAll('.sa-row')].find((r) => r.querySelector('.sa-name')?.textContent === 'denied')!;
    expect(row.querySelector('.sa-pop')).toBeNull();
  });
});

describe('SubagentDock — the clock', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('does NOT tick for a roster of only settled rows', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    render(SubagentDock, {
      messages: [settled], dismissed: [], open: true,
      onToggle: () => {}, onDismiss: () => {},
    });
    await tick();
    expect(spy, 'a finished row has no age left to age').not.toHaveBeenCalled();
  });

  it('ticks while at least one agent is still out', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    render(SubagentDock, {
      messages: [settled, live], dismissed: [], open: true,
      onToggle: () => {}, onDismiss: () => {},
    });
    await tick();
    expect(spy).toHaveBeenCalled();
  });
});
