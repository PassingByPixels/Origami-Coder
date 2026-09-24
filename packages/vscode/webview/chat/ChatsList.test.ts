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
import SidebarLauncher from './SidebarLauncher.svelte';

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
    expect(src).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.session-ring\[data-state='working'\],\s*\.session-ring\[data-state='subagents'\]\s*\{\s*animation:\s*none;/);
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

// t-ql9ari — swipe-to-delete (A1, t-q8zfo7) misread a horizontal drag as a
// reorder attempt and was removed. The x icon is the only delete affordance
// again, and a drag never deletes — it only reorders.
describe('ChatsList — the x is the only delete affordance (t-ql9ari)', () => {
  it('imports no SwipeRow leaf and renders no swipe wrapper', () => {
    const src = readFileSync(join(__dirname, 'ChatsList.svelte'), 'utf-8');
    expect(src).not.toMatch(/SwipeRow/);
    expect(src).not.toMatch(/og-sw/);
  });

  // t-ru13hb item 2 CHANGED the second half of this: the x still needs no
  // gesture, but it no longer posts on the click. The row goes and an Undo
  // toast runs for the fuse; `closeSession` is posted when the fuse burns.
  // chatCloseUndo.test.ts owns the fuse, the undo and the commit.
  it('clicking the x takes the chat off the list with no gesture required', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await fireEvent.click(container.querySelector('.session-close') as HTMLElement);
    await tick();
    expect(container.querySelectorAll('.session-row')).toHaveLength(0);
    expect(posts().some((p) => p.type === 'closeSession'),
      'not before the undo window has passed').toBe(false);
  });

  it('a horizontal pointer drag on a row reorders it and never closes it', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a', 'b'));
    const rows = container.querySelectorAll('.session-row');

    // A horizontal drag-and-drop from row 0 onto row 1 — the exact gesture
    // that used to be misread as a swipe.
    await dragRowOnto(container, 0, rows[1]);

    expect(posts()).toContainEqual({ type: 'reorderSessions', order: ['b', 'a'] });
    expect(posts().some((p) => p.type === 'closeSession')).toBe(false);
  });
});

