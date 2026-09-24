// toolReadImage.ts — the picture a `read` card shows, as a webview-side fact.
//
// EXTRACTED rather than added to chatToolMeta.ts, which was 21 lines under its
// 110 cap when this arrived and would have gone 23 over: the sibling shapers
// there all read a tool's OWN metadata off the wire, while this one validates a
// rider the HOST stamped (src/dashboard/toolImageCard.ts) after resolving a file
// path against one webview's resource roots.

/**
 * The image file a `read` card shows. `src` is that webview's own resource URI
 * for the file, and is ABSENT on a surface that cannot read local files — the
 * phone, which gets `thumb` instead (a capped JPEG data URI, host-encoded off
 * the same file) when one could be made, and the size-and-path placeholder
 * when it could not. The base64 the engine sent the model never reaches the
 * webview either way.
 */
export interface ToolReadImage { path: string; mime: string; bytes: number; src?: string; thumb?: string; }

/** Shape the host's `readImage` rider. No path, no card: an `<img>` with a blank
 *  src renders as a broken picture, which reads as a failed read. */
export function readImage(raw: unknown): ToolReadImage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== 'string' || !r.path) return undefined;
  return {
    path: r.path,
    mime: typeof r.mime === 'string' ? r.mime : '',
    bytes: typeof r.bytes === 'number' ? r.bytes : 0,
    ...(typeof r.src === 'string' && r.src ? { src: r.src } : {}),
    ...(typeof r.thumb === 'string' && r.thumb ? { thumb: r.thumb } : {}),
  };
}
