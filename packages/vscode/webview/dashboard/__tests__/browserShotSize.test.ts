// The PNG below is BUILT here, byte by byte, to the format's own spec (8-byte signature,
// a length, `IHDR`, then two big-endian uint32s) rather than pasted from a capture — so
// the test states what it believes about the format and would fail if that belief is
// wrong, instead of agreeing with whatever bytes happened to be lying around.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { render, cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';
import { pngSize } from '../../../src/browserShotSize';
import { frameOf } from '../../../src/browserSnapshot';
import { viewportCaption, type BrowserFrame } from '../panes/browserFrames';
import BrowserViewportRow from '../components/BrowserViewportRow.svelte';

afterEach(cleanup);

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A PNG header for the given pixel size, base64 — everything after IHDR's two sizes is
 *  irrelevant to the reader and omitted. */
function png(width: number, height: number): string {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(0x89504e47, 0);
  head.writeUInt32BE(0x0d0a1a0a, 4);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head.toString('base64');
}

const answer = (over: Record<string, unknown> = {}) => ({ ok: true, ...over }) as never;

const frame = (over: Partial<BrowserFrame> = {}): BrowserFrame => ({
  action: 'screenshot', ts: 1, seq: 0, imageDataUrl: 'data:image/png;base64,AAAA', ...over,
});

describe('pngSize — the size of the picture, out of its own header', () => {
  it('reads the pixel size a PNG declares', () => {
    expect(pngSize(png(320, 180))).toEqual({ width: 320, height: 180 });
    expect(pngSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('answers undefined for anything that is not a PNG, rather than guessing', () => {
    expect(pngSize(undefined)).toBeUndefined();
    expect(pngSize('')).toBeUndefined();
    expect(pngSize('AAAA')).toBeUndefined();
    expect(pngSize(Buffer.alloc(24).toString('base64'))).toBeUndefined(); // right length, wrong signature
    expect(pngSize(png(0, 0))).toBeUndefined();
  });
});

describe('the frame carries both sizes', () => {
  it('the viewport from the host measurement, the shown size from the bytes', () => {
    const image = answer({ imageBase64: png(320, 180), imageMime: 'image/png', width: 1920, height: 1080 });
    expect(frameOf('screenshot', answer(), image, 5)).toMatchObject({
      width: 1920, height: 1080, shotWidth: 320, shotHeight: 180,
    });
  });

  it('a non-PNG picture has a viewport and no shown size', () => {
    const image = answer({ imageBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', imageMime: 'image/jpeg', width: 1920, height: 1080 });
    const out = frameOf('screenshot', answer(), image, 5);
    expect(out.width).toBe(1920);
    expect(out.shotWidth).toBeUndefined();
  });
});

// The defect this exists for: ChatPane's `browserSnapshot` case destructures an EXPLICIT
// field list, so a new field on the wire is silently dropped on the way in. Every test
// above still passed while the caption showed the old text in the real bundle, because
// they all start downstream of that line.
describe('the pane lets every frame field through', () => {
  it('names each BrowserShot field in the browserSnapshot destructure', () => {
    const shot = readFileSync(path.join(pkgRoot, 'webview/dashboard/panes/browserFrames.ts'), 'utf8');
    const body = /export interface BrowserShot \{([\s\S]*?)\n\}/.exec(shot);
    expect(body, 'no BrowserShot interface in browserFrames.ts').toBeTruthy();
    const fields = [...body![1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    const pane = readFileSync(path.join(pkgRoot, 'webview/dashboard/panes/ChatPane.svelte'), 'utf8');
    const line = /const \{([^}]*)\} = msg;\s*browserFrames = pushFrame/.exec(pane);
    expect(line, 'no browserSnapshot destructure in ChatPane.svelte').toBeTruthy();
    const taken = line![1].split(',').map((n) => n.trim());
    expect(fields.filter((f) => !taken.includes(f)), 'dropped on the way into the frame store').toEqual([]);
  });
});

describe('the caption', () => {
  it('names the viewport AND the shown size when the capture was scaled', () => {
    expect(viewportCaption([frame({ width: 1920, height: 1080, shotWidth: 320, shotHeight: 180 })]))
      .toBe('frame 1 of 1 · screenshot · 1920 × 1080 viewport · 320 × 180 shown');
  });

  it('says it once when the picture is the size of the page', () => {
    expect(viewportCaption([frame({ width: 1920, height: 1080, shotWidth: 1920, shotHeight: 1080 })]))
      .toBe('frame 1 of 1 · screenshot · 1920 × 1080 px');
  });

  it('an old host sends no shown size — the caption is what it always was', () => {
    expect(viewportCaption([frame({ width: 1280, height: 720 })])).toBe('frame 1 of 1 · screenshot · 1280 × 720 px');
  });

  it('still prints no size at all when the viewport is unknown', () => {
    expect(viewportCaption([frame({ shotWidth: 320, shotHeight: 180 })])).toBe('frame 1 of 1 · screenshot');
    expect(viewportCaption([])).toBe('');
  });

  it('the row renders the scaled caption, and does not throw on a frame with neither size', () => {
    const scaled = render(BrowserViewportRow, {
      props: { frames: [frame({ width: 1920, height: 1080, shotWidth: 320, shotHeight: 180 })], onReveal: () => {} },
    });
    expect(scaled.container.querySelector('.browser-viewport-size')?.textContent)
      .toBe('frame 1 of 1 · screenshot · 1920 × 1080 viewport · 320 × 180 shown');

    const bare = render(BrowserViewportRow, { props: { frames: [frame()], onReveal: () => {} } });
    expect(bare.container.querySelector('.browser-viewport-size')?.textContent).toBe('frame 1 of 1 · screenshot');
  });
});
