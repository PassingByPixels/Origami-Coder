// imageDecodeThrow.test.ts — t-fisfs5 R1/R2: a corrupt picture must not throw
// out of a broadcast.
//
// pngjs and jpeg-js throw on truncated bytes. Both thumbnail callers sit inside
// a fan-out — the desk's `stampToolImages` in DashboardPanel.post()/postTo(),
// the phone's `shapeForPhone` in RemoteView.postMessage — so an escaping throw
// aborts the fan-out and truncates a hydration burst. These tests go through
// those two production call shapes, not through `encodeThumbnail` directly.
//
// Reaching the decode: `desktopImageFallback` only decodes ABOVE its cap, so
// the desk fixture is a real file larger than DESKTOP_IMAGE_BYTE_CAP (a PNG
// signature followed by junk). `readImageThumb` decodes every time, so the
// phone fixture is small. Fixtures live in a real temp dir — never a user path.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { desktopImageFallback } from '../../../src/dashboard/desktopImageFallback';
import { shapeForPhone } from '../../../src/remote/phonePictures';
import { DESKTOP_IMAGE_BYTE_CAP } from '../../../src/dashboard/toolImageCard';
import { stampToolImages } from '../../../src/dashboard/toolImageStamp';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'origami-image-decode-throw-'));
}

/** A file that sniffs as a real image and then falls apart in the decoder:
 *  the signature, then `size` bytes of junk. `PNG.sync.read` answers this with
 *  "unrecognised content at end of stream"; `jpeg-js` with "unknown JPEG
 *  marker". */
function writeCorrupt(dir: string, name: string, signature: Buffer, size: number): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.concat([signature, Buffer.alloc(size, 0x41)]));
  return filePath;
}

/** The live `toolResult` shape a read of an image produces: the engine's
 *  display block plus the model's base64 copy the stamp drops. */
function readResult(filePath: string, mime: string, bytes: number): Record<string, unknown> {
  return {
    type: 'toolResult',
    toolName: 'read',
    images: [`data:${mime};base64,AAAA`],
    rawOutputMeta: { display: { type: 'image', path: filePath, mime, bytes } },
  };
}

/** The message a phone actually receives: the desk stamp has already run (on a
 *  remote webview `webviewImageSrc` has no roots and returns undefined), so the
 *  `readImage` card is present with no `src` and RemoteView.postMessage hands
 *  THAT to shapeForPhone. */
function phoneInput(filePath: string, mime: string, bytes: number): unknown {
  return stampToolImages(readResult(filePath, mime, bytes), () => undefined);
}

describe('R1 — a corrupt picture never throws into the desk broadcast', () => {
  it('stampToolImages with desktopImageFallback returns a card and no src', () => {
    const dir = tempDir();
    try {
      // Above DESKTOP_IMAGE_BYTE_CAP so desktopImageFallback takes its decode
      // branch instead of the raw data-URI one.
      const filePath = writeCorrupt(dir, 'corrupt-big.png', PNG_SIGNATURE, DESKTOP_IMAGE_BYTE_CAP + 1024);
      const size = fs.statSync(filePath).size;
      expect(size).toBeGreaterThan(DESKTOP_IMAGE_BYTE_CAP);
      const out = stampToolImages(readResult(filePath, 'image/png', size), (facts) =>
        desktopImageFallback(facts),
      ) as Record<string, unknown>;
      expect(out.readImage).toEqual({ path: filePath, mime: 'image/png', bytes: size });
      expect(out).not.toHaveProperty('images');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a restoreMessages replay carrying a corrupt read still returns the whole burst', () => {
    const dir = tempDir();
    try {
      const filePath = writeCorrupt(dir, 'corrupt-replay.png', PNG_SIGNATURE, DESKTOP_IMAGE_BYTE_CAP + 1024);
      const size = fs.statSync(filePath).size;
      const msg = {
        type: 'restoreMessages',
        messages: [
          { tool: { call: { id: 'a' }, result: readResult(filePath, 'image/png', size) } },
          { text: 'the trailing entry that must survive' },
        ],
      };
      const out = stampToolImages(msg, (facts) => desktopImageFallback(facts)) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(out.messages).toHaveLength(2);
      expect(out.messages[1]).toEqual({ text: 'the trailing entry that must survive' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a corrupt JPEG takes the same road', () => {
    const dir = tempDir();
    try {
      const filePath = writeCorrupt(dir, 'corrupt-big.jpg', JPEG_SIGNATURE, DESKTOP_IMAGE_BYTE_CAP + 1024);
      const size = fs.statSync(filePath).size;
      const out = stampToolImages(readResult(filePath, 'image/jpeg', size), (facts) =>
        desktopImageFallback(facts),
      ) as Record<string, unknown>;
      expect(out.readImage).toEqual({ path: filePath, mime: 'image/jpeg', bytes: size });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R1 — a corrupt picture never throws into the phone burst', () => {
  it('shapeForPhone drops the base64 and carries no thumb', () => {
    const dir = tempDir();
    try {
      // readImageThumb decodes on every call, so no size is needed here.
      const filePath = writeCorrupt(dir, 'corrupt-small.png', PNG_SIGNATURE, 256);
      const size = fs.statSync(filePath).size;
      const out = shapeForPhone(phoneInput(filePath, 'image/png', size)) as {
        type?: string;
        readImage?: { thumb?: string };
      };
      expect(out).not.toHaveProperty('images');
      expect(out.readImage?.thumb).toBeUndefined();
      expect(out.type).toBe('toolResult');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shapeForPhone survives a corrupt browser screenshot data URI too', () => {
    const corrupt = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(256, 0x41)]).toString('base64');
    const out = shapeForPhone({
      type: 'toolResult',
      toolName: 'browser',
      images: [`data:image/png;base64,${corrupt}`],
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty('images');
    expect(out.type).toBe('toolResult');
  });
});

describe('R2 — the phone decodes by magic bytes, not the claimed mime', () => {
  it('a real PNG the engine labels image/jpeg still gets a thumbnail', () => {
    const dir = tempDir();
    try {
      const width = 64;
      const height = 48;
      const png = new PNG({ width, height });
      for (let i = 0; i < width * height; i++) {
        png.data[i * 4] = (i * 3) % 255;
        png.data[i * 4 + 1] = (i * 5) % 255;
        png.data[i * 4 + 2] = (i * 7) % 255;
        png.data[i * 4 + 3] = 255;
      }
      const filePath = path.join(dir, 'mislabelled.png');
      fs.writeFileSync(filePath, PNG.sync.write(png));
      const size = fs.statSync(filePath).size;
      // `mime` here is what the ENGINE claimed; the bytes on disk are PNG.
      const out = shapeForPhone(phoneInput(filePath, 'image/jpeg', size)) as {
        readImage?: { thumb?: string };
      };
      expect(out.readImage?.thumb).toMatch(/^data:image\/jpeg;base64,/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
