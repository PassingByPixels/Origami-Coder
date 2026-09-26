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
import { dockProps } from '../panes/subagentRowFixture';

// `label` is the CARD's header, which for a `task` call is the literal word
// `task`; what a row PRINTS is its identity, off the call's own description
// (subagentLabel.ts). Both are set here, so a row that regressed to the header
// would fail the lookups below rather than quietly matching.
const live: SubagentMessage = {
  taskSessionId: 'child-live', label: 'task', taskDescription: 'still going', toolStatus: 'in_progress',
  toolName: 'task', taskStream: '> read: a.ts\n', timestamp: Date.now(),
};
const settled: SubagentMessage = {
  taskSessionId: 'child-done', label: 'task', taskDescription: 'finished', toolStatus: 'completed',
  toolName: 'task', taskStream: '> read: b.ts\n', timestamp: Date.now(),
};

/** A spawn the engine refused — no child session, so nothing to read. */
const denied: SubagentMessage = {
  label: 'task', taskDescription: 'denied', toolName: 'task', toolStatus: 'failed',
  toolCallId: 'tc-9', timestamp: Date.now(),
};

async function openDrawer(messages: SubagentMessage[]) {
  const { container } = render(SubagentDock, dockProps(messages));
  if (!container.querySelector('.sa-groups')) await fireEvent.click(container.querySelector('.sa-head') as HTMLElement); // t-ru13hb: a running row may have unfolded it already
  // The COMPLETE band ships shut (t-d93fjo); open it, or a settled child's row
  // — and its ↗ — is not in the DOM to click.
  const fold = container.querySelector('.sa-group-fold') as HTMLElement | null;
  if (fold) await fireEvent.click(fold);
  return container;
}

/** `restoreAllMocks` BEFORE `useRealTimers`, and both after EVERY case: the
 *  clock suite spies on `setInterval` while fake timers are installed, and
 *  swapping the timers back without un-spying first leaves globalThis with no
 *  `setInterval` at all. Every later suite in this file then failed inside the
 *  dock's own tick effect, nowhere near the test that actually broke it. */
const reset = () => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); };

/** The ↗ on the row whose name matches. */
const popFor = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll('.sa-row')]
    .find((r) => r.querySelector('.sa-name')?.textContent === name)!
    .querySelector('.sa-pop') as HTMLElement;

describe('SubagentDock — expanding a row', () => {
  afterEach(reset);

  it('opens the read-only TRANSCRIPT for a settled child', async () => {
    const c = await openDrawer([settled]);
    await fireEvent.click(popFor(c, 'T1 · finished'));
    await tick();
    expect(c.querySelector('.sat-overlay'), 'the transcript panel mounts').not.toBeNull();
  });

  it('opens the SAME transcript for a child that is still mid-run', async () => {
    // The owner-reported defect, at its seam: a running child used to route to
    // the flat stream tab, whose content is a one-shot snapshot of a buffer
    // that is empty after a reload — "(no output yet)", for hours. Its stored
    // session is readable the whole time, so it reads the same way.
    const c = await openDrawer([live]);
    await fireEvent.click(popFor(c, 'T1 · still going'));
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
    const row = [...c.querySelectorAll('.sa-row')].find((r) => r.querySelector('.sa-name')?.textContent === 'T1 · denied')!;
    expect(row.querySelector('.sa-pop')).toBeNull();
  });
});

describe('SubagentDock — the clock', () => {
  afterEach(reset);

  it('does NOT tick for a roster of only settled rows', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    render(SubagentDock, dockProps([settled]));
    await tick();
    expect(spy, 'a finished row has no age left to age').not.toHaveBeenCalled();
  });

  it('ticks while at least one agent is still out', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    render(SubagentDock, dockProps([settled, live]));
    await tick();
    expect(spy).toHaveBeenCalled();
  });
});

