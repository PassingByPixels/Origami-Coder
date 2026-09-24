// Origami Remote / Flock — the REAL-SCANNER gate for src/remote/qr.ts.
//
// remoteQr.test.ts decodes the finished symbol with a decoder written in the
// same file, from the same reading of the standard, by the same hand. That is
// an ECHO: a convention the encoder got wrong is a convention the mirror gets
// wrong too, and the pair agrees forever. Origami Folio shipped a QR no phone
// could read behind exactly such a test (wiki origami_folio_launch, "QR encoder
// fix — the echo-test trap").
//
// This file decodes with jsQR instead — an INDEPENDENT computer-vision decoder
// of the same class an iPhone Camera runs, written by someone else from the
// same ISO/IEC 18004. The requirement under test is the only one that matters:
// "a phone pointed at the pairing card recovers the exact URL."
//
// jsqr is a DEV dependency. It is imported only from this file, never from
// src/ or webview/, so it cannot reach out/ or the VSIX. qr.svg.test.ts asserts
// that.
//
// The rasteriser draws the module matrix the way qrSvg does — one solid square
// per module, integer scale, a white quiet zone — so a failure here is an
// encoder bug and not a rendering artefact. No blur, no glare, no SVG
// rasteriser in the loop.

import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { encodeQr, pickVersion } from '../../../src/remote/qr';

/** The module matrix as RGBA pixels: `scale` px per module, `quiet` modules of
 *  white all round. Mirrors qrSvg's geometry exactly. */
export function rasterise(
  modules: boolean[][],
  size: number,
  scale: number,
  quiet: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255); // opaque white
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y]![x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

/** Encode, rasterise, decode with jsQR. Returns what a scanner recovers, or
 *  null when no scanner could read the symbol at all. */
function scan(text: string, scale = 8, quiet = 4): string | null {
  const code = encodeQr(text);
  const img = rasterise(code.modules, code.size, scale, quiet);
  return jsQR(img.data, img.width, img.height)?.data ?? null;
}

// ---------------------------------------------------------- the payloads --

/** The pairing URL the Remote pane actually encodes: relay origin + fragment
 *  carrying the 22-char rid and the 43-char base64url session key. 103 bytes,
 *  which pickVersion places at version 6. */
const PAIRING = `https://relay.origamilabs.nl/app/#v1.${'r'.repeat(22)}.${'Ks9-_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abc'}`;

/** A real flock invite, built to the shape packages/engine/src/flock/store.ts
 *  emits: origami://flock/invite#v2.<43>.<43>.<name b64url>.<22 token>.<issuedAt
 *  b64url>[.<relay b64url>]. 162 bytes bare (version 9), 190 with the relay
 *  segment (version 10) — the two largest versions the encoder supports, and
 *  the ones with UNEQUAL RS block splits. */
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const INVITE = [
  'origami://flock/invite#v2',
  'MCowBQYDK2VwAyEA1zK9-QpXn0aBcDeFgHiJkLmNoPqRsTuVwXyZ012',  // signPub, 43
  'X25519pub-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',           // boxPub, 43
  b64url('Jane'),
  'Tk9uY2VUb2tlbjE2Qnl0',                                      // 16-byte token, 22
  b64url(String(1756900000000)),
].join('.');
const INVITE_WITH_RELAY = `${INVITE}.${b64url('relay.origamilabs.nl')}`;

describe('QR — an independent scanner (jsQR) reads what the encoder writes', () => {
  it('decodes the real pairing URL — the production case', () => {
    expect(encodeQr(PAIRING).version).toBe(6); // guard: the payload really is the shipped one
    expect(scan(PAIRING)).toBe(PAIRING);
  });

  it('decodes a real flock invite', () => {
    expect(scan(INVITE)).toBe(INVITE);
  });

  it('decodes a flock invite carrying the relay segment', () => {
    expect(scan(INVITE_WITH_RELAY)).toBe(INVITE_WITH_RELAY);
  });

  it('decodes a minimal version-1 symbol', () => {
    expect(scan('hi')).toBe('hi');
  });

  it('round-trips UTF-8 multibyte text', () => {
    const s = 'café — naïve ☕ Ω';
    expect(scan(s)).toBe(s);
  });

  it('decodes every version 1-10, including the unequal RS block splits', () => {
    // One payload per version: the smallest byte length that pickVersion sends
    // to v, so the sweep really covers alignment patterns (v2+), the version
    // information field (v7+) and two-group block layouts (v8, v9, v10).
    const seen = new Set<number>();
    for (let len = 1; len <= 210 && seen.size < 10; len++) {
      const v = pickVersion(len);
      if (seen.has(v)) continue;
      seen.add(v);
      const s = 'X'.repeat(len);
      expect(encodeQr(s).version, `version for ${len} bytes`).toBe(v);
      expect(scan(s), `version ${v} (${len} bytes)`).toBe(s);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  // ------------------------------------------- one format copy at a time --
  //
  // The format field is written TWICE, and jsQR — like any real decoder — takes
  // whichever copy passes its BCH check. So a bug in ONE copy is invisible to a
  // plain scan: proven by mutation, reversing copy 1 alone left all seven cases
  // above green. The shipped bug transposed BOTH, which is why the QR died
  // outright rather than quietly losing its redundancy.
  //
  // Half a format field is half the error budget a phone has in bad light. So
  // each copy is gated on its own: blank the other one's fifteen cells, which
  // makes that copy fail its check, and require the survivor to carry the read.
  // The coordinates below are a DAMAGE MAP, not a decoder — they say which
  // modules to erase, never how to interpret them; jsQR still does all the
  // reading. (Mutating either copy turns the matching case red. That is the
  // only evidence these two lines are right.)
  type Cell = [row: number, col: number];
  /** Copy 1 wraps the top-left finder; its fifteen cells are size-independent. */
  const COPY_1: Cell[] = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
    [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  /** Copy 2 runs along row 8 from the right edge, then up column 8 from the
   *  bottom. Its last cell in column 8 is the always-dark module, which belongs
   *  to neither copy and is left alone. */
  const COPY_2 = (n: number): Cell[] => [
    ...Array.from({ length: 8 }, (_, i): Cell => [8, n - 1 - i]),
    ...Array.from({ length: 7 }, (_, i): Cell => [n - 7 + i, 8]),
  ];

  /** Encode, erase one format copy, then let jsQR read the other. */
  function scanOnOneCopy(text: string, keep: 1 | 2): string | null {
    const code = encodeQr(text);
    const doomed = keep === 1 ? COPY_2(code.size) : COPY_1;
    for (const [y, x] of doomed) code.modules[y]![x] = false;
    const img = rasterise(code.modules, code.size, 8, 4);
    return jsQR(img.data, img.width, img.height)?.data ?? null;
  }

  it('the FIRST format copy alone carries the pairing URL', () => {
    expect(scanOnOneCopy(PAIRING, 1)).toBe(PAIRING);
  });

  it('the SECOND format copy alone carries the pairing URL', () => {
    expect(scanOnOneCopy(PAIRING, 2)).toBe(PAIRING);
  });

  it('survives the module size the pairing card actually renders', () => {
    // The card is a fixed pixel box; at v6 (41 modules + 8 quiet) it is barely
    // 3 px per module. Scanning at scale 3 proves the matrix is not merely
    // correct in the abstract but readable at the size a phone sees.
    expect(scan(PAIRING, 3)).toBe(PAIRING);
  });
});
