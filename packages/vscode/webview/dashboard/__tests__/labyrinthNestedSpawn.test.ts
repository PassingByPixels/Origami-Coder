// t-vikozs: the Labyrinth crashed with Svelte's each_key_duplicate when a
// sub-agent step (a nested spawn) also carried depth > 0. branchModel opens the
// step's own depth branch AND the spawn's branch at the same index, so two
// spans share `first`, and the rails were keyed by `first`.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import LabyrinthMap from '../components/LabyrinthMap.svelte';
import { branchModel, type LayoutStep, type MapMode } from '../components/labyrinthLayout';

const step = (ordinal: number, over: Partial<LayoutStep> = {}): LayoutStep => ({
  ordinal, kind: 'reply', title: `step ${ordinal}`, ...over,
});

// A child's spawn of a grandchild, seen with no enclosing branch open yet.
const NESTED_SPAWN: LayoutStep[] = [
  step(0, { kind: 'prompt', title: 'audit' }),
  step(1, { kind: 'subagent', tool: 'task', title: 'nested spawn', depth: 1, parentOrdinal: 0 }),
  step(2, { kind: 'prompt', title: 'brief', depth: 2, parentOrdinal: 1 }),
  step(3, { kind: 'reply', title: 'done' }),
];
const none = { steps: new Set<number>(), branches: new Set<number>() };

afterEach(() => cleanup());

describe('Labyrinth — a sub-agent step that also has depth > 0', () => {
  it('the branch model really yields two spans that start on the same step', () => {
    const firsts = branchModel(NESTED_SPAWN).spans.map((s) => s.first);
    expect(firsts.filter((f) => f === 1).length).toBe(2);
  });

  for (const mode of ['thread', 'flight', 'corridor'] as MapMode[]) {
    it(`${mode}: the map renders every step and does not throw`, () => {
      const { container } = render(LabyrinthMap, {
        steps: NESTED_SPAWN, mode, selected: null, onSelect: () => {}, fade: none,
      });
      expect(container.querySelector('svg.lab-svg')).not.toBeNull();
    });
  }
});

// t-vikozs: at a ~900 px panel the map column is narrower than its toolbar's one
// unbroken row, so the row ran under the inspector column, which covered Fit.
// jsdom has no layout; the rule that prevents it is asserted here and the
// overflow was measured in headless Chromium (lane report).
describe('Labyrinth toolbar — wraps inside its column', () => {
  it('the head row wraps, and the title can shrink', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../components/LabyrinthMapToolbar.svelte'), 'utf-8');
    expect(src.match(/\.lab-map-head\s*\{[^}]*\}/)?.[0]).toMatch(/flex-wrap:\s*wrap/);
    expect(src.match(/\.lab-map-title\s*\{[^}]*\}/)?.[0]).toMatch(/min-width:\s*0/);
  });
});
