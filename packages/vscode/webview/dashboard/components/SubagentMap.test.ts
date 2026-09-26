// SubagentMap.test.ts — the live agent map (t-z1xlfy, the mockup's "Sub-agents
// pull-out and agent map"). The GEOMETRY is agentMapLayout.test.ts's (jsdom has
// no layout); this asserts what only a render can: every agent, tier and chip
// reaches the DOM at the model's place, the head counts, the zoom controls, the
// pan, and the dismissals.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SubagentMap from './SubagentMap.svelte';
import { row, tokens } from '../panes/subagentRowFixture';
import type { AgentTreeData, TreeTask } from '../panes/agentTree';
import type { RosterRow } from '../panes/chatHistory';
import type { SubagentRow } from '../panes/subagentRows';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const THREE = [
  row({ key: 'c1', taskSessionId: 'c1', description: 'audit the bundle', agentType: 'scout', ordinal: 1, model: 'openrouter/qwen3-coder', elapsedMs: 125_000, tokens: tokens() }),
  row({ key: 'c2', taskSessionId: 'c2', description: 'write the tests', ordinal: 2, state: 'done', settled: true, elapsedMs: 0 }),
  row({ key: 'c3', description: 'never spawned', ordinal: 3, state: 'failed', settled: true, taskSessionId: undefined, elapsedMs: 0 }),
];
const roster = (id: string, parentId: string, depth: number, over: Partial<RosterRow> = {}): RosterRow => ({
  id, parentId, depth, title: `job ${id}`, agent: 'explore', status: 'idle', created: 0, updated: 60_000,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, steps: null, context: null, ...over,
});

function open(over: { rows?: SubagentRow[]; tree?: AgentTreeData; chatTasks?: TreeTask[]; onOpen?: (r: SubagentRow) => void; onClose?: () => void } = {}) {
  const { container } = render(SubagentMap, {
    rows: over.rows ?? THREE,
    title: '#3 coder: hardening',
    tree: over.tree,
    chatTasks: over.chatTasks ?? [],
    onOpen: over.onOpen ?? (() => {}),
    onClose: over.onClose ?? (() => {}),
  });
  return container;
}

const names = (c: HTMLElement) => [...c.querySelectorAll('.am-card .sa-name')].map((n) => n.textContent);
const place = (el: Element) => { const s = (el.closest('.am-at') as HTMLElement).style; return [parseFloat(s.left), parseFloat(s.top)]; };
const canvasOf = (c: HTMLElement) => c.querySelector('.am-canvas') as HTMLElement;
const zoomText = (c: HTMLElement) => c.querySelector('.am-zv')?.textContent;

describe('SubagentMap — the tree', () => {
  it('draws the hub and one card per sub-agent, Running then Failed then Done', () => {
    const c = open();
    expect(c.querySelector('.am-hub-name')?.textContent).toBe('#3 coder: hardening');
    expect(names(c)).toEqual(['scout · T1 · audit the bundle', 'T3 · never spawned', 'T2 · write the tests']);
  });

  it('puts a grandchild in the next column, on its parent\'s row, numbered from it', () => {
    const c = open({ tree: { rows: [roster('c1', 'root', 1), roster('g1', 'c1', 2), roster('g2', 'c1', 2), roster('gg', 'g1', 3)], background: [] } });
    const card = (k: string) => c.querySelector(`.am-card[data-k="${k}"]`)!;
    expect(card('g1').textContent).toContain('T1.1');
    expect(card('gg').textContent).toContain('T1.1.1');
    const [x1, y1] = place(card('c1')), [x2, y2] = place(card('g1')), [x3, y3] = place(card('gg'));
    expect(x2).toBeGreaterThan(x1);
    expect(x3).toBeGreaterThan(x2);
    expect([y2, y3]).toEqual([y1, y1]);
    expect(place(card('g2'))[1]).toBeGreaterThan(y1);
    expect(c.querySelector('.am-hub-kind')?.textContent).toContain('6 sub-agents in 3 tiers');
  });

  it('one rounded elbow wire per card, classed by its group; the failed one is dashed-class', () => {
    const c = open();
    const wires = [...c.querySelectorAll('path.am-w')];
    expect(wires.map((w) => [...w.classList].find((k) => k.startsWith('am-w-')))).toEqual(['am-w-running', 'am-w-failed', 'am-w-done']);
    expect(wires[1].getAttribute('d')).toMatch(/^M\d+,\d+ H\d+ Q/);
    // The running one carries the travelling light.
    expect(c.querySelectorAll('path.am-flow')).toHaveLength(1);
  });

  it('the head counts running / done / failed over every tier, and the running background tasks', () => {
    const c = open({ tree: { rows: [roster('g1', 'c1', 2, { status: 'running' })], background: [] }, chatTasks: [{ key: 'b1', owner: 'hub', title: 'bun run dev', status: 'running', startedAt: Date.now() }] });
    const head = c.querySelector('.sm-head')!.textContent!.replace(/\s+/g, ' ');
    expect(head).toContain('2 running');
    expect(head).toContain('1 done');
    expect(head).toContain('1 failed');
    expect(head).toContain('1 background');
  });
});

