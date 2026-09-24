// ChatSectionBlock — one collapsible chat-list section header. t-qmzz3q
// (change 32, Mock-Redesign/CHANGES.md porting index row 32) ported the
// rotating chevron and the count pill; ChatsList.test.ts covers the
// hover-only "+", since that button is rendered there.
//
// Mounted through ChatsList, not standalone: this component's header only
// takes its name/extra areas as Snippet props (see the file header comment),
// and ChatsList.test.ts already establishes that rendering it through the
// real caller exercises the same, shipped DOM (its own header comment says
// so of SidebarLauncher.test.ts).
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';
import ChatsList from './ChatsList.svelte';

afterEach(() => {
  cleanup();
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

async function post(data: unknown): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

function chatSections(state: Partial<{
  membership: Record<string, string>;
  sections: Array<{ id: string; name: string; collapsed: boolean }>;
  mainCollapsed: boolean;
}>): unknown {
  return { type: 'chatSections', state: { membership: {}, sections: [], mainCollapsed: false, ...state } };
}

describe('ChatSectionBlock — chevron rotates, one glyph (change 32)', () => {
  it('renders the same glyph whether open or collapsed — no swapped character', async () => {
    const { container } = render(ChatsList);
    const chevron = () => container.querySelector('.chat-section-chevron')!.textContent;
    expect(chevron()).toBe('▾');

    await post(chatSections({ mainCollapsed: true }));
    expect(chevron()).toBe('▾');
  });

  it('aria-expanded flips with collapsed, which is what the rotation CSS keys on', async () => {
    const { container } = render(ChatsList);
    const btn = () => container.querySelector('.chat-section-chevron-btn')!;
    expect(btn().getAttribute('aria-expanded')).toBe('true');

    await fireEvent.click(btn());
    expect(btn().getAttribute('aria-expanded')).toBe('false');
  });

  // CSS-SOURCE: no `css: true` in vitest.config.mts, so getComputedStyle
  // cannot see the transform here — see WORKING_ON_ORIGAMI_CODER.md.
  it('the collapsed rule rotates the glyph -90deg via a transition, not a character swap', () => {
    const src = readFileSync(join(__dirname, 'ChatSectionBlock.svelte'), 'utf-8');
    expect(src).toMatch(/\.chat-section-chevron\s*\{[^}]*transition:\s*transform/);
    expect(src).toMatch(/\.chat-section-chevron-btn\[aria-expanded='false'\]\s*\.chat-section-chevron\s*\{\s*transform:\s*rotate\(-90deg\);/);
  });
});

describe('ChatSectionBlock — count is a pill (change 32)', () => {
  it('renders the row count', async () => {
    const { container } = render(ChatsList);
    await post({ type: 'sessionList', sessions: ['a', 'b', 'c'].map((id, n) => ({ id, number: n + 1, agentName: 'Tsuru', title: id })) });
    expect(container.querySelector('.chat-section-count')!.textContent).toBe('3');
  });

  it('the pill has a border and radius, not bare text', () => {
    const src = readFileSync(join(__dirname, 'ChatSectionBlock.svelte'), 'utf-8');
    expect(src).toMatch(/\.chat-section-count\s*\{[^}]*border:\s*1px solid var\(--og-border\);[^}]*border-radius:\s*8px;/);
  });
});
