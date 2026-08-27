// The five pillars are declared TWICE on purpose: mapSchema.ts owns them for
// validation, and webview/dashboard/components/repoMapPillars.ts mirrors them
// because tsconfig.webview.json pins rootDir to `webview/`, so the webview
// cannot import a runtime value out of src/. The house rule for that pattern is
// that a mirror needs a test which reads BOTH files and asserts they still
// agree — without it, a pillar renamed in the schema silently keeps its old
// name in the UI, and the map renders under headings that never validated.
import { describe, it, expect } from 'vitest';
import {
  fitScale,
  nodesInPillar,
  nodesInSection,
  nodesWithoutSection,
  sectionsInPillar,
} from '../components/repoMapPillars';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Pull `{ number, name, purpose }` triples out of either file's PILLARS array. */
function pillarsFrom(rel: string): Array<{ number: string; name: string; purpose: string }> {
  const src = readFileSync(path.join(pkgRoot, rel), 'utf8');
  const block = /PILLARS[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error(`no PILLARS array found in ${rel}`);
  const out: Array<{ number: string; name: string; purpose: string }> = [];
  const entry = /\{\s*number:\s*(\d+),\s*name:\s*'([^']*)',\s*purpose:\s*'([^']*)'\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(block[1])) !== null) out.push({ number: m[1], name: m[2], purpose: m[3] });
  return out;
}

/** Pull a named constant TABLE out of a file as flat `key=value` (or `value`)
 *  strings, so a Record and an array can both be compared across the seam. */
