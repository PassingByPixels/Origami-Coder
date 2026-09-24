// chatFind.ts: Ctrl+F rules for one chat cell (owning cell, text hits, "next" at list end).
//
// Collapsed tool cards are not searched: they have no DOM body until
// opened, and auto-expanding them to search would rewrite the transcript
// on every keystroke. A closed <details> (thought, compaction) keeps its
// text in the DOM, so it IS counted, and landing on it opens it (revealMatch).

/** One hit as the two DOM endpoints it spans. Node references, not
 *  indices: an index means nothing once a streaming transcript changes. */
export interface FindMatch {
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
}

/** Where one text node's characters landed in the joined haystack. */
export interface Segment { node: Text; start: number; }

/** Elements that don't break a run of text. A match may cross these but
 *  never a block boundary. Keyed on tag name, not computed `display`:
 *  jsdom has no layout engine, so a display-based rule couldn't be tested. */
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DFN', 'EM', 'I', 'KBD',
  'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME',
  'U', 'VAR', 'WBR',
]);

function blockOf(node: Node, root: Element): Element {
  let el = node.parentElement;
  while (el && el !== root && INLINE_TAGS.has(el.tagName)) el = el.parentElement;
  return el ?? root;
}

/** Lower-cased but length-preserving. A few characters lower-case to two
 *  chars (e.g. 'İ'), which would shift offsets after them; those keep
 *  their original form, a miss rather than a lie. Fast path is the plain string. */
function fold(s: string): string {
  const low = s.toLowerCase();
  if (low.length === s.length) return low;
  let out = '';
  for (const ch of s) { const l = ch.toLowerCase(); out += l.length === ch.length ? l : ch; }
  return out;
}

/** Every text node under `root`, joined into one string with a newline
 *  at each block boundary, so a match can't cross blocks. */
export function buildHaystack(root: Element): { text: string; segments: Segment[] } {
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: Segment[] = [];
  let text = '';
  let lastBlock: Element | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    if (!node.data) continue;
    const block = blockOf(node, root);
    if (lastBlock !== null && block !== lastBlock) text += '\n';
    lastBlock = block;
    segments.push({ node, start: text.length });
    text += node.data;
  }
  return { text, segments };
}

/** The node/offset an index falls on. Walks backwards: an index on a
 *  separator belongs to the node before it, clamped to its end. */
function locate(segments: readonly Segment[], index: number): { node: Text; offset: number } | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (index >= s.start) return { node: s.node, offset: Math.min(index - s.start, s.node.data.length) };
  }
  return null;
}

/** Every non-overlapping, case-insensitive hit of `query`, in document
 *  order. Substring only, no regex, so the find box never surprises.
 *  Empty query matches nothing (unlike paneSearch.ts's filter). */
export function findMatches(root: Element, query: string): FindMatch[] {
  const needle = fold(query);
  if (!needle) return [];
  const { text, segments } = buildHaystack(root);
  const hay = fold(text);
  const out: FindMatch[] = [];
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    const s = locate(segments, at);
    const e = locate(segments, at + needle.length);
    if (s && e) out.push({ startNode: s.node, startOffset: s.offset, endNode: e.node, endOffset: e.offset });
  }
  return out;
}

/** The DOM Range a match occupies. Built on demand, never stored: a
 *  stored Range under a streamed message ends up over the wrong words. */
export function matchRange(m: FindMatch): Range {
  const range = (m.startNode.ownerDocument ?? document).createRange();
  range.setStart(m.startNode, m.startOffset);
  range.setEnd(m.endNode, m.endOffset);
  return range;
}

/** Next/previous match, wrapping like browser find. `total <= 0` -> 0,
 *  so an out-of-range `current` can't land on -1. */
export function stepIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0;
  return (((current + dir) % total) + total) % total;
}

