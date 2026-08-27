// ChatsList — the sidebar's Chats half, extracted from SidebarLauncher.svelte
// at t-kgserq (the seam that file's own architecture-cap comment named),
// extended at t-kgserq v2 from two fixed sections to Main (pinned top) / N
// user sections (middle) / Loops (pinned bottom), then reduced at t-r43glr
// (2026-08-14) to Main (pinned top) plus any number of user sections below —
// no other built-in. The session-list/ring/drag/rename/history behaviour
// this file inherited is already pinned down end-to-end via
// SidebarLauncher.test.ts, which renders the SAME markup through the parent
// — Svelte components render inline, so those assertions still exercise the
// real, shipped DOM. What is added here is what is NEW: the section layout,
// section CRUD, and the ring-CSS source-regex checks that moved with the
// ring markup itself.
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
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

function posts(): Array<Record<string, unknown>> {
  return globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
}

function sessionList(...ids: string[]): unknown {
  return {
    type: 'sessionList',
    sessions: ids.map((id, n) => ({ id, number: n + 1, agentName: 'Tsuru', title: id })),
  };
}

function chatSections(state: Partial<{
  membership: Record<string, string>;
  sections: Array<{ id: string; name: string; collapsed: boolean }>;
  mainCollapsed: boolean;
}>): unknown {
  return {
    type: 'chatSections',
    state: { membership: {}, sections: [], mainCollapsed: false, ...state },
  };
}

function rowIdsIn(container: HTMLElement, selector: string): string[] {
  return Array.from(container.querySelectorAll(`${selector} .session-name`)).map(
    (n) => (n.textContent ?? '').replace('Tsuru: ', ''),
  );
}

async function dragRowOnto(container: HTMLElement, rowIndex: number, target: Element) {
  const rows = container.querySelectorAll('.session-row');
  await fireEvent.dragStart(rows[rowIndex]);
  await fireEvent.dragOver(target);
  await fireEvent.drop(target);
}

function headerNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.chat-section-header')).map((h) => (h.textContent ?? '').trim());
}

