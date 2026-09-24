// Origami Remote — a QR encoder, byte mode, EC level M, versions 1-10.
//
// In-house because the input is a pairing SECRET: a QR library is a third party
// that gets handed Ks on every pairing. Byte mode and EC M are all the pairing
// URL needs, so the general cases are absent rather than half-written.
//
// It is in src/ rather than webview/: tsconfig pins rootDir to src/, so a host
// file cannot import from webview/ (TS6059).

export interface QrCode {
  version: number;
  size: number;
  mask: number;
  /** [row][col], true = dark. */
  modules: boolean[][];
}

// ---------------------------------------------------------------- GF(256) --

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Reed-Solomon generator polynomial of the given degree. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j]!, 1);
      next[j + 1] ^= gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** The `degree` error-correction codewords for one data block. */
export function rsEncode(data: Uint8Array, degree: number): Uint8Array {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1]!, factor);
  }
  return rem;
}

// ----------------------------------------------------------------- tables --

/** Per version (index 1-10): [ecCodewordsPerBlock, group1Blocks,
 *  group1DataCodewords, group2Blocks, group2DataCodewords] at EC level M. */
const EC_BLOCKS_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 0, 0, 0, 0], // unused index 0
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
];

export const MAX_VERSION = 10;
/** M = 0b00 in the format-information EC field (L=01, M=00, Q=11, H=10). */
const EC_LEVEL_BITS = 0b00;

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT_POSITIONS: ReadonlyArray<readonly number[]> = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

export function versionSize(version: number): number {
  return version * 4 + 17;
}

/** Data codewords a version holds at EC M — the sum of both groups. */
export function dataCapacity(version: number): number {
  const [, b1, d1, b2, d2] = EC_BLOCKS_M[version]!;
  return b1 * d1 + b2 * d2;
}

/** Total codewords (data + EC), derived from the MATRIX GEOMETRY rather than a
 *  table, so a typo in EC_BLOCKS_M cannot pass the test silently. */
export function totalCodewords(version: number): number {
  let bits = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const n = Math.floor(version / 7) + 2;
    bits -= (25 * n - 10) * n - 55;
    if (version >= 7) bits -= 36;
  }
  return Math.floor(bits / 8);
}

// ----------------------------------------------------------------- encode --

class BitBuffer {
  public readonly bits: number[] = [];
  public push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** Smallest version 1-10 whose EC-M data capacity holds `byteLength` bytes. The
 *  8-bit character count grows to 16 bits from version 10. */
export function pickVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const headerBits = 4 + (v >= 10 ? 16 : 8);
    if (Math.ceil((headerBits + byteLength * 8) / 8) <= dataCapacity(v)) return v;
  }
  throw new Error(`origami remote: ${byteLength} bytes needs a QR version above ${MAX_VERSION}`);
}

function dataCodewords(text: string, version: number): Uint8Array {
  const body = new TextEncoder().encode(text);
  const buf = new BitBuffer();
  buf.push(0b0100, 4); // byte mode
  buf.push(body.length, version >= 10 ? 16 : 8);
  for (const byte of body) buf.push(byte, 8);

  const capacityBits = dataCapacity(version) * 8;
  if (buf.bits.length > capacityBits) {
    throw new Error(`origami remote: payload overflows QR version ${version}`);
  }
  // Terminator (up to four zero bits), then pad to a byte boundary.
  buf.push(0, Math.min(4, capacityBits - buf.bits.length));
  buf.push(0, (8 - (buf.bits.length % 8)) % 8);

  const out = new Uint8Array(dataCapacity(version));
  for (let i = 0; i < buf.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buf.bits[i + j]!;
    out[i / 8] = byte;
  }
  // Alternating pad bytes fill the rest, ALWAYS starting with 0xEC at the FIRST
  // pad codeword — keying off the absolute index starts with 0x11 sometimes.
  const firstPad = buf.bits.length / 8;
  for (let i = firstPad; i < out.length; i++) out[i] = (i - firstPad) % 2 === 0 ? 0xec : 0x11;
  return out;
}

