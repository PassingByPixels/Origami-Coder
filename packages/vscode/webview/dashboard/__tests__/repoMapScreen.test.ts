// The in-editor map SCREEN, rendered for real. It draws the same geometry as the
// exported artifact (both consume layoutMap()'s numbers), so what is worth
// asserting here is the part the two surfaces do NOT share: this screen's own
// state — what a click selects, what a filter removes, what folding a rail does
// to the markup, and that Export asks the host rather than trying to write a file
// from inside a webview.
//
// jsdom has NO layout engine, so nothing here can claim a rail is 214px wide or
// that folding it gave the map the space. Those are real-browser facts; the
// gesture itself needs Passing's eyes. What jsdom CAN prove is that the rail
// leaves the DOM, that the box really disappears, and that the message is posted.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import RepoMapScreen from '../panes/RepoMapScreen.svelte';
import { layoutMap } from '../../../src/dashboard/agentManager/isoLayout';
import type { RepoMap } from '../../../src/dashboard/agentManager/mapSchema';

const MAP: RepoMap = {
  version: 2,
  builtAt: { sha: 'abcdef1234567890', branch: 'main', at: 1700000000000 },
  name: 'demo',
  summary: 'a fixture app',
  nodes: [
    { id: 'cli', name: 'The CLI', pillar: 1, kind: 'entrypoint', path: 'src/cli.ts', summary: 'the way in' },
    { id: 'core', name: 'The Core', pillar: 2, kind: 'service', path: 'src/core.ts', summary: 'does the work' },
    { id: 'out', name: 'The Bundle', pillar: 5, kind: 'build', summary: 'what falls out', section: 'Output' },
  ],
  edges: [{ from: 'cli', to: 'core', label: 'invokes' }],
  flows: [{
    id: 'run', name: 'Running it', description: 'start to finish',
    steps: [{ node: 'cli', note: 'user types' }, { node: 'core', note: 'work happens' }],
  }],
  keyFiles: [{ path: 'src/core.ts', why: 'the single write path' }],
  conventions: ['one way in'],
};

