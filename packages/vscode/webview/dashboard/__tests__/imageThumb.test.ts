// imageThumb.test.ts — t-dclrh8: the pure decode/downscale/re-encode path a
// phone thumbnail goes through. No `vscode` import in imageThumb.ts, so this
// runs the module directly against real PNG/JPEG bytes it builds itself
// (pngjs to construct the fixture, jpeg-js to build a JPEG one) rather than a
// committed binary.

import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { encode as encodeJpeg } from 'jpeg-js';
import { encodeThumbnail, encodeThumbnailDataUrl, thumbnailDataUrl } from '../../../src/dashboard/imageThumb';
import { PHONE_IMAGE_BYTE_CAP } from '../../../src/dashboard/toolImageCard';

/** A 1920x1080 PNG with real, JPEG-compressible content: horizontal colour
 *  bands over a diagonal gradient, not a flat fill (which would compress to
 *  nearly nothing at any quality and prove little) and not noise (which is
 *  the one input real JPEG cannot compress, and is not what a screenshot or
 *  a photo actually looks like). */
function png1080p(): Buffer {
  const width = 1920;
  const height = 1080;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const band = Math.floor(y / 60) % 6;
      const bands = [
        [220, 60, 60], [60, 220, 60], [60, 60, 220],
        [220, 220, 60], [60, 220, 220], [220, 60, 220],
      ];
      const [r, g, b] = bands[band];
      png.data[i] = Math.min(255, r + Math.floor((x / width) * 30));
      png.data[i + 1] = Math.min(255, g + Math.floor((y / height) * 30));
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function jpeg64x48(): Buffer {
  const width = 64;
  const height = 48;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 3) % 255;
    data[i * 4 + 1] = (i * 5) % 255;
    data[i * 4 + 2] = (i * 7) % 255;
    data[i * 4 + 3] = 255;
  }
  return encodeJpeg({ width, height, data }, 90).data;
}

const GIF_HEADER = Buffer.from('GIF89a', 'ascii');

describe('encodeThumbnail — the ticket fixture', () => {
  it('turns a 1920x1080 PNG into a JPEG <= 40 KB with longest side <= 512', () => {
    const jpeg = encodeThumbnail(png1080p(), 'image/png');
    expect(jpeg).toBeDefined();
    expect(jpeg!.length).toBeLessThanOrEqual(PHONE_IMAGE_BYTE_CAP);
    // JPEG SOF0 marker (0xFFC0) carries height then width as two big-endian
    // u16 fields five bytes in; decode it back out instead of trusting a
    // hand-rolled offset scan.
    const decoded = decodeSize(jpeg!);
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(512);
  });

  it('reports the real byte count for the record', () => {
    const jpeg = encodeThumbnail(png1080p(), 'image/png');
    // eslint-disable-next-line no-console
    console.log(`[imageThumb] 1920x1080 PNG -> ${jpeg?.length ?? 'undefined'} byte JPEG (cap ${PHONE_IMAGE_BYTE_CAP})`);
    expect(jpeg).toBeDefined();
  });

  it('decodes a JPEG source too, not only PNG', () => {
    const jpeg = encodeThumbnail(jpeg64x48(), 'image/jpeg');
    expect(jpeg).toBeDefined();
    expect(jpeg!.length).toBeLessThanOrEqual(PHONE_IMAGE_BYTE_CAP);
  });

  it('returns undefined for a GIF — the placeholder path stays', () => {
    expect(encodeThumbnail(GIF_HEADER, 'image/gif')).toBeUndefined();
  });

  it('returns undefined for WebP and any other unknown mime', () => {
    expect(encodeThumbnail(Buffer.from('RIFF....WEBP'), 'image/webp')).toBeUndefined();
    expect(encodeThumbnail(Buffer.from('nonsense'), 'application/octet-stream')).toBeUndefined();
  });

  it('leaves a small source below the cap untouched in scale (no upscale)', () => {
    const jpeg = encodeThumbnail(jpeg64x48(), 'image/jpeg');
    const decoded = decodeSize(jpeg!);
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(48);
  });
});

describe('encodeThumbnailDataUrl / thumbnailDataUrl — the wire shapes', () => {
  it('wraps the JPEG as a data:image/jpeg;base64 URI', () => {
    const url = encodeThumbnailDataUrl(png1080p(), 'image/png');
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('undefined stays undefined through the wrapper', () => {
    expect(encodeThumbnailDataUrl(GIF_HEADER, 'image/gif')).toBeUndefined();
  });

  it('thumbnailDataUrl parses a source data: URI and re-encodes it', () => {
    const source = `data:image/png;base64,${png1080p().toString('base64')}`;
    const out = thumbnailDataUrl(source);
    expect(out).toMatch(/^data:image\/jpeg;base64,/);
    const bytes = Buffer.from(out!.slice(out!.indexOf(',') + 1), 'base64');
    expect(bytes.length).toBeLessThanOrEqual(PHONE_IMAGE_BYTE_CAP);
  });

  it('a malformed data: URI yields undefined rather than throwing', () => {
    expect(thumbnailDataUrl('not-a-data-url')).toBeUndefined();
    expect(thumbnailDataUrl('data:image/png;base64,')).toBeUndefined();
  });
});

/** Reads width/height back out of an encoded JPEG's SOF0 marker, so the
 *  "longest side <= 512" claim is checked against the real encoded bytes
 *  instead of trusted from the function under test. */
function decodeSize(jpeg: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < jpeg.length - 1) {
    if (jpeg[i] !== 0xff) { i++; continue; }
    const marker = jpeg[i + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      const height = jpeg.readUInt16BE(i + 5);
      const width = jpeg.readUInt16BE(i + 7);
      return { width, height };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = jpeg.readUInt16BE(i + 2);
    i += 2 + len;
  }
  throw new Error('no SOF marker found');
}
