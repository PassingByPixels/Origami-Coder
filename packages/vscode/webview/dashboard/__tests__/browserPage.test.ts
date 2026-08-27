// browserPage.test.ts — the reveal that runs before a page verb.
//
// THE FIXTURE IS THE POINT, as in its two siblings. The page-list lines below
// are VS Code's own format, from `Lcn` in the 1.132.0 bundle:
//
//   `${indent}- [${id}] ${title} (${url}) (active|visible|not visible)`
//
// and the three states are not decoration — the same function computes them as
//
//   let t = editorService.activeEditor, i = new Set(editorService.visibleEditors);
//   … a === t ? " (active)" : i.has(a) ? " (visible)" : " (not visible)"
//
// which is exactly why this file trusts them: they ARE the editor render state,
// reported by the service a reveal moves. If that format changes, re-derive
// these strings from the bundle rather than editing them to fit.
//
// The reveal target is equally derived: `oy.forId(id)` builds
// `URI.from({scheme: "vscode-browser", path: "/" + id})`, and the browser
// editor is registered for `vscode-browser:/**` as `exclusive` +
// `singlePerResource`, so `vscode.open` on that uri reveals the tab it already
// has. The assertion below is on that uri, because a reveal that opens some
// OTHER resource is the failure this suite exists to catch.

import { describe, expect, it, beforeEach, vi } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    executed: [] as unknown[][],
    executeThrows: undefined as string | undefined,
    invokeResults: {} as Record<string, unknown>,
  },
}));

vi.mock('vscode', () => ({
  Uri: {
    // Mirrors `URI.from` closely enough to assert on: scheme + path, stringified
    // the way the workbench would read it back.
    from: (c: { scheme: string; path: string }) => ({ scheme: c.scheme, path: c.path, toString: () => `${c.scheme}:${c.path}` }),
  },
  commands: {
    executeCommand: async (...args: unknown[]) => {
      fake.executed.push(args);
      if (fake.executeThrows) throw new Error(fake.executeThrows);
    },
  },
  workspace: { getConfiguration: () => ({ get: () => false }) },
  lm: {
    get tools() {
      return [];
    },
    invokeTool: async (name: string) => fake.invokeResults[name],
  },
}));

import { lookupPage, planReveal, screenNote } from '../../../src/browserPage';
import type { ListedPage } from '../../../src/browserResult';

const SHIPPED_TOOLS = ['list_browser_pages', 'read_page', 'click_element'];

/** `list_browser_pages` output, in VS Code's own wording and line format. */
function pageList(pages: { id: string; title: string; url: string; state: string }[]) {
  const head =
    'The following browser pages are currently shared with you and can be interacted with using the browser tools:\n' +
    pages.map((p) => `- [${p.id}] ${p.title} (${p.url}) (${p.state})`).join('\n');
  return { content: [{ value: head }] };
}

function listed(state: ListedPage['state'], id = 'page-1'): ListedPage[] {
  return [{ id, state }];
}

beforeEach(() => {
  fake.executed = [];
  fake.executeThrows = undefined;
  fake.invokeResults = {};
});

describe('planReveal — the decision, off VS Code’s own three states', () => {
  it('a page listed "not visible" is a background editor tab, so it is revealed', () => {
    expect(planReveal(listed('not visible'), 'page-1')).toEqual({ act: 'reveal' });
  });

  it('an ACTIVE page is left alone — it is already the editor on screen', () => {
    expect(planReveal(listed('active'), 'page-1')).toEqual({ act: 'rendered', state: 'active' });
  });

  it('a VISIBLE page is left alone too, and that is the interesting one', () => {
    // "visible" means the page IS in editorService.visibleEditors — the active
    // editor of some other group. It has layout, which is all Playwright's
    // actionability check needs; it does not need focus. Revealing it anyway
    // would take the user's cursor out of whatever they are typing in, on every
    // verb, to fix nothing. A change that reveals on "not active" instead of on
    // "not visible" turns this red.
    expect(planReveal(listed('visible'), 'page-1')).toEqual({ act: 'rendered', state: 'visible' });
  });

  it('an id VS Code did NOT list is never revealed', () => {
    // Not cosmetic. The editor resolver's createEditorInput runs
    // `getOrCreateLazy(id)`, so `vscode.open` on an id that has no page OPENS A
    // BLANK ONE. This branch is what stops a future caller that takes a page id
    // from the model — rather than from list_browser_pages — spraying empty
    // browser tabs across the user's editor.
    expect(planReveal(listed('active', 'page-1'), 'page-9')).toEqual({ act: 'unlisted' });
    expect(planReveal([], 'page-1')).toEqual({ act: 'unlisted' });
  });
});