describe('SubagentMap — background chips', () => {
  it('a running chip ticks its age with a steady dot; a stopped one says it stopped with its owner', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const failed = row({ key: 'c5', taskSessionId: 'c5', ordinal: 5, state: 'failed', settled: true });
    const c = open({
      rows: [failed],
      chatTasks: [{ key: 'b1', owner: 'hub', title: 'bun run dev', status: 'running', startedAt: 40_000 }],
      tree: { rows: [], background: [{ ownerSessionId: 'c5', jobId: 'b5', title: 'tail rpfm.log', status: 'cancelled', startedAt: 1 }] },
    });
    const chip = (k: string) => c.querySelector(`.am-chip[data-k="${k}"]`)!;
    expect(chip('b1').getAttribute('data-s')).toBe('run');
    expect(chip('b1').querySelector('.am-bt')?.textContent).toBe('1m 00s');
    expect(chip('b1').querySelector('.am-own')?.textContent).toBe('shell · this chat');
    expect(chip('b5').querySelector('.am-bt')?.textContent).toBe('stopped with T5');
    expect(chip('b5').querySelector('.am-own')?.textContent).toBe('shell · T5');
    await vi.advanceTimersByTimeAsync(2000);
    expect(chip('b1').querySelector('.am-bt')?.textContent).toBe('1m 02s');
  });
});