/** True when point (a, ao) comes before point (b, bo) in the document. */
function before(a: Node, ao: number, b: Node, bo: number): boolean {
  if (a === b) return ao < bo;
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * The match to land on next, found from the match the reader is ON, not from a number (t-v5qrdz).
 * The list is re-read on every step, and rows prepended above (an older page) shift every index:
 * a stored number then points at a different match. `dir` 0 = stay on `current`. `current` gone
 * from the list: the first match after where it was (1, 0) or the last before it (-1). `current`
 * gone from the document: `fallback`, the old index, as before.
 */
export function stepFrom(matches: readonly FindMatch[], current: FindMatch | null, dir: 1 | -1 | 0, fallback = 0): number {
  const n = matches.length;
  if (n === 0) return 0;
  if (!current) return dir === -1 ? n - 1 : 0;
  const at = matches.findIndex((m) => m.startNode === current.startNode && m.startOffset === current.startOffset);
  if (at >= 0) return dir === 0 ? at : stepIndex(at, n, dir);
  if (!current.startNode.isConnected) return dir === 0 ? Math.min(Math.max(fallback, 0), n - 1) : stepIndex(fallback, n, dir);
  const ahead = matches.filter((m) => before(m.startNode, m.startOffset, current.startNode, current.startOffset)).length;
  return dir === -1 ? (ahead - 1 + n) % n : ahead % n;
}

/** Open every closed <details> around `node`, so a match the walk counted is on screen when it
 *  is landed on (t-v5qrdz). A thought block, a compaction summary and a sub-agent's live output
 *  keep their text in the DOM while closed: counted, but hidden, until this opens them. The
 *  caller's `ontoggle` records the open, so a re-render does not close it again. */
export function revealMatch(node: Node): void {
  for (let d = node.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) {
    // Its own summary stays drawn while closed: a match there needs nothing opened.
    if (!d.open && !d.querySelector(':scope > summary')?.contains(node)) d.open = true;
  }
}

/** Which cell owns Ctrl+F when many chats show at once. Priority: focus
 *  caret, then pointer, then first cell on screen. Off-screen ids are
 *  ignored at every step, so a stale active id can't steal focus. */
export function pickFindTarget(
  cellIds: readonly string[],
  activeCellId: string | null,
  hoveredCellId: string | null,
): string | null {
  if (activeCellId && cellIds.includes(activeCellId)) return activeCellId;
  if (hoveredCellId && cellIds.includes(hoveredCellId)) return hoveredCellId;
  return cellIds[0] ?? null;
}

/** Session id of the cell an element sits in; null if focus is on the document body. */
export function cellIdOf(el: Element | null): string | null {
  return el?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId ?? null;
}

/** Highlight names mirrored in ChatFind.svelte's `::highlight()` rules.
 *  Neither compiler can see the other; a test asserts they agree
 *  (ChatFind.test.ts). Renaming one alone silently breaks colour. */
export const HL_ALL = 'og-chat-find';
export const HL_CURRENT = 'og-chat-find-current';

/** Cap on painted matches. `new Highlight(...ranges)` is a spread, and a
 *  one-letter query can exceed the engine's argument limit. Counting and
 *  stepping stay correct past this cap; only colour stops. */
const HL_PAINT_CAP = 2000;

/** Mirror of the writable half of `HighlightRegistry`. lib.dom's type
 *  only declares `forEach`, so the registry needs this to type `set`. */
interface HighlightWriter {
  set(name: string, highlight: Highlight): unknown;
  delete(name: string): unknown;
}

function registry(): HighlightWriter | null {
  if (typeof CSS === 'undefined' || typeof Highlight !== 'function') return null;
  return (CSS.highlights as unknown as HighlightWriter | undefined) ?? null;
}

/** Paint `matches`, with `current` in its own highlight to stand out.
 *  Returns false when the browser has no CSS Custom Highlight API
 *  (jsdom has none); callers still count, step and scroll without colour. */
export function paintHighlights(matches: readonly FindMatch[], current: number): boolean {
  const reg = registry();
  if (!reg) return false;
  reg.delete(HL_ALL);
  reg.delete(HL_CURRENT);
  const painted = matches.slice(0, HL_PAINT_CAP).map(matchRange);
  if (painted.length > 0) reg.set(HL_ALL, new Highlight(...painted));
  const hit = matches[current];
  if (hit) reg.set(HL_CURRENT, new Highlight(matchRange(hit)));
  return true;
}

/** Drop both highlights. Called on close and unmount: a highlight is
 *  registered on the document, so an uncleared widget leaves colour on text nobody's searching. */
export function clearHighlights(): boolean {
  const reg = registry();
  if (!reg) return false;
  reg.delete(HL_ALL);
  reg.delete(HL_CURRENT);
  return true;
}
