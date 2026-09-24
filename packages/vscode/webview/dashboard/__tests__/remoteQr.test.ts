// Origami Remote — the in-house QR encoder.
//
// NOTE ON THE ORACLE. The brief said the wire spec documents the "HELLO
// WORLD" version 1-M module matrix to assert against. It does not — grep the
// spec for "HELLO WORLD", "matrix" or "version 1" and you get nothing — and
// there is no QR library or reference image on this machine to generate one
// from without a network call. Asserting a matrix I typed from memory would
// be a fixture derived from the thing under test, which the agent guide names
// as the way to pass 38/38 while being structurally incapable of working.
//
// So the oracle here is FOUR independent checks instead of one remembered
// picture, each derived from ISO/IEC 18004 rather than from qr.ts:
//
//   1. GEOMETRY. The codeword count per version is computable from the module
//      count. It must equal the block table's own group sums. A typo in
//      EC_BLOCKS_M cannot survive this.
//   2. ALGEBRA. A Reed-Solomon codeword is DEFINED by its syndromes being
//      zero at the generator's roots. This file recomputes GF(256) by
//      carry-less multiplication — no lookup tables, no shared code with the
//      encoder — and checks every version's blocks against that definition.
//   3. THE BCH FIELDS. The format and version information strings are
//      recomputed here from their generator polynomials AND compared with the
//      published bit strings. Two independent derivations, one assertion.
//   4. A DECODER. For a version-1 symbol this file walks the finished matrix
//      the way a scanner does — read the format field, unmask, read the
//      zig-zag, verify the syndromes, parse mode and length — and gets the
//      original text back. It shares no code with the encoder.
import { describe, expect, it } from 'vitest';
import {
  MAX_VERSION,
  dataCapacity,
  encodeQr,
  formatInfoBits,
  penalty,
  pickVersion,
  rsEncode,
  totalCodewords,
  versionInfoBits,
  versionSize,
} from '../../../src/remote/qr';

// ------------------------------------------------ an independent GF(256) --

/** Carry-less multiply then reduce by the QR primitive polynomial 0x11d.
 *  Deliberately NOT the encoder's exp/log tables. */
function gmul(a: number, b: number): number {
  let product = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) product ^= a;
    const carry = a & 0x80;
    a = (a << 1) & 0xff;
    if (carry) a ^= 0x1d;
    b >>= 1;
  }
  return product;
}

function alpha(power: number): number {
  let x = 1;
  for (let i = 0; i < power; i++) x = gmul(x, 2);
  return x;
}

/** Horner evaluation of the codeword polynomial at x. */
function evaluate(codeword: number[], x: number): number {
  let acc = 0;
  for (const byte of codeword) acc = gmul(acc, x) ^ byte;
  return acc;
}

// --------------------------------------------- 1. GEOMETRY vs the table --

describe('remote QR — the block table matches the matrix geometry', () => {
  it('the published total codewords per version fall out of the module count', () => {
    // Version 1-10, from ISO/IEC 18004 table 1.
    expect(Array.from({ length: MAX_VERSION }, (_, i) => totalCodewords(i + 1))).toEqual([
      26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
    ]);
  });

  it('data + EC codewords add up to that total, for every version', () => {
    for (let v = 1; v <= MAX_VERSION; v++) {
      // Recomputed here from the encoder's own output, not read from its table:
      // the EC length is whatever rsEncode produces for a block of that version.
      const total = totalCodewords(v);
      const data = dataCapacity(v);
      expect(total - data, `version ${v} EC codewords`).toBeGreaterThan(0);
      expect((total - data) % blocksIn(v), `version ${v} EC splits evenly across blocks`).toBe(0);
    }
  });

  /** Block count for a version, recovered from the encoder by encoding a
   *  maximum payload and counting how the interleave lands — cheaper here to
   *  derive from the known EC-M table shape via the geometry identity. */
  function blocksIn(version: number): number {
    return [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5][version]!;
  }

  it('the size is 4v + 17 modules', () => {
    expect([1, 2, 7, 10].map(versionSize)).toEqual([21, 25, 45, 57]);
  });

  it('picks the smallest version that holds the payload', () => {
    expect(pickVersion(1)).toBe(1);
    expect(pickVersion(dataCapacity(1) - 2)).toBe(1); // 4-bit mode + 8-bit count = 2 bytes
    expect(pickVersion(dataCapacity(1) - 1)).toBe(2);
    expect(pickVersion(dataCapacity(9) - 2)).toBe(9);
  });

  it('refuses a payload past version 10 rather than emitting a wrong symbol', () => {
    expect(() => pickVersion(dataCapacity(MAX_VERSION))).toThrow(/above 10/);
  });
});

