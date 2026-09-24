// desktopImageFallback.test.ts — t-fdw2j2: the desktop's own copy of a
// read-image's bytes when the file sits outside every webview resource root
// (Downloads, the ticket's own repro). A capped data URI, then the phone's
// thumbnail encoder, then `undefined` — never a broken `<img>`. The fixture
// lives in a real temp dir, outside any workspace/tmp root the production
// code would recognise, matching the ticket's "temp dir outside the roots"
// acceptance wording.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_IMAGE_SIZE_CEILING, desktopImageFallback } from '../../../src/dashboard/desktopImageFallback';
import { sniffImageMime } from '../../../src/dashboard/imageThumb';
import { DESKTOP_IMAGE_BYTE_CAP, PHONE_IMAGE_BYTE_CAP } from '../../../src/dashboard/toolImageCard';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'origami-desktop-image-fallback-'));
}

/** A real, small PNG on disk — desktopImageFallback.ts reads the file itself
 *  (fs.readFileSync), so these tests need an actual file, not a mock. */
function writeSmallPng(dir: string, name = 'outside-roots.png'): string {
  const width = 64;
  const height = 48;
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = (i * 3) % 255;
    png.data[i * 4 + 1] = (i * 5) % 255;
    png.data[i * 4 + 2] = (i * 7) % 255;
    png.data[i * 4 + 3] = 255;
  }
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, PNG.sync.write(png));
  return filePath;
}

describe('sniffImageMime — magic bytes, never the extension', () => {
  it('reads PNG, JPEG, GIF and WebP signatures', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a...', 'ascii'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from('GIF87a...', 'ascii'))).toBe('image/gif');
    const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')]);
    expect(sniffImageMime(webp)).toBe('image/webp');
  });

  it('sniffs a PNG signature even under a name/claim that lies about it', () => {
    // The ticket's own requirement: "sniff the format by magic bytes, never
    // by extension" — a caller renaming the bytes must not change the result.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(sniffImageMime(png)).toBe('image/png');
  });

  it('returns undefined for a non-image file and for too-short input', () => {
    expect(sniffImageMime(Buffer.from('not an image, just plain text', 'ascii'))).toBeUndefined();
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBeUndefined();
  });
});

