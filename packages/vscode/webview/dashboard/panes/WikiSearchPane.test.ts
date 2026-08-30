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
  // getState is a shared global mock: a restore test that leaves a return value
  // on it would silently pre-load every later mount in this file.
  globalThis.__vscodeApiMock.getState.mockReset();
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

const previewToggle = (c: HTMLElement) => c.querySelector('.preview-toggle') as HTMLButtonElement;

// Select a page the way a user can in jsdom: filter, then click the result
// card. The canvas route (click a node) is unavailable here — getBoundingClientRect
// returns zeros and render() bails without a 2d context — but it lands on the
// same selectPage(), which is what the preview reads.
async function selectAlpha(container: HTMLElement) {
  const input = container.querySelector('.search-input') as HTMLInputElement;
  await fireEvent.input(input, { target: { value: 'Alpha' } });
  await tick();
  await fireEvent.click(container.querySelector('.search-card') as HTMLButtonElement);
  await tick();
}

// The read box used to be unconditional: a 200px slab under the graph, holding
// that height even in its "Select a node or page to preview" empty state. In the
// 380px sidebar host that was over half the pane spent on nothing. These pin the
// collapsed default and the one click that undoes it.
describe('Page preview — collapsed by default, one click to open', () => {
  it('costs a single header row and nothing else on a fresh mount', async () => {
    const { container } = await mountWithPages();
    expect(container.querySelector('.preview')).toBeNull();
    // No handle either: a divider with nothing under it is a control that does
    // nothing, and it carried the same 7px the header row now uses honestly.
    expect(container.querySelector('.resize-handle')).toBeNull();
    expect(previewToggle(container)).not.toBeNull();
    expect(previewToggle(container).getAttribute('aria-expanded')).toBe('false');
  });

  // The stored height is 100, not the 200 default: clampPreview() measures the
  // pane, and jsdom reports every element 0 tall, so anything above its 120px
  // floor is clamped there and a `200` assertion would prove only the clamp.
  it('opens on a click, at the PERSISTED height, with the resize handle back', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ memoryGraph: { previewH: 100 } });
    const { container } = await mountWithPages();
    await fireEvent.click(previewToggle(container));
    await tick();
    const box = container.querySelector('.preview') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.getAttribute('style')).toContain('height: 100px');
    expect(container.querySelector('.resize-handle')).not.toBeNull();
    expect(previewToggle(container).getAttribute('aria-expanded')).toBe('true');
  });

  it('shuts again on a second click — the header is not a one-way door', async () => {
    const { container } = await mountWithPages();
    await fireEvent.click(previewToggle(container));
    await tick();
    await fireEvent.click(previewToggle(container));
    await tick();
    expect(container.querySelector('.preview')).toBeNull();
    expect(container.querySelector('.resize-handle')).toBeNull();
  });

  // The tempting shortcut is to expand on selection. It makes the pane's height
  // jump whenever a click lands on a node, which is exactly the unpredictable
  // space use the collapse was for. The header names the page instead.
  it('names the selected page in the header WITHOUT opening the box', async () => {
    const { container } = await mountWithPages();
    await selectAlpha(container);
    expect(container.querySelector('.preview')).toBeNull();
    expect(previewToggle(container).textContent).toContain('Alpha');
  });

  it('shows that page once the header is clicked', async () => {
    const { container } = await mountWithPages();
    await selectAlpha(container);
    await fireEvent.click(previewToggle(container));
    await tick();
    expect(container.querySelector('.preview-title')?.textContent).toBe('Alpha');
    expect(container.querySelector('.empty-preview')).toBeNull();
  });

  it('keeps the empty-state wording when opened with nothing selected', async () => {
    const { container } = await mountWithPages();
    await fireEvent.click(previewToggle(container));
    await tick();
    expect(container.querySelector('.empty-preview')?.textContent).toContain('Select a node or page to preview');
  });

  it('persists the open state in the same memoryGraph bag as previewH', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ memoryGraph: { previewH: 100 } });
    const { container } = await mountWithPages();
    await fireEvent.click(previewToggle(container));
    const saved = globalThis.__vscodeApiMock.setState.mock.calls.at(-1)?.[0] as
      { memoryGraph?: { previewCollapsed?: boolean; previewH?: number } } | undefined;
    expect(saved?.memoryGraph?.previewCollapsed).toBe(false);
    // The neighbouring field must survive the write — this bag is merged, not
    // replaced, and dropping previewH would silently reset a dragged height.
    expect(saved?.memoryGraph?.previewH).toBe(100);
  });

  it('restores an OPEN box from stored state', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ memoryGraph: { previewCollapsed: false } });
    const { container } = await mountWithPages();
    expect(container.querySelector('.preview')).not.toBeNull();
  });

  // State written by a build that predates the toggle has no such field. It must
  // read as collapsed, not as the old always-open behaviour.
  it('treats an absent previewCollapsed as collapsed', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ memoryGraph: { previewH: 260, labelMode: 'all' } });
    const { container } = await mountWithPages();
    expect(container.querySelector('.preview')).toBeNull();
    expect(previewToggle(container)).not.toBeNull();
  });
});

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
