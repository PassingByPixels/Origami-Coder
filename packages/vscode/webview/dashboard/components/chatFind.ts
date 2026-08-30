// chatFind.ts — the rules behind Ctrl+F inside one chat cell.
//
// WHY A LEAF. The widget itself is a bar with a box and two arrows. The parts
// that can be WRONG all live below it: which cell claims the key when a grid is
// showing twelve chats at once, which runs of text a query actually hits when a
// transcript is a tree of markdown elements, and what "next" means at the end
// of the list. None of that needs a rendered pane to be checked, and all of it
// is checked here (chatFind.test.ts).
//
// NOT SEARCHED, deliberately, in v1: a COLLAPSED tool card, thought block or
// compacted block has no body in the DOM at all — ToolCard.svelte mounts its
// output only while the card is open — so a DOM-text search cannot see it, and
// this module does not pretend to. Auto-expanding cards to reach that text
// would rewrite the reader's transcript underneath them on every keystroke.

/** One hit, as the two DOM endpoints it spans. Node references, not indices:
 *  an index into a transcript that is still streaming means nothing a moment
 *  later. */
export interface FindMatch {
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
}

/** Where one text node's characters landed in the joined haystack. */
export interface Segment { node: Text; start: number; }

/** Elements that do NOT break a run of text. A match may cross these — "the
 *  `code`" is one phrase to a reader and two text nodes to the DOM — but never
 *  a block boundary, or the last word of one message would join the first word
 *  of the next into a match nobody can see on screen. A TAG-NAME rule, not a
 *  layout one, on purpose: jsdom has no layout engine, so a rule that asked
 *  what `display` computes to could not be tested at all. */
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

/** Lower-cased, but LENGTH-PRESERVING. A handful of characters lower-case to
 *  two ('İ'.toLowerCase() is 'i̇'), which would shift every offset after them
 *  and paint the highlight over the wrong words. Those characters keep their
 *  original form instead — so they simply do not match case-insensitively,
 *  which is a miss rather than a lie. The fast path is the whole string. */
function fold(s: string): string {
  const low = s.toLowerCase();
  if (low.length === s.length) return low;
  let out = '';
  for (const ch of s) { const l = ch.toLowerCase(); out += l.length === ch.length ? l : ch; }
  return out;
}

/** Every text node under `root`, in document order, joined into ONE string with
 *  a newline wherever the block changes — plus where each node's text landed in
 *  it, so a hit in the string maps back to a node and an offset. The newline is
 *  what makes a cross-block match impossible: a query typed into a one-line box
 *  can never contain one. */
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

/** The node and offset an absolute haystack index falls on. Walks BACKWARDS:
 *  an index sitting exactly on a block separator belongs to the node before it,
 *  clamped to that node's end, which is the same DOM point as offset 0 of the
 *  node after. */
function locate(segments: readonly Segment[], index: number): { node: Text; offset: number } | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (index >= s.start) return { node: s.node, offset: Math.min(index - s.start, s.node.data.length) };
  }
  return null;
}

/**
 * Every non-overlapping, case-insensitive hit of `query` under `root`, in
 * document order. Substring only — no regex, the paneSearch.ts call: a find box
 * that surprises you is worse than one that misses.
 *
 * An empty or whitespace-free-but-empty query matches NOTHING, which is the
 * OPPOSITE of paneSearch.ts's filter (where no filter means "keep everything").
 * A find bar with an empty box has nothing to step through and must not report
 * that it has.
 */
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

/** The DOM Range a match occupies. Built on demand and never stored: a Range
 *  holds live node references, and a transcript that streamed a new message
 *  under a kept Range is exactly how a highlight ends up over the wrong words. */
export function matchRange(m: FindMatch): Range {
  const range = (m.startNode.ownerDocument ?? document).createRange();
  range.setStart(m.startNode, m.startOffset);
  range.setEnd(m.endNode, m.endOffset);
  return range;
}

