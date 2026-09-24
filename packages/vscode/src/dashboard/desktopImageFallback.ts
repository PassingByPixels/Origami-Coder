// desktopImageFallback.ts — t-fdw2j2: the desktop's OWN copy of a read-image's
// bytes, for the one case a webview resource URI cannot serve: the file sits
// outside every chat surface's `localResourceRoots` (Downloads, the ticket's
// own repro). Never widens the roots — toolImageUri.ts's `webviewImageSrc`
// stays the first try, and only when THAT returns undefined does this read
// the file itself and hand back a `data:` URI, capped, sniffed by magic byte
// (never by extension — a claimed mime can lie). Above the cap, the same
// encoder the phone uses (imageThumb.ts) makes a small JPEG in its place.
// Host-side, off the real file on disk: the model's base64 copy never
// factors in, and this has no `vscode` import so it is unit-testable like
// its sibling readImageThumb.ts.

import * as fs from 'node:fs';
import { encodeThumbnailDataUrl, sniffImageMime } from './imageThumb';
import { makeThumbCache } from './imageThumbCache';
import { DESKTOP_IMAGE_BYTE_CAP, type ReadImageFacts } from './toolImageCard';

/**
 * The size at which this refuses the file outright (t-fisfs5 R6). Everything
 * here is SYNCHRONOUS on the extension host — the read, the sniff, and above
 * the cap a full decode — and it runs once per post and once per replay. A 5 MB
 * PNG measured at about 124 ms; there is no size at which a card's picture is
 * worth freezing the host for, so past this the card takes its click-to-open
 * text. Well above the desktop cap: between the two, only the small JPEG
 * thumbnail is made.
 */
export const DESKTOP_IMAGE_SIZE_CEILING = 32 * 1024 * 1024;

const CACHE_LIMIT = 20;
/** path + ':' + mtimeMs + ':' + cap -> the URI, or '' for "tried and failed".
 *  The same cache readImageThumb.ts uses (imageThumbCache.ts). The cap is in
 *  the key because it decides WHICH answer was made: full bytes under it, a
 *  thumbnail above it. */
const cache = makeThumbCache(CACHE_LIMIT);

/** t-ru0by6: opens a new batch on this cache (imageThumbCache.ts's
 *  `beginBatch`), so a caller about to walk many entries in one synchronous
 *  pass — a `subagentTranscriptData` poll — does not have that pass's own
 *  entries evict each other before the pass finishes. */
export function beginDesktopImageFallbackBatch(): void {
  cache.beginBatch();
}

/**
 * The desktop's `<img src>` for a read-image card whose file is outside every
 * webview resource root: a full `data:` URI under `capBytes` (default the
 * desktop cap), the phone-style JPEG thumbnail above it, or `undefined` when
 * neither can be made — the file cannot be read, is above `ceilingBytes`, is
 * not one of the four recognised image formats, or (above the cap) is a format
 * the thumbnail encoder cannot decode (GIF, WebP). `undefined` here is what
 * tells the card to fall to its click-to-open text instead of a broken `<img>`.
 *
 * `statSync` FIRST: the size decides whether the bytes are read at all, so a
 * huge file costs one stat rather than a read and a decode.
 */
export function desktopImageFallback(
  facts: ReadImageFacts,
  capBytes = DESKTOP_IMAGE_BYTE_CAP,
  ceilingBytes = DESKTOP_IMAGE_SIZE_CEILING,
): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(facts.path);
  } catch {
    return undefined;
  }
  if (stat.size > ceilingBytes) return undefined;
  const key = `${facts.path}:${stat.mtimeMs}:${capBytes}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cache.remember(key, cached);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(facts.path);
  } catch {
    return undefined;
  }
  const mime = sniffImageMime(bytes);
  if (!mime) return cache.remember(key, '');
  const src =
    bytes.length <= capBytes
      ? `data:${mime};base64,${bytes.toString('base64')}`
      : encodeThumbnailDataUrl(bytes, mime);
  return cache.remember(key, src ?? '');
}
