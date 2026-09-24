// SchedulesPane (t-ru1qsp) — Crons and Loops folded into one rail item, the
// two panes now behind tabs here instead of two rail rows. These tests pin
// the behaviour the ticket's acceptance items care about: both existing panes
// mount UNCHANGED, the last tab persists per window, a deep-linked view id
// (crons/loops) opens the matching tab, and the two are still described as
// DIFFERENT things (the distinction the owner said users get wrong) — moved
// here from boardShell.test.ts now that it is a tab-level, not rail-level, fact.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import SchedulesPane from '../panes/SchedulesPane.svelte';
import { noteRequestedTab } from '../panes/scheduleTabRequest';

const tabButton = (c: HTMLElement, name: string): HTMLButtonElement =>
  Array.from(c.querySelectorAll('.sch-tab')).find((b) => b.textContent === name) as HTMLButtonElement;

beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
  (window as unknown as { __ORIGAMI_SCHEDULE_TAB__?: string }).__ORIGAMI_SCHEDULE_TAB__ = undefined;
});
afterEach(() => cleanup());

describe('SchedulesPane — opens on Crons by default, mounts the existing panes unchanged', () => {
  it('mounts CronsPane, not LoopsPane, with Crons marked active', async () => {
    const { container } = render(SchedulesPane);
    await tick();
    expect(container.querySelector('.crons-pane')).not.toBeNull();
    expect(container.querySelector('.loops-pane')).toBeNull();
    expect(tabButton(container, 'Crons').classList.contains('on')).toBe(true);
  });

  it('clicking Loops mounts LoopsPane, unmounts CronsPane, and persists the pick', async () => {
    const { container } = render(SchedulesPane);
    await tick();
    await fireEvent.click(tabButton(container, 'Loops'));
    await tick();
    expect(container.querySelector('.loops-pane')).not.toBeNull();
    expect(container.querySelector('.crons-pane')).toBeNull();
    expect(tabButton(container, 'Loops').classList.contains('on')).toBe(true);
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]))
      .toContainEqual({ type: 'setScheduleTab', tab: 'loops' });
  });

  it('clicking back to Crons posts the tab pick too', async () => {
    const { container } = render(SchedulesPane);
    await tick();
    await fireEvent.click(tabButton(container, 'Loops'));
    await tick();
    await fireEvent.click(tabButton(container, 'Crons'));
    await tick();
    expect(container.querySelector('.crons-pane')).not.toBeNull();
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]))
      .toContainEqual({ type: 'setScheduleTab', tab: 'crons' });
  });
});

describe('SchedulesPane — the last tab is restored from the window this session was given', () => {
  it('opens on Loops when window.__ORIGAMI_SCHEDULE_TAB__ says so (the host-persisted pick)', async () => {
    (window as unknown as { __ORIGAMI_SCHEDULE_TAB__?: string }).__ORIGAMI_SCHEDULE_TAB__ = 'loops';
    const { container } = render(SchedulesPane);
    await tick();
    expect(container.querySelector('.loops-pane')).not.toBeNull();
    expect(tabButton(container, 'Loops').classList.contains('on')).toBe(true);
  });
});

describe('SchedulesPane — a deep-linked view id opens the matching tab', () => {
  it('a pending crons/loops request (viewForSection, boardViews.ts) overrides the persisted default, then clears itself', async () => {
    (window as unknown as { __ORIGAMI_SCHEDULE_TAB__?: string }).__ORIGAMI_SCHEDULE_TAB__ = 'crons';
    noteRequestedTab('loops');
    const { container, unmount } = render(SchedulesPane);
    await tick();
    expect(container.querySelector('.loops-pane')).not.toBeNull();
    unmount();

    // ONE-SHOT: a second mount with nothing newly requested falls back to the
    // persisted default again, not to the tab the last deep link picked.
    const { container: second } = render(SchedulesPane);
    await tick();
    expect(second.querySelector('.crons-pane')).not.toBeNull();
  });
});

describe('SchedulesPane — Crons and Loops are described as DIFFERENT things', () => {
  // A loop dies with the window; a cron is an OS task that fires with VS Code
  // closed. A tab pair that blurs the two sends people to the wrong one.
  it('the Crons tab title says the schedule survives VS Code closing, the Loops tab title does not', async () => {
    const { container } = render(SchedulesPane);
    await tick();
    expect(tabButton(container, 'Crons').getAttribute('title')).toContain('closed');
    expect(tabButton(container, 'Loops').getAttribute('title')).not.toContain('closed');
  });
});