// lane/ring-subagents — the ring's 4th state: the chat's OWN turn ended, but a
// BACKGROUND sub-agent it launched is still out. Drives the real message
// sequence rather than calling deriveRowVisualState directly, so a wiring
// regression in the switch (wrong field name, wrong case) fails here too.
describe('ChatsList — sub-agents running ring state', () => {
  function ringState(container: HTMLElement): string | null {
    return container.querySelector('.session-ring')!.getAttribute('data-state');
  }

  it('a background sub-agent still out after the turn settles shows subagents, then ready once it finishes', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post({ type: 'echoUser', sessionId: 'a' });
    expect(ringState(container)).toBe('working');

    await post({ type: 'toolResult', sessionId: 'a', toolName: 'task', taskBackground: true, taskSessionId: 'child-a' });
    await post({ type: 'sessionStatus', status: 'idle', sessionId: 'a' });
    expect(ringState(container)).toBe('subagents');

    await post({ type: 'subagentDone', sessionId: 'a', taskSessionId: 'child-a', state: 'completed' });
    expect(ringState(container)).toBe('ready');
  });

  it('a sessionList reply already naming a running child mounts straight into subagents', async () => {
    const { container } = render(ChatsList);
    await post({ type: 'sessionList', sessions: [{ id: 'a', number: 1, agentName: 'Tsuru', title: 'a', runningChildIds: ['child-a'] }] });
    expect(ringState(container)).toBe('subagents');
  });

  it('a foreground task never enters the running set — no ring at all', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post({ type: 'toolResult', sessionId: 'a', toolName: 'task', taskBackground: false, taskSessionId: 'child-a' });
    await post({ type: 'sessionStatus', status: 'idle', sessionId: 'a' });
    expect(ringState(container)).toBe('ready');
  });

  // lane/ring-signals — the case DashboardPanel's sessionStatus fix exists
  // for: a background child finishes, the parent's own turn ended (subagents
  // showing), and then the ENGINE ITSELF starts a new turn to inject that
  // child's result (no echoUser — nobody typed this). `sessionStatus busy`
  // is the ONLY signal for that; without it the ring never spins for a turn
  // the engine started on its own. `working` outranks `subagents` while it
  // runs, and outranks it again once the child is done but the engine's own
  // turn has not settled yet — only the matching `idle` clears it.
  it('an engine-started turn (injecting a finished child) outranks subagents until its own idle lands', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    await post({ type: 'echoUser', sessionId: 'a' });
    await post({ type: 'toolResult', sessionId: 'a', toolName: 'task', taskBackground: true, taskSessionId: 'child-a' });
    await post({ type: 'turnDone', sessionId: 'a' });
    expect(ringState(container)).toBe('subagents');

    await post({ type: 'sessionStatus', status: 'busy', sessionId: 'a' });
    expect(ringState(container)).toBe('working');

    await post({ type: 'subagentDone', sessionId: 'a', taskSessionId: 'child-a', state: 'completed' });
    expect(ringState(container)).toBe('working');

    await post({ type: 'sessionStatus', status: 'idle', sessionId: 'a' });
    expect(ringState(container)).toBe('ready');
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

// The "＋ Claude Code" launcher is GONE (0.4.69). It was phase 1's entry point;
// round 2 moved the passthrough into the model picker's Labs group and the
// connections strip's CC square, so a third "new chat" button here would be a
// competing way to start the same thing.
describe('ChatsList — no Claude Code launcher', () => {
  const src = readFileSync(join(__dirname, 'ChatsList.svelte'), 'utf8');

  it('renders no Claude Code button, detected or not', async () => {
    const { container } = render(ChatsList);
    // The old detection broadcast, in case anything still listens for it.
    await post({ type: 'claudeCodeStatus', installed: true, version: '2.1.198', binary: 'C:\claude.exe' });
    expect(screen.queryByRole('button', { name: /Claude Code/i })).toBeNull();
    // New chat / History / Agents are the DOCK's now (SidebarDock.test.ts);
    // this half no longer draws a toolbar at all.
    expect(container.querySelector('.chats-toolbar')).toBeNull();
  });

  it('no longer asks the host to probe for the CLI — nothing here depends on the answer', () => {
    render(ChatsList);
    expect(posts().some((p) => p.type === 'requestClaudeCodeStatus')).toBe(false);
    // …and the dead state went with it, rather than lingering unread.
    expect(src).not.toContain('newClaudeCodeSession');
    expect(src).not.toContain('claudeCodeStatus');
  });
});

// t-hb1o0e — the popup used to sit in normal flow under the toolbar, so 8+
// sections below it got squeezed down the page and its own list got clipped
// by the scrolling column. It is now a fixed overlay: opening it must not
// move a single section, and it must close on a pick, on Escape, and on a
// click outside it — but stay open on a click inside it.
//
// Rendered through the PARENT since the toolbar became SidebarDock.svelte:
// the popup is the dock's, the sections are this half's, and the whole point
// of these cases is that one does not move the other.
describe('ChatsList — the History popup overlays the sections instead of squeezing them (t-hb1o0e)', () => {
  function eightSections(): unknown {
    return chatSections({
      sections: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `Folder ${i}`, collapsed: false })),
    });
  }

  it('opening it over 8 folders leaves every section header in place, and renders as a fixed overlay', async () => {
    render(SidebarLauncher);
    await post(sessionList('a'));
    await post(eightSections());
    const before = headerNames(document.body);

    await fireEvent.click(screen.getByRole('button', { name: /History/i }));
    await post({ type: 'historyList', sessions: [] });

    expect(headerNames(document.body)).toEqual(before);
    expect(before).toHaveLength(9); // Main + 8 folders

    // jsdom applies no CSS; the fixed-overlay rule (.hd-overlay, in
    // HistoryDropdown.svelte) is proven by HistoryDropdown.test.ts's own
    // source check. Here: the caller wired the anchor through, so the
    // modifier class landed and the DYNAMIC numbers it drives are real.
    const panel = document.querySelector('.history-dropdown') as HTMLElement;
    expect(panel.classList.contains('hd-overlay')).toBe(true);
    expect(panel.style.width).not.toBe('');
    expect(panel.style.maxHeight).not.toBe('');
  });

  it('closes on a pick', async () => {
    render(SidebarLauncher);
    await fireEvent.click(screen.getByRole('button', { name: /History/i }));
    await post({ type: 'historyList', sessions: [{ sessionId: 'o1', title: 'Parser rewrite', folder: 'origami', updatedAt: '2026-09-08T09:00:00.000Z', kind: 'origami', current: false }] });

    await fireEvent.click(document.querySelector('.history-row')!);
    expect(document.querySelector('.history-dropdown')).toBeNull();
  });

  it('closes on Escape from anywhere in the sidebar, not just the search box', async () => {
    render(SidebarLauncher);
    await fireEvent.click(screen.getByRole('button', { name: /History/i }));
    expect(document.querySelector('.history-dropdown')).not.toBeNull();

    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.history-dropdown')).toBeNull();
  });

  it('closes on a click outside it (the backdrop) and stays open on a click inside it', async () => {
    render(SidebarLauncher);
    await fireEvent.click(screen.getByRole('button', { name: /History/i }));

    await fireEvent.click(document.querySelector('.history-dropdown')!);
    expect(document.querySelector('.history-dropdown')).not.toBeNull(); // inside click — still open

    await fireEvent.click(document.querySelector('.history-backdrop')!);
    expect(document.querySelector('.history-dropdown')).toBeNull(); // outside click — closed
  });
});