describe('ChatsList — activity border presentation (source)', () => {
  it('the ring is a positioned, clipped overlay (not real box space), so no state can shift the row', () => {
    const src = readFileSync(join(__dirname, 'ChatsList.svelte'), 'utf-8');
    expect(src).toMatch(/\.session-ring\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*overflow:\s*hidden;/);
  });

  it('the working sweep is a registered <angle> custom property animated in place, not a transform on an element', () => {
    const src = readFileSync(join(__dirname, 'ChatsList.svelte'), 'utf-8');
    expect(src).toMatch(/@property\s+--sl-ring-angle\s*\{[^}]*syntax:\s*'<angle>';[^}]*inherits:\s*false;[^}]*initial-value:\s*0deg;/);
    expect(src).toMatch(/\.session-ring\[data-state='working'\]\s*\{[^}]*conic-gradient\(from var\(--sl-ring-angle\),\s*var\(--og-warning\)/);
    expect(src).toMatch(/\.session-ring\[data-state='working'\]\s*\{[^}]*animation:\s*sl-ring-spin/);
    expect(src).toMatch(/@keyframes sl-ring-spin\s*\{\s*to\s*\{\s*--sl-ring-angle:\s*360deg;\s*\}\s*\}/);
    expect(src).not.toMatch(/transform:\s*rotate/);
  });

  it('the ring is wired with the required colours and a reduced-motion branch', () => {
    const src = readFileSync(join(__dirname, 'ChatsList.svelte'), 'utf-8');
    expect(src).toMatch(/\.session-ring\[data-state='ready'\]\s*\{\s*background:\s*var\(--og-success\)/);
    expect(src).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.session-ring\[data-state='working'\]\s*\{\s*animation:\s*none;/);
  });

  // The waiting-for-user state (t-owc0813) must read its colour from the theme
  // token added for it in every bundled theme, never a literal — a hex here
  // would be a chat that needs the user reading as the wrong colour (or no
  // colour) in whichever of the five themes the literal happens to clash with.
  it('the waiting state is wired to the --og-status-waiting theme token, and no component in this file names a literal colour', () => {
    const src = readFileSync(join(__dirname, 'ChatsList.svelte'), 'utf-8');
    expect(src).toMatch(/\.session-ring\[data-state='waiting'\]\s*\{\s*background:\s*var\(--og-status-waiting\)/);
    // The one pre-existing literal in this file is the mask stencil's #fff
    // (alpha-only, not a themed colour — see architecture.test.ts's THEMED_FILES
    // comment for why the file is not opted into the blanket "no literal" test).
    // Assert it stays confined to exactly that mask declaration, so a future
    // change cannot smuggle a real colour literal past this narrower check.
    const literals = [...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(literals).toEqual(['#fff', '#fff']);
    expect(src).toMatch(/-webkit-mask:\s*linear-gradient\(#fff 0 0\)/);
  });

  it('no session-ring-sweep element or class remains anywhere in the source', () => {
    const src = readFileSync(join(__dirname, 'ChatsList.svelte'), 'utf-8');
    expect(src).not.toMatch(/session-ring-sweep/);
  });
});

// t-r43glr (2026-08-14) — Main (pinned top) plus any number of user sections
// below it, a chat draggable into any of them. The old fixed "Loops" section
// (pinned bottom) is retired; nothing renders below the user sections any
// more.
describe('ChatsList — the section layout', () => {
  it('Main always renders alone when there are no custom sections', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    const headers = container.querySelectorAll('.chat-section-header');
    expect(headers).toHaveLength(1);
    expect(headers[0].textContent).toContain('Main');
  });

  it('user sections render BELOW Main, in the given order', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post(chatSections({ sections: [{ id: 's1', name: 'Reviews', collapsed: false }, { id: 's2', name: 'Deep work', collapsed: false }] }));
    const names = headerNames(container);
    expect(names).toHaveLength(3);
    expect(names[0]).toContain('Main');
    expect(names[1]).toContain('Reviews');
    expect(names[2]).toContain('Deep work');
  });

  it('a chatSections reply groups chats under the right header, in reorder-array order', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a', 'b', 'c', 'd', 'e'));
    await post(chatSections({
      sections: [{ id: 's1', name: 'Reviews', collapsed: false }, { id: 's2', name: 'Deep work', collapsed: false }],
      membership: { b: 's2', d: 's1', c: 's2', e: 's1' },
    }));

    const sections = container.querySelectorAll('.chat-section-list');
    // Main, Reviews, Deep work — in render order.
    expect(rowIdsIn(sections[0] as HTMLElement, '')).toEqual(['a']);
    expect(rowIdsIn(sections[1] as HTMLElement, '')).toEqual(['d', 'e']);
    expect(rowIdsIn(sections[2] as HTMLElement, '')).toEqual(['b', 'c']);
  });

  it('Main\'s empty state points BELOW itself once every chat is claimed by a section, matching where those sections actually render', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post(chatSections({ sections: [{ id: 's1', name: 'Reviews', collapsed: false }], membership: { a: 's1' } }));
    const mainEmpty = container.querySelector('.chat-section-list')?.querySelector('.chat-section-empty');
    expect(mainEmpty?.textContent).toBe('Every open chat is in a section below.');
    expect(mainEmpty?.textContent).not.toContain('above');
  });

  it('Main carries no rename or delete control', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    const mainHeader = container.querySelector('.chat-section-header')!;
    expect(mainHeader.querySelector('.chat-section-delete-btn')).toBeNull();
    expect(mainHeader.querySelector('.chat-section-rename-btn')).toBeNull();
  });

  it('Main is the only header carrying the + create-section control', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post(chatSections({ sections: [{ id: 's1', name: 'Reviews', collapsed: false }] }));
    const [mainHeader, sectionHeader] = container.querySelectorAll('.chat-section-header');
    expect(mainHeader.querySelector('.chat-section-add-btn')).not.toBeNull();
    expect(sectionHeader.querySelector('.chat-section-add-btn')).toBeNull();
  });

  it('clicking + posts createChatSection (no optimistic row — the id is host-generated)', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await fireEvent.click(container.querySelector('.chat-section-add-btn') as HTMLElement);
    expect(posts()).toContainEqual(expect.objectContaining({ type: 'createChatSection' }));
    expect(container.querySelectorAll('.chat-section-header')).toHaveLength(1); // unchanged until the echo lands
  });

  it('the echoed chatSections reply is what actually adds the new section header', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post(chatSections({ sections: [{ id: 'sec-new', name: 'New Section', collapsed: false }] }));
    const names = headerNames(container);
    expect(names).toHaveLength(2);
    expect(names[0]).toContain('Main');
    expect(names[1]).toContain('New Section');
  });

  it('deleting a user section moves its chats back to Main and posts deleteChatSection', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a', 'b'));
    await post(chatSections({ sections: [{ id: 's1', name: 'Reviews', collapsed: false }], membership: { a: 's1' } }));
    const sectionHeader = Array.from(container.querySelectorAll('.chat-section-header')).find((h) => h.textContent?.includes('Reviews'))!;

    await fireEvent.click(sectionHeader.querySelector('.chat-section-delete-btn') as HTMLElement);

    expect(posts()).toContainEqual({ type: 'deleteChatSection', id: 's1' });
    expect(container.querySelectorAll('.chat-section-header')).toHaveLength(1); // back to just Main
    const mainList = container.querySelectorAll('.chat-section-list')[0] as HTMLElement;
    expect(rowIdsIn(mainList, '')).toEqual(['a', 'b']);
  });

  it('the pencil renames a user section and posts renameChatSection with its id', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post(chatSections({ sections: [{ id: 's1', name: 'Reviews', collapsed: false }] }));

    await fireEvent.click(screen.getByRole('button', { name: 'Rename section' }));
    const input = container.querySelector('.chat-section-rename') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'Deep work' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    expect(posts()).toContainEqual({ type: 'renameChatSection', id: 's1', name: 'Deep work' });
    expect(headerNames(container)[1]).toContain('Deep work');
  });

  it('double-clicking a user section name also opens rename, without toggling collapse', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post(chatSections({ sections: [{ id: 's1', name: 'Reviews', collapsed: false }], membership: { a: 's1' } }));
    const before = container.querySelectorAll('.chat-section-list').length;

    await fireEvent.dblClick(screen.getByTitle('Double-click to rename'));

    expect(container.querySelector('.chat-section-rename')).not.toBeNull();
    expect(posts().filter((p) => p.type === 'toggleChatSectionCollapse')).toEqual([]);
    expect(container.querySelectorAll('.chat-section-list').length).toBe(before);
  });

  it('dropping a dragged chat onto a user section header posts setChatSection with its id', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a', 'b'));
    await post(chatSections({ sections: [{ id: 's1', name: 'Reviews', collapsed: false }] }));

    const reviewsHeader = Array.from(container.querySelectorAll('.chat-section-header')).find((h) => h.textContent?.includes('Reviews'))!;
    await dragRowOnto(container, 0, reviewsHeader);

    expect(posts()).toContainEqual({ type: 'setChatSection', sessionId: 'a', section: 's1' });
  });

  it('dropping a dragged chat onto the Main header posts setChatSection with a null section (moves it back)', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a', 'b'));
    await post(chatSections({ sections: [{ id: 's1', name: 'Reviews', collapsed: false }], membership: { a: 's1' } }));

    const mainHeader = container.querySelectorAll('.chat-section-header')[0];
    // DOM order follows render order (Main first): 'b' (Main) is row 0, 'a'
    // (Reviews, rendered below) is row 1.
    await dragRowOnto(container, 1, mainHeader);

    expect(posts()).toContainEqual({ type: 'setChatSection', sessionId: 'a', section: null });
  });

  it('collapsing a section posts toggleChatSectionCollapse with its id and hides its rows without dropping them', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post(chatSections({ sections: [{ id: 's1', name: 'Reviews', collapsed: false }], membership: { a: 's1' } }));
    const sectionHeader = container.querySelectorAll('.chat-section-header')[1];
    expect(container.querySelectorAll('.chat-section-list')[1].querySelectorAll('.session-row')).toHaveLength(1);

    await fireEvent.click(sectionHeader.querySelector('.chat-section-chevron-btn') as HTMLElement);

    expect(posts()).toContainEqual({ type: 'toggleChatSectionCollapse', section: 's1' });
    // Collapsed: the section's row list no longer renders at all (not just visually hidden) — only Main's remains.
    expect(container.querySelectorAll('.chat-section-list')).toHaveLength(1);
  });

  it('the un-group button removes a chat from its section and posts setChatSection with a null section', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a', 'b'));
    await post(chatSections({ sections: [{ id: 's1', name: 'Reviews', collapsed: false }], membership: { a: 's1' } }));

    await fireEvent.click(container.querySelector('.session-ungroup-btn') as HTMLElement);

    expect(posts()).toContainEqual({ type: 'setChatSection', sessionId: 'a', section: null });
    const sectionList = container.querySelectorAll('.chat-section-list')[1] as HTMLElement;
    expect(rowIdsIn(sectionList, '')).toHaveLength(0);
    const mainList = container.querySelectorAll('.chat-section-list')[0] as HTMLElement;
    expect(rowIdsIn(mainList, '')).toContain('a');
  });

  it('a Main row (never in a section) carries no un-group button', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    expect(container.querySelector('.session-ungroup-btn')).toBeNull();
  });

  it('an orphaned membership entry (its section no longer exists on this client) lands the chat in Main, not dropped', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post(chatSections({ membership: { a: 'sec-deleted' }, sections: [] }));
    const mainList = container.querySelectorAll('.chat-section-list')[0] as HTMLElement;
    expect(rowIdsIn(mainList, '')).toEqual(['a']);
  });

  it('a membership entry naming the retired built-in "loops" lands the chat in Main too, no Loops header ever renders', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post(chatSections({ membership: { a: 'loops' }, sections: [] }));
    const headers = container.querySelectorAll('.chat-section-header');
    expect(headers).toHaveLength(1); // Main only — no Loops header materialized
    const mainList = container.querySelectorAll('.chat-section-list')[0] as HTMLElement;
    expect(rowIdsIn(mainList, '')).toEqual(['a']);
  });
});
