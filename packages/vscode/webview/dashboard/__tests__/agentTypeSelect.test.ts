// AgentTypeSelect (S12) — the native <select> became a custom listbox so each entry
// can carry its brand GLYPH beside a CAPITALIZED display name. These assert the
// observable behaviour a real user (mouse + keyboard) sees: the trigger reflects the
// current pick with a glyph + capitalized label; the popup lists Tsuru first and
// the harvested modes capitalized; a click or a keyboard Enter fires onchange
// with the raw lowercase id (NOT the capitalized label); Escape closes without picking.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import AgentTypeSelect from '../components/AgentTypeSelect.svelte';

afterEach(cleanup);

interface AgentType { id: string; name: string; default?: boolean; description?: string }
const mount = (agentTypes: AgentType[], value: string, onchange = vi.fn()) => {
  const r = render(AgentTypeSelect, { props: { agentTypes, value, onchange } });
  return { ...r, onchange };
};
const trigger = (c: HTMLElement) => c.querySelector('.am-agenttype') as HTMLButtonElement;
const opts = (c: HTMLElement) => Array.from(c.querySelectorAll('.am-agenttype-option')) as HTMLElement[];
const values = (c: HTMLElement) => opts(c).map((o) => o.getAttribute('data-value'));
async function openIt(c: HTMLElement) { await fireEvent.click(trigger(c)); await tick(); }

describe('AgentTypeSelect — trigger reflects the selection', () => {
  it('shows the CURRENT pick capitalized, with its glyph', async () => {
    // value is the lowercase id 'ask'; the trigger must render "Ask" + the cat glyph.
    const { container } = mount([{ id: 'ask', name: 'ask' }], 'ask');
    const t = trigger(container);
    expect(t.querySelector('.att-label')!.textContent).toBe('Ask');
    expect(t.querySelector('svg.am-glyph')).not.toBeNull(); // ask has a brand glyph
  });

  it('the brand default (tsuru) shows its label with the crane glyph', () => {
    const { container } = mount([], 'tsuru');
    const t = trigger(container);
    expect(t.querySelector('.att-label')!.textContent).toBe('Tsuru (default)');
    expect(t.querySelector('svg.am-glyph')).not.toBeNull(); // Tsuru wears the crane sigil
  });
});

describe('AgentTypeSelect — an id absent from the roster', () => {
  it('shows the id itself capitalized, NOT a false "Tsuru", when value is not in entries', async () => {
    // A row whose agentName has not (yet) been harvested into the roster: value is
    // 'debug' but only Tsuru is listed. The trigger must read "Debug"
    // (matching AgentCard's line2 badge), not silently substitute "Tsuru (default)".
    const { container } = mount([], 'debug');
    const t = trigger(container);
    expect(t.querySelector('.att-label')!.textContent).toBe('Debug');
    // And opening still lists the real roster (Tsuru); the phantom id is not injected.
    await openIt(container);
    expect(values(container)).toEqual(['tsuru']);
  });
});

describe('AgentTypeSelect — the option list', () => {
  it('lists Tsuru first, harvested modes CAPITALIZED; hides the flagged engine default', async () => {
    const { container } = mount(
      [{ id: 'build', name: 'build', default: true }, { id: 'plan', name: 'plan' }, { id: 'debug', name: 'debug' }],
      'tsuru',
    );
    await openIt(container);
    expect(values(container)).toEqual(['tsuru', 'plan', 'debug']); // build hidden (it's the default)
    const labels = opts(container).map((o) => o.querySelector('.att-optlabel')!.textContent);
    expect(labels).toEqual(['Tsuru (default)', 'Plan', 'Debug']);
    // A harvested mode with a brand glyph renders it; Tsuru wears the crane.
    const debugOpt = opts(container).find((o) => o.getAttribute('data-value') === 'debug')!;
    expect(debugOpt.querySelector('svg.am-glyph')).not.toBeNull();
    const tsuruOpt = opts(container).find((o) => o.getAttribute('data-value') === 'tsuru')!;
    expect(tsuruOpt.querySelector('svg.am-glyph')).not.toBeNull();
  });

  it('with no harvested roster it degrades to Tsuru', async () => {
    const { container } = mount([], 'tsuru');
    await openIt(container);
    expect(values(container)).toEqual(['tsuru']);
  });
});

