// The sidebar's Collabs half collapses — asserted through the real launcher,
// and only on what jsdom can see: which elements are mounted and what is posted.
// Whether the collapsed header LOOKS right still needs a human eye; no <style>
// reaches this DOM (vitest.config.mts does not set css:true).
//
// The pair of claims: the half (label, body and RESIZE HANDLE alike) is absent
// until the dock asks for it — a handle for a section with nothing to resize is
// a control that cannot act — and the choice is posted so collabsSection.ts can
// persist it; the host half of that round trip is proven in
// collabsSection.test.ts. Default CLOSED since t-qhzy4k.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import SidebarLauncher from '../../chat/SidebarLauncher.svelte';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
// The half's own header button is gone (change 1): the DOCK toggles it now,
// and `aria-pressed` on that item is where "expanded" is readable.
const toggle = (c: HTMLElement) => c.querySelector('.dock-item[aria-label="Collabs"]') as HTMLButtonElement;
const expanded = (c: HTMLElement) => toggle(c).getAttribute('aria-pressed');

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('SidebarLauncher — the Collabs half collapses', () => {
  it('starts CLOSED: no half, no label, no resize handle', () => {
    const { container } = render(SidebarLauncher);
    expect(expanded(container)).toBe('false');
    expect(container.querySelector('.collabs-half')).toBeNull();
    expect(container.querySelector('.collab-list')).toBeNull();
    expect(container.querySelector('.section-divider')).toBeNull();
  });

  it('the dock item brings the list AND its resize handle in, and puts them away again', async () => {
    const { container } = render(SidebarLauncher);
    await fireEvent.click(toggle(container));
    await tick();
    expect(container.querySelector('.collab-list')).not.toBeNull();
    expect(container.querySelector('.section-divider')).not.toBeNull();
    expect(expanded(container)).toBe('true');

    await fireEvent.click(toggle(container));
    await tick();
    expect(container.querySelector('.collab-list')).toBeNull();
    expect(container.querySelector('.section-divider')).toBeNull();
    // The dock item stays: it is the only way back.
    expect(expanded(container)).toBe('false');
  });

  it('posts the choice so the host can persist it', async () => {
    const { container } = render(SidebarLauncher);
    await fireEvent.click(toggle(container));
    expect(posts().filter((p) => p.type === 'setCollabsCollapsed')).toEqual([
      { type: 'setCollabsCollapsed', collapsed: false },
    ]);

    await fireEvent.click(toggle(container));
    expect(posts().filter((p) => p.type === 'setCollabsCollapsed').at(-1)).toEqual({
      type: 'setCollabsCollapsed',
      collapsed: true,
    });
  });

  it('asks the host on mount and honours a stored OPEN answer', async () => {
    const { container } = render(SidebarLauncher);
    expect(posts().filter((p) => p.type === 'requestCollabsHeight')).toHaveLength(1);
    expect(container.querySelector('.collab-list')).toBeNull();

    send({ type: 'collabsHeight', heightPx: null, collapsed: false });
    await tick();
    expect(container.querySelector('.collab-list')).not.toBeNull();
  });

  it('a stored HEIGHT is not applied while closed — Chats takes the whole split', async () => {
    const { container } = render(SidebarLauncher);
    send({ type: 'collabsHeight', heightPx: 180, collapsed: true });
    await tick();
    expect(container.querySelector('.collabs-half')).toBeNull();

    // ...and opening gives the dragged height straight back.
    await fireEvent.click(toggle(container));
    await tick();
    expect((container.querySelector('.collabs-half') as HTMLElement).style.flex).toBe('0 0 180px');
  });
});
