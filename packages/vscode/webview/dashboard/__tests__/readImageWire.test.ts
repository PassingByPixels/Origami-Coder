// readImageWire.test.ts — t-d93nqh: the picture a `read` card shows, and the
// bytes neither wire carries.
//
// The engine answers a read of an image with "Image read successfully" plus the
// model's base64 copy, and that copy used to ride the ACP image block all the
// way into the webview for a card that drew nothing. The fixtures here are the
// engine's REAL shapes: `rawOutputMeta.display` is what packages/engine/src/
// tool/read.ts now emits (type 'image', absolute path, sniffed mime, size), and
// the `images` entry is the data URI src/acpToolContent.ts makes from the ACP
// block.
//
// What is pinned: the desktop gets a resource URI and NO base64; the phone gets
// neither (its frame stays kilobytes, not megabytes); the replay road
// (`restoreMessages`) is stamped by the same rule as the live one; and a text
// read travels untouched.

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { PNG } from 'pngjs';

const { fake } = vi.hoisted(() => ({ fake: { folders: [] as Array<{ uri: unknown }> } }));

// The Uri surface toolImageUri.ts uses, with fsPath/toString behaving as they do
// on Windows for a file: URI. `asWebviewUri` is faked per test webview below.
vi.mock('vscode', () => {
  const file = (p: string) => ({ scheme: 'file', fsPath: p, path: '/' + p.replace(/\\/g, '/'), toString: () => `file:///${p.replace(/\\/g, '/')}` });
  return {
    Uri: { file, joinPath: (base: { fsPath: string }, ...parts: string[]) => file([base.fsPath, ...parts].join('\\')) },
    workspace: { get workspaceFolders() { return fake.folders; } },
  };
});

import { PHONE_IMAGE_BYTE_CAP, readImageFacts } from '../../../src/dashboard/toolImageCard';
import { stampToolImages } from '../../../src/dashboard/toolImageStamp';
import { desktopImageSrc, isUnderRoot, webviewImageSrc } from '../../../src/dashboard/toolImageUri';
import { RemoteView } from '../../../src/remote/remoteView';
import { applyToolResult } from '../panes/chatToolMsg';

/** A real, small PNG on disk — readImageThumb.ts reads the file itself
 *  (fs.statSync + fs.readFileSync), so the phone-thumbnail tests below need
 *  an actual file rather than a mocked one. */
function writeRealPng(): string {
  const width = 64;
  const height = 48;
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = (i * 3) % 255;
    png.data[i * 4 + 1] = (i * 5) % 255;
    png.data[i * 4 + 2] = (i * 7) % 255;
    png.data[i * 4 + 3] = 255;
  }
  const filePath = nodePath.join(
    os.tmpdir(),
    `origami-read-image-wire-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  );
  fs.writeFileSync(filePath, PNG.sync.write(png));
  return filePath;
}

const PNG_PATH = 'C:\\Users\\a\\AppData\\Local\\Temp\\origami\\mia\\mouth_e26_front_26deg.png';
const DISPLAY = { preview: 'Image read successfully', truncated: false, loaded: [], display: { type: 'image', path: PNG_PATH, mime: 'image/png', bytes: 1_800_000 } };
/** The engine's `rawOutputMeta` shape for a real file — readImageFacts reads
 *  the path off THIS, not off the `readImage` rider, so a phone-thumbnail
 *  test against a real on-disk fixture must set both. */
function displayFor(path: string, bytes: number) {
  return { preview: 'Image read successfully', truncated: false, loaded: [], display: { type: 'image', path, mime: 'image/png', bytes } };
}
/** ~2 MB of base64, the size a 1080p render really is on this wire. */
const HUGE_DATA_URL = `data:image/png;base64,${'A'.repeat(2_000_000)}`;

function toolResult(extra: Record<string, unknown> = {}) {
  return { type: 'toolResult', toolCallId: 'tc1', status: 'completed', content: 'Image read successfully', toolName: 'read', rawOutputMeta: DISPLAY, images: [HUGE_DATA_URL], sessionId: 's1', ...extra };
}

/** A webview stub with the roots the chat surfaces are created with. */
function webviewWithRoots(roots: string[]) {
  return {
    options: { localResourceRoots: roots.map((r) => ({ scheme: 'file', fsPath: r })) },
    asWebviewUri: (uri: { path: string }) => ({ toString: () => `https://file%2B.vscode-resource.vscode-cdn.net${uri.path}` }),
  } as never;
}

