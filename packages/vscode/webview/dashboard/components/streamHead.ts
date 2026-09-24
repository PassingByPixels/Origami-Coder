// streamHead.ts — WHERE the live colour stops.
//
// A2 painted the WHOLE open reply in --og-chat and let it settle to ink when the
// stream went quiet (streamSettle.ts owns that timing, and still does). The owner
// wants the colour to FLOW instead: "3 to 4 words are blue and the rest behind
// them turns white". So the row is split — a HEAD of the newest few words that
// wears the accent, and a BODY behind it that is already normal text — and the
// split moves with every delta. On completion the caller asks for no head at all,
// so nothing is left blue.
//
// A pure leaf: the split is a string rule, and jsdom has no layout, so a test
// asserting the COLOUR would prove nothing. What is decidable — and what breaks
// if this is done carelessly — is WHERE the cut lands.
//
// THE HAZARD. The head is marked by injecting a <span> into the MARKDOWN, before
// `marked` parses it (MessageRow renders the whole reply in one pass; two parses
// would split a paragraph in half). Markdown is not a string you may cut
// anywhere: a cut in the middle of `` `a code span` `` would leave the opening
// backtick in the body and the closing one inside the span, and marked would
// render a stray backtick and literal `<span>` text in the reader's prose. Two
// rules keep that from happening:
//   1. Never inside a fenced block. Inside ``` the injected tag is not markup at
//      all — it is code the reader would SEE. An open fence means no head.
//   2. An inline construct is swallowed WHOLE. If the cut would land inside a
//      code span, bold run or link label, it moves back to before that
//      construct's opener, so the tag is injected outside it. Moving back is
//      always safe; the head only gets longer.

/** How many words ride at the head of the stream. The owner's "3 to 4". */
export const HEAD_WORDS = 4;

/** The class the head wears. MessageRow's stylesheet is the other half of it. */
export const HEAD_CLASS = 'og-stream-head';

export interface StreamHeadSplit {
  /** Everything behind the head — normal text colour. */
  body: string;
  /** The newest few words, accent-coloured. '' when no safe cut exists. */
  head: string;
}

/** Is the text sitting inside an unclosed ``` fence? Then there is no markup to
 *  inject into — only code the reader would see the tag in. */
function insideFence(text: string): boolean {
  return (text.match(/^[ \t]*(```|~~~)/gm) ?? []).length % 2 === 1;
}

/**
 * Move a cut back to before any inline construct still OPEN at it, so the head
 * swallows that construct whole and the injected tag lands outside it.
 *
 * Rule 2, and it covers a CLASS. A code span was the case the ticket named, but
 * `**bold**` and `[a link](url)` fail the same way and for the same reason: the
 * opener stays in the body, the closer ends up inside the head's span, and
 * marked renders the delimiters as literal characters in the reader's prose.
 * Backticks are checked FIRST and alone — inside a code span nothing else is
 * markup.
 *
 * Widening is always safe: it only makes the head longer, never the markup
 * different. An opener that is never closed (an unlucky `[`) costs a few extra
 * accent-coloured words for one frame, which is the cheap direction to be wrong.
 */
function widenPastOpenMarkup(line: string, cut: number): number {
  const before = line.slice(0, cut);
  if ((before.match(/`/g) ?? []).length % 2 === 1) return before.lastIndexOf('`');

  const opens: number[] = [];
  if ((before.match(/\*\*/g) ?? []).length % 2 === 1) opens.push(before.lastIndexOf('**'));
  if ((before.match(/\[/g) ?? []).length > (before.match(/]/g) ?? []).length) opens.push(before.lastIndexOf('['));
  return opens.length ? Math.min(...opens) : cut;
}

/**
 * Split `text` so the last `words` whitespace-delimited words are the head.
 *
 * `body + head === text` ALWAYS — this never rewrites the reply, it only says
 * where to cut it. When no safe cut exists (an open fence, an empty tail) the
 * head is '' and the whole reply reads as settled prose, which is the state the
 * previous frame was in anyway.
 */
export function splitStreamHead(text: string, words = HEAD_WORDS): StreamHeadSplit {
  const none = { body: text, head: '' };
  if (!text.trim() || insideFence(text)) return none;

  // The head never crosses a line, so it can never span a block boundary (a
  // heading, a list item, the start of a fence) and turn one block into two.
  const lineStart = text.lastIndexOf('\n') + 1;
  const line = text.slice(lineStart);

  const token = /\S+/g;
  const starts: number[] = [];
  for (let m = token.exec(line); m; m = token.exec(line)) starts.push(m.index);
  if (starts.length === 0) return none;

  const at = lineStart + widenPastOpenMarkup(line, starts[Math.max(0, starts.length - words)]);
  const head = text.slice(at);
  return head.trim() ? { body: text.slice(0, at), head } : none;
}

/**
 * The reply with the head wrapped, ready for `marked`. Returns `text` untouched
 * when `live` is false or no safe cut exists — which is how a finished reply
 * ends up with nothing blue in it.
 */
export function markStreamHead(text: string, live: boolean, words = HEAD_WORDS): string {
  if (!live) return text;
  const { body, head } = splitStreamHead(text, words);
  return head ? `${body}<span class="${HEAD_CLASS}">${head}</span>` : text;
}