function mount(map: RepoMap = MAP) {
  (window as unknown as { __ORIGAMI_REPO_MAP__: unknown }).__ORIGAMI_REPO_MAP__ = {
    root: 'C:/repo', name: map.name, map, layout: layoutMap(map),
  };
  return render(RepoMapScreen).container;
}
const boxes = (c: HTMLElement): Element[] => [...c.querySelectorAll('g.node')];
const posts = (): unknown[] => (globalThis.__vscodeApiMock.postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

beforeEach(() => { (globalThis.__vscodeApiMock.postMessage as ReturnType<typeof vi.fn>).mockClear(); });

describe('the map screen', () => {
  it('draws one solid per component and states the repo in its header', () => {
    const c = mount();
    expect(boxes(c)).toHaveLength(3);
    expect(c.textContent).toContain('demo');
    expect(c.textContent).toContain('3 components · 1 links · 1 flows');
    expect(c.textContent).toContain('main @ abcdef1');
  });

  it('shows the map INDEX until something is picked', () => {
    const c = mount();
    expect(c.textContent).toContain('About this map');
    expect(c.textContent).toContain('the single write path');   // key files
    expect(c.textContent).toContain('one way in');              // conventions
  });

  it('picking a component reads out its connections and dims the rest', async () => {
    const c = mount();
    await fireEvent.click(c.querySelector('g.node')!);
    expect(c.textContent).toContain('Connections (1)');
    expect(c.textContent).toContain('invokes');
    // `out` is wired to nothing, so it must fade; the two ends of the edge stay lit.
    expect(boxes(c).filter((b) => b.classList.contains('dim'))).toHaveLength(1);
    expect(c.querySelector('g.node.sel')).not.toBeNull();
  });

  it('spells out a component CONDITION instead of leaving a one-word badge', async () => {
    // The badge tells the reader the `status` field exists; it never tells them
    // what it is claiming. This survived the mockup port on purpose.
    const c = mount({ ...MAP, nodes: MAP.nodes.map((n) => (n.id === 'cli' ? { ...n, status: 'modified' as const } : n)) });
    await fireEvent.click(c.querySelector('g.node')!);
    expect(c.textContent).toContain('modified — it changed since the previous map was built.');
  });

  it('tracing a flow lists its steps in order and lights only that path', async () => {
    const c = mount();
    await fireEvent.click([...c.querySelectorAll('button')].find((b) => b.textContent?.includes('Running it'))!);
    const steps = [...c.querySelectorAll('.steprow')].map((r) => r.textContent);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain('The CLI');
    expect(steps[0]).toContain('user types');
    expect(c.querySelectorAll('.flowline')).toHaveLength(1);   // one hop between two steps
    expect(boxes(c).filter((b) => b.classList.contains('dim'))).toHaveLength(1);
  });

  it('a kind filter REMOVES the box, not merely fades it', async () => {
    // Fading a filtered component is the easy mistake and it defeats the purpose:
    // the point of a filter on a 63-node map is to get the clutter off the glass.
    const c = mount();
    const build = [...c.querySelectorAll('button.legend')].find((b) => b.textContent?.includes('build'))!;
    await fireEvent.click(build);
    expect(boxes(c)).toHaveLength(2);
    await fireEvent.click(build);
    expect(boxes(c)).toHaveLength(3);
  });

  it('the search matches a summary and a path, not only the name', async () => {
    const c = mount();
    const box = c.querySelector('input.search') as HTMLInputElement;
    await fireEvent.input(box, { target: { value: 'falls out' } });
    expect(boxes(c)).toHaveLength(1);
    await fireEvent.input(box, { target: { value: 'src/cli.ts' } });
    expect(boxes(c)).toHaveLength(1);
    await fireEvent.input(box, { target: { value: '' } });
    expect(boxes(c)).toHaveLength(3);
  });

  it('folding a rail takes it out of the markup entirely, and unfolds it again', async () => {
    const c = mount();
    const btn = (label: string): HTMLButtonElement =>
      [...c.querySelectorAll('button.rm-btn')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
    expect(c.querySelector('input.search')).not.toBeNull();
    await fireEvent.click(btn('Filters'));
    expect(c.querySelector('input.search')).toBeNull();
    await fireEvent.click(btn('Filters'));
    expect(c.querySelector('input.search')).not.toBeNull();
    expect(c.textContent).toContain('Repository');
    await fireEvent.click(btn('Details'));
    expect(c.textContent).not.toContain('Repository');
  });

  it('the Names toggle cycles, and Edges takes the connectors away', async () => {
    const c = mount();
    const btn = (starts: string): HTMLButtonElement =>
      [...c.querySelectorAll('button.rm-btn')].find((b) => b.textContent?.trim().startsWith(starts)) as HTMLButtonElement;
    expect(c.querySelectorAll('.links .lk')).toHaveLength(1);
    await fireEvent.click(btn('Edges'));
    expect(c.querySelectorAll('.links .lk')).toHaveLength(0);
    expect(btn('Names').textContent).toContain('auto');
    await fireEvent.click(btn('Names'));
    expect(btn('Names').textContent).toContain('all');
  });

  it('Export ASKS THE HOST to save the page — a webview cannot write a file', async () => {
    const c = mount();
    await fireEvent.click([...c.querySelectorAll('button.rm-btn')].find((b) => b.textContent?.trim() === 'Export')!);
    expect(posts()).toEqual([{ type: 'exportRepoMap', root: 'C:/repo' }]);
  });

  it('says so plainly when there is no map at all', () => {
    (window as unknown as { __ORIGAMI_REPO_MAP__: unknown }).__ORIGAMI_REPO_MAP__ = undefined;
    const { container } = render(RepoMapScreen);
    expect(container.textContent).toContain('No map to show.');
  });
});
