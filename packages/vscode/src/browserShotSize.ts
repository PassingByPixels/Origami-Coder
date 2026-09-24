// How big the PICTURE is, as opposed to how big the PAGE was (t-ru1i84).
//
// `browserViewport.ts` answers the second question — the viewport the capture was taken
// at — and the strip's caption has always printed that. It is the right number, and this
// file does not replace it. But a screenshot is routinely scaled on its way out: a
// 1920x1080 viewport can arrive as a 320x180 bitmap, and a caption that prints only one
// pair leaves a reader unable to tell which one they are looking at.
//
// READ FROM THE BYTES THE HOST ALREADY HOLDS, not from a decoded <img>. The webview's
// `naturalWidth` would answer the same question, but it is unavailable until the image
// loads, absent in a test DOM that decodes nothing, and it puts a number the caption
// depends on outside the host's sight. A PNG says its own size in its first chunk.
//
// PNG ONLY, on purpose. IHDR is fixed-offset and needs no parser; a JPEG's size sits
// behind a chunk walk, and the capture path writes `image/png` unless VS Code says
// otherwise. An unrecognised image simply has no shown size, and the caption falls back
// to naming the viewport alone.

/** The first 24 bytes of a PNG: an 8-byte signature, a 4-byte length, the type `IHDR`,
 *  then width and height as big-endian uint32s. 32 base64 characters carry 24 bytes. */
const PNG_HEADER_B64 = 32;

export interface ShotSize {
  width: number;
  height: number;
}

/** The pixel size of a base64 PNG, or undefined for anything that is not one.
 *  Never throws: a malformed picture must cost a caption half, not a frame. */
export function pngSize(base64: string | undefined): ShotSize | undefined {
  if (!base64 || base64.length < PNG_HEADER_B64) return undefined;
  let head: Buffer;
  try {
    head = Buffer.from(base64.slice(0, PNG_HEADER_B64), 'base64');
  } catch {
    return undefined;
  }
  if (head.length < 24) return undefined;
  if (head.readUInt32BE(0) !== 0x89504e47 || head.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
  if (head.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}