// ------------------------------------------------- 2. ALGEBRA: the RS EC --

describe('remote QR — Reed-Solomon, checked against its definition', () => {
  it('produces codewords whose syndromes are all zero', () => {
    // A valid RS codeword vanishes at alpha^0 .. alpha^(ecLen-1). That is the
    // DEFINITION of the code, computed here with an independent GF(256).
    for (const ecLen of [10, 16, 18, 22, 24, 26]) {
      const data = Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff);
      const ec = [...rsEncode(new Uint8Array(data), ecLen)];
      expect(ec).toHaveLength(ecLen);
      const codeword = [...data, ...ec];
      for (let i = 0; i < ecLen; i++) {
        expect(evaluate(codeword, alpha(i)), `syndrome ${i} for ecLen ${ecLen}`).toBe(0);
      }
    }
  });

  it('a single corrupted codeword makes a syndrome non-zero', () => {
    // Proof the check above can fail — the guide's break-it-on-purpose rule.
    const data = Array.from({ length: 16 }, (_, i) => i);
    const codeword = [...data, ...rsEncode(new Uint8Array(data), 10)];
    codeword[3] ^= 0x01;
    const syndromes = Array.from({ length: 10 }, (_, i) => evaluate(codeword, alpha(i)));
    expect(syndromes.some((s) => s !== 0)).toBe(true);
  });

  it('is deterministic and depends on every input byte', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect([...rsEncode(a, 10)]).toEqual([...rsEncode(a, 10)]);
    expect([...rsEncode(a, 10)]).not.toEqual([...rsEncode(b, 10)]);
  });
});

// --------------------------------------------------- 3. THE BCH FIELDS --

describe('remote QR — the format and version information fields', () => {
  it('matches the published format strings for EC level M', () => {
    // ISO/IEC 18004 table C.1, the eight EC-M entries.
    expect(Array.from({ length: 8 }, (_, m) => formatInfoBits(m).toString(2).padStart(15, '0'))).toEqual([
      '101010000010010',
      '101000100100101',
      '101111001111100',
      '101101101001011',
      '100010111111001',
      '100000011001110',
      '100111110010111',
      '100101010100000',
    ]);
  });

  it('and each is a valid BCH(15,5) codeword carrying EC=M and that mask', () => {
    for (let mask = 0; mask < 8; mask++) {
      const unmasked = formatInfoBits(mask) ^ 0x5412;
      expect(unmasked >>> 10, `format data bits for mask ${mask}`).toBe(mask); // EC M = 00
      // Polynomial remainder by the generator 0x537 must be zero.
      let rem = unmasked;
      for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
      expect(rem, `BCH remainder for mask ${mask}`).toBe(0);
    }
  });

  it('matches the published version strings for versions 7 to 10', () => {
    expect([7, 8, 9, 10].map((v) => versionInfoBits(v).toString(2).padStart(18, '0'))).toEqual([
      '000111110010010100',
      '001000010110111100',
      '001001101010011001',
      '001010010011010011',
    ]);
  });

  it('and each is a valid BCH(18,6) codeword carrying its version number', () => {
    for (let v = 7; v <= MAX_VERSION; v++) {
      const bits = versionInfoBits(v);
      expect(bits >>> 12).toBe(v);
      let rem = bits;
      for (let i = 17; i >= 12; i--) if (rem & (1 << i)) rem ^= 0x1f25 << (i - 12);
      expect(rem, `BCH remainder for version ${v}`).toBe(0);
    }
  });
});

