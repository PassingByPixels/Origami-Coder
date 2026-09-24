// toolImageCard.ts — THE PICTURE A `read` CARD SHOWS, WITHOUT ITS BYTES.
//
// The engine answers a `read` of an image with "Image read successfully" plus a
// base64 attachment: the MODEL's copy. That attachment also reached the webview
// as an ACP image block, so a 2 MB render crossed postMessage for a card that
// never drew it. Both wires now carry the FILE INSTEAD:
//   desktop — `readImage.src` is an `asWebviewUri` of the path, and the base64
//             `images` array is dropped from the read card's payload;
//   phone   — no `src` at all (there is no encoder in the extension host to
//             make a capped thumbnail with, and `vscode-resource` URIs mean
//             nothing on a phone), so the card prints the size and the path.
// The path comes from `rawOutputMeta.display` (engine tool/read.ts), which is
// absolute and normalised — `locations[0].path` is the model's raw argument and
// is often relative.
//
// Pure: no `vscode` import, so the walk is unit-testable. Resolving a path to a
// webview URI is toolImageUri.ts; stamping the rider onto a host message is
// toolImageStamp.ts (t-j50p3r).

/** What the engine's `display` block says about the file that was read. */
export interface ReadImageFacts {
  path: string;
  mime: string;
  bytes: number;
}

/** Those facts plus the desktop's `<img src>`, absent on every surface that
 *  cannot load a local file, plus the phone's own `thumb` — a capped JPEG
 *  data URI phoneView.ts attaches after this stamp runs (readImageThumb.ts). */
export interface ReadImageCard extends ReadImageFacts {
  src?: string;
  thumb?: string;
}

/** Ceiling for image payload on ONE phone frame. Nothing currently rides under
 *  it — the host has no encoder — so the cap is what proves the bytes are gone. */
export const PHONE_IMAGE_BYTE_CAP = 40 * 1024;

/** Ceiling for a desktop read-image card's OWN `data:` URI (t-fdw2j2), for a
 *  file outside every webview resource root. A postMessage payload, not a
 *  network request, so this is sized for "does not stall the webview", not
 *  for bandwidth — well above the phone's cap, well under "just widen the
 *  resource roots instead". Above it, desktopImageFallback.ts falls back to
 *  the same capped JPEG thumbnail the phone uses. */
export const DESKTOP_IMAGE_BYTE_CAP = 4 * 1024 * 1024;

/** Turns `rawOutputMeta` into the read-image facts, or undefined for a text or
 *  directory read and for every tool but `show_image`, which sends the SAME display
 *  block and ACP kind so it draws here too. A half-filled shape stamps nothing: an
 *  `<img>` with no path renders as a broken picture, which reads as a failed read. */
export function readImageFacts(toolName: unknown, meta: unknown): ReadImageFacts | undefined {
  if (typeof toolName === 'string' && toolName && !/^(read|show_image)$/i.test(toolName)) return undefined;
  if (!meta || typeof meta !== 'object') return undefined;
  const display = (meta as Record<string, unknown>).display;
  if (!display || typeof display !== 'object') return undefined;
  const d = display as Record<string, unknown>;
  if (d.type !== 'image') return undefined;
  const path = typeof d.path === 'string' ? d.path : '';
  const mime = typeof d.mime === 'string' ? d.mime : '';
  if (!path || !mime.startsWith('image/')) return undefined;
  return { path, mime, bytes: typeof d.bytes === 'number' && d.bytes >= 0 ? d.bytes : 0 };
}

/** Resolves a read card's `<img src>` for one surface. Returns undefined when
 *  the surface cannot load the file, and the card falls back to the placeholder. */
export type ImageSrcFor = (facts: ReadImageFacts) => string | undefined;
