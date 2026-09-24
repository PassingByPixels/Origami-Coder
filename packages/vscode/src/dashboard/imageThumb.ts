// imageThumb.ts — the pure decode/downscale/re-encode PATH for a phone thumbnail.
//
// A phone frame is metered (docs/TOOL_CARD_CONTRACT.md), and a full-resolution
// PNG or JPEG blows the budget by two orders of magnitude. This turns PNG/JPEG
// bytes into a JPEG thumbnail whose longest side is at most 512 px and whose
// encoded size is at most `PHONE_IMAGE_BYTE_CAP` (40 KB) — or `undefined` when
// the source cannot be decoded (GIF, WebP, a corrupt file) or cannot be gotten
// under the cap at all, in which case the caller's placeholder stays.
//
// Bytes in, bytes out: no `vscode` import, no filesystem, no network. The host
// side that reads a file off disk is readImageThumb.ts.

import { PNG } from 'pngjs';
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { PHONE_IMAGE_BYTE_CAP } from './toolImageCard';

/** An RGBA bitmap, the common shape both decoders and the encoder agree on. */
interface Bitmap {
  width: number;
  height: number;
  data: Buffer;
}

const MAX_SIDE = 512;
/** Stepped high to low: the first quality that fits under the cap wins, so a
 *  small source keeps its best-looking encode instead of always paying the
 *  worst one. */
const QUALITY_STEPS = [80, 70, 60, 50, 40];

/**
 * The real image format of `bytes`, read off its magic-byte signature —
 * never off a filename or a claimed mime, both of which can lie (the ticket's
 * own bug report: an extension-trusting path fed the wrong mime downstream).
 * Only the four formats a read-image card ever needs to show are recognised;
 * anything else is `undefined`, and the caller falls back to the
 * click-to-open text rather than guessing.
 */
export function sniffImageMime(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

function decodeBitmap(bytes: Buffer, mime: string): Bitmap | undefined {
  if (mime === 'image/png') {
    const png = PNG.sync.read(bytes);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    const jpg = decodeJpeg(bytes);
    return { width: jpg.width, height: jpg.height, data: jpg.data };
  }
  return undefined;
}

/** Nearest-neighbour resample to a longest side of `maxSide`. A bitmap already
 *  at or under `maxSide` on both axes is returned untouched. */
function scaleToFit(bitmap: Bitmap, maxSide: number): Bitmap {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) return bitmap;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcY = Math.min(bitmap.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(bitmap.width - 1, Math.floor(x / scale));
      const srcOffset = (srcY * bitmap.width + srcX) * 4;
      const dstOffset = (y * width + x) * 4;
      bitmap.data.copy(data, dstOffset, srcOffset, srcOffset + 4);
    }
  }
  return { width, height, data };
}

/**
 * PNG or JPEG bytes -> a JPEG thumbnail under the cap, or `undefined` when the
 * mime is not decodable (GIF, WebP, unknown) or no quality step gets under
 * `capBytes`. `capBytes` defaults to the phone's cap so the same function
 * proves the ticket's fixture claim in tests.
 */
export function encodeThumbnail(bytes: Buffer, mime: string, capBytes = PHONE_IMAGE_BYTE_CAP): Buffer | undefined {
  // pngjs and jpeg-js THROW on a truncated or corrupt file rather than
  // returning nothing. Every caller sits inside a broadcast — the desk's
  // stampToolImages in DashboardPanel.post()/postTo(), the phone's
  // shapeForPhone in RemoteView.postMessage — so an escaping throw aborts the
  // whole fan-out and truncates a hydration burst. A picture that cannot be
  // decoded is the same answer as a GIF: undefined, and the caller's
  // placeholder stays.
  try {
    const bitmap = decodeBitmap(bytes, mime);
    if (!bitmap) return undefined;
    const scaled = scaleToFit(bitmap, MAX_SIDE);
    for (const quality of QUALITY_STEPS) {
      const jpeg = encodeJpeg({ width: scaled.width, height: scaled.height, data: scaled.data }, quality);
      if (jpeg.data.length <= capBytes) return jpeg.data;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** `encodeThumbnail`, as a `data:image/jpeg;base64,...` URI ready for an
 *  `<img src>` — or `undefined` for the same reasons. */
export function encodeThumbnailDataUrl(bytes: Buffer, mime: string, capBytes = PHONE_IMAGE_BYTE_CAP): string | undefined {
  const jpeg = encodeThumbnail(bytes, mime, capBytes);
  return jpeg ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : undefined;
}

/** A `data:<mime>;base64,<data>` URI — the shape acpToolContent.ts makes for a
 *  browser screenshot — turned into a thumbnail URI of the same shape. */
const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

export function thumbnailDataUrl(dataUrl: string, capBytes = PHONE_IMAGE_BYTE_CAP): string | undefined {
  const match = DATA_URL.exec(dataUrl);
  if (!match) return undefined;
  return encodeThumbnailDataUrl(Buffer.from(match[2], 'base64'), match[1], capBytes);
}