describe('desktopImageFallback — the picture outside the roots', () => {
  it('returns the raw bytes as a capped data URI, sniffed to the real mime', () => {
    const dir = tempDir();
    try {
      const filePath = writeSmallPng(dir);
      const raw = fs.readFileSync(filePath);
      const src = desktopImageFallback({ path: filePath, mime: 'image/png', bytes: raw.length });
      expect(src).toBe(`data:image/png;base64,${raw.toString('base64')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sniffs the mime independently of the claimed one', () => {
    // The engine's `facts.mime` says jpeg; the bytes on disk are a real PNG.
    // The data URI must carry the SNIFFED mime, not the claimed one — an
    // `<img>` tagged `image/jpeg` over PNG bytes renders nothing in Chromium.
    const dir = tempDir();
    try {
      const filePath = writeSmallPng(dir);
      const src = desktopImageFallback({ path: filePath, mime: 'image/jpeg', bytes: fs.statSync(filePath).size });
      expect(src).toMatch(/^data:image\/png;base64,/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls to undefined when the file cannot be read', () => {
    const missing = path.join(tempDir(), 'does-not-exist.png');
    expect(desktopImageFallback({ path: missing, mime: 'image/png', bytes: 0 })).toBeUndefined();
  });

  it('falls to undefined for a non-image file, even with an image mime claimed', () => {
    const dir = tempDir();
    try {
      const filePath = path.join(dir, 'fake.png');
      fs.writeFileSync(filePath, 'not actually a png');
      expect(desktopImageFallback({ path: filePath, mime: 'image/png', bytes: 19 })).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the phone-style JPEG thumbnail above the cap', () => {
    // A tiny injected cap (rather than a multi-MB fixture) exercises the SAME
    // over-cap branch the real 4 MB DESKTOP_IMAGE_BYTE_CAP takes — the
    // optional capBytes param mirrors imageThumb.ts's own encodeThumbnail(...,
    // capBytes) convention.
    const dir = tempDir();
    try {
      const filePath = writeSmallPng(dir);
      const src = desktopImageFallback({ path: filePath, mime: 'image/png', bytes: fs.statSync(filePath).size }, 10);
      expect(src).toMatch(/^data:image\/jpeg;base64,/);
      const jpegBytes = Buffer.from(src!.split(',')[1], 'base64');
      expect(jpegBytes.length).toBeLessThanOrEqual(PHONE_IMAGE_BYTE_CAP);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives no src for a GIF above the cap — the thumbnail encoder cannot decode it', () => {
    const dir = tempDir();
    try {
      const filePath = path.join(dir, 'huge.gif');
      fs.writeFileSync(filePath, Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(64)]));
      expect(desktopImageFallback({ path: filePath, mime: 'image/gif', bytes: 70 }, 10)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // t-fisfs5 R6: this runs synchronously on the extension host, once per post
  // and once per replay, so the size is checked BEFORE the bytes are read and
  // an unchanged file is answered from the cache.
  it('stats before reading, and refuses above the ceiling without reading the file', () => {
    const dir = tempDir();
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      const filePath = path.join(dir, 'enormous.png');
      // A sparse file: truncate sets the SIZE without writing 33 MB of bytes,
      // which is exactly what a statSync-first check must see.
      fs.writeFileSync(filePath, Buffer.alloc(0));
      fs.truncateSync(filePath, DESKTOP_IMAGE_SIZE_CEILING + 1);
      expect(fs.statSync(filePath).size).toBeGreaterThan(DESKTOP_IMAGE_SIZE_CEILING);
      read.mockClear();

      expect(desktopImageFallback({ path: filePath, mime: 'image/png', bytes: 0 })).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the ceiling is 32 MB and sits well above the 4 MB desktop cap', () => {
    expect(DESKTOP_IMAGE_SIZE_CEILING).toBe(32 * 1024 * 1024);
    expect(DESKTOP_IMAGE_SIZE_CEILING).toBeGreaterThan(DESKTOP_IMAGE_BYTE_CAP);
  });

  it('a file at the ceiling exactly is still read (>, not >=)', () => {
    const dir = tempDir();
    try {
      const filePath = path.join(dir, 'at-the-ceiling.bin');
      fs.writeFileSync(filePath, Buffer.alloc(0));
      fs.truncateSync(filePath, DESKTOP_IMAGE_SIZE_CEILING);
      // Zero bytes sniff as no image, so the answer is still undefined — what
      // this proves is the ceiling did not refuse it: the read happened.
      const read = vi.spyOn(fs, 'readFileSync');
      try {
        expect(desktopImageFallback({ path: filePath, mime: 'image/png', bytes: 0 })).toBeUndefined();
        expect(read).toHaveBeenCalledWith(filePath);
      } finally {
        read.mockRestore();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers an unchanged path from the cache instead of re-reading it', () => {
    const dir = tempDir();
    try {
      const filePath = writeSmallPng(dir, 'cached.png');
      const first = desktopImageFallback({ path: filePath, mime: 'image/png', bytes: 0 });
      expect(first).toMatch(/^data:image\/png;base64,/);

      const read = vi.spyOn(fs, 'readFileSync');
      try {
        const second = desktopImageFallback({ path: filePath, mime: 'image/png', bytes: 0 });
        expect(second).toBe(first);
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a changed file invalidates the entry — the mtime is in the key', () => {
    const dir = tempDir();
    try {
      const filePath = writeSmallPng(dir, 'changing.png');
      const first = desktopImageFallback({ path: filePath, mime: 'image/png', bytes: 0 });

      // A different PNG, and an mtime the key can tell apart from the first.
      const width = 32;
      const height = 32;
      const png = new PNG({ width, height });
      for (let i = 0; i < width * height; i++) png.data[i * 4 + 3] = 255;
      fs.writeFileSync(filePath, PNG.sync.write(png));
      const later = new Date(fs.statSync(filePath).mtimeMs + 5000);
      fs.utimesSync(filePath, later, later);

      const second = desktopImageFallback({ path: filePath, mime: 'image/png', bytes: 0 });
      expect(second).toMatch(/^data:image\/png;base64,/);
      expect(second).not.toBe(first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remembers a REFUSAL too, so a non-image is not re-read on every post', () => {
    const dir = tempDir();
    try {
      const filePath = path.join(dir, 'not-an-image.png');
      fs.writeFileSync(filePath, 'plain text pretending to be a picture');
      expect(desktopImageFallback({ path: filePath, mime: 'image/png', bytes: 0 })).toBeUndefined();

      const read = vi.spyOn(fs, 'readFileSync');
      try {
        expect(desktopImageFallback({ path: filePath, mime: 'image/png', bytes: 0 })).toBeUndefined();
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('at exactly the cap, still takes the raw data-URI branch (<=, not <)', () => {
    const dir = tempDir();
    try {
      const filePath = writeSmallPng(dir);
      const size = fs.statSync(filePath).size;
      const src = desktopImageFallback({ path: filePath, mime: 'image/png', bytes: size }, size);
      expect(src).toMatch(/^data:image\/png;base64,/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
