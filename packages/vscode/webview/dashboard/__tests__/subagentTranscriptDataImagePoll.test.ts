// subagentTranscriptDataImagePoll.test.ts — t-ru0by6 item 4. A polled child
// transcript (subagentTranscriptData, 4 s cadence — DashboardPanel.ts's
// requestSubagentTranscript) with more than desktopImageFallback.ts's
// CACHE_LIMIT (20) out-of-root images re-read every one of them on EVERY
// poll: the cache's plain LRU evicts entries from earlier in the SAME poll's
// own linear scan once the batch outgrows the limit, so even an unchanged
// frame thrashes. stampToolImages' subagentTranscriptData branch now opens a
// batch on desktopImageFallback.ts's cache before stamping, so a batch larger
// than the limit does not evict its own still-in-flight entries. A second,
// unchanged poll is then a full cache hit.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import { desktopImageFallback } from '../../../src/dashboard/desktopImageFallback';
import { stampToolImages } from '../../../src/dashboard/toolImageStamp';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'origami-subagent-image-poll-'));
}

function writeSmallPng(dir: string, name: string): string {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < 8 * 8; i++) png.data[i * 4 + 3] = 255;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, PNG.sync.write(png));
  return filePath;
}

/** A `subagentTranscriptData` message with N distinct out-of-root images, the
 *  same replay-log shape subagentTranscript.ts hands the webview. */
function transcriptWithImages(dir: string, count: number) {
  const entries = Array.from({ length: count }, (_, i) => {
    const filePath = writeSmallPng(dir, `img-${i}.png`);
    return {
      tool: {
        call: { toolCallId: `t${i}`, toolName: 'read' },
        result: {
          toolName: 'read',
          rawOutputMeta: { display: { type: 'image', path: filePath, mime: 'image/png', bytes: 0 } },
        },
      },
    };
  });
  return { type: 'subagentTranscriptData', entries };
}

describe('subagentTranscriptData image poll — no per-poll re-read thrash', () => {
  it('a second, unchanged poll of 25 out-of-root images performs zero disk reads', () => {
    const dir = tempDir();
    try {
      const msg = transcriptWithImages(dir, 25);

      // First poll: populates the cache. Every image is a genuine first read.
      stampToolImages(msg, desktopImageFallback);

      const read = vi.spyOn(fs, 'readFileSync');
      try {
        // Second poll: same message, nothing on disk changed.
        stampToolImages(msg, desktopImageFallback);
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still shows every image after the batch fix — no change to what the card carries', () => {
    const dir = tempDir();
    try {
      const msg = transcriptWithImages(dir, 25);
      const stamped = stampToolImages(msg, desktopImageFallback) as { entries: Array<{ tool: { result: { readImage?: { src?: string } } } }> };
      expect(stamped.entries).toHaveLength(25);
      for (const entry of stamped.entries) {
        expect(entry.tool.result.readImage?.src).toMatch(/^data:image\/png;base64,/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
