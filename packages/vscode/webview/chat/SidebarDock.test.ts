// SidebarDock — the seven-icon dock that replaced the Chats toolbar (New
// chat / History / Agents) and the Collabs / Front Desk / Memory section
// toggles. Mock-Redesign/CHANGES.md change 1; the icons and their order are
// sidebarDockItems.ts.
//
// The History popup and its whole wire moved here WITH the toolbar that held
// it, so the Claude-Code history cases below came across from
// ChatsList.test.ts unchanged except for what they render. They are the same
// end-to-end assertions: the host's payload in, the drawn rows out, the
// switch, and what a click on each kind posts back.
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import SidebarDock from './SidebarDock.svelte';
import { DOCK_ITEMS } from './sidebarDockItems';

const DOCK_PROPS = {
  onToggleCollabs: () => {},
  onToggleFrontDesk: () => {},
  onToggleMemory: () => {},
};

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

function items(c: HTMLElement): HTMLButtonElement[] {
  return Array.from(c.querySelectorAll('.dock-item'));
}

describe('SidebarDock — the seven items', () => {
  it('draws all seven, in the order the OWNER named (t-qhzy4k)', () => {
    const { container } = render(SidebarDock, { props: DOCK_PROPS });
    expect(items(container).map((b) => b.getAttribute('aria-label'))).toEqual([
      'New chat', 'Chat history', 'Manager', 'Memory graph', 'Front Desk', 'Collabs', 'Artifacts',
    ]);
    expect(DOCK_ITEMS).toHaveLength(7);
  });

  // CSS-SOURCE test, deliberately: vitest.config.mts sets no `css: true`, so no
  // <style> ever reaches this DOM and getComputedStyle would return ''. The
  // rule itself is the only thing here that can be asserted, and it is the
  // thing that broke: the hover pop used to lift the tile 2px and scale it
  // 1.08, which put the hovered Artifacts item 1.8px from the pill's 1px
  // border and painted its own fill across the pill's rounded corner.
  it('keeps the hover pop INSIDE the dock pill (t-qhzy4k)', () => {
    // path.resolve, NOT `new URL(..., import.meta.url)` — vite rewrites that
    // form and the read then fails on a non-file scheme.
    const here = path.dirname(fileURLToPath(import.meta.url));
    // t-qlgav5: the item's own rule moved to SidebarDockTrack.svelte, which
    // now writes that markup — Svelte scopes CSS to the file that renders
    // it. The pill's padding is still SidebarDock.svelte's own.
    const pillSrc = readFileSync(path.join(here, 'SidebarDock.svelte'), 'utf8');
    const itemSrc = readFileSync(path.join(here, 'SidebarDockTrack.svelte'), 'utf8');
    const hover = /\.dock-item:hover\s*\{([^}]*)\}/.exec(itemSrc)?.[1];
    expect(hover, '.dock-item:hover rule not found').toBeTruthy();
    // No lift: a translate spends the pill's padding, which is all the
    // clearance the tile has.
    expect(hover).not.toMatch(/translate/);
    // No spill: a glow drawn outside the box crosses the outline whatever the
    // transform does.
    expect(hover).not.toMatch(/box-shadow/);

    // And the scale that IS allowed must fit the padding the pill gives it.
    const scale = Number(/scale\(([\d.]+)\)/.exec(hover ?? '')?.[1]);
    const padY = Number(/\.dock\s*\{[^}]*padding:\s*(\d+)px/.exec(pillSrc)?.[1]);
    const itemH = Number(/\.dock-item\s*\{[^}]*height:\s*(\d+)px/.exec(itemSrc)?.[1]);
    expect(Number.isFinite(scale) && Number.isFinite(padY) && Number.isFinite(itemH)).toBe(true);
    const overhang = (itemH * scale - itemH) / 2;
    expect(overhang, `scale ${scale} overhangs ${overhang}px into ${padY}px of padding`).toBeLessThan(padY);
  });

  it('draws no divider — the row is unbroken (t-qhzy4k)', () => {
    const { container } = render(SidebarDock, { props: DOCK_PROPS });
    expect(container.querySelector('.dock-sep')).toBeNull();
    expect(JSON.stringify(DOCK_ITEMS)).not.toContain('divider');
  });

  it('every item carries a label for the warm tooltip and no native title to fight it', () => {
    const { container } = render(SidebarDock, { props: DOCK_PROPS });
    for (const b of items(container)) {
      expect(b.getAttribute('aria-label')).toBeTruthy();
      // Two tooltips on one control is the bug the port was warned about.
      expect(b.getAttribute('title')).toBeNull();
    }
  });

  it('New chat and Manager post exactly what the old toolbar buttons posted', async () => {
    const { container } = render(SidebarDock, { props: DOCK_PROPS });
    await fireEvent.click(items(container)[0]);
    expect(posts()).toContainEqual({ type: 'newSession' });
    await fireEvent.click(items(container)[2]);
    expect(posts()).toContainEqual({ type: 'openAgentManager' });
  });

  // t-rz4555: the placeholder got its surface. Two messages, one intent — the
  // shape the Front Desk's Open Flock link uses: open the board tab, then name
  // the view. The section request survives a board that has not attached yet
  // (BoardShell's own boardReady handshake replays it).
  it('Artifacts opens the board AND names the Artifacts view', async () => {
    const { container } = render(SidebarDock, { props: DOCK_PROPS });
    await fireEvent.click(items(container)[6]);
    expect(posts()).toEqual([
      { type: 'openAgentManager' },
      { type: 'openBoardSection', section: 'artifacts' },
    ]);
    expect(items(container)[6].getAttribute('aria-label')).toBe('Artifacts');
  });

  it('badges the unopened arrivals the host counted, and clears them on the click', async () => {
    const { container } = render(SidebarDock, { props: DOCK_PROPS });
    await post({ type: 'artifactsBadge', count: 3 });
    const badge = () => items(container)[6].querySelector('.dock-badge');
    expect(badge()!.textContent).toBe('3');

    await fireEvent.click(items(container)[6]);
    // Cleared on the click itself: the pane may take a second to attach, and a
    // badge still showing 3 over an open list is a badge nobody trusts again.
    expect(badge()).toBeNull();
  });

  it('the three section items call the parent rather than posting anything', async () => {
    const spies = { collabs: vi.fn(), frontDesk: vi.fn(), memory: vi.fn() };
    const { container } = render(SidebarDock, {
      props: {
        onToggleCollabs: spies.collabs,
        onToggleFrontDesk: spies.frontDesk,
        onToggleMemory: spies.memory,
      },
    });
    await fireEvent.click(items(container)[3]);
    await fireEvent.click(items(container)[4]);
    await fireEvent.click(items(container)[5]);
    expect(spies.collabs).toHaveBeenCalledTimes(1);
    expect(spies.frontDesk).toHaveBeenCalledTimes(1);
    expect(spies.memory).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
  });

  it('an open section reads as pressed, so the dock shows what is already showing', () => {
    const { container } = render(SidebarDock, { props: { ...DOCK_PROPS, collabsOpen: true, memoryOpen: true } });
    const pressed = items(container).filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed.map((b) => b.getAttribute('aria-label'))).toEqual(['Memory graph', 'Collabs']);
  });

  it('the open item also carries is-on, which is what change 31\'s underline dot keys on', () => {
    const { container } = render(SidebarDock, { props: { ...DOCK_PROPS, collabsOpen: true } });
    const collabs = items(container).find((b) => b.getAttribute('aria-label') === 'Collabs')!;
    expect(collabs.classList.contains('is-on')).toBe(true);
    const newChat = items(container).find((b) => b.getAttribute('aria-label') === 'New chat')!;
    expect(newChat.classList.contains('is-on')).toBe(false);
  });

  // CSS-SOURCE: no `css: true` in vitest.config.mts, so the ::after dot's
  // paint cannot be read back from jsdom — see WORKING_ON_ORIGAMI_CODER.md.
  it('change 31\'s underline dot is a no-node ::after, so it survives a re-render', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, 'SidebarDockTrack.svelte'), 'utf8');
    expect(src).toMatch(/\.dock-item\.is-on::after\s*\{[^}]*content:\s*'';[^}]*border-radius:\s*50%;[^}]*background:\s*var\(--og-chat\);/);
  });

  it('the Front Desk badge shows a waiting count and NOTHING at zero', () => {
    const none = render(SidebarDock, { props: { ...DOCK_PROPS, frontDeskCount: 0 } });
    expect(none.container.querySelector('.dock-badge')).toBeNull();
    cleanup();
    const some = render(SidebarDock, { props: { ...DOCK_PROPS, frontDeskCount: 3 } });
    expect(some.container.querySelector('.dock-badge')!.textContent).toBe('3');
  });

  it('the host can still open the History popup with showHistory', async () => {
    render(SidebarDock, { props: DOCK_PROPS });
    await post({ type: 'showHistory' });
    expect(posts()).toContainEqual({ type: 'requestHistory' });
    expect(document.querySelector('.history-dropdown')).not.toBeNull();
  });
});

