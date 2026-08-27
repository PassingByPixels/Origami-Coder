// The Labels control's four states, tested as the DECISION each one makes
// about a given node — not as a table of flags read back out.
//
// The state that earns this file is `clean`. The other three all keep a
// standing escape hatch: hover a node, select one, or type a filter, and text
// appears again. `clean` is the only state where the graph is guaranteed to
// carry no text at all, and that guarantee is exactly what a lookup-table
// assertion would fail to pin — so every case below poses the state a node
// that WOULD have been labelled in some other state.

import { describe, expect, it } from 'vitest';
import {
  LABEL_MODES,
  drawsNodeLabel,
  isLabelMode,
  labelModeText,
  nextLabelMode,
  showsReadouts,
  type LabelContext,
  type LabelMode,
} from './wikiGraphLabels';

/** A plain, unremarkable page node: not a hub, not hovered, not selected, no
 *  filter running. Each test overrides only the fact it is about. */
const plain: LabelContext = {
  isHub: false,
  isHovered: false,
  isSelected: false,
  isQueryHit: false,
  queryActive: false,
};
const node = (over: Partial<LabelContext> = {}): LabelContext => ({ ...plain, ...over });

describe('the cycle — Hubs then All then None then Clean, then round again', () => {
  it('steps through all four in order and returns to the start', () => {
    const seen: LabelMode[] = ['hubs'];
    for (let i = 0; i < 4; i++) seen.push(nextLabelMode(seen[seen.length - 1]));
    expect(seen).toEqual(['hubs', 'all', 'none', 'clean', 'hubs']);
  });

  it('keeps the pre-existing three in their original relative order', () => {
    // The control shipped as hubs -> all -> none. Clean is an ADDED step; it
    // must not reshuffle the sequence a user already has in their fingers.
    expect(LABEL_MODES.indexOf('hubs')).toBeLessThan(LABEL_MODES.indexOf('all'));
    expect(LABEL_MODES.indexOf('all')).toBeLessThan(LABEL_MODES.indexOf('none'));
    expect(LABEL_MODES.indexOf('none')).toBeLessThan(LABEL_MODES.indexOf('clean'));
  });

  it('names each state for the button in the same words the button shows', () => {
    expect(LABEL_MODES.map(labelModeText)).toEqual(['Hubs', 'All', 'None', 'Clean']);
  });
});

describe('isLabelMode — the persisted-preference gate', () => {
  it('accepts every state the control can actually reach', () => {
    for (const m of LABEL_MODES) expect(isLabelMode(m)).toBe(true);
  });

  it('rejects a stale or junk persisted value rather than adopting it', () => {
    // Webview state outlives a release; a value written by an older build (or
    // a hand-edited state bag) must fall back to the default, not become an
    // unhandled fifth mode that renders nothing.
    for (const junk of ['Hubs', 'hidden', '', null, undefined, 0, {}]) {
      expect(isLabelMode(junk)).toBe(false);
    }
  });
});

describe('clean — the state with no text, under every condition that adds text elsewhere', () => {
  it('draws no label for a hovered node (every other state does)', () => {
    expect(drawsNodeLabel('clean', node({ isHovered: true }))).toBe(false);
    for (const m of ['hubs', 'all', 'none'] as const) {
      expect(drawsNodeLabel(m, node({ isHovered: true }))).toBe(true);
    }
  });

  it('draws no label for the selected node (every other state does)', () => {
    expect(drawsNodeLabel('clean', node({ isSelected: true }))).toBe(false);
    for (const m of ['hubs', 'all', 'none'] as const) {
      expect(drawsNodeLabel(m, node({ isSelected: true }))).toBe(true);
    }
  });

  it('draws no label for a live-filter hit (every other state does)', () => {
    const hit = node({ queryActive: true, isQueryHit: true });
    expect(drawsNodeLabel('clean', hit)).toBe(false);
    for (const m of ['hubs', 'all', 'none'] as const) {
      expect(drawsNodeLabel(m, hit)).toBe(true);
    }
  });

  it('draws no label for a folder hub (the one label None still had to lose)', () => {
    expect(drawsNodeLabel('clean', node({ isHub: true }))).toBe(false);
  });

  it('hides the legend strip — the text the canvas modes never controlled', () => {
    expect(showsReadouts('clean')).toBe(false);
    for (const m of ['hubs', 'all', 'none'] as const) expect(showsReadouts(m)).toBe(true);
  });
});

describe('none — no STANDING labels, but focus and filter still speak', () => {
  it('leaves a plain node unlabelled', () => {
    expect(drawsNodeLabel('none', plain)).toBe(false);
  });

  it('leaves a folder hub unlabelled too (this is what separates it from Hubs)', () => {
    expect(drawsNodeLabel('none', node({ isHub: true }))).toBe(false);
    expect(drawsNodeLabel('hubs', node({ isHub: true }))).toBe(true);
  });
});

describe('hubs — folder labels only', () => {
  it('labels a folder hub and not an ordinary page', () => {
    expect(drawsNodeLabel('hubs', node({ isHub: true }))).toBe(true);
    expect(drawsNodeLabel('hubs', plain)).toBe(false);
  });
});

describe('all — every node, until a filter narrows it', () => {
  it('labels an ordinary page with no filter running', () => {
    expect(drawsNodeLabel('all', plain)).toBe(true);
  });

  it('drops to hits only once a filter is running', () => {
    // A non-hit is not drawn at all while a filter is live, so labelling it
    // would paint text over empty space where its node used to be.
    expect(drawsNodeLabel('all', node({ queryActive: true, isQueryHit: false }))).toBe(false);
    expect(drawsNodeLabel('all', node({ queryActive: true, isQueryHit: true }))).toBe(true);
  });
});

describe('a filter running does not resurrect text in clean', () => {
  it('stays silent for hit and non-hit alike', () => {
    expect(drawsNodeLabel('clean', node({ queryActive: true, isQueryHit: true }))).toBe(false);
    expect(drawsNodeLabel('clean', node({ queryActive: true, isQueryHit: false }))).toBe(false);
  });

  it('stays silent even when a node is hovered AND selected AND a hit AND a hub', () => {
    expect(drawsNodeLabel('clean', {
      isHub: true, isHovered: true, isSelected: true, isQueryHit: true, queryActive: true,
    })).toBe(false);
  });
});