/** Split into blocks, RS-encode each, then INTERLEAVE — data codeword i of every
 *  block, then EC codeword i — so a burst of damage spreads across blocks. */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const [ecLen, b1, d1, b2, d2] = EC_BLOCKS_M[version]!;
  const blocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const size = i < b1 ? d1 : d2;
    const block = data.subarray(offset, offset + size);
    offset += size;
    blocks.push(block);
    ecBlocks.push(rsEncode(block, ecLen));
  }
  const out: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return new Uint8Array(out);
}

// ----------------------------------------------------------------- matrix --

interface Canvas {
  size: number;
  modules: boolean[][];
  reserved: boolean[][];
}

function blankCanvas(size: number): Canvas {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setModule(c: Canvas, y: number, x: number, dark: boolean): void {
  c.modules[y]![x] = dark;
  c.reserved[y]![x] = true;
}

function drawFinder(c: Canvas, cy: number, cx: number): void {
  // The 7x7 finder plus its one-module separator, drawn as a 9x9 stamp so the
  // separator is reserved too (it is white, and data must not land in it).
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const y = cy + dy;
      const x = cx + dx;
      if (y < 0 || y >= c.size || x < 0 || x >= c.size) continue;
      const d = Math.max(Math.abs(dy), Math.abs(dx));
      setModule(c, y, x, d !== 2 && d !== 4);
    }
  }
}

function drawFunctionPatterns(c: Canvas, version: number): void {
  const size = c.size;
  // Timing patterns first: the alignment patterns overwrite them where they
  // overlap, which is the order the standard specifies.
  for (let i = 0; i < size; i++) {
    setModule(c, 6, i, i % 2 === 0);
    setModule(c, i, 6, i % 2 === 0);
  }
  drawFinder(c, 3, 3);
  drawFinder(c, 3, size - 4);
  drawFinder(c, size - 4, 3);

  const positions = ALIGNMENT_POSITIONS[version]!;
  for (const cy of positions) {
    for (const cx of positions) {
      // The three corners belong to the finders.
      const atFinder =
        (cy === 6 && cx === 6) ||
        (cy === 6 && cx === size - 7) ||
        (cy === size - 7 && cx === 6);
      if (atFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setModule(c, cy + dy, cx + dx, Math.max(Math.abs(dy), Math.abs(dx)) !== 1);
        }
      }
    }
  }

  // Reserve the two format-information strips and the dark module. Values are
  // written later, once the mask is chosen.
  for (let i = 0; i < 9; i++) {
    reserve(c, 8, i);
    reserve(c, i, 8);
  }
  for (let i = 0; i < 8; i++) {
    reserve(c, 8, size - 1 - i);
    reserve(c, size - 1 - i, 8);
  }
  setModule(c, size - 8, 8, true); // the always-dark module

  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + c.size - 11;
      setModule(c, b, a, dark);
      setModule(c, a, b, dark);
    }
  }
}

function reserve(c: Canvas, y: number, x: number): void {
  c.reserved[y]![x] = true;
}

/** 18-bit version information: 6 data bits + a 12-bit BCH(18,6) remainder,
 *  generator 0x1F25. Not XOR-masked (unlike the format field). */
export function versionInfoBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return ((version << 12) | rem) >>> 0;
}

/** 15-bit format information: 2 EC bits + 3 mask bits, a 10-bit BCH(15,5)
 *  remainder with generator 0x537, then XOR 0x5412 so an all-zero field is
 *  never valid. */
export function formatInfoBits(mask: number): number {
  const data = (EC_LEVEL_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) >>> 0;
}