describe('SubagentMap — zoom and pan', () => {
  it('− / + step the zoom, 1:1 resets it, and the scroll area scales with it', async () => {
    const c = open();
    const sizer = c.querySelector('.am-sizer') as HTMLElement;
    const w100 = parseFloat(sizer.style.width);
    await fireEvent.click(c.querySelector('[aria-label="Zoom in"]')!);
    expect(zoomText(c)).toBe('125%');
    expect(parseFloat(sizer.style.width)).toBeCloseTo(w100 * 1.25);
    expect((c.querySelector('.am-world') as HTMLElement).style.transform).toBe('scale(1.25)');
    await fireEvent.click(c.querySelector('[aria-label="Zoom out"]')!);
    await fireEvent.click(c.querySelector('[aria-label="Zoom out"]')!);
    expect(zoomText(c)).toBe('80%');
    await fireEvent.click([...c.querySelectorAll('.am-zoom button')].find((b) => b.textContent === '1:1')!);
    expect(zoomText(c)).toBe('100%');
  });

  it('Fit shrinks a big map to the view', async () => {
    const big = Array.from({ length: 40 }, (_, i) => row({ key: `k${i}`, taskSessionId: `k${i}`, ordinal: i + 1 }));
    const c = open({ rows: big });
    Object.defineProperty(canvasOf(c), 'clientWidth', { value: 800 });
    Object.defineProperty(canvasOf(c), 'clientHeight', { value: 400 });
    await fireEvent.click([...c.querySelectorAll('.am-zoom button')].find((b) => b.textContent === 'Fit')!);
    const pct = parseInt(zoomText(c)!, 10);
    expect(pct).toBeLessThan(100);
    const sizer = c.querySelector('.am-sizer') as HTMLElement;
    expect(parseFloat(sizer.style.height)).toBeLessThanOrEqual(400);
  });

  it('Ctrl + wheel zooms; a plain wheel only scrolls', async () => {
    const c = open();
    await fireEvent.wheel(canvasOf(c), { deltaY: 100 });
    expect(zoomText(c)).toBe('100%');
    await fireEvent.wheel(canvasOf(c), { deltaY: -100, ctrlKey: true });
    expect(zoomText(c)).toBe('110%');
  });

  it('a drag on empty canvas pans both axes; a drag that starts on a card does not', async () => {
    const c = open();
    const cv = canvasOf(c);
    cv.scrollLeft = 100; cv.scrollTop = 80;
    // jsdom has no PointerEvent: a MouseEvent under the pointer event's name carries button + clientX.
    const ptr = (el: Element, type: string, x: number, y: number) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    ptr(cv, 'pointerdown', 300, 300);
    ptr(cv, 'pointermove', 260, 250);
    expect([cv.scrollLeft, cv.scrollTop]).toEqual([140, 130]);
    ptr(cv, 'pointerup', 260, 250);
    ptr(c.querySelector('.am-card')!, 'pointerdown', 0, 0);
    ptr(cv, 'pointermove', 500, 500);
    expect([cv.scrollLeft, cv.scrollTop]).toEqual([140, 130]);
  });

  it('the big map (89 agents) mounts every card and a scroll area wider and taller than one screen', () => {
    const rows: SubagentRow[] = Array.from({ length: 5 }, (_, i) => row({ key: `T${i}`, taskSessionId: `T${i}`, ordinal: i + 1, state: 'done', settled: true }));
    const deep: RosterRow[] = [];
    for (const top of rows) for (let a = 1; a <= 3; a++) {
      deep.push(roster(`${top.key}.${a}`, top.key, 2));
      for (let b = 1; b <= 2; b++) { deep.push(roster(`${top.key}.${a}.${b}`, `${top.key}.${a}`, 3)); deep.push(roster(`${top.key}.${a}.${b}.1`, `${top.key}.${a}.${b}`, 4)); }
    }
    const c = open({ rows, tree: { rows: deep, background: [] } });
    expect(c.querySelectorAll('.am-card').length).toBe(5 + deep.length);
    expect(5 + deep.length).toBeGreaterThanOrEqual(80);
    const sizer = c.querySelector('.am-sizer') as HTMLElement;
    expect(parseFloat(sizer.style.width)).toBeGreaterThan(1000);
    expect(parseFloat(sizer.style.height)).toBeGreaterThan(1000);
  });
});

describe('SubagentMap — opening and dismissing', () => {
  it('clicking a card reports THAT row, a grandchild included', async () => {
    const onOpen = vi.fn();
    const c = open({ onOpen, tree: { rows: [roster('g1', 'c1', 2)], background: [] } });
    await fireEvent.click(c.querySelector('.am-card[data-k="c2"]')!);
    expect(onOpen.mock.calls[0][0].key).toBe('c2');
    await fireEvent.click(c.querySelector('.am-card[data-k="g1"]')!);
    expect(onOpen.mock.calls[1][0]).toMatchObject({ key: 'g1', taskSessionId: 'g1' });
  });

  it('a spawn with no child session is not clickable', () => {
    expect((open().querySelector('.am-card[data-k="c3"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the close button and Escape dismiss; another key does not', async () => {
    const onClose = vi.fn();
    const c = open({ onClose });
    await fireEvent.keyDown(window, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await fireEvent.click(c.querySelector('.sm-close')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('t-ze0hwh: opens as a panel sized by mapPanelSize (centred by the scrim), not the whole chat panel', () => {
    const c = open();
    const panel = c.querySelector('.sm-panel') as HTMLElement;
    expect([panel.style.width, panel.style.height]).toEqual(['744px', '624px']); // jsdom measures 0: the cap
    const src = readFileSync(path.join(__dirname, 'SubagentMap.svelte'), 'utf8');
    expect(src).not.toMatch(/calc\(100% - 24px\)/);
    expect(src).toMatch(/\.sm-scrim \{[^}]*align-items: center; justify-content: center;/);
  });

  it('reduced motion turns off the travelling light and the stagger', () => {
    const src = readFileSync(path.join(__dirname, 'SubagentMap.svelte'), 'utf8');
    const block = src.slice(src.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/\.am-flow \{ display: none; \}/);
    expect(block).toMatch(/\.am-enter \.am-at \{ animation: none; \}/);
  });
});
