// whatsNewContent.test.ts — drift guards for the SHIPPED What's new content (t-v5r1fd):
// the notes in packages/vscode/whats-new/, their diagrams, the panel CSS that colours
// them, and the public-release list. Each guard names the bug it stops:
//  - a diagram token with no file: the diagram silently vanishes from the pop-up;
//  - an SVG class the panel does not style, or a fixed colour: a shape ignores the theme
//    (black on the dark themes);
//  - a --og-* token that theme.css does not define: the colour falls back to nothing;
//  - the same marker id in two diagrams: both inline on one page, so arrowheads cross-wire;
//  - a public release with no text: its users get an empty pop-up.

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whatsNewTokens } from '../../../src/dashboard/whatsNewInline';
import { PUBLIC_RELEASES } from '../../../src/dashboard/publicReleases';
import { compareVersions, previousPublicRelease } from '../../../src/dashboard/changelogGate';
import { mergeChangelogSince } from '../../../src/dashboard/changelogSection';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const notesDir = path.join(pkgRoot, 'whats-new');
const diagramsDir = path.join(notesDir, 'diagrams');
const read = (p: string) => readFileSync(p, 'utf8');
const notes = readdirSync(notesDir).filter((f) => f.endsWith('.md'));
const diagrams = readdirSync(diagramsDir).filter((f) => f.endsWith('.svg'));
const panelSrc = read(path.join(pkgRoot, 'src', 'dashboard', 'changelogPanel.ts'));

describe('shipped What\'s new notes', () => {
  it('there is at least one note and one diagram (the guards below are not vacuous)', () => {
    expect(notes).toContain('0.4.174.md');
    expect(diagrams.length).toBeGreaterThanOrEqual(4);
  });

  it('every diagram token names a diagram file that exists', () => {
    for (const note of notes) {
      const tokens = whatsNewTokens(read(path.join(notesDir, note))).filter((t) => t.kind === 'diagram');
      expect(tokens.length, note).toBeGreaterThan(0);
      for (const t of tokens) expect(existsSync(path.join(diagramsDir, `${t.name}.svg`)), `${note}: ${t.name}`).toBe(true);
    }
  });

  it('every token has a caption (the screenshot placeholder tells the owner what to capture)', () => {
    for (const note of notes) {
      for (const t of whatsNewTokens(read(path.join(notesDir, note)))) expect(t.caption.length, `${note}: ${t.name}`).toBeGreaterThan(10);
    }
  });
});

describe('diagrams follow the theme', () => {
  const styled = new Set([...panelSrc.matchAll(/\.wn-fig svg \.([a-z0-9-]+)/g)].map((m) => m[1]));

  it('use only classes the panel styles, and no fixed colours', () => {
    for (const file of diagrams) {
      const svg = read(path.join(diagramsDir, file));
      const classes = [...svg.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
      for (const c of classes) expect(styled.has(c), `${file}: .${c}`).toBe(true);
      expect(svg, file).not.toMatch(/\s(fill|stroke|color|style)="/);
    }
  });

  it('marker ids are unique across diagrams', () => {
    const ids = diagrams.flatMap((f) => [...read(path.join(diagramsDir, f)).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Text drawn ON a filled shape: the ink/fill pair must read in EVERY theme. The
  // "Continued on" pill was gold ink-on-gold at 2.36:1 in Ember before this guard.
  it('text on a filled shape keeps 4.5:1 contrast in every theme', () => {
    const theme = read(path.join(pkgRoot, 'webview', 'shared', 'theme.css'));
    const token = (cls: string, prop: string) =>
      new RegExp(`\\.wn-fig svg \\.${cls} \\{[^}]*\\b${prop}: var\\((--og-[a-z0-9-]+)\\)`).exec(panelSrc)?.[1];
    const pairs = [['t-warn', 'pill-warn'], ['t-on', 'fill-chat']].map(([ink, fill]) => [token(ink, 'fill'), token(fill, 'fill')]);
    const lum = (hex: string) => {
      const c = [0, 2, 4].map((i) => Number.parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const checked = new Set<string>();
    // Later `:root[data-theme="x"] .rule` blocks hold no tokens; only palette blocks count.
    for (const block of theme.split(':root[data-theme="').slice(1)) {
      const name = block.slice(0, block.indexOf('"'));
      const hex = (t: string) => new RegExp(`${t}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1];
      for (const [ink, fill] of pairs) {
        const a = hex(ink ?? ''), b = hex(fill ?? '');
        if (!a || !b) continue;
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        expect((hi + 0.05) / (lo + 0.05), `${name}: ${ink} on ${fill}`).toBeGreaterThanOrEqual(4.5);
        checked.add(`${name} ${ink}`);
      }
    }
    for (const name of ['meadow', 'harbour', 'ember', 'midnight']) {
      for (const [ink] of pairs) expect(checked.has(`${name} ${ink}`), `${name} ${ink} not checked`).toBe(true);
    }
  });

  it('the panel uses only --og-* tokens that theme.css defines', () => {
    const theme = read(path.join(pkgRoot, 'webview', 'shared', 'theme.css'));
    const defined = new Set([...theme.matchAll(/(--og-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...panelSrc.matchAll(/var\((--og-[a-z0-9-]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(5);
    for (const t of used) expect(defined.has(t), t).toBe(true);
  });
});

describe('PUBLIC_RELEASES', () => {
  it('is oldest first with no duplicates', () => {
    const sorted = [...PUBLIC_RELEASES].sort(compareVersions);
    expect([...PUBLIC_RELEASES]).toEqual(sorted);
    expect(new Set(PUBLIC_RELEASES).size).toBe(PUBLIC_RELEASES.length);
  });

  it('every public release has text: a curated note or CHANGELOG sections since the release before it', () => {
    const changelog = read(path.join(pkgRoot, 'CHANGELOG.md'));
    for (const r of PUBLIC_RELEASES) {
      const hasNote = existsSync(path.join(notesDir, `${r}.md`));
      const merged = mergeChangelogSince(changelog, previousPublicRelease(r, PUBLIC_RELEASES), r);
      expect(hasNote || merged.length > 0, r).toBe(true);
    }
  });
});