// t-463pb6 — the History popup lists Claude Code's own past chats beside
// Origami's. This is the whole surface end to end: the host's payload in, the
// drawn rows out, the switch, and what a click on each kind posts back.
//
// The REMEMBERED half is asserted across a full unmount/remount rather than a
// re-render. A flag held only in component state passes a re-render and fails
// the reload, and the reload is the case the user meets — VS Code destroys this
// webview whenever the sidebar is hidden.
describe('SidebarDock — Claude Code rows in the History popup', () => {
  const MIXED = {
    type: 'historyList',
    sessions: [
      { sessionId: 'o1', title: 'Parser rewrite', folder: 'origami', updatedAt: '2026-09-08T09:00:00.000Z', kind: 'origami', current: false },
      { sessionId: 'c1', title: 'Terrain shader', folder: 'aetheron', updatedAt: '2026-09-09T09:00:00.000Z', kind: 'claude', cwd: 'C:\\ws\\aetheron', turns: 12 },
    ],
  };

  /** The webview state blob really persisting across a remount, which is what
   *  vscode.getState/setState does in a live panel. */
  function persistentState(): { value: unknown } {
    const held: { value: unknown } = { value: undefined };
    globalThis.__vscodeApiMock.getState.mockImplementation(() => held.value);
    globalThis.__vscodeApiMock.setState.mockImplementation((next: unknown) => { held.value = next; });
    return held;
  }

  async function openHistory(): Promise<void> {
    await fireEvent.click(screen.getByRole('button', { name: /History/i }));
    await post(MIXED);
  }

  function titles(): string[] {
    return Array.from(document.querySelectorAll('.history-row .history-title')).map((n) => n.textContent ?? '');
  }

  afterEach(() => {
    globalThis.__vscodeApiMock.getState.mockReset();
    globalThis.__vscodeApiMock.setState.mockReset();
  });

  it('lists both kinds and marks only the Claude one', async () => {
    persistentState();
    render(SidebarDock, { props: DOCK_PROPS });
    await openHistory();

    expect(titles()).toEqual(['Parser rewrite', 'Terrain shader']);
    const rows = document.querySelectorAll('.history-row');
    expect(rows[0].querySelector('.history-mark')).toBeNull();
    expect(rows[1].querySelector('.history-mark')!.textContent).toBe('CC');
  });

  it('the switch hides the Claude row and leaves the Origami one alone', async () => {
    persistentState();
    render(SidebarDock, { props: DOCK_PROPS });
    await openHistory();
    await fireEvent.click(document.querySelector('.kind-toggle') as HTMLButtonElement);
    await tick();

    expect(titles()).toEqual(['Parser rewrite']);
  });

  it('remembers hidden across a webview reload, not just a re-render', async () => {
    persistentState();
    const first = render(SidebarDock, { props: DOCK_PROPS });
    await openHistory();
    await fireEvent.click(document.querySelector('.kind-toggle') as HTMLButtonElement);
    await tick();
    first.unmount();

    render(SidebarDock, { props: DOCK_PROPS });
    await openHistory();

    expect(titles()).toEqual(['Parser rewrite']);
    expect((document.querySelector('.kind-toggle') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
  });

  it('recalls an Origami row and RESUMES a Claude one, with its own folder', async () => {
    persistentState();
    render(SidebarDock, { props: DOCK_PROPS });
    await openHistory();
    await fireEvent.click(document.querySelectorAll('.history-row')[1]);

    expect(posts()).toContainEqual({
      type: 'openClaudeHistory', claudeSessionId: 'c1', cwd: 'C:\\ws\\aetheron', title: 'Terrain shader',
    });

    await openHistory();
    await fireEvent.click(document.querySelectorAll('.history-row')[0]);

    expect(posts()).toContainEqual({ type: 'recallSession', sessionId: 'o1' });
  });
});

// t-5nmtva — a work laptop reported "History finds no Claude Code sessions" and
// the report could not be acted on, because the popup never said what it had
// read. End to end here: the host's facts in, the diagnostic line out.
describe('SidebarDock — the History popup says what it scanned when no Claude row came back', () => {
  const SCANNED = {
    type: 'historyList',
    sessions: [
      { sessionId: 'o1', title: 'Parser rewrite', folder: 'origami', updatedAt: '2026-09-08T09:00:00.000Z', kind: 'origami', current: false },
    ],
    claudeScan: {
      root: 'C:\\Users\\jane_doe\\.claude\\projects',
      seen: 12,
      keys: ['c--users-jane-doe-downloads-test-rig'],
    },
  };

  function note(): string {
    return document.querySelector('[data-testid="history-note"]')?.textContent ?? '';
  }

  it('names the root, the folder count and the key it looked for', async () => {
    render(SidebarDock, { props: DOCK_PROPS });
    await fireEvent.click(screen.getByRole('button', { name: /History/i }));
    await post(SCANNED);

    expect(note()).toContain('C:\\Users\\jane_doe\\.claude\\projects');
    expect(note()).toContain('12 project folders');
    expect(note()).toContain('c--users-jane-doe-downloads-test-rig');
    // The Origami row is untouched — this is a footer, not an empty state.
    expect(document.querySelectorAll('.history-row')).toHaveLength(1);
  });

  it('stays quiet once a Claude row IS listed', async () => {
    render(SidebarDock, { props: DOCK_PROPS });
    await fireEvent.click(screen.getByRole('button', { name: /History/i }));
    await post({
      ...SCANNED,
      sessions: [
        ...SCANNED.sessions,
        { sessionId: 'c1', title: 'Terrain shader', folder: 'aetheron', updatedAt: '2026-09-09T09:00:00.000Z', kind: 'claude', cwd: 'C:\\ws\\aetheron' },
      ],
    });

    expect(document.querySelector('[data-testid="history-note"]')).toBeNull();
  });
});

