// Flock M4 wave X2 — the collab composer's `@` vocabulary, as a PURE leaf.
//
// TWO JOBS, one grammar. `parseMentions` answers what a SUBMITTED line targets
// (the `mentions: string[]` that rides collab_post and drives wake rule C17);
// `mentionQuery`/`applyMention` answer what the PICKER should be doing while
// the line is still being typed. Both read the same token shape, so a name the
// picker offered cannot fail to parse a keystroke later.
//
// THE ROSTER IS THE AUTHORITY. An unknown slug is DROPPED here rather than
// sent: `collab_post` errors on one (naming the valid slugs) and nothing is
// appended, so a typo'd @name would otherwise refuse a whole message. Prose
// `@name` never wakes anyone by itself (C23) — only this array does, which is
// exactly why it is built from an exact-match set and never from prose.
//
// Compose-time text is short and unstructured, so there is deliberately no
// code-fence awareness: `@crane` inside a fenced block in the composer is
// still a mention, and that is the honest reading of a one-box composer.

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

/** A slug character. Deliberately narrow: an agent slug is `collab-crane`, so
 *  `-`/`_` are IN and every punctuation mark that can end a sentence is OUT,
 *  which is what makes `@collab-crane,` and `@collab-crane's` parse. */
const SLUG_CHARS = /^[A-Za-z0-9_-]*$/;
/** `@` must open a word: preceded by the start of the line or by something
 *  that is neither a slug character nor another `@`, so `a@b.com` is an email
 *  and `@@crane` is not a mention. */
const TOKEN = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9][A-Za-z0-9_-]*)/g;

/**
 * The slugs a composed line targets, in first-appearance order, deduped, and
 * filtered against `roster` — the ACTIVE participants, nobody else.
 */
export function parseMentions(text: string, roster: readonly string[]): string[] {
  const known = new Set(roster);
  return allMentions(text).filter((slug) => known.has(slug));
}

/**
 * Every address a draft names, in first-appearance order, deduped — UNFILTERED.
 *
 * The roster filter above is right for a POST and wrong for the C14 preview
 * (report 2.5): `collab_post` refuses an unknown slug outright, so the composer
 * has to warn about one BEFORE the send, and it can only do that by asking
 * about it. `collab_preview` classifies the addresses itself, answering `wake`
 * for the ones on the roster and `unknown` for the rest.
 */
export function allMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    if (!out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

/**
 * The mention token the caret is sitting in, or null when it is not in one.
 * Null closes the picker — which is what a space, a punctuation mark or a
 * second `@` all mean, without any of them needing their own branch.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const start = before.lastIndexOf('@');
  if (start === -1) return null;
  const prev = start === 0 ? '' : before[start - 1];
  if (prev && /[A-Za-z0-9_@]/.test(prev)) return null;
  const query = before.slice(start + 1);
  return SLUG_CHARS.test(query) ? { start, query } : null;
}

/**
 * Replace the token under the caret with `@slug ` (trailing space included —
 * the next word must not glue itself onto the handle). Called with a caret
 * that is NOT in a token, it inserts at the caret rather than refusing, so a
 * click-to-pick can never lose the pick.
 */
export function applyMention(text: string, caret: number, slug: string): { text: string; caret: number } {
  const end = Math.max(0, Math.min(caret, text.length));
  const q = mentionQuery(text, end);
  const start = q ? q.start : end;
  return {
    text: `${text.slice(0, start)}@${slug} ${text.slice(end)}`,
    caret: start + slug.length + 2,
  };
}

/** The picker's filter — slug OR display name, case-insensitively. An empty
 *  query offers the whole roster (typing `@` alone is a legitimate "who is
 *  here?"), never nothing. */
export function filterMentions(candidates: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...candidates];
  return candidates.filter((c) => c.slug.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
}
