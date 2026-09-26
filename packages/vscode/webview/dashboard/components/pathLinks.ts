// pathLinks.ts — FILE PATHS IN RENDERED CHAT HTML BECOME CLICK-TO-OPEN LINKS.
//
// Pure (no DOM, no Svelte) so every rule here is testable on strings. Taken out
// of MessageRow.svelte for t-v486mk, which added the delimited-path rules.
//
// Two kinds of match:
//  1. BARE: a path in prose ("packages/engine/src/agent/agent.ts:109"). Its end
//     is not marked, so it may not hold a space or a parenthesis — "see the
//     Model Lab/a.py file" must not join words across the space.
//  2. DELIMITED: the whole of an inline code span, a quoted run ("…", '…', `…`,
//     “…”) or an unparsed markdown link target. Here the delimiters mark both
//     ends, so the path may hold spaces, parentheses and any letters. A space is
//     accepted only in a ROOTED path (C:\, \\server, /, ./, ../): "git add
//     src/a.ts" in backticks is a command, not a path named "git add src/a.ts".
//
// The link carries data-path (the real path, entities decoded) and data-line;
// MessageRow's click handler posts them as `openAbsoluteFile`.

/** Split a "path:line[:col]" reference into its path and 1-based line.
 *  A bare path, or a range like ":10-20", yields line: undefined. */
export function splitPathLine(raw: string): { path: string; line?: number } {
  const m = raw.match(/^(.+?):(\d+)(?::\d+)?$/);
  if (m) return { path: m[1], line: parseInt(m[2], 10) };
  return { path: raw };
}

/** A markdown link target may encode a space as %20 (the CommonMark way to put
 *  one in a link). The file on disk has the space, so decode it. */
export function decodeHref(href: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(href)) return href;
  try { return decodeURIComponent(href); } catch { return href; }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The entities marked (and MessageRow's escapeHtml) write into text.
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decodeEntities = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]);

function anchor(path: string, line: number | undefined, innerHtml: string): string {
  const dataLine = line !== undefined ? ` data-line="${line}"` : '';
  return `<a class="file-link" data-path="${escapeAttr(path)}"${dataLine}>${innerHtml}</a>`;
}

// Leading (?<!...) boundary stops a match starting mid-token, which also
// collapses O(n^2) backtracking to linear on a long separator-less blob
// (verified: 100k chars 11.9s -> 0.6ms). The root alternative lets a Windows
// (C:/... or C:\...) or POSIX (/...) absolute path linkify too. \p{L}\p{M}\p{N}
// are letters, marks and digits of any script, so "café/naïve.ts" is one path.
const BARE = /(?<![\p{L}\p{M}\p{N}_./\\-])((?:[A-Za-z]:[\\/]|\/)?(?:[\p{L}\p{M}\p{N}_.\-]+[\\/])*[\p{L}\p{M}\p{N}_.\-]+\.\p{L}[\p{L}\p{M}\p{N}_]{0,7})(:\d+(?::\d+)?)?/gu;

// A token must have a path separator OR a :line suffix to qualify, which skips
// version strings ("1.29.0"), domains, and "a.b" method refs.
function linkBare(text: string): string {
  return text.replace(BARE, (whole: string, pathPart: string, linePart?: string) => {
    const hasSep = /[\\/]/.test(pathPart);
    if (!hasSep && !linePart) return whole; // unqualified — leave as text
    const line = linePart ? parseInt(linePart.slice(1), 10) : undefined;
    return anchor(pathPart, line, whole);
  });
}

const ROOTED = /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/;
// Characters a delimited path may hold. No , ; : * ? " < > | or backtick, so a
// list ("a.ts,b.ts"), a URL ("https://…") or a glob never passes as one path.
const PATH_CHARS = /^[\p{L}\p{M}\p{N}_.\-()[\]{}@+#&'!$%=~ \\/]+$/u;
const ENDS_IN_FILE = /[\\/][^\\/]*\.\p{L}[\p{L}\p{M}\p{N}_]{0,7}$/u;
// A later word that starts like a flag or a second path: a command line.
const COMMAND_WORD = /^(?:-|\/|\\|[A-Za-z]:[\\/])/;

/** True when the whole of `p` (no :line suffix) names one file. */
export function isWholePath(p: string): boolean {
  const body = p.replace(/^[A-Za-z]:(?=[\\/])/, ''); // the drive colon is the only colon allowed
  if (!PATH_CHARS.test(body) || !ENDS_IN_FILE.test(p)) return false;
  if (!p.includes(' ')) return !p.startsWith('~');   // ~ is not expanded by the host
  if (!ROOTED.test(p) || p !== p.trim() || p.includes('  ')) return false;
  return !p.split(' ').slice(1).some((w) => COMMAND_WORD.test(w));
}

/** The link for an HTML run that is (as a whole) a path, else undefined. */
function wholePathLink(html: string, labelHtml = html): string | undefined {
  const { path, line } = splitPathLine(decodeEntities(html));
  return isWholePath(path) ? anchor(path, line, labelHtml) : undefined;
}

// A quoted run (same quote both ends; the escaped forms are what marked writes),
// a curly-quoted run, or a markdown link marked left as text because its target
// holds a space: [label](C:\a b\c.py). One level of (...) inside the target.
const DELIMITED = /(&quot;|"|&#39;|'|`)([^<>\n]+?)\1|“([^<>\n]+?)”|\[([^[\]<>\n]+)\]\(((?:[^()<>\n]|\([^()<>\n]*\))+)\)/g;

/** Link the paths in one run of escaped text (no tags in it). */
function linkText(text: string): string {
  const re = new RegExp(DELIMITED.source, 'g');
  let out = '';
  let done = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let link: string | undefined;
    if (m[1] !== undefined) { const a = wholePathLink(m[2]); link = a && m[1] + a + m[1]; }
    else if (m[3] !== undefined) { const a = wholePathLink(m[3]); link = a && `“${a}”`; }
    else link = wholePathLink(m[5], m[4]);
    if (!link) { re.lastIndex = m.index + 1; continue; } // not a path: its close quote may open the next run
    out += linkBare(text.slice(done, m.index)) + link;
    done = re.lastIndex;
  }
  return out + linkBare(text.slice(done));
}

/**
 * Linkify file paths in already-rendered HTML. TEXT runs and inline <code>
 * spans only: a <pre> block (highlighted code) and existing links are left
 * untouched. Inline <code> MUST linkify — coder models wrap nearly every path in
 * single backticks ("edit `src/foo.ts:78`") — and a span that is one path as a
 * whole links as one path, spaces included. (Assumes marked emits balanced
 * tags; a malformed unclosed <pre> could let a path in its body linkify —
 * cosmetic only, the link still resolves.)
 */
export function linkifyPaths(html: string): string {
  const PROTECTED = /(<pre[\s\S]*?<\/pre>|<a\b[\s\S]*?<\/a>|<code>[^<]*<\/code>|<[^>]+>)/gi;
  return html
    .split(PROTECTED)
    .map((seg, i) => {
      if (i % 2 === 0) return linkText(seg);
      const code = seg.match(/^<code>([^<]*)<\/code>$/i);
      if (!code) return seg; // tag or protected block — leave as-is
      return `<code>${wholePathLink(code[1]) ?? linkText(code[1])}</code>`;
    })
    .join('');
}
