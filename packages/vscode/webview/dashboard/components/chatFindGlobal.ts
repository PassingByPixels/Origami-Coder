// chatFindGlobal.ts — find's GLOBAL mode (t-ucnp7t, owner answer Q2). The LOCAL mode is
// chatFind.ts: a walk of the rows on screen. With older pages not loaded that walk answers for the
// loaded part only, so the find bar offers both and the reader picks:
//   - LOCAL: fast, the loaded rows, and it says "loaded part" while older pages exist;
//   - GLOBAL: the engine searches the whole stored chat (`history_search`, wire_contract.md 5), and
//     a jump to a hit first loads the pages it needs, then lands on the words.
//
// The engine names a hit by message id (and tool call id), not by a place in the DOM. Landing is
// therefore two steps: find the row (`data-engine-msg` on an agent row, `data-tool-call` on a tool
// step, both drawn by ChatTranscript/ToolRunGroup), then the local match inside it. A user row has
// no id on screen, so its hit is placed by the words around the match (the snippet), which is
// also the fallback for any row the ids do not reach.

import type { FindMatch } from './chatFind';

/** Mirror of src/acpHistory.ts `SearchHit` (a webview leaf cannot import src/). */
export interface GlobalHit {
  messageId: string;
  partId: string;
  role: 'user' | 'assistant';
  kind: 'text' | 'reasoning' | 'tool';
  toolCallId: string | null;
  time: number;
  fromEnd: number;
  snippet: string;
  matchStart: number;
  matchLength: number;
  matchesInPart: number;
}

export type FindMode = 'loaded' | 'all';

/** The row a hit lives in, when the transcript draws one with its id. */
export function rowForHit(root: Element, hit: GlobalHit): Element | null {
  const esc = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&'));
  if (hit.toolCallId) {
    const card = root.querySelector(`[data-tool-call="${esc(hit.toolCallId)}"]`);
    if (card) return card;
  }
  return root.querySelector(`[data-engine-msg="${esc(hit.messageId)}"]`);
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Up to `n` characters of text around a DOM match: the node text before and after it. */
function around(m: FindMatch, n: number): { before: string; after: string } {
  return { before: m.startNode.data.slice(Math.max(0, m.startOffset - n), m.startOffset), after: m.endNode.data.slice(m.endOffset, m.endOffset + n) };
}

/** Of the `among` matches, the one whose surrounding words agree most with the snippet's; -1 when
 *  none agrees at all. */
function bySnippet(matches: readonly FindMatch[], among: readonly number[], hit: GlobalHit): number {
  const wantBefore = squash(hit.snippet.slice(0, hit.matchStart)).slice(-24);
  const wantAfter = squash(hit.snippet.slice(hit.matchStart + hit.matchLength)).slice(0, 24);
  let best = -1;
  let bestScore = 0;
  for (const i of among) {
    const { before, after } = around(matches[i], 60);
    const b = squash(before);
    const a = squash(after);
    let score = 0;
    if (wantBefore && b.endsWith(wantBefore.slice(-12))) score += 2;
    if (wantAfter && a.startsWith(wantAfter.slice(0, 12))) score += 2;
    if (!wantBefore && !wantAfter) score = 1;
    // Later wins a tie: the engine lists hits newest first, and a repeated phrase is most often
    // being looked for where it was said last.
    if (score > 0 && score >= bestScore) { best = i; bestScore = score; }
  }
  return best;
}

/**
 * Which local match is this hit. Inside the hit's own row when one is drawn, by the snippet's words
 * (a row can hold several hits: two text parts of one message); a thought hit inside a thought block,
 * never in the answer row that shares its message id. Else the match whose surrounding words agree
 * most with the snippet's; -1 when no match on screen can be it (its row is folded or collapsed).
 */
export function pickJumpMatch(root: Element, matches: readonly FindMatch[], hit: GlobalHit): number {
  if (matches.length === 0) return -1;
  const all = matches.map((_, i) => i);
  const row = hit.kind === 'reasoning' ? null : rowForHit(root, hit);
  const inside = all.filter((i) => {
    const el = matches[i].startNode.parentElement;
    return row ? row.contains(el) : hit.kind === 'reasoning' && !!el?.closest('.thought-block');
  });
  if (inside.length > 0) { const at = bySnippet(matches, inside, hit); return at >= 0 ? at : inside[0]; }
  return bySnippet(matches, all, hit);
}

/** Expand the collapsed tool card a tool hit lives in, the way the reader would: a click on its
 *  header. ToolCard mounts a card's body only once it is open, so until then the words are not in
 *  the DOM. True when it clicked (the caller waits a tick for the body to draw). */
export function openToolCard(root: Element, hit: GlobalHit): boolean {
  if (!hit.toolCallId) return false;
  const row = rowForHit(root, hit);
  const arrow = row?.querySelector('.tool-header .expand-arrow');
  if (!arrow || arrow.classList.contains('open')) return false;
  row?.querySelector<HTMLElement>('.tool-header')?.click();
  return true;
}

/** `3/12`, with `+` while the engine has more of the chat left to search. */
export function hitCount(index: number, hits: readonly GlobalHit[], done: boolean, asked: boolean): string {
  if (hits.length === 0) return asked ? (done ? '0/0' : '…') : '';
  return `${index + 1}/${hits.length}${done ? '' : '+'}`;
}