describe('readImageFacts — only a real image read stamps a card', () => {
  it('reads the engine display block', () => {
    expect(readImageFacts('read', DISPLAY)).toEqual({ path: PNG_PATH, mime: 'image/png', bytes: 1_800_000 });
  });

  it('ignores a text read, a directory read and another tool', () => {
    expect(readImageFacts('read', { display: { type: 'file', path: PNG_PATH, text: 'x' } })).toBeUndefined();
    expect(readImageFacts('read', { display: { type: 'directory', path: PNG_PATH, entries: [] } })).toBeUndefined();
    expect(readImageFacts('browser', DISPLAY)).toBeUndefined();
    expect(readImageFacts('read', undefined)).toBeUndefined();
  });

  // `show_image` (engine tool/show-image.ts) emits the SAME display block on
  // purpose, so the same card draws it. A name check that only knew 'read'
  // would drop its picture and leave the user a bare caption.
  it('stamps a show_image result on the same card, and drops its base64', () => {
    expect(readImageFacts('show_image', DISPLAY)).toEqual({ path: PNG_PATH, mime: 'image/png', bytes: 1_800_000 });
    const out = stampToolImages(toolResult({ toolName: 'show_image', content: 'hero.png' }), () => undefined) as Record<string, unknown>;
    expect((out.readImage as { path: string }).path).toBe(PNG_PATH);
    expect(out.images).toBeUndefined();
  });

  it('refuses a half-filled block rather than stamping a broken picture', () => {
    expect(readImageFacts('read', { display: { type: 'image', mime: 'image/png' } })).toBeUndefined();
    expect(readImageFacts('read', { display: { type: 'image', path: PNG_PATH, mime: 'text/plain' } })).toBeUndefined();
  });
});

