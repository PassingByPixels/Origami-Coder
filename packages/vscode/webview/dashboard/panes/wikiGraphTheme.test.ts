// The memory graph's paint side: the palette the canvas is PINNED to, and the
// two tints derived from it.
//
// The Harbour fixtures here are NOT invented. They are parsed out of the real
// webview/shared/theme.css, so a retint of the Harbour block — a deeper ground,
// a new accent — shows up as a failure here rather than as a graph quietly
// wearing last year's blue. That is the "derive your fixtures from the external
// thing" rule from docs/WORKING_ON_ORIGAMI_CODER.md Part 6, and it is the whole
// safety net for pinning a live theme read to a copy.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HARBOUR_GRAPH_THEME,
  hubHaloColour,
  vignetteColour,
  clusterColour,
  drawRadius,
  tagAlpha,
  CLUSTER_SAT,
  CLUSTER_LIGHT,
  TAG_ALPHA_FLOOR,
  DEG_SCALE,
  VIGNETTE,
  type GraphTheme,
} from './wikiGraphTheme';

// webview/dashboard/panes -> webview/shared/theme.css
const THEME_CSS = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'theme.css'),
  'utf8',
);

/** The concrete value a shipped theme block actually declares for one token. */
function tokenOf(theme: string, token: string): string {
  const at = THEME_CSS.indexOf(`[data-theme="${theme}"]`);
  expect(at, `theme.css has no block for "${theme}"`).toBeGreaterThan(-1);
  const block = THEME_CSS.slice(at, THEME_CSS.indexOf('}', at));
  const decl = new RegExp(`${token}:\\s*([^;]+);`).exec(block);
  expect(decl, `theme "${theme}" declares no ${token}`).not.toBeNull();
  return decl![1].trim();
}

/** Which --og-* token each field of the pinned palette is a copy of. */
const PINNED_TO: Record<keyof GraphTheme, string> = {
  text: '--og-text',
  muted: '--og-text-muted',
  border: '--og-border',
  chat: '--og-chat',
  accent: '--og-accent',
  tag: '--og-error',
  hub: '--og-crane',
  bg: '--og-bg',
};

describe('HARBOUR_GRAPH_THEME — the graph wears Harbour on every theme', () => {
  for (const [field, token] of Object.entries(PINNED_TO)) {
    it(`${field} still equals the ${token} Harbour ships`, () => {
      expect(HARBOUR_GRAPH_THEME[field as keyof GraphTheme]).toBe(tokenOf('harbour', token));
    });
  }

  it('pins every colour the canvas paints with — a new field cannot slip through unpinned', () => {
    expect(Object.keys(HARBOUR_GRAPH_THEME).sort()).toEqual(Object.keys(PINNED_TO).sort());
  });

  it('is a DARK ground, which is the point of the pin', () => {
    // Harbour's --og-bg is the darkest surface of the five themes; the graph
    // took it precisely so a light theme could not make the canvas unreadable.
    expect(HARBOUR_GRAPH_THEME.bg).not.toBe(tokenOf('ember', '--og-bg'));
    expect(HARBOUR_GRAPH_THEME.bg).toBe(tokenOf('harbour', '--og-bg'));
  });
});

describe('hubHaloColour — the halo blooms off the pinned ground', () => {
  const lightnessOf = (c: string) => Number(/,\s*([\d.]+)%,\s*[\d.]+\)$/.exec(c)![1]);

  it('is lighter than mid, so it reads as a bloom against the dark ground', () => {
    expect(lightnessOf(hubHaloColour(200, 0.35))).toBeGreaterThan(50);
  });

  it('keeps the hub\'s own folder hue — the halo says WHICH folder, not just "a folder"', () => {
    expect(hubHaloColour(17, 1)).toContain('hsla(17,');
    expect(hubHaloColour(300, 1)).toContain('hsla(300,');
  });

  it('floors a fractional hue rather than emitting "hsla(212.7," ', () => {
    expect(hubHaloColour(212.7, 1)).toContain('hsla(212,');
  });

  it('carries the alpha through, so the gradient can fade to nothing at the rim', () => {
    expect(hubHaloColour(200, 0.35)).toBe(`hsla(200, ${CLUSTER_SAT}%, ${CLUSTER_LIGHT}%, 0.35)`);
    expect(hubHaloColour(200, 0).endsWith(', 0)')).toBe(true);
  });
});

describe('vignetteColour — the rim deepens past the pinned ground', () => {
  it('deepens toward black at the rim', () => {
    expect(vignetteColour(VIGNETTE)).toBe(`rgba(0, 0, 0, ${VIGNETTE})`);
  });

  it('starts fully transparent at the centre, so the middle of the graph is untouched', () => {
    expect(vignetteColour(0)).toBe('rgba(0, 0, 0, 0)');
  });

  it('is achromatic — a tinted rim would fight the folder hues it darkens', () => {
    const [r, g, b] = /rgba\((\d+), (\d+), (\d+),/.exec(vignetteColour(0.5))!.slice(1);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });
});

describe('drawRadius — size means degree', () => {
  it('leaves an unconnected node at its base radius', () => {
    expect(drawRadius(6, 0, 12)).toBe(6);
  });

  it('grows the busiest node by the full scale', () => {
    expect(drawRadius(6, 12, 12)).toBeCloseTo(6 * (1 + DEG_SCALE), 9);
  });

  it('is monotonic in degree — a better-connected page is never drawn smaller', () => {
    const sizes = [0, 3, 6, 9, 12].map((d) => drawRadius(6, d, 12));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
  });

  it('survives an empty graph (maxDegree 0) without dividing by zero', () => {
    expect(Number.isFinite(drawRadius(6, 0, 0))).toBe(true);
  });
});

describe('tagAlpha — rare tags fade, the busiest is full', () => {
  it('puts the least-used tag on the floor and the most-used at full', () => {
    expect(tagAlpha(0, 10)).toBeCloseTo(TAG_ALPHA_FLOOR, 9);
    expect(tagAlpha(10, 10)).toBeCloseTo(1, 9);
  });

  it('does not divide by zero on a wiki with no tags at all', () => {
    expect(tagAlpha(0, 0)).toBe(1);
  });
});

describe('clusterColour — the generated hue palette', () => {
  it('carries the recipe\'s saturation and lightness', () => {
    expect(clusterColour(200)).toBe(`hsl(200, ${CLUSTER_SAT}%, ${CLUSTER_LIGHT}%)`);
  });
});
