// nativeTitleScan.ts — finds native `title` tooltips in a .svelte file's markup.
//
// The house tooltip is `use:tip` (warmTip.ts). A native `title` on the same
// kind of control draws the plain browser tooltip instead, which is the
// inconsistency t-v483ot fixed. nativeTitleGuard.test.ts runs this scan over
// every .svelte file and holds each file to a baseline count, so a NEW bare
// `title` fails the suite.
//
// Pure string work, no Svelte compiler: the markup is walked tag by tag, and
// `{ ... }` expressions are skipped as a unit, so an arrow function
// (`onclick={() => a > b}`) does not end a tag early and an object key named
// `title:` inside an expression is not an attribute.

/** Elements where `title` is not a tooltip. An iframe's title names the frame
 *  for screen readers, and nothing else can do that job. */
const EXEMPT_TAGS = new Set(['iframe']);

export interface NativeTitleHit {
  tag: string;
  line: number;
}

/** The markup only: script, style and comments hold text that looks like tags. */
function blankNonMarkup(src: string): string {
  // Replace with spaces of the same length (newlines kept), so line numbers hold.
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<script\b[\s\S]*?<\/script>/g, blank)
    .replace(/<style\b[\s\S]*?<\/style>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/**
 * Reads one open tag from `start` (the `<`). Returns the tag with every
 * `{ ... }` expression collapsed to `{}` (or `{title}` for the shorthand),
 * and the index after its closing `>`.
 */
function readTag(src: string, start: number): { flat: string; end: number } {
  let flat = '';
  let depth = 0;
  let quote = '';
  let expr = '';
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (depth > 0) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (depth > 0) expr += c;
      else {
        flat += expr.trim() === 'title' ? '{title}' : '{}';
        expr = '';
      }
      continue;
    }
    if (c === '{') {
      depth = 1;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      flat += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return { flat, end: i + 1 };
    flat += c;
  }
  return { flat, end: src.length };
}

/** Every lowercase (native) element in the markup that carries a `title`
 *  attribute. Component tags (`<ConnectionPill title=...>`) are props, not
 *  tooltips, and are not counted. */
export function findNativeTitles(src: string): NativeTitleHit[] {
  const markup = blankNonMarkup(src);
  const hits: NativeTitleHit[] = [];
  const open = /<([a-z][a-z0-9-]*)(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(markup))) {
    const { flat, end } = readTag(markup, m.index);
    open.lastIndex = end;
    if (EXEMPT_TAGS.has(m[1])) continue;
    if (/\stitle\s*=/.test(flat) || /\s\{title\}/.test(flat)) {
      hits.push({ tag: m[1], line: markup.slice(0, m.index).split('\n').length });
    }
  }
  return hits;
}