describe('AgentTypeSelect — selection fires onchange with the raw id', () => {
  it('clicking an option fires onchange(id) and closes the popup', async () => {
    const { container, onchange } = mount([{ id: 'plan', name: 'plan' }], 'tsuru');
    await openIt(container);
    await fireEvent.click(opts(container).find((o) => o.getAttribute('data-value') === 'plan')!);
    await tick();
    expect(onchange).toHaveBeenCalledWith('plan'); // the lowercase id, not "Plan"
    expect(opts(container).length).toBe(0);         // closed
  });

  it('keyboard: ArrowDown opens, ArrowDown moves, Enter selects the raw id', async () => {
    const { container, onchange } = mount([{ id: 'plan', name: 'plan' }], 'tsuru');
    const t = trigger(container);
    await fireEvent.keyDown(t, { key: 'ArrowDown' }); // opens, active = selected (tsuru, idx 0)
    await tick();
    expect(opts(container).length).toBe(2);
    await fireEvent.keyDown(t, { key: 'ArrowDown' }); // -> plan (idx 1)
    await fireEvent.keyDown(t, { key: 'Enter' });     // select
    await tick();
    expect(onchange).toHaveBeenCalledWith('plan');
    expect(opts(container).length).toBe(0);
  });

  it('Escape closes without picking', async () => {
    const { container, onchange } = mount([{ id: 'plan', name: 'plan' }], 'tsuru');
    await openIt(container);
    expect(opts(container).length).toBe(2);
    await fireEvent.keyDown(trigger(container), { key: 'Escape' });
    await tick();
    expect(opts(container).length).toBe(0);
    expect(onchange).not.toHaveBeenCalled();
  });
});

describe('AgentTypeSelect — the tile grid (S15)', () => {
  // 6 non-default modes -> entries = [tsuru, m0..m5] = 7 tiles in a 3-column grid:
  // rows [0,1,2] [3,4,5] [6]. These assert the 2D geometry a keyboard user feels.
  const roster = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `m${i}` }));
  const activeIndex = (c: HTMLElement) => opts(c).findIndex((o) => o.classList.contains('active'));

  it('a glyph type renders its glyph tile; a glyph-less type an initial-letter tile', async () => {
    // 'review' is a harvested custom mode with no brand animal -> initial-letter tile.
    const { container } = mount([{ id: 'debug', name: 'debug' }, { id: 'review', name: 'review' }], 'tsuru');
    await openIt(container);
    const debugOpt = opts(container).find((o) => o.getAttribute('data-value') === 'debug')!;
    expect(debugOpt.querySelector('svg.am-glyph')).not.toBeNull();       // fox glyph
    const reviewOpt = opts(container).find((o) => o.getAttribute('data-value') === 'review')!;
    expect(reviewOpt.querySelector('svg.am-glyph')).toBeNull();          // no menagerie animal
    expect(reviewOpt.querySelector('.att-initial')?.textContent).toBe('R'); // initial-letter fallback
  });

  it('Down/Up step one ROW (±3); Left/Right step one and wrap across a row edge; Home/End jump', async () => {
    const { container } = mount(roster(6), 'tsuru');
    const t = trigger(container);
    await fireEvent.keyDown(t, { key: 'ArrowDown' }); await tick(); // opens, active = selected tsuru (idx 0)
    expect(opts(container).length).toBe(7);
    expect(activeIndex(container)).toBe(0);
    await fireEvent.keyDown(t, { key: 'ArrowDown' });               // +3 -> row 1
    expect(activeIndex(container)).toBe(3);
    await fireEvent.keyDown(t, { key: 'ArrowUp' });                 // -3 -> row 0
    expect(activeIndex(container)).toBe(0);
    await fireEvent.keyDown(t, { key: 'ArrowRight' });
    await fireEvent.keyDown(t, { key: 'ArrowRight' });              // 0 -> 1 -> 2 (row edge)
    expect(activeIndex(container)).toBe(2);
    await fireEvent.keyDown(t, { key: 'ArrowRight' });              // wraps 2 -> 3 (next row)
    expect(activeIndex(container)).toBe(3);
    await fireEvent.keyDown(t, { key: 'ArrowLeft' });               // 3 -> 2 (wraps back)
    expect(activeIndex(container)).toBe(2);
    await fireEvent.keyDown(t, { key: 'End' });
    expect(activeIndex(container)).toBe(6);
    await fireEvent.keyDown(t, { key: 'Home' });
    expect(activeIndex(container)).toBe(0);
  });

  it('Down clamps at the last (partial) row; Enter selects the active tile\'s raw id', async () => {
    const { container, onchange } = mount(roster(6), 'tsuru');
    const t = trigger(container);
    await fireEvent.keyDown(t, { key: 'ArrowDown' }); await tick(); // open, active 0
    await fireEvent.keyDown(t, { key: 'End' });                     // -> idx 6 (lone tile, row 2)
    await fireEvent.keyDown(t, { key: 'ArrowDown' });               // no row below -> clamps at 6
    expect(activeIndex(container)).toBe(6);
    await fireEvent.keyDown(t, { key: 'Enter' });
    await tick();
    expect(onchange).toHaveBeenCalledWith('m5'); // idx 6 = m5 (idx0 tsuru, idx1..6 = m0..m5)
    expect(opts(container).length).toBe(0);       // closed
  });
});