// --- t-dclj7z -------------------------------------------------------------
// The dock's ceiling wiring. The rule itself is unit-tested as a pure leaf
// (subagentWarn / subagentLimitWire); what only a render can show is that the
// dock actually calls it, with the roster it is showing.
describe('SubagentDock — the ceiling', () => {
  afterEach(reset);

  it('asks the HOST for the sub-agent time limit rather than reading a setting itself', () => {
    // A webview cannot read `origami.subagentTimeLimitHours`, and a second
    // reader of it could report a ceiling the engine was never spawned with.
    render(SubagentDock, dockProps([live]));
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'requestSubagentLimit' });
  });

  it('ambers a running row once the host names a ceiling it is already past', async () => {
    // Nothing is amber before the answer arrives — the dock refuses to guess.
    const old: SubagentMessage = { ...live, taskStartedAt: Date.now() - 3_600_000 };
    const c = await openDrawer([old]);
    expect(c.querySelector('.sa-dot')?.className).not.toContain('sa-warn');

    // 0.5 h, so an hour-old child is well past 80% of it.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'subagentLimitData', hours: 0.5 } }));
    await tick();
    expect(c.querySelector('.sa-dot')?.className).toContain('sa-warn');
  });
});

// t-h8gv8w — a finished row is HISTORY. Nothing retires it but the owner.
describe('SubagentDock — a settled row is never retired on its own', () => {
  afterEach(reset);

  /** A child that finished an hour ago, with both stamps — what the old age
   *  sweep took, and what the drawer now keeps. */
  const longDone: SubagentMessage = {
    ...settled, taskSessionId: 'child-old', taskDescription: 'long done',
    taskStartedAt: Date.now() - 7_200_000, taskEndedAt: Date.now() - 3_600_000,
  };

  it('keeps a row that ended long past the ceiling, and dismisses nothing', async () => {
    const onDismiss = vi.fn();
    const { container } = render(SubagentDock, dockProps([longDone], { onDismiss }));
    // The ceiling the old sweep read: half an hour, against a child that ended
    // an hour ago. It used to be gone a tick later.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'subagentLimitData', hours: 0.5 } }));
    await tick();
    expect(onDismiss, 'nothing retires a settled row on the clock').not.toHaveBeenCalled();
    if (!container.querySelector('.sa-groups')) await fireEvent.click(container.querySelector('.sa-head') as HTMLElement); // t-ru13hb: a running row may have unfolded it already
    await fireEvent.click(container.querySelector('.sa-group-fold') as HTMLElement);
    expect(container.querySelector('.sa-name')?.textContent).toBe('T1 · long done');
  });

  it('offers no bulk clear over the Complete band', async () => {
    const { container } = render(SubagentDock, dockProps([live, settled, longDone]));
    if (!container.querySelector('.sa-groups')) await fireEvent.click(container.querySelector('.sa-head') as HTMLElement); // t-ru13hb: a running row may have unfolded it already
    expect(container.querySelector('.sa-group-clear')).toBeNull();
  });
});

describe('SubagentDock — the agent map', () => {
  afterEach(reset);

  it('opens from the pull-out and closes again', async () => {
    const { container } = render(SubagentDock, dockProps([live]));
    expect(container.querySelector('.sm-scrim')).toBeNull();
    await fireEvent.click(container.querySelector('.sa-map-btn') as HTMLElement);
    await tick();
    expect(container.querySelector('.am-hub-name')?.textContent).toBe('#1 coder');
    await fireEvent.click(container.querySelector('.sm-close') as HTMLElement);
    await tick();
    expect(container.querySelector('.sm-scrim')).toBeNull();
  });

  it('a node hands off to the SAME transcript the drawer ↗ opens, and closes behind it', async () => {
    // Two stacked overlays over one chat cell is one too many, and the
    // transcript is the thing the click was actually asking for.
    const { container } = render(SubagentDock, dockProps([live]));
    await fireEvent.click(container.querySelector('.sa-map-btn') as HTMLElement);
    await tick();
    await fireEvent.click(container.querySelector('.am-card') as HTMLElement);
    await tick();
    expect(container.querySelector('.sm-scrim')).toBeNull();
    expect(container.querySelector('.sat-overlay')).not.toBeNull();
    expect(globalThis.__vscodeApiMock.postMessage)
      .toHaveBeenCalledWith({ type: 'requestSubagentTranscript', sessionId: 'child-live' });
  });
});
