// t-s9k0q6 rule 1 — the Here | Nest control exists only when it is useful.
//
// With Nests off, or on with no other desk, the sidebar's Chats half must be
// EXACTLY today's markup: no control, no chips, no wrapper. The snapshot below
// was RECORDED ON THE BASE CODE (master 7f7141d912, before this lane touched
// a line), so it is today's DOM, not the new code's own echo. A lane that adds
// one element, class or attribute to the gated-off path turns this red.
import { render, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach } from 'vitest';
import { tick } from 'svelte';
import SidebarLauncher from './SidebarLauncher.svelte';

afterEach(() => {
  cleanup();
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

/** Two sections, three chats, one of them in a section: enough markup that a
 *  stray wrapper or class anywhere in the half would show in the string. */
async function driveToday(): Promise<HTMLElement> {
  const { container } = render(SidebarLauncher);
  await post({
    type: 'sessionList',
    sessions: [
      { id: 'a', number: 1, agentName: 'Tsuru', title: 'Godot rig' },
      { id: 'b', number: 2, agentName: 'Coder', title: 'Cron sweep' },
      { id: 'c', number: 3, agentName: 'Element', title: 'Agent message' },
    ],
  });
  await post({
    type: 'chatSections',
    state: { sections: [{ id: 's1', name: 'Work', collapsed: false }], membership: { b: 's1' }, mainCollapsed: false },
  });
  return container as HTMLElement;
}

/** Every element, attribute, class and text node, WITHOUT Svelte's empty
 *  comment anchors: a `{#if}` or `{@render}` adds one even when it renders
 *  nothing, and a comment has no box, no role and no text. The stored snapshot
 *  is the base recording with its anchors removed by this same rule (commit
 *  6795d1481a holds the raw one). */
const half = (c: HTMLElement): string =>
  (c.querySelector('.chats-half') as HTMLElement).outerHTML.split('<!---->').join('');

const desk = (id: string, name: string) => ({ id, name, os: 'windows', online: true, lastSeen: 0, motherBase: false });

describe('the Chats half is unchanged while the Nest control is hidden', () => {
  it('with no nest push at all (the host never answered)', async () => {
    const c = await driveToday();
    expect(half(c)).toMatchSnapshot();
  });

  it('with Nests off (the host pushes no desks)', async () => {
    const c = await driveToday();
    await post({ type: 'origami/nestIndex', rows: [], desks: [] });
    expect(half(c)).toMatchSnapshot();
  });

  it('with Nests on and this desk alone in the group', async () => {
    const c = await driveToday();
    await post({ type: 'origami/nestIndex', rows: [], desks: [desk('self', 'Surface')] });
    expect(half(c)).toMatchSnapshot();
  });
});