function tableFrom(rel: string, name: string): string[] {
  const src = readFileSync(path.join(pkgRoot, rel), 'utf8');
  const block = new RegExp(`${name}\\b[^=]*=\\s*([[{])([\\s\\S]*?)[\\]}];`).exec(src);
  if (!block) throw new Error(`no ${name} table found in ${rel}`);
  const body = block[2];
  const pairs = [...body.matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => `${m[1]}=${m[2]}`);
  return pairs.length > 0 ? pairs : [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe('the map PALETTE is mirrored, not drifting', () => {
  // Same rule as the pillars below, for the colour tables: mapPalette.ts owns them
  // for the exported artifact, repoMapPalette.ts mirrors them for the in-editor
  // screen, and rootDir forbids importing across. Without this guard a kind
  // recoloured on one side draws in two different colours on the two surfaces —
  // and since the colour IS the legend's key, the picture would be lying.
  const host = 'src/dashboard/agentManager/mapPalette.ts';
  const view = 'webview/dashboard/components/repoMapPalette.ts';

  for (const table of ['KIND_COLOR', 'KIND_ORDER', 'PILLAR_COLOR', 'FLOW_COLOR']) {
    it(`${table} agrees exactly on both sides`, () => {
      const a = tableFrom(host, table);
      expect(a.length, `${table} parsed empty — did the table change shape?`).toBeGreaterThan(0);
      expect(tableFrom(view, table)).toEqual(a);
    });
  }

  it('every kind in the legend order has a colour, and vice versa', () => {
    const colours = tableFrom(host, 'KIND_COLOR').map((p) => p.split('=')[0]);
    expect([...tableFrom(host, 'KIND_ORDER')].sort()).toEqual([...colours].sort());
  });
});

describe('the five pillars are mirrored, not drifting', () => {
  const schema = pillarsFrom('src/dashboard/agentManager/mapSchema.ts');
  const screen = pillarsFrom('webview/dashboard/components/repoMapPillars.ts');

  it('both files declare all five pillars', () => {
    expect(schema).toHaveLength(5);
    expect(screen).toHaveLength(5);
  });

  it('the numbers, names and purposes agree exactly', () => {
    expect(screen).toEqual(schema);
  });

  it('the numbers are 1-5 with no gaps, so validateMap and the columns cover the same set', () => {
    expect(schema.map((p) => p.number)).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe('node status colours name tokens the theme actually defines', () => {
  // --og-green/yellow/red never existed; the statuses fell through to a
  // hardcoded hex and ignored the theme on every one of the four palettes.
  const screen = readFileSync(
    path.join(pkgRoot, 'webview/dashboard/components/repoMapPillars.ts'),
    'utf8',
  );
  const theme = readFileSync(path.join(pkgRoot, 'webview/shared/theme.css'), 'utf8');

  it('every --og- token used by the status colours is defined in theme.css', () => {
    const statusBlock = /STATUS_COLOR[^}]*\}/.exec(screen);
    expect(statusBlock, 'STATUS_COLOR map not found').toBeTruthy();
    const used = [...statusBlock![0].matchAll(/--og-[a-z0-9-]+/g)].map((m) => m[0]);
    expect(used.length).toBeGreaterThan(0);
    const undefinedTokens = used.filter((t) => !theme.includes(`${t}:`));
    expect(undefinedTokens, `not defined in theme.css: ${undefinedTokens.join(', ')}`).toEqual([]);
  });
});

describe('the map screen names only tokens the theme actually defines', () => {
  // Same rule as the status colours above, widened to the two files the
  // isometric rewrite put the map's colour in. It is the cheapest guard there
  // is against the exact defect that started this: `var(--og-green, #4caf50)`
  // typechecks, renders, and screenshots fine — the fallback quietly takes over
  // and the surface ignores the user's theme on all five palettes. Every
  // --og-* below must resolve, including the ones in the SVG faces, which have
  // no visible fallback to give the game away.
  //
  // IsoGround.svelte is deliberately NOT in this list: its only colours are the
  // flow and pillar TINTS, which are data encoding rather than chrome, so it names
  // no --og-* token at all and the "did this file stop using the theme?" assertion
  // would be false there.
  const theme = readFileSync(path.join(pkgRoot, 'webview/shared/theme.css'), 'utf8');
  for (const rel of [
    'webview/dashboard/panes/RepoMapScreen.svelte',
    'webview/dashboard/panes/RepoMapFilters.svelte',
    'webview/dashboard/panes/RepoMapDetail.svelte',
    'webview/dashboard/components/IsoStage.svelte',
    'webview/dashboard/components/IsoNodes.svelte',
    'webview/dashboard/components/IsoWires.svelte',
    'webview/dashboard/components/IsoLabels.svelte',
  ]) {
    it(`${rel} uses no undefined --og-* token`, () => {
      const src = readFileSync(path.join(pkgRoot, rel), 'utf8');
      const used = [...new Set([...src.matchAll(/--og-[a-z0-9-]+/g)].map((m) => m[0]))];
      expect(used.length, 'no theme tokens found — did the file stop using the theme?').toBeGreaterThan(0);
      expect(used.filter((t) => !theme.includes(`${t}:`)), `not defined in theme.css`).toEqual([]);
    });
  }
});

describe('grouping puts every node in exactly one place', () => {
  // The bug this guards: unsectioned nodes vanishing when section grouping was
  // added. A node with no `section` is not a node with no column.
  const nodes = [
    { id: 'a', pillar: 1, section: 'CLI Tools' },
    { id: 'b', pillar: 1 },
    { id: 'c', pillar: 1, section: '' },
    { id: 'd', pillar: 2, section: 'Calc Engine' },
    { id: 'e', pillar: 5 },
  ];

  it('an ungrouped node still appears in its pillar', () => {
    expect(nodesWithoutSection(nodes, 1).map((n) => n.id)).toEqual(['b', 'c']);
    expect(nodesInPillar(nodes, 1).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('a blank section counts as ungrouped, not as a section named ""', () => {
    expect(sectionsInPillar(nodes, 1)).toEqual(['CLI Tools']);
  });

  it('every node of a pillar renders exactly once across the two loops', () => {
    for (const p of [1, 2, 3, 4, 5]) {
      const rendered = [
        ...nodesWithoutSection(nodes, p),
        ...sectionsInPillar(nodes, p).flatMap((s) => nodesInSection(nodes, p, s)),
      ].map((n) => n.id);
      expect(new Set(rendered).size, `pillar ${p} renders a node twice`).toBe(rendered.length);
      expect(rendered.sort()).toEqual(nodesInPillar(nodes, p).map((n) => n.id).sort());
    }
  });
});

describe('fit-to-width only ever shrinks', () => {
  it('scales an overflowing stage down to the wrapper', () => {
    expect(fitScale(1000, 500)).toBe(0.5);
  });

  it('leaves a stage that already fits alone, and never enlarges it', () => {
    expect(fitScale(400, 800)).toBe(1);
    expect(fitScale(800, 800)).toBe(1);
  });

  it('is a no-op before either measurement has landed', () => {
    expect(fitScale(0, 500)).toBe(1);
    expect(fitScale(1000, 0)).toBe(1);
  });
});