function drawFormatInfo(c: Canvas, mask: number): void {
  const bits = formatInfoBits(mask);
  const size = c.size;
  // ROW AND COLUMN ARE NOT INTERCHANGEABLE: the standard wants `modules[i][8]`,
  // and a transposed write fails both copies' BCH check. Bit 14 is the most
  // significant; copy 1 is column 8 down (b0..b5), (7,8), (8,8), row 8 leftwards.
  for (let i = 0; i <= 5; i++) c.modules[i]![8] = bit(bits, i);
  c.modules[7]![8] = bit(bits, 6);
  c.modules[8]![8] = bit(bits, 7);
  c.modules[8]![7] = bit(bits, 8);
  for (let i = 9; i < 15; i++) c.modules[8]![14 - i] = bit(bits, i);
  // Second copy: row 8 from the right edge inwards holds b0..b7, then column 8
  // from the bottom edge upwards holds b8..b14.
  for (let i = 0; i < 8; i++) c.modules[8]![size - 1 - i] = bit(bits, i);
  for (let i = 8; i < 15; i++) c.modules[size - 15 + i]![8] = bit(bits, i);
  c.modules[size - 8]![8] = true; // dark module, restated after the strip write
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) === 1;
}

/** The standard's two-module-wide upward/downward snake, right to left,
 *  skipping the vertical timing column. */
function placeData(c: Canvas, codewords: Uint8Array): void {
  let i = 0;
  for (let right = c.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < c.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? c.size - 1 - vert : vert;
        if (c.reserved[y]![x]) continue;
        if (i < codewords.length * 8) {
          c.modules[y]![x] = bit(codewords[i >>> 3]!, 7 - (i & 7));
          i++;
        }
        // Remainder bits stay light, which is what the standard requires.
      }
    }
  }
}

const MASKS: ReadonlyArray<(y: number, x: number) => boolean> = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (_y, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

function applyMask(c: Canvas, mask: number): void {
  const fn = MASKS[mask]!;
  for (let y = 0; y < c.size; y++) {
    for (let x = 0; x < c.size; x++) {
      if (!c.reserved[y]![x] && fn(y, x)) c.modules[y]![x] = !c.modules[y]![x];
    }
  }
}

/** The four penalty rules. Lowest total wins the mask. */
export function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  // Rule 1 — runs of five or more same-coloured modules in a line.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const prev = horizontal ? modules[i]![j - 1]! : modules[j - 1]![i]!;
        const cur = horizontal ? modules[i]![j]! : modules[j]![i]!;
        if (cur === prev) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  }
  // Rule 2 — every 2x2 block of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = modules[y]![x]!;
      if (v === modules[y]![x + 1] && v === modules[y + 1]![x] && v === modules[y + 1]![x + 1]) score += 3;
    }
  }
  // Rule 3 — the finder-lookalike 1:1:3:1:1 pattern with four light modules
  // on either side, which is what confuses a scanner.
  const patterns = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true],
  ];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      for (const pattern of patterns) {
        let rowHit = true;
        let colHit = true;
        for (let k = 0; k < 11; k++) {
          if (modules[i]![j + k] !== pattern[k]) rowHit = false;
          if (modules[j + k]![i] !== pattern[k]) colHit = false;
        }
        if (rowHit) score += 40;
        if (colHit) score += 40;
      }
    }
  }
  // Rule 4 — deviation of the dark-module proportion from 50%.
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** Encode `text` as a QR symbol. Deterministic for the same text. */
export function encodeQr(text: string): QrCode {
  const byteLength = new TextEncoder().encode(text).length;
  const version = pickVersion(byteLength);
  const codewords = interleave(dataCodewords(text, version), version);

  let best: { mask: number; canvas: Canvas; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const canvas = blankCanvas(versionSize(version));
    drawFunctionPatterns(canvas, version);
    placeData(canvas, codewords);
    applyMask(canvas, mask);
    drawFormatInfo(canvas, mask);
    const score = penalty(canvas.modules);
    if (!best || score < best.score) best = { mask, canvas, score };
  }
  const chosen = best!;
  return { version, size: chosen.canvas.size, mask: chosen.mask, modules: chosen.canvas.modules };
}

/** Render as an SVG string. One `<path>` of rectangles rather than a rect per
 *  module: 2,200 elements makes the pairing panel visibly slow to paint. */
export function qrSvg(code: QrCode, quietZone = 4): string {
  const span = code.size + quietZone * 2;
  const parts: string[] = [];
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y]![x]) parts.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">` +
    `<rect width="${span}" height="${span}" fill="#ffffff"/>` +
    `<path d="${parts.join('')}" fill="#000000"/>` +
    `</svg>`
  );
}
