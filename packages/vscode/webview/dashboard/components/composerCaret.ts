// composerCaret.ts — pure caret-insertion and file-URI decoding for the
// composer's drag-and-drop intake. Pure so the insertion math and the URI
// decoding are unit-testable without mounting InputBar.svelte, the same
// split collabMentions.ts made for the `@` picker's insertion math.

/** Splice `insertion` over the current selection, caret placed right after it. */
export function spliceAtCaret(text: string, start: number, end: number, insertion: string): { text: string; caret: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return { text: text.slice(0, s) + insertion + text.slice(e), caret: s + insertion.length };
}

/** `items`, space-separated and padded with one space on each side, spliced
 *  over the current selection — so a dropped path or name never glues onto
 *  whatever text already sits on either side of the caret. */
export function insertRun(text: string, start: number, end: number, items: string[]): { text: string; caret: number } {
  return spliceAtCaret(text, start, end, ` ${items.join(' ')} `);
}

/** `file:///C:/a/b.ts` -> `C:\a\b.ts` (a Windows drive path loses its leading
 *  slash and turns `/` into `\`); a posix `file:///home/a/b.ts` keeps its
 *  forward slashes. A URI that fails to parse is returned verbatim. */
export function decodeFileUri(uri: string): string {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri;
  }
  const win = /^\/([A-Za-z]):(\/.*)?$/.exec(pathname);
  if (win) return `${win[1]}:${(win[2] ?? '').replace(/\//g, '\\')}`;
  return pathname;
}

/**
 * Parse a `text/uri-list` drop payload (RFC 2483): one URI per line, blank
 * lines and `#`-comments ignored. `file:` entries decode to a local path
 * (see {@link decodeFileUri}); anything else (an `https://` URL, an
 * `untitled:` buffer, …) is kept as the URI text itself.
 */
export function decodeUriList(raw: string): string[] {
  return raw
    .split(/\r\n|\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('file:') ? decodeFileUri(l) : l));
}
