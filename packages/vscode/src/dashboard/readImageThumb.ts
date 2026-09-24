// readImageThumb.ts — the phone's picture for a `read` card, off the DISK.
//
// toolImageUri.ts makes a `<img src>` for a webview that can load the file
// straight from its own filesystem; the phone cannot, so this reads the same
// file in the extension host and hands back a capped JPEG thumbnail instead.
// One card can restamp the same read several times (a live update, then the
// `restoreMessages` replay on every reopen), so a small LRU keyed on the
// path AND its mtime holds the last encode: the file changing invalidates the
// entry, and nothing here re-decodes a picture that has not changed.

import * as fs from 'node:fs';
import { encodeThumbnailDataUrl, sniffImageMime } from './imageThumb';
import { makeThumbCache } from './imageThumbCache';
import type { ReadImageFacts } from './toolImageCard';

const CACHE_LIMIT = 20;
/** path + ':' + mtimeMs -> the thumbnail, or '' for "tried and failed" (an
 *  undecodable mime, or no quality step fit under the cap) so a repeat read
 *  of the same GIF does not re-read and re-decode it every time. */
const cache = makeThumbCache(CACHE_LIMIT);

/** The phone's thumbnail for one read-image card, or `undefined` when the
 *  file cannot be read or cannot be encoded under the cap — the placeholder
 *  path stays either way. */
export function readImageThumb(facts: ReadImageFacts): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(facts.path);
  } catch {
    return undefined;
  }
  const key = `${facts.path}:${stat.mtimeMs}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cache.remember(key, cached);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(facts.path);
  } catch {
    return undefined;
  }
  // The MAGIC BYTES decide, not the engine's claimed mime: the desktop path
  // (desktopImageFallback.ts) already sniffs, and a read the engine labelled
  // image/jpeg over real PNG bytes must not be handed to the JPEG decoder.
  return cache.remember(key, encodeThumbnailDataUrl(bytes, sniffImageMime(bytes) ?? facts.mime) ?? '');
}
