// The browser strip's frame ring, split out of ChatPane.svelte since a ring
// with a bound is arithmetic, not markup.
//
// A ring, not a list: a frame is a full page screenshot as a base64 `data:`
// URL, hundreds of kilobytes each, held in the webview's own heap. Twelve is
// what a horizontal band of 96px-tall thumbnails holds at a readable size;
// past that the oldest goes, since the point of the strip is where the
// agent is now.
//
// Per session, keyed by id, since the pane draws a grid of up to twelve
// chats. The store is replaced rather than mutated on every write, since a
// fresh object is what makes the `{#each}` over cells re-evaluate.
//
// Not persisted anywhere: these live for as long as the webview does. A
// picture of a page as it was an hour ago, replayed as if current, is worse
// than no picture.

/** A frame as the HOST sends it. */
export interface BrowserShot {
  /** The verb that produced it — drawn in the caption. */
  action: string;
  ts: number;
  url?: string;
  /** `data:<mime>;base64,…`, ready to be an <img src>. Absent is possible on
   *  the wire and the strip must not draw a broken thumbnail for it. */
  imageDataUrl?: string;
  /** The page viewport the capture was taken at, attached by the host
   *  (src/browserSnapshot.ts). Absent on an older host and on a frame whose
   *  viewport could not be set — every reader treats blank as an answer. */
  width?: number;
  height?: number;
  /** t-ru1i84. The size of the PICTURE, as against the viewport above it. The two
   *  differ whenever the capture was scaled, and the caption then names both. */
  shotWidth?: number;
  shotHeight?: number;
  pageText?: string;
}

/** ...and as the strip holds it. `seq` is assigned here for the `{#each}`
 *  key: `ts` isn't safe, since two frames landing in one millisecond would
 *  key the same. Keying on the array index instead would re-src every
 *  surviving thumbnail each time the ring drops its oldest. */
export type BrowserFrame = BrowserShot & { seq: number };

/** Frames by session id. Read-only by contract: every writer below returns a
 *  new object rather than editing this one. */
export type FrameStore = Readonly<Record<string, readonly BrowserFrame[]>>;

export const FRAME_CAP = 12;

/** A second bound, in bytes, since the count alone doesn't hold the memory:
 *  a long article at high DPI is megabytes where a login form is kilobytes.
 *  16 MB per session, measured on what's actually held. The count cap still
 *  applies first; this only bites on frames big enough that twelve wouldn't
 *  have been affordable anyway. */
export const FRAME_BYTE_BUDGET = 16 * 1024 * 1024;

/** What one frame costs to hold. String length, not a byte count of the decoded
 *  image: the string IS the thing in the heap. */
function frameBytes(frame: BrowserShot): number {
  return (frame.imageDataUrl?.length ?? 0) + (frame.pageText?.length ?? 0);
}

/** One session's frames, oldest first. Never undefined, so callers can count
 *  and iterate without a guard of their own. */
export function framesFor(store: FrameStore, sessionId: string): readonly BrowserFrame[] {
  return store[sessionId] ?? [];
}

/** Add the newest frame at the end and drop the oldest past either bound. A
 *  frame with no image is refused outright, since every element in the strip
 *  is a thumbnail. The frame just pushed is never evicted, even when it
 *  alone is over budget: a huge page is held alone, and the next push clears it. */
export function pushFrame(store: FrameStore, sessionId: string, shot: BrowserShot): FrameStore {
  if (!shot.imageDataUrl) return store;
  const held = framesFor(store, sessionId);
  const seq = (held[held.length - 1]?.seq ?? -1) + 1;
  let next = [...held, { ...shot, seq }];
  if (next.length > FRAME_CAP) next = next.slice(next.length - FRAME_CAP);
  let bytes = next.reduce((total, frame) => total + frameBytes(frame), 0);
  let from = 0;
  while (bytes > FRAME_BYTE_BUDGET && from < next.length - 1) {
    bytes -= frameBytes(next[from]);
    from += 1;
  }
  return { ...store, [sessionId]: from > 0 ? next.slice(from) : next };
}

/** Forget one session's frames — the session closed, and the pictures are the
 *  one part of it that was never anywhere but here. */
export function clearFrames(store: FrameStore, sessionId: string): FrameStore {
  if (!(sessionId in store)) return store;
  const next = { ...store };
  delete next[sessionId];
  return next;
}

/** What the strip says UNDER the film: which frame the caption describes, and
 *  the size that frame really is.
 *
 *  A pure rule rather than markup, because the two cases worth getting right are
 *  both about ABSENCE: an empty ring captions nothing, and a frame with no size
 *  prints `frame 2 of 2` rather than inventing `0 × 0 px`. The newest frame is
 *  the one described — it is the one the header's action and url describe too. */
export function viewportCaption(frames: readonly BrowserFrame[]): string {
  if (frames.length === 0) return '';
  const newest = frames[frames.length - 1];
  const where = `frame ${frames.length} of ${frames.length}`;
  if (!newest.width || !newest.height) return where;
  // The VIEWPORT is the number that answers "what was the page laid out at", so it keeps
  // the first slot and now says so in a word. The shown size joins it only when the two
  // disagree: printing `1920 × 1080 viewport · 1920 × 1080 shown` would be noise.
  const scaled = newest.shotWidth && newest.shotHeight
    && (newest.shotWidth !== newest.width || newest.shotHeight !== newest.height);
  const size = scaled
    ? `${newest.width} × ${newest.height} viewport · ${newest.shotWidth} × ${newest.shotHeight} shown`
    : `${newest.width} × ${newest.height} px`;
  return `${where} · ${size}`;
}
