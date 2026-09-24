// The QR as it is actually PAINTED, and the rules a paintable QR obeys.
//
// qr.scanner.test.ts proves the module matrix is spec-correct. That is only
// half of "a phone can read it": the other half is the ink. Three ways a
// correct matrix still fails on a real camera, one assertion each here —
//
//   1. IT IS THEMED. A QR drawn in `currentColor` or a theme variable turns
//      grey-on-grey the moment the reader is on a dark theme, and a camera
//      that needs a hard black/white edge sees mush. Both cards therefore sit
//      outside this board's theme-vars-only rule ON PURPOSE, and the literals
//      are load-bearing, not a lapse — so they are asserted, not trusted.
//   2. NO QUIET ZONE. A scanner locates the finders by the white margin around
//      them. CSS padding is not enough: it scales differently from the symbol,
//      it is outside the exported/screenshotted SVG, and a viewer that renders
//      the SVG alone gets none of it. The margin must be INSIDE the viewBox.
//   3. TOO SMALL. Correct, unthemed, quiet-zoned and 1.5 CSS px per module is
//      a picture of a QR. The px-per-module arithmetic is asserted from the
//      component's own CSS so a well-meant tidy-up cannot shrink it silently.
//
// Also here: the proof that jsqr stays a DEV dependency. It is a decoder used
// to test an encoder; the moment it is reachable from src/ or webview/ it is in
// the bundle, in the VSIX, and in the CWS remote-code surface for nothing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeQr, qrSvg } from '../../../src/remote/qr';

const PKG = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(PKG, p), 'utf8');

const PAIRING = `https://relay.origamilabs.nl/app/#v1.${'r'.repeat(22)}.${'k'.repeat(43)}`;
const INVITE = `origami://flock/invite#v2.${'s'.repeat(43)}.${'b'.repeat(43)}.QWRhbQ.Tk9uY2VUb2tlbjE2Qnl0.MTc1NjkwMDAwMDAwMA.cmVsYXkub3JpZ2FtaWxhYnMubmw`;

/** Every dark module's top-left corner, from the single `<path>` qrSvg emits. */
function darkCells(svg: string): Array<[number, number]> {
  const d = /<path d="([^"]*)"/.exec(svg)?.[1] ?? '';
  return [...d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => [Number(m[2]), Number(m[1])] as [number, number]);
}