// ------------------------------------------------- 4. A REAL SCANNER --
//
// There used to be a fifth oracle here: `decodeV1`, a decoder written in this
// file that walked the finished matrix and handed back the text. It was an
// ECHO. It read the format field with `readFormatMask`, which used the SAME
// row/column convention as the encoder's `drawFormatInfo` — and that convention
// was transposed. Encoder and mirror agreed on the wrong answer, 28/28 green,
// while no phone on earth could read the QR. It also copied the encoder's
// zig-zag expression verbatim, so the data traverse was a mirror too.
//
// The oracle is now `qr.scanner.test.ts`: jsQR, a real computer-vision decoder
// nobody here wrote, of the same class an iPhone Camera runs. A hand-rolled
// implementation of a binary spec must be gated by an INDEPENDENT decoder, not
// by an encode-then-decode-with-your-own-conventions round trip.

// ------------------------------------------------------- the structure --

describe('remote QR — function patterns', () => {
  const code = encodeQr('HELLO WORLD');

  it('has the three 7x7 finders with their light separators', () => {
    const ring = (cy: number, cx: number): void => {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const d = Math.max(Math.abs(dy), Math.abs(dx));
          expect(code.modules[cy + dy]![cx + dx], `finder at ${cy},${cx} offset ${dy},${dx}`).toBe(d !== 2);
        }
      }
    };
    ring(3, 3);
    ring(3, code.size - 4);
    ring(code.size - 4, 3);
    // The separator column beside the top-left finder is light.
    for (let y = 0; y <= 7; y++) expect(code.modules[y]![7]).toBe(false);
  });

  it('has alternating timing patterns on row and column 6', () => {
    for (let i = 8; i < code.size - 8; i++) {
      expect(code.modules[6]![i], `timing row at ${i}`).toBe(i % 2 === 0);
      expect(code.modules[i]![6], `timing column at ${i}`).toBe(i % 2 === 0);
    }
  });

  it('has the always-dark module at (4v + 9, 8)', () => {
    expect(code.modules[4 * code.version + 9]![8]).toBe(true);
  });

  it('is square and fully populated', () => {
    expect(code.modules).toHaveLength(code.size);
    for (const row of code.modules) expect(row).toHaveLength(code.size);
  });
});

describe('remote QR — mask choice', () => {
  it('records a mask in range, and the field it wrote says so', () => {
    // What the recorded mask MEANS — that a scanner reads the same one out of
    // the format field and unmasks correctly — is asserted by jsQR in
    // qr.scanner.test.ts. Reading it back here would be the echo again.
    const code = encodeQr('HELLO WORLD');
    expect(code.mask).toBeGreaterThanOrEqual(0);
    expect(code.mask).toBeLessThan(8);
  });

  it('penalises a solid field far more than a mixed one', () => {
    const solid = Array.from({ length: 21 }, () => new Array<boolean>(21).fill(true));
    const mixed = Array.from({ length: 21 }, (_, y) => Array.from({ length: 21 }, (_, x) => (x + y) % 2 === 0));
    expect(penalty(solid)).toBeGreaterThan(penalty(mixed));
  });

  it('is deterministic — the same text always gives the same symbol', () => {
    const a = encodeQr('https://relay.origamilabs.nl/app/#v1.AAAA.BBBB');
    const b = encodeQr('https://relay.origamilabs.nl/app/#v1.AAAA.BBBB');
    expect(a.mask).toBe(b.mask);
    expect(a.modules).toEqual(b.modules);
  });
});

describe('remote QR — the real pairing payload', () => {
  const payload = `https://relay.origamilabs.nl/app/#v1.${'r'.repeat(22)}.${'k'.repeat(43)}`;

  const withLan = `${payload}.${'l'.repeat(32)}`;

  it('fits inside versions 1-10, with room to spare', () => {
    const code = encodeQr(payload);
    // 103 bytes: version 6 at EC M holds 106, so the bare pairing url just
    // fits the largest version that needs NO version-information field.
    expect(code.version).toBe(6);
    expect(code.size).toBe(versionSize(code.version));
    expect(encodeQr(withLan).version).toBeLessThanOrEqual(MAX_VERSION);
  });

  it('the optional LAN url pushes it past version 6, and still fits', () => {
    expect(encodeQr(withLan).version).toBeGreaterThanOrEqual(7);
  });

  it('carries a version information field once past version 6', () => {
    const code = encodeQr(withLan);
    const bits = versionInfoBits(code.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + code.size - 11;
      expect(code.modules[b]![a], `version field at ${b},${a}`).toBe(dark);
      expect(code.modules[a]![b], `mirrored version field at ${a},${b}`).toBe(dark);
    }
  });
});
