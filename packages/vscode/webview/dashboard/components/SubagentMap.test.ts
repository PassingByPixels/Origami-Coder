// SubagentMap.test.ts — the live agent map, rendered from a three-agent
// roster: the left-to-right tree draws, a node opens its own transcript,
// Escape and the close button both dismiss.
//
// Direct-render, the precedent the rest of this family set (SubagentRow.test.ts,
// SubagentDrawer.test.ts). The LAYOUT maths is subagentMapNodes.test.ts's; this
// asserts the part only a render can: that every node reached the DOM, that a
// click reports the row the user aimed at, and that the two dismissals work.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SubagentMap from './SubagentMap.svelte';
import { row, tokens } from '../panes/subagentRowFixture';

afterEach(() => cleanup());

const THREE = [
  row({ key: 'c1', description: 'audit the bundle', agentType: 'scout', ordinal: 1, model: 'openrouter/qwen3-coder', elapsedMs: 125_000, tokens: tokens() }),
  row({ key: 'c2', description: 'write the tests', ordinal: 2, state: 'queued', elapsedMs: 0 }),
  row({ key: 'c3', description: 'never spawned', ordinal: 3, state: 'failed', settled: true, taskSessionId: undefined, elapsedMs: 0 }),
];

function open(over: { onOpen?: (key: string) => void; onClose?: () => void } = {}) {
  const { container } = render(SubagentMap, {
    rows: THREE,
    title: '#3 coder: hardening',
    onOpen: over.onOpen ?? (() => {}),
    onClose: over.onClose ?? (() => {}),
  });
  return container;
}

const names = (c: HTMLElement) => [...c.querySelectorAll('.sm-name')].map((n) => n.textContent);

describe('SubagentMap — the tree', () => {
  it('draws the chat hub, rounded-rectangle and unabbreviated, and one node per sub-agent', () => {
    const c = open();
    // The hub is a bordered BOX now (.sm-hub-box styles it a rounded rectangle
    // in real CSS — jsdom has no layout engine, so this checks the class is
    // there, not the computed radius: docs/WORKING_ON_ORIGAMI_CODER.md Part 6),
    // not a bare label floating over a bare SVG circle (t-f6uvu5) — no circle
    // left to find at all.
    expect(c.querySelector('.sm-hub-box')).not.toBeNull();
    expect(c.querySelector('.sm-hub-name')?.textContent).toBe('#3 coder: hardening');
    expect(c.querySelectorAll('circle.sm-hub')).toHaveLength(0);
    expect(names(c)).toEqual(['scout · T1 · audit the bundle', 'T2 · write the tests', 'T3 · never spawned']);
    // One spoke per node, so nothing is drawn floating off the hub.
    expect(c.querySelectorAll('.sm-spoke')).toHaveLength(3);
  });

  it('labels the Running and Error bands — this fixture has no Done row', () => {
    // THREE is running, queued (both Running) then failed (Error) — the group
    // order the ticket names, with no Done band to draw for this fixture.
    const c = open();
    expect([...c.querySelectorAll('.sm-group-label')].map((l) => l.textContent)).toEqual(['Running', 'Error']);
  });

  // t-di35mj's own acceptance: a 25-agent fixture must still render — every
  // card mounts and the SCROLLING canvas grows past the panel rather than
  // cramming 25 nodes onto a fixed ring (subagentMapNodes.test.ts proves the
  // maths; this proves the component actually reaches for it).
  it('a 25-agent roster mounts every card and grows the scroll canvas', () => {
    const twentyFive = Array.from({ length: 25 }, (_, i) => row({ key: `k${i}`, title: `agent ${i}` }));
    const { container } = render(SubagentMap, { rows: twentyFive, title: 'big fan-out', onOpen: () => {}, onClose: () => {} });
    expect(container.querySelectorAll('.sm-card')).toHaveLength(25);
    const canvas = container.querySelector('.sm-canvas') as HTMLElement;
    // The old star's fixed square was a 100-unit viewBox at 5px/unit = 500px;
    // 25 stacked nodes need noticeably more than that.
    expect(parseInt(canvas.style.height, 10)).toBeGreaterThan(500);
  });

  it('a node carries its state, its time, its tokens AND its model on the card, as three rows (t-f9jxl1)', () => {
    const c = open();
    const first = c.querySelectorAll('.sm-card')[0];
    expect(first.querySelector('.sm-dot')?.className).toContain('sm-running');
    expect(first.textContent).toContain('2m 05s');
    expect(first.textContent).toContain('14.5k tokens');
    // The card widened to fit a third line: the model is back on the face,
    // mirroring the drawer row's own identity/tokens+elapsed/model layout —
    // AND still named in the tooltip, for a model string long enough to clip.
    expect(first.querySelector('.sm-model')?.textContent).toBe('openrouter/qwen3-coder');
    expect(first.getAttribute('title')).toContain('openrouter/qwen3-coder');
  });

  it('a node with no model renders no third line at all', () => {
    const c = open();
    const queued = c.querySelectorAll('.sm-card')[1]; // c2 — no model on the fixture
    expect(queued.querySelector('.sm-model')).toBeNull();
  });

  it('no longer prints the sub-agent count in the header — the description already says it', () => {
    const c = open();
    expect(c.querySelector('.sm-sub')).toBeNull();
    expect(c.querySelector('.sm-title')?.textContent).toBe('Agent map');
  });
});

describe('SubagentMap — opening a node', () => {
  it('clicking a node reports THAT row, not the first one', () => {
    const onOpen = vi.fn();
    const c = open({ onOpen });
    fireEvent.click(c.querySelectorAll('.sm-card')[1] as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith('c2');
  });

  it('a spawn with no child session is not clickable at all', () => {
    // There is no transcript behind it. A disabled control says so; one that
    // opened an empty page would not.
    const c = open();
    expect((c.querySelectorAll('.sm-card')[2] as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('SubagentMap — dismissing it', () => {
  it('the close button dismisses', () => {
    const onClose = vi.fn();
    fireEvent.click(open({ onClose }).querySelector('.sm-close') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape dismisses, from anywhere in the window', () => {
    // On `window` rather than the panel: the panel is not focusable, so a
    // key handler that needed focus would be a shortcut that never fires.
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('another key does nothing', () => {
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.keyDown(window, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
