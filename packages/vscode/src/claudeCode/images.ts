// images.ts — how a composer attachment becomes a Claude content block. Pure: no process, no
// vscode, no I/O.
// The allowlist is checked here too, not only in the composer: widening the composer's intake must
// not let an unsupported media type reach the wire and fail the whole turn — a filter here degrades
// that to "the image was dropped" instead.

/** The four media types an `image` block may declare. */
export const IMAGE_MEDIA_TYPES: readonly string[] = ['image/gif', 'image/jpeg', 'image/png', 'image/webp'];

/** One decoded attachment on its way to the child. */
export interface ImagePart {
  mediaType: string;
  /** Base64 payload, `data:` prefix already stripped. */
  data: string;
}

/**
 * `data:image/png;base64,AAA…` → the part, or null.
 *
 * Null for a non-string, a non-image URL, a non-base64 URL, or a media type outside the allowlist.
 *  Re-implements the composer's own `parseImages` regex rather than importing it, since a module
 *  under src/claudeCode may not depend on the dashboard.
 */
export function imagePartOf(dataUrl: unknown): ImagePart | null {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  const mediaType = m[1]!.toLowerCase();
  if (!IMAGE_MEDIA_TYPES.includes(mediaType)) return null;
  return { mediaType, data: m[2]! };
}

/** The `image` content blocks for one turn, in order. Empty in ⇒ empty out,
 *  which is what keeps an ordinary text turn's frame byte-identical to the one
 *  phase 1 sent. */
export function imageBlocks(images: readonly ImagePart[]): Array<Record<string, unknown>> {
  return images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));
}