describe('screenNote — what a FAILURE is told about where the page was', () => {
  it('a revealed page says it was hidden and was brought forward', () => {
    const note = screenNote({ act: 'reveal' }, 'page-1');
    expect(note).toContain('"not visible"');
    expect(note).toContain('brought to the front');
  });

  it('a rendered page rules the container OUT, by name and state', () => {
    // This is the sentence that would have saved round 2: it tells the model
    // the hidden-tab theory is dead and the selector is the remaining suspect.
    const note = screenNote({ act: 'rendered', state: 'active' }, 'page-1');
    expect(note).toContain('already on screen');
    expect(note).toContain('"active"');
    expect(note).toContain('hidden tab is not the cause');
  });

  it('a reveal that THREW says so, and never claims the page was brought forward', () => {
    const note = screenNote({ act: 'reveal' }, 'page-1', new Error('command not found'));
    expect(note).toContain('could NOT be brought to the front');
    expect(note).toContain('command not found');
    expect(note).not.toContain('so it was brought to the front before this ran');
  });

  it('an unlisted page is named in the failure, id and all', () => {
    expect(screenNote({ act: 'unlisted' }, 'page-9')).toContain('Page page-9 was not in');
  });
});

describe('lookupPage — the reveal actually reaching VS Code', () => {
  it('opens the page’s editor resource, once, when the page is not visible', async () => {
    fake.invokeResults = {
      list_browser_pages: pageList([{ id: '8f1c-aaa', title: 'Origami', url: 'https://a.test/', state: 'not visible' }]),
    };
    const found = await lookupPage(SHIPPED_TOOLS);
    expect(found.pageId).toBe('8f1c-aaa');
    expect(fake.executed).toHaveLength(1);
    expect(fake.executed[0][0]).toBe('vscode.open');
    expect(String((fake.executed[0][1] as { toString(): string }).toString())).toBe('vscode-browser:/8f1c-aaa');
    expect(found.screen).toContain('brought to the front');
  });

  it('opens NOTHING when the page is already on screen', async () => {
    fake.invokeResults = {
      list_browser_pages: pageList([{ id: 'front', title: 'App', url: 'https://app.test/', state: 'active' }]),
    };
    const found = await lookupPage(SHIPPED_TOOLS);
    expect(fake.executed).toEqual([]);
    expect(found.screen).toContain('already on screen');
  });

  it('reveals the page it CHOSE, not the first one listed', async () => {
    // choosePageId ranks active > visible > not visible, so with no page active
    // the visible one is driven — and it is the one that must not be revealed.
    fake.invokeResults = {
      list_browser_pages: pageList([
        { id: 'bg', title: 'Docs', url: 'https://docs.test/', state: 'not visible' },
        { id: 'front', title: 'App', url: 'https://app.test/', state: 'visible' },
      ]),
    };
    const found = await lookupPage(SHIPPED_TOOLS);
    expect(found.pageId).toBe('front');
    expect(fake.executed).toEqual([]);
  });

  it('a reveal that throws does not swallow the verb — it becomes a sentence', async () => {
    // The reveal is best effort by design. VS Code renaming or dropping
    // `vscode.open` must degrade to a worse click, never to no click at all.
    fake.executeThrows = 'command "vscode.open" not found';
    fake.invokeResults = {
      list_browser_pages: pageList([{ id: 'bg', title: 'Docs', url: 'https://docs.test/', state: 'not visible' }]),
    };
    const found = await lookupPage(SHIPPED_TOOLS);
    expect(found.pageId).toBe('bg');
    expect(found.screen).toContain('could NOT be brought to the front');
    expect(found.screen).toContain('not found');
  });

  it('no list tool means no lookup and no reveal', async () => {
    const found = await lookupPage(['read_page']);
    expect(found).toEqual({ unshared: 0 });
    expect(fake.executed).toEqual([]);
  });
});