describe('QR SVG — the ink', () => {
  for (const [name, payload] of [['pairing URL', PAIRING], ['flock invite', INVITE]] as const) {
    describe(name, () => {
      const code = encodeQr(payload);
      const svg = qrSvg(code);

      it('is pure black on pure white, with no theme colour anywhere', () => {
        expect(svg).toContain('fill="#ffffff"');
        expect(svg).toContain('fill="#000000"');
        expect(svg).not.toMatch(/currentColor/i);
        expect(svg).not.toMatch(/var\(--/);
        // Exactly two fills: the white ground and the black module path.
        expect([...svg.matchAll(/fill="/g)]).toHaveLength(2);
      });

      it('carries a 4-module quiet zone inside the viewBox', () => {
        expect(svg).toContain(`viewBox="0 0 ${code.size + 8} ${code.size + 8}"`);
        const cells = darkCells(svg);
        expect(cells.length).toBeGreaterThan(0);
        const rows = cells.map(([y]) => y);
        const cols = cells.map(([, x]) => x);
        // Nothing dark within 4 modules of any edge, and the symbol really does
        // start at 4 — a quiet zone that is 4 on one side and 0 on another is
        // the bug this catches.
        expect(Math.min(...rows)).toBeGreaterThanOrEqual(4);
        expect(Math.min(...cols)).toBeGreaterThanOrEqual(4);
        expect(Math.max(...rows)).toBeLessThanOrEqual(code.size + 3);
        expect(Math.max(...cols)).toBeLessThanOrEqual(code.size + 3);
        // The top-left finder's corner pins the offset exactly.
        expect(cells).toContainEqual([4, 4]);
      });

      it('fetches nothing and runs nothing', () => {
        expect(svg).not.toMatch(/<script|href=|url\(|<image/);
      });
    });
  }

  it('renders the whole symbol as one path, not thousands of rects', () => {
    // A v10 symbol is ~3,250 modules; one element per module makes the pane
    // visibly slow to paint.
    expect([...qrSvg(encodeQr(INVITE)).matchAll(/<rect/g)]).toHaveLength(1);
  });
});

describe('QR SVG — the tiles that frame it', () => {
  const pairCard = read('webview/dashboard/components/RemotePairCode.svelte');
  const flockCard = read('webview/dashboard/components/FlockInviteQr.svelte');

  /** The `width: NNNpx` the QR tile's own rule declares. */
  const tilePx = (css: string, rule: RegExp): number => {
    const m = rule.exec(css);
    expect(m, `a width matching ${rule}`).not.toBeNull();
    return Number(m![1]);
  };
  const PAIR_TILE = /\.qr \{[^}]*width: (\d+)px/;
  const FLOCK_TILE = /\.qr \{[^}]*width: (\d+)px/;

  it('the pairing tile is white in every theme', () => {
    expect(pairCard).toMatch(/\.qr\s*\{[^}]*background:\s*#ffffff/);
    expect(pairCard).not.toMatch(/\.qr\s*\{[^}]*background:\s*var\(--/);
  });

  it('the flock invite tile is white in every theme', () => {
    expect(flockCard).toMatch(/\.qr\s*\{[^}]*background:\s*#ffffff/);
    expect(flockCard).not.toMatch(/\.qr\s*\{[^}]*background:\s*var\(--/);
  });

  // BORDER-BOX, like the flock tile below it. theme.css resets every element
  // to border-box, so the padding comes OUT of the declared width — an earlier
  // version of this assertion said "content-box" and read 200 off a rule that
  // really drew 184px of SVG, which is 3.8 px per module and under its own bar.
  it('gives the pairing QR at least 4 CSS px per module', () => {
    const svgPx = tilePx(pairCard, PAIR_TILE) - 20; // border-box, 10px padding
    const span = encodeQr(PAIRING).size + 8; // + the SVG's own quiet zone
    expect(encodeQr(PAIRING).version).toBe(6);
    expect(svgPx / span).toBeGreaterThanOrEqual(4);
  });

  it('gives the flock invite QR at least 3 CSS px per module', () => {
    // border-box with 8px padding: the SVG gets width - 16.
    const svgPx = tilePx(flockCard, FLOCK_TILE) - 16;
    const span = encodeQr(INVITE).size + 8;
    expect(encodeQr(INVITE).version).toBe(10); // the relay segment pushes it here
    expect(svgPx / span).toBeGreaterThanOrEqual(3);
  });
});

describe('jsqr is a DEV dependency and cannot reach the bundle', () => {
  const pkg = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('is declared under devDependencies only', () => {
    expect(pkg.devDependencies?.['jsqr']).toBeTruthy();
    expect(pkg.dependencies?.['jsqr']).toBeUndefined();
  });

  it('is imported only from test files', () => {
    // esbuild bundles from src/extension.ts and webview/dashboard/main.ts. If
    // no shipped module names jsqr, no bundle can contain it. (The out/ and
    // VSIX greps in the report are the end-to-end half of this.)
    const shipped = [
      'src/remote/qr.ts',
      'src/dashboard/remotePane.ts',
      'src/dashboard/flockPane.ts',
      'webview/dashboard/components/RemotePairCode.svelte',
      'webview/dashboard/components/FlockInviteQr.svelte',
    ];
    // The IMPORT, not the name: qr.ts's comment cites jsQR as the gate that
    // caught the format-info bug, and that sentence is worth keeping.
    for (const f of shipped) {
      expect(read(f), f).not.toMatch(/(?:from|import|require\()\s*['"]jsqr['"]/i);
    }
  });
});
