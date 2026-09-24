// t-ru13hb item 3 — THE DRAWER OPENS ITSELF WHEN A CHILD GOES OUT.
//
// The sub-agent drawer booted shut with its list collapsed, so a fan-out could
// be running with nothing on screen saying so. Now a child going out reveals
// the roster: the drawer is asked to open, the list unfolds, and the first
// running row is scrolled into view.
//
// The second half is what keeps it bearable: a user who shuts the drawer, or
// collapses the list, is not re-opened by the next spawn. That memory lasts
// for the session (the surface's lifetime), and it is asserted here because a
// drawer that reopens itself every few seconds is worse than one that never
// opens at all.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import SubagentDrawer from './SubagentDrawer.svelte';
import { drawerProps, row } from '../panes/subagentRowFixture';
import { shouldReveal } from './subagentAutoOpen';

// jsdom implements no scrolling at all; the production call is guarded for
// exactly that reason, so the spy is also what makes the call observable.
let scrollSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  scrollSpy = vi.fn();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollSpy;
});
afterEach(() => cleanup());

const settled = row({ key: 'old', ordinal: 9, description: 'finished', state: 'done', settled: true });
const live = (key: string, ordinal: number) =>
  row({ key, ordinal, description: `working ${key}`, state: 'running' });

const listShown = (c: HTMLElement) => c.querySelector('.sa-groups') !== null;
const firstRowName = (c: HTMLElement) =>
  c.querySelector('.sa-group .sa-list .sa-name')?.textContent ?? '';

describe('a running child reveals the roster', () => {
  it('asks the shut drawer to open, unfolds the list, and shows the first running row', async () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(SubagentDrawer, drawerProps([settled], { open: false, onToggle }));
    await tick();
    expect(listShown(container as HTMLElement), 'nothing is out yet').toBe(false);

    await rerender(drawerProps([settled, live('a', 1)], { open: false, onToggle }));
    await tick();
    await tick();

    expect(onToggle, 'a shut drawer has to be asked to open by its owner').toHaveBeenCalledTimes(1);
    expect(listShown(container as HTMLElement)).toBe(true);
    expect(firstRowName(container as HTMLElement)).toBe('T1 · working a');
    expect(scrollSpy, 'the first running row is put where it can be read').toHaveBeenCalled();
  });

  it('does not re-ask an already-open drawer to toggle', async () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(SubagentDrawer, drawerProps([settled], { open: true, onToggle }));
    await rerender(drawerProps([settled, live('a', 1)], { open: true, onToggle }));
    await tick();
    await tick();
    expect(onToggle, 'toggling an open drawer would SHUT it').not.toHaveBeenCalled();
    expect(listShown(container as HTMLElement)).toBe(true);
  });

  it('leaves a collapsed list collapsed once the user has collapsed it', async () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(SubagentDrawer, drawerProps([settled, live('a', 1)], { open: true, onToggle }));
    await tick();
    await tick();
    expect(listShown(container as HTMLElement)).toBe(true);

    // The user folds it away again.
    await fireEvent.click(container.querySelector('.sa-head') as HTMLElement);
    await tick();
    expect(listShown(container as HTMLElement)).toBe(false);

    // A second child goes out. The drawer must NOT spring open over the reply.
    await rerender(drawerProps([settled, live('a', 1), live('b', 2)], { open: true, onToggle }));
    await tick();
    await tick();
    expect(listShown(container as HTMLElement), 'the user said no once').toBe(false);
  });

  it('does not reopen a drawer the user shut from the tab', async () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(SubagentDrawer, drawerProps([settled, live('a', 1)], { open: true, onToggle }));
    await tick();
    await fireEvent.click(container.querySelector('.sa-tab') as HTMLElement);
    await tick();
    expect(onToggle, 'the tab still toggles').toHaveBeenCalledTimes(1);
    onToggle.mockClear();

    await rerender(drawerProps([settled, live('a', 1), live('b', 2)], { open: false, onToggle }));
    await tick();
    await tick();
    expect(onToggle, 'a drawer shut on purpose stays shut').not.toHaveBeenCalled();
  });
});

describe('the reveal rule itself', () => {
  it('fires when the running band GREW', () => {
    expect(shouldReveal(0, 1, false)).toBe(true);
    expect(shouldReveal(2, 3, false)).toBe(true);
  });
  it('does not fire while the same children keep running', () => {
    expect(shouldReveal(3, 3, false)).toBe(false);
  });
  it('does not fire as children finish', () => {
    expect(shouldReveal(3, 1, false)).toBe(false);
  });
  it('never fires once the user has collapsed the surface', () => {
    expect(shouldReveal(0, 4, true)).toBe(false);
  });
});
