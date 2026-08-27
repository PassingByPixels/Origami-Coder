// The Labels control driven through the REAL pane.
//
// wikiGraphLabels.test.ts pins the decision; this pins that the pane asks it.
// A pane that kept its own inline chain of conditionals would pass every test
// in the leaf's suite while showing the old three states on screen — so the
// assertions here are the ones a user could see: the words on the button, and
// whether the legend strip under the canvas is still in the document.
//
// Canvas text cannot be asserted here: jsdom has no 2d context, so render()
// returns at its `if (!ctx)` guard and nothing is ever painted. The canvas
// half of each state is covered by drawsNodeLabel in the leaf's suite.

import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { describe, expect, it, afterEach } from 'vitest';
import { tick } from 'svelte';
import WikiSearchPane from './WikiSearchPane.svelte';

afterEach(() => {
  cleanup();
  globalThis.__vscodeApiMock.postMessage.mockClear();
  globalThis.__vscodeApiMock.setState.mockClear();
});

// Shaped like WorkspaceReader.readWikiPagesFromDir output (src/workspace/
// WorkspaceReader.ts): id is the path relative to wiki/, namespace is its
// dirname with a trailing slash, links are RAW targets the graph resolves.
const PAGES = [
  { id: 'pages/alpha.md', title: 'Alpha', namespace: 'pages/', updated: '2026-01-01', snippet: 'first', tags: ['core'], content: '', links: ['Beta'] },
  { id: 'pages/projects/beta.md', title: 'Beta', namespace: 'pages/projects/', updated: '2026-01-02', snippet: 'second', tags: ['core', 'ui'], content: '', links: [] },
];

async function mountWithPages() {
  const view = render(WikiSearchPane);
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'workspaceData', data: { wikiPages: PAGES } },
  }));
  await tick();
  return view;
}

const labelsButton = (c: HTMLElement) =>
  [...c.querySelectorAll('button.action-btn')].find((b) => b.textContent?.startsWith('Labels:')) as HTMLButtonElement;

describe('Labels control — four states, and only one of them is silent', () => {
  it('cycles Hubs -> All -> None -> Clean -> Hubs on the button itself', async () => {
    const { container } = await mountWithPages();
    const btn = labelsButton(container);
    const seen = [btn.textContent?.trim()];
    for (let i = 0; i < 4; i++) {
      await fireEvent.click(btn);
      await tick();
      seen.push(labelsButton(container).textContent?.trim());
    }
    expect(seen).toEqual(['Labels: Hubs', 'Labels: All', 'Labels: None', 'Labels: Clean', 'Labels: Hubs']);
  });

  it('keeps the legend strip through Hubs, All and None, and removes it in Clean', async () => {
    const { container } = await mountWithPages();
    const btn = labelsButton(container);
    const legendAt: Record<string, boolean> = {};
    for (const state of ['Hubs', 'All', 'None', 'Clean']) {
      legendAt[state] = !!container.querySelector('.graph-legend');
      if (state !== 'Clean') { await fireEvent.click(btn); await tick(); }
    }
    expect(legendAt).toEqual({ Hubs: true, All: true, None: true, Clean: false });
  });

  it('brings the legend back on the next click, so Clean is not a trap', async () => {
    const { container } = await mountWithPages();
    const btn = labelsButton(container);
    for (let i = 0; i < 3; i++) { await fireEvent.click(btn); await tick(); }
    expect(container.querySelector('.graph-legend')).toBeNull();
    await fireEvent.click(btn);
    await tick();
    expect(container.querySelector('.graph-legend')).not.toBeNull();
  });

  it('leaves every control reachable in Clean — the way back out is still on screen', async () => {
    // Clean hides readouts, never controls. Hiding the button row would strand
    // the user in a state whose whole point is that nothing on it is readable.
    const { container } = await mountWithPages();
    const btn = labelsButton(container);
    for (let i = 0; i < 3; i++) { await fireEvent.click(btn); await tick(); }
    expect(labelsButton(container).textContent?.trim()).toBe('Labels: Clean');
    expect(container.querySelectorAll('button.action-btn').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector('.search-input')).not.toBeNull();
    expect(container.querySelectorAll('.zoom-btn').length).toBe(3);
  });

  it('persists the new state so a collapse/expand does not silently drop it', async () => {
    const { container } = await mountWithPages();
    const btn = labelsButton(container);
    for (let i = 0; i < 3; i++) { await fireEvent.click(btn); await tick(); }
    const saved = globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0] as
      { memoryGraph?: { labelMode?: string } } | undefined;
    expect(saved?.memoryGraph?.labelMode).toBe('clean');
  });
});