/**
 * Next (`+1`) or previous (`-1`) match, WRAPPING. Wrapping is the browser-find
 * convention and it is why there is no "no more matches" state to get stuck in.
 * `total <= 0` answers 0, so a caller with nothing to step through cannot land
 * on -1 and index an empty list; a `current` left over from a longer list (the
 * transcript streamed and the recount came back smaller) folds back into range
 * rather than throwing.
 */
export function stepIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0;
  return (((current + dir) % total) + total) % total;
}

/**
 * WHICH cell a Ctrl+F belongs to when a grid is showing many chats at once.
 *
 * Focus first: a caret is the least ambiguous statement of intent there is, and
 * honouring it is also what makes Ctrl+F work from inside the composer, per the
 * browser-find convention that the key belongs to the page rather than to the
 * field. Then the pointer. Then the first cell on screen — which is the whole
 * answer in the single-chat and solo-tab layouts, where there is only one.
 *
 * An id that is not on screen is IGNORED at every arm: a stale active id would
 * otherwise open find on a cell nobody can see, with the key apparently doing
 * nothing at all.
 */
export function pickFindTarget(
  cellIds: readonly string[],
  activeCellId: string | null,
  hoveredCellId: string | null,
): string | null {
  if (activeCellId && cellIds.includes(activeCellId)) return activeCellId;
  if (hoveredCellId && cellIds.includes(hoveredCellId)) return hoveredCellId;
  return cellIds[0] ?? null;
}

/** The session id of the cell an element sits in — the DOM half of the rule
 *  above, kept here so that "focus is on the document body" answers null
 *  instead of throwing on a `closest` that found nothing. */
export function cellIdOf(el: Element | null): string | null {
  return el?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId ?? null;
}

/** The two registered highlight names. MIRRORED in ChatFind.svelte's
 *  `::highlight()` rules, because a highlight is addressed by a string in two
 *  languages and neither compiler can see the other — so they carry the house
 *  obligation a mirror always does, a test that reads BOTH and asserts they
 *  still agree (ChatFind.test.ts). Rename one alone and the matches simply
 *  stop being coloured, with nothing failing anywhere. */
export const HL_ALL = 'og-chat-find';
export const HL_CURRENT = 'og-chat-find-current';

/** How many matches get painted. `new Highlight(...ranges)` is a spread, and a
 *  one-letter query against a long transcript can produce tens of thousands of
 *  hits — past the engine's argument limit, where the whole call throws. The
 *  COUNT and the stepping stay truthful past this; only the colour stops, and
 *  the current match is registered separately so it is never the one missing. */
const HL_PAINT_CAP = 2000;

/** MIRROR of the maplike half of `HighlightRegistry`. TypeScript 5.8's lib.dom
 *  declares that interface with `forEach` and nothing else — no `set`, no
 *  `delete` — so the registry cannot be written through its own published type.
 *  Structural rather than imported because there is nothing to import it from. */
interface HighlightWriter {
  set(name: string, highlight: Highlight): unknown;
  delete(name: string): unknown;
}

function registry(): HighlightWriter | null {
  if (typeof CSS === 'undefined' || typeof Highlight !== 'function') return null;
  return (CSS.highlights as unknown as HighlightWriter | undefined) ?? null;
}

/**
 * Paint `matches`, with the one at `current` in its own highlight so "the one
 * you are on" is distinguishable from "the others".
 *
 * Returns FALSE when this browser has no CSS Custom Highlight API — jsdom has
 * none, and neither would an older webview — and the caller then carries on
 * counting, stepping and scrolling without colour. A find that stops working
 * because a paint threw is worse than one that is merely colourless.
 */
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

/** Drop both highlights. Called on close AND on unmount: a highlight is
 *  registered on the DOCUMENT, so a widget that went away without clearing
 *  leaves colour on text nobody is searching any more. */
export function clearHighlights(): boolean {
  const reg = registry();
  if (!reg) return false;
  reg.delete(HL_ALL);
  reg.delete(HL_CURRENT);
  return true;
}