describe('the desktop — a resource URI, and no base64', () => {
  const srcFor = (facts: { path: string }) => webviewImageSrc(webviewWithRoots(['C:\\Users\\a\\AppData\\Local\\Temp']), facts as never);

  it('stamps readImage.src as a webview resource URI and drops the data URL', () => {
    const out = stampToolImages(toolResult(), srcFor) as Record<string, unknown>;
    const pic = out.readImage as { src: string; path: string; bytes: number };
    expect(pic.src).toMatch(/^https:\/\/file%2B\.vscode-resource\.vscode-cdn\.net\//);
    expect(pic.src).toContain('mouth_e26_front_26deg.png');
    expect(pic.src.startsWith('data:')).toBe(false);
    expect(pic.path).toBe(PNG_PATH);
    expect(pic.bytes).toBe(1_800_000);
    expect('images' in out).toBe(false);
    expect(JSON.stringify(out).length).toBeLessThan(2000);
  });

  it('keeps the facts with no src when the file is outside the roots, and never leaves the base64 behind', () => {
    const out = stampToolImages(toolResult(), () => undefined) as Record<string, unknown>;
    expect(out.readImage).toEqual({ path: PNG_PATH, mime: 'image/png', bytes: 1_800_000 });
    expect('images' in out).toBe(false);
  });

  it('passes a non-image read and every other message by identity', () => {
    const text = { type: 'toolResult', toolName: 'read', rawOutputMeta: { display: { type: 'file', path: 'a.ts', text: 'x' } } };
    expect(stampToolImages(text, srcFor)).toBe(text);
    const shot = { type: 'toolResult', toolName: 'browser', images: [HUGE_DATA_URL] };
    expect(stampToolImages(shot, srcFor)).toBe(shot);
    const other = { type: 'agentText', text: 'hello' };
    expect(stampToolImages(other, srcFor)).toBe(other);
  });

  it('stamps the replay road too, so a reopened tab draws the same card', () => {
    const log = {
      type: 'restoreMessages',
      sessionId: 's1',
      messages: [
        { kind: 'agent', text: 'rendering' },
        { kind: 'tool', text: 'read', tool: { call: { toolCallId: 'tc1', toolName: 'read' }, result: { toolCallId: 'tc1', toolName: 'read', rawOutputMeta: DISPLAY, images: [HUGE_DATA_URL] } } },
      ],
    };
    const out = stampToolImages(log, srcFor) as { messages: Array<{ tool?: { result?: Record<string, unknown> } }> };
    const result = out.messages[1].tool!.result!;
    expect((result.readImage as { src?: string }).src).toContain('mouth_e26_front_26deg.png');
    expect('images' in result).toBe(false);
    expect(out.messages[0]).toEqual({ kind: 'agent', text: 'rendering' });
  });

  // t-j50p3r. A CHILD's transcript is the same replay-log shape, on its own
  // message type. Without this branch the sub-agent transcript view drew the
  // read as a plain text row while the parent chat drew the picture — the same
  // card system, one wire short.
  it('stamps a child transcript, so the sub-agent view draws the picture the parent drew', () => {
    const child = {
      type: 'subagentTranscriptData',
      sessionId: 'ses_child',
      found: true,
      entries: [
        { kind: 'user', text: 'look at the render' },
        { kind: 'tool', text: 'read', tool: { call: { toolCallId: 'tc1', toolName: 'read' }, result: { toolCallId: 'tc1', toolName: 'read', rawOutputMeta: DISPLAY, images: [HUGE_DATA_URL] } } },
      ],
    };
    const out = stampToolImages(child, srcFor) as { entries: Array<{ tool?: { result?: Record<string, unknown> } }> };
    const result = out.entries[1].tool!.result!;
    expect((result.readImage as { src?: string }).src).toContain('mouth_e26_front_26deg.png');
    expect('images' in result).toBe(false);
    expect(out.entries[0]).toEqual({ kind: 'user', text: 'look at the render' });
    // The phone's surface resolves no src, so the rider is facts only and the
    // card falls back to its size-and-path placeholder — the same thing the
    // `restoreMessages` replay does there today, and no megabytes either way.
    const phone = stampToolImages(child, () => undefined) as { entries: Array<{ tool?: { result?: Record<string, unknown> } }> };
    const phoneResult = phone.entries[1].tool!.result!;
    expect(phoneResult.readImage).toEqual({ path: PNG_PATH, mime: 'image/png', bytes: 1_800_000 });
    expect('images' in phoneResult).toBe(false);
    expect(JSON.stringify(phone).length).toBeLessThan(PHONE_IMAGE_BYTE_CAP);
  });

  it('a child transcript with no picture in it travels by identity', () => {
    const plain = { type: 'subagentTranscriptData', sessionId: 'ses_child', entries: [{ kind: 'agent', text: 'done' }] };
    expect(stampToolImages(plain, srcFor)).toBe(plain);
  });
});

describe('the roots — a path compare, not a string prefix', () => {
  it('accepts a file under a root and rejects a sibling with the same prefix', () => {
    expect(isUnderRoot('C:\\a\\b\\shot.png', 'C:\\a\\b')).toBe(true);
    expect(isUnderRoot('C:\\a\\bb\\shot.png', 'C:\\a\\b')).toBe(false);
    expect(isUnderRoot('C:\\other\\shot.png', 'C:\\a\\b')).toBe(false);
  });

  it('gives no src for a file outside every root', () => {
    expect(webviewImageSrc(webviewWithRoots(['C:\\ws']), { path: 'D:\\elsewhere\\a.png', mime: 'image/png', bytes: 1 })).toBeUndefined();
  });

  it('gives no src for a surface created with no roots at all — the phone shim', () => {
    const bare = { options: {}, asWebviewUri: () => ({ toString: () => 'nope' }) } as never;
    expect(webviewImageSrc(bare, { path: PNG_PATH, mime: 'image/png', bytes: 1 })).toBeUndefined();
  });
});

describe('desktopImageSrc — t-fdw2j2, a picture outside the workspace still draws', () => {
  it('still prefers the resource URI when the file IS under a root', () => {
    const src = desktopImageSrc(webviewWithRoots(['C:\\Users\\a\\AppData\\Local\\Temp']), {
      path: PNG_PATH, mime: 'image/png', bytes: 1,
    });
    expect(src).toMatch(/^https:\/\/file%2B\.vscode-resource\.vscode-cdn\.net\//);
  });

  it('a real file outside every root renders as a data URI, not the placeholder', () => {
    const filePath = writeRealPng();
    try {
      const raw = fs.readFileSync(filePath);
      // Roots that do not cover the temp file's own directory — the ticket's
      // "Downloads" case: a workspace root exists, but not one that reaches here.
      const src = desktopImageSrc(webviewWithRoots(['C:\\some\\other\\workspace']), {
        path: filePath, mime: 'image/png', bytes: raw.length,
      });
      expect(src).toBe(`data:image/png;base64,${raw.toString('base64')}`);
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('an unreadable file outside every root gives undefined — no broken img', () => {
    const src = desktopImageSrc(webviewWithRoots(['C:\\ws']), {
      path: 'D:\\nope\\does-not-exist.png', mime: 'image/png', bytes: 1,
    });
    expect(src).toBeUndefined();
  });
});

describe('the transcript card — write-if-present', () => {
  it('keeps the picture when a later update carries no rider', () => {
    const card = [{ id: 1, kind: 'tool', label: 'read', text: '', toolCallId: 'tc1', toolName: 'read' }] as never[];
    const first = applyToolResult(card, { toolCallId: 'tc1', status: 'completed', content: 'Image read successfully', readImage: { path: PNG_PATH, mime: 'image/png', bytes: 1_800_000, src: 'https://x/y.png' } });
    expect((first[0] as { toolReadImage?: { src?: string } }).toolReadImage?.src).toBe('https://x/y.png');
    const second = applyToolResult(first, { toolCallId: 'tc1', status: 'completed', content: 'Image read successfully' });
    expect((second[0] as { toolReadImage?: { src?: string } }).toolReadImage?.src).toBe('https://x/y.png');
  });
});

describe('the phone — one frame, and it stays small', () => {
  it('sends the read card with the model\'s base64 gone, and no src (no local roots)', async () => {
    const sent: unknown[] = [];
    const view = new RemoteView({ send: (m) => sent.push(m) });
    // A path that does not exist on disk: readImageThumb.ts's fs.statSync
    // throws, so no thumb is made either — this is the pure "bytes gone"
    // claim, independent of the encoder.
    await view.webview.postMessage(toolResult({ readImage: { path: PNG_PATH, mime: 'image/png', bytes: 1_800_000 } }));
    expect(sent).toHaveLength(1);
    const frame = JSON.stringify(sent[0]);
    expect(frame).not.toContain('data:image/png;base64,AAAA');
    expect(frame).not.toContain(HUGE_DATA_URL.slice(20, 60));
    expect(frame).toContain('mouth_e26_front_26deg.png');
  });

  it('sends a real read image as a capped JPEG thumbnail instead of the placeholder', async () => {
    const filePath = writeRealPng();
    try {
      const sent: unknown[] = [];
      const view = new RemoteView({ send: (m) => sent.push(m) });
      const bytes = fs.statSync(filePath).size;
      // `rawOutputMeta` (not just the `readImage` rider) must name the real
      // file: shapeForPhone reads `readImageFacts` off it, the same way the
      // live desk stamp does.
      await view.webview.postMessage(
        toolResult({
          rawOutputMeta: displayFor(filePath, bytes),
          readImage: { path: filePath, mime: 'image/png', bytes },
        }),
      );
      const frame = sent[0] as { readImage?: { thumb?: string; src?: string } };
      expect(frame.readImage?.thumb).toMatch(/^data:image\/jpeg;base64,/);
      expect(frame.readImage?.src).toBeUndefined();
      const jpegBytes = Buffer.from(frame.readImage!.thumb!.split(',')[1], 'base64');
      expect(jpegBytes.length).toBeLessThanOrEqual(PHONE_IMAGE_BYTE_CAP);
      // The whole frame — not just the picture — stays well inside a normal
      // phone-message budget; the historic 40 KB cap was sized for "no
      // picture at all" and a thumbnail's base64 overhead pushes past it,
      // so the frame is checked against the picture's own cap plus a small
      // allowance for the rest of the card, not PHONE_IMAGE_BYTE_CAP itself.
      expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThanOrEqual(PHONE_IMAGE_BYTE_CAP * 2);
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('caches the thumbnail by path+mtime — a second frame for the same file re-reads nothing new', async () => {
    const filePath = writeRealPng();
    try {
      const bytes = fs.statSync(filePath).size;
      const readSpy = vi.spyOn(fs, 'readFileSync');
      const view = new RemoteView({ send: () => {} });
      const frame = () => toolResult({
        rawOutputMeta: displayFor(filePath, bytes),
        readImage: { path: filePath, mime: 'image/png', bytes },
      });
      await view.webview.postMessage(frame());
      const callsAfterFirst = readSpy.mock.calls.filter((c) => c[0] === filePath).length;
      expect(callsAfterFirst).toBeGreaterThan(0);
      await view.webview.postMessage(frame());
      const callsAfterSecond = readSpy.mock.calls.filter((c) => c[0] === filePath).length;
      expect(callsAfterSecond).toBe(callsAfterFirst);
      readSpy.mockRestore();
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('thumbnails a browser screenshot instead of sending it full-size', async () => {
    const filePath = writeRealPng();
    try {
      const source = `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`;
      const sent: unknown[] = [];
      const view = new RemoteView({ send: (m) => sent.push(m) });
      await view.webview.postMessage({ type: 'toolResult', toolName: 'browser', images: [source] });
      const images = (sent[0] as { images?: string[] }).images;
      expect(images).toBeDefined();
      expect(images![0]).toMatch(/^data:image\/jpeg;base64,/);
      expect(images![0].length).toBeLessThan(source.length);
      const jpegBytes = Buffer.from(images![0].split(',')[1], 'base64');
      expect(jpegBytes.length).toBeLessThanOrEqual(PHONE_IMAGE_BYTE_CAP);
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it('drops a browser screenshot it cannot thumbnail (GIF) rather than sending it full-size', async () => {
    const sent: unknown[] = [];
    const view = new RemoteView({ send: (m) => sent.push(m) });
    await view.webview.postMessage({ type: 'toolResult', toolName: 'browser', images: ['data:image/gif;base64,R0lGODlh'] });
    expect((sent[0] as { images?: unknown[] }).images).toBeUndefined();
  });
});