// t-h4sc42 — the workspace-wide roster chip (t-dclj7z) is gone from the
// toolbar. The per-row ring (sessionRowState.ts's fourth state) is the only
// sub-agent surface the sidebar draws now; ring behaviour is covered above
// and in runningChildren.test.ts. This asserts the chip's absence across the
// states that used to draw it, not just the empty one.
describe('ChatsList — no workspace-wide sub-agent count', () => {
  const chip = (c: HTMLElement) => c.querySelector('.sa-roster') as HTMLButtonElement | null;

  /** A session list where each chat already names its running children. */
  const withChildren = (rows: Array<[string, string[]]>) => ({
    type: 'sessionList',
    sessions: rows.map(([id, children], n) => ({ id, number: n + 1, agentName: 'Tsuru', title: id, runningChildIds: children })),
  });

  it('draws no chip when nothing is out', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a', 'b'));
    expect(chip(container)).toBeNull();
  });

  it('draws no chip with children running across multiple chats', async () => {
    const { container } = render(ChatsList);
    await post(withChildren([['a', ['c1', 'c2']], ['b', ['c3']]]));
    expect(chip(container)).toBeNull();
  });

  it('draws no chip after the last child comes home either', async () => {
    const { container } = render(ChatsList);
    await post(withChildren([['a', ['c1']]]));
    await post({ type: 'subagentDone', sessionId: 'a', taskSessionId: 'c1', state: 'completed' });
    await tick();
    expect(chip(container)).toBeNull();
  });
});

// t-qmzz3q (change 29) — the status dot beside the title, the unread badge
// and the number demoted to the tooltip. Driven entirely off the real host
// messages the ring above already reacts to — no new fixture shape.
describe('ChatsList — status dot, unread badge, #n in the tooltip', () => {
  function dotState(c: HTMLElement): string | null {
    return c.querySelector('.session-dot')!.getAttribute('data-state');
  }

  it('idle at mount, running while a turn is live, asking when parked on an approval', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    expect(dotState(container)).toBe('idle');

    await post({ type: 'echoUser', sessionId: 'a' });
    expect(dotState(container)).toBe('running');

    await post({ type: 'turnDone', sessionId: 'a' });
    expect(dotState(container)).toBe('idle');

    await post({ type: 'requestPermission', sessionId: 'a', toolCallId: 't1' });
    expect(dotState(container)).toBe('asking');
  });

  it('a background sub-agent also reads as running, not idle', async () => {
    const { container } = render(ChatsList);
    await post({ type: 'sessionList', sessions: [{ id: 'a', number: 1, agentName: 'Tsuru', title: 'a', runningChildIds: ['child-a'] }] });
    expect(dotState(container)).toBe('running');
  });

  it('the number moves into the open button title, and is not drawn as text', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    expect(container.querySelector('.session-tag')).toBeNull();
    const open = container.querySelector('.session-open') as HTMLButtonElement;
    expect(open.title).toContain('#1');
  });

  it('the unread badge tracks open asks, and disappears once they resolve', async () => {
    const { container } = render(ChatsList);
    await post(sessionList('a'));
    expect(container.querySelector('.session-unread')).toBeNull();

    await post({ type: 'requestPermission', sessionId: 'a', toolCallId: 't1' });
    await post({ type: 'requestPermission', sessionId: 'a', toolCallId: 't2' });
    expect(container.querySelector('.session-unread')!.textContent).toBe('2');

    await post({ type: 'permissionAudit', toolCallId: 't1', action: 'approved' });
    expect(container.querySelector('.session-unread')!.textContent).toBe('1');

    await post({ type: 'permissionAudit', toolCallId: 't2', action: 'denied' });
    expect(container.querySelector('.session-unread')).toBeNull();
  });
});

// change 32's "+" is hover-only. CSS-SOURCE, deliberately: vitest.config.mts
// sets no `css: true`, so getComputedStyle(el).opacity would read '' here,
// not '0' — see WORKING_ON_ORIGAMI_CODER.md's jsdom-layout warning. The
// button is rendered here (Main's nameSlot extra), but the hover trigger is
// `.chat-section-header`, ChatSectionBlock.svelte's own element — hence the
// `:global()` step, same idiom the rename-btn rule above it already uses.
describe('ChatsList — the + is hover-only (change 32)', () => {
  it('opacity 0 at rest, revealed only via :global(.chat-section-header):hover/:focus-within', () => {
    const src = readFileSync(join(__dirname, 'ChatsList.svelte'), 'utf-8');
    expect(src).toMatch(/\.chat-section-add-btn\s*\{[^}]*opacity:\s*0;/);
    expect(src).toMatch(/:global\(\.chat-section-header\):hover \.chat-section-add-btn,\s*\n\s*:global\(\.chat-section-header\):focus-within \.chat-section-add-btn\s*\{\s*opacity:\s*0?\.8;/);
  });
});
