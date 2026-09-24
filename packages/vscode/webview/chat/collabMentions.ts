// The collab composer's `@` vocabulary, as a pure leaf.
//
// Two jobs, one grammar: `parseMentions` answers what a submitted line
// targets (drives the wake rule); `mentionQuery`/`applyMention` answer
// what the picker should do while still typing. Both read the same token
// shape, so a name the picker offered can't fail to parse later.
//
// The roster is the authority: an unknown slug is dropped here rather
// than sent, so a typo'd @name can't refuse a whole message. Compose-time
// text has no code-fence awareness, so `@crane` inside a fenced block is still a mention.

/** One pickable participant — the ACTIVE roster, projected. */
export interface MentionCandidate {
  slug: string;
  /** The display name the picker shows beside the slug. */
  name: string;
}

/** A mention token being typed: where its `@` sits and what follows it. */
export interface MentionQuery {
  /** Index of the `@` in the full text — where a replacement starts. */
  start: number;
  /** Everything between the `@` and the caret. Empty right after `@`. */
  query: string;
}

/** A slug character. Deliberately narrow: `-`/`_` are in, punctuation that
 *  ends a sentence is out, so `@collab-crane,` and `@collab-crane's` parse. */
const SLUG_CHARS = /^[A-Za-z0-9_-]*$/;
/** `@` must open a word: preceded by line-start or a non-slug, non-`@`
 *  character, so `a@b.com` is an email and `@@crane` is not a mention. */
const TOKEN = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9][A-Za-z0-9_-]*)/g;

/** The slugs a composed line targets, in first-appearance order, deduped
 *  and filtered against the active roster, nobody else. */
export function parseMentions(text: string, roster: readonly string[]): string[] {
  const known = new Set(roster);
  return allMentions(text).filter((slug) => known.has(slug));
}

/**
 * Every address a draft names, in first-appearance order, deduped and
 * unfiltered. The roster filter above suits a post but not the live
 * preview: `collab_post` refuses an unknown slug outright, so the
 * composer warns before send by classifying each address as `wake` or `unknown`.
 */
export function allMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    if (!out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

/** The mention token the caret sits in, or null when not in one. Null
 *  closes the picker: a space, punctuation, or a second `@` all mean that. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const start = before.lastIndexOf('@');
  if (start === -1) return null;
  const prev = start === 0 ? '' : before[start - 1];
  if (prev && /[A-Za-z0-9_@]/.test(prev)) return null;
  const query = before.slice(start + 1);
  return SLUG_CHARS.test(query) ? { start, query } : null;
}

/** Replaces the token under the caret with `@slug ` (trailing space, so
 *  the next word can't glue on). A caret not in a token inserts there instead of refusing. */
export function applyMention(text: string, caret: number, slug: string): { text: string; caret: number } {
  const end = Math.max(0, Math.min(caret, text.length));
  const q = mentionQuery(text, end);
  const start = q ? q.start : end;
  return {
    text: `${text.slice(0, start)}@${slug} ${text.slice(end)}`,
    caret: start + slug.length + 2,
  };
}

/** The picker's filter: slug or display name, case-insensitive. An empty
 *  query offers the whole roster ("who is here?"), never nothing. */
export function filterMentions(candidates: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...candidates];
  return candidates.filter((c) => c.slug.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
}
