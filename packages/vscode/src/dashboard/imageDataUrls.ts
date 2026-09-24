// `data:image/png;base64,AAA…` -> the {mimeType, data} pair the ACP wire carries. One regex, two
// callers: the panel's attachment send and the interject path (turnMessages.ts), kept in one place
// so a picture reaches the model in the same shape either way.
//
// Deliberately not claudeCode/images.ts's parser: that one also enforces an Anthropic media-type
// allowlist, a fact about that API, not this wire.

/** One picture, in the shape the ACP prompt wire already carries a fresh turn's
 *  images in (AcpClient.prompt's `{ data, mimeType }` blocks). */
export type ImageDataPair = { mimeType: string; data: string };

/** Anything that did not parse is DROPPED, never sent half-formed. */
export function parseImageDataUrls(raw: ReadonlyArray<{ dataUrl?: string; name?: string }>): ImageDataPair[] {
  return raw
    .map(img => {
      const match = img.dataUrl?.match(/^data:(image\/[^;]+);base64,(.+)$/);
      return match ? { mimeType: match[1], data: match[2] } : null;
    })
    .filter((x): x is ImageDataPair => x !== null);
}

/** The webview's attachment shape, as it arrives on a message payload. */
export function rawImagesOf(value: unknown): Array<{ dataUrl: string; name: string }> {
  return Array.isArray(value) ? (value as Array<{ dataUrl: string; name: string }>) : [];
}
