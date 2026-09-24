// phonePictures.ts — EXTRACTED from phoneView.ts (t-dclrh8): the one thing
// every phone frame carrying a PICTURE gets, never the model's base64 copy,
// always a capped JPEG thumbnail when one can be made.
//
// A `read` card's bytes never leave the desk (readImageFacts + readImageThumb
// — the file is re-read and re-encoded off disk, not off the model's copy); a
// `browser` screenshot's `images` data URIs are thumbnailed in place. Either
// kind falls back to no picture — the read card's placeholder, or the
// screenshot silently missing its frame — when the source cannot be decoded
// (GIF, WebP) or cannot be gotten under the cap at any quality.
//
// Belt AND braces on the read-card path: the desk's stamp (toolImageCard.ts)
// already drops the base64 before a real webview.postMessage reaches here
// (the phone shim has no `localResourceRoots` to resolve a file against), and
// this holds if that ever changes.

import { readImageFacts, type ReadImageFacts } from '../dashboard/toolImageCard';
import { readImageThumb } from '../dashboard/readImageThumb';
import { thumbnailDataUrl } from '../dashboard/imageThumb';

export function shapeForPhone(msg: unknown): unknown {
  const m = msg as Record<string, unknown> | null;
  if (!m || m.type !== 'toolResult') return msg;
  const facts = readImageFacts(m.toolName, m.rawOutputMeta);
  if (facts) return shapeReadImage(m, facts);
  if (!Array.isArray(m.images)) return msg;
  return shapeScreenshots(m);
}

function shapeReadImage(m: Record<string, unknown>, facts: ReadImageFacts): Record<string, unknown> {
  const hasImages = 'images' in m;
  const readImage = m.readImage as Record<string, unknown> | undefined;
  const thumb = readImageThumb(facts);
  if (!hasImages && !thumb) return m;
  const { images: _dropped, ...rest } = m;
  return thumb && readImage ? { ...rest, readImage: { ...readImage, thumb } } : rest;
}

function shapeScreenshots(m: Record<string, unknown>): Record<string, unknown> {
  const thumbs = (m.images as unknown[])
    .filter((v): v is string => typeof v === 'string')
    .map((url) => thumbnailDataUrl(url))
    .filter((v): v is string => v !== undefined);
  const { images: _dropped, ...rest } = m;
  return thumbs.length ? { ...rest, images: thumbs } : rest;
}
