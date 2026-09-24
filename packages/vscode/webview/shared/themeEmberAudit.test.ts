// themeEmberAudit.test.ts — t-qn0wj5, proposal 22 (port of Mock-Redesign CHANGES.md #36).
//
// On the light `ember` theme the composer used --og-pane-header (the same step as its
// dark siblings' header colour, but heavier than the page on a light theme) and the
// context gauge's error state read var(--og-error), a saturated red the ember palette
// never tuned for light-background text — --og-error-text exists for exactly this.
//
// Both fixes are LOCAL custom-property redefinitions scoped to ember, not literal
// colours and not a rewrite of the shared var: `.input-area` is one step lighter via
// --og-surface, and `--og-error` is locally redefined to --og-error-text ONLY inside
// `.ctx-gauge-wrap`, so the inline `color: var(--og-error)` the gauge already writes
// (InputBar.svelte, owned by lane port-composer — not edited here) resolves to the
// ember-tuned ink without touching that file. Harbour and the other themes carry no
// such override, so their composer and gauge are provably unchanged.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const themeCss = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'theme.css'),
  'utf8',
);

// The ember block only, so a harbour-side regression can't hide behind a global match.
// theme.css is CRLF, so the closing-brace search tolerates an optional \r.
function block(src: string, marker: string): string {
  const start = src.indexOf(marker);
  const end = src.slice(start).search(/\r?\n\}\r?\n/);
  return src.slice(start, start + end);
}

const emberBlock = (src: string) => block(src, ':root[data-theme="ember"]');
const harbourBlock = (src: string) => block(src, ':root[data-theme="harbour"]');

describe('ember token audit (t-qn0wj5)', () => {
  it('steps the composer surface one step lighter on ember, via a token', () => {
    expect(themeCss).toMatch(
      /:root\[data-theme=['"]ember['"]\]\s*\.input-area\s*\{[^}]*background:\s*var\(--og-surface\)/,
    );
  });

  it('redefines --og-error to --og-error-text inside the gauge wrap, on ember only', () => {
    expect(themeCss).toMatch(
      /:root\[data-theme=['"]ember['"]\]\s*\.ctx-gauge-wrap\s*\{[^}]*--og-error:\s*var\(--og-error-text\)/,
    );
  });

  it('never hard-codes a colour for the override — every value is an --og-* var', () => {
    const rules = themeCss.match(/:root\[data-theme=['"]ember['"]\]\s*\.(input-area|ctx-gauge-wrap)\s*\{[^}]*\}/g) || [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const literals = [...rule.matchAll(/#[0-9a-fA-F]{3,8}\b/g), ...rule.matchAll(/\brgba?\(/g)];
      expect(literals.map((m) => m[0]), rule).toEqual([]);
    }
  });

  it('leaves harbour with no matching override (the fix is ember-scoped, not global)', () => {
    const harbour = harbourBlock(themeCss);
    expect(harbour).not.toMatch(/--og-error:\s*var\(--og-error-text\)/);
  });

  it('does not touch the shared --og-error token value itself', () => {
    const ember = emberBlock(themeCss);
    // The theme's OWN --og-error declaration (inside the palette block) must stay
    // literal hex — only the scoped override two rules further down redefines
    // --og-error locally. This guards against "fixing" the bug by editing the
    // palette instead of adding the scoped override.
    //
    // --og-surface's own literal is NOT pinned here any more: t-ru0p04 darkened it
    // (ddcfb2 -> bfa988, one step toward the owner's #b8a07e swatch) as part of the
    // main-surfaces darkening this ticket asked for. See t-ru0p04's own comment on
    // the ember block for the contrast numbers that move stayed inside.
    expect(ember).toMatch(/--og-error:\s*#e85540/);
  });
});

// t-ru0p04 (owner follow-up) — darkening bg/surface dropped --og-error-text/
// --og-success-text/--og-warning-text/--og-chat under 4.5:1. Each was retuned
// to a darker shade on the SAME hue. This is a COMPUTED check, not a literal
// pin: it reads whatever hex the ember block currently declares for these six
// tokens and does the real WCAG relative-luminance maths, so a future change
// to bg/surface/pane-header OR to any of the four inks re-proves the pairing
// instead of silently drifting the way the plain hex assertions above would.
function relLum(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function tokenHex(block: string, name: string): string {
  const m = block.match(new RegExp(`--og-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`ember block never declares --og-${name}`);
  return m[1];
}

describe('ember ink audit (t-ru0p04 follow-up) — the four inks clear 4.5:1 on both new surfaces', () => {
  const ember = emberBlock(themeCss);
  const bg = tokenHex(ember, 'bg');
  const surface = tokenHex(ember, 'surface');

  for (const name of ['error-text', 'success-text', 'warning-text', 'chat']) {
    it(`--og-${name} clears 4.5:1 on --og-bg (${bg}) and --og-surface (${surface})`, () => {
      const ink = tokenHex(ember, name);
      expect(contrastRatio(ink, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
