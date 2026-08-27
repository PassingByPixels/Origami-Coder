// Collabs — collabNames.ts: the SHORT name shown on roster chips, message
// author lines and the invite list. A collab agent's displayName is often
// authored as a full sentence ("Crane - the collab's builder: reviews every
// diff before it lands"), which is the right text for a TOOLTIP and the
// wrong one for a chip or a header — it reads as a screed, not a name.
//
// One rule, two sources: when displayName is authored "Name - blurb", the
// name is the text before the FIRST " - "; otherwise fall back to the slug
// itself (minus its `collab-` prefix, capitalised), which is always short
// and stable even when the def carries no separator at all.

const SEPARATOR = ' - ';

function fromSlug(slug: string): string {
  const bare = slug.startsWith('collab-') ? slug.slice('collab-'.length) : slug;
  return bare.length ? bare[0]!.toUpperCase() + bare.slice(1) : bare;
}

/** The short name for a chip / author label / invite row. `displayName` is
 *  the FULL text (a description, or just the slug echoed back when the
 *  source had nothing better) — never rendered here, only mined for a
 *  leading name. */
export function collabShortName(slug: string, displayName?: string | null): string {
  const dn = (displayName ?? '').trim();
  const sep = dn.indexOf(SEPARATOR);
  return sep > 0 ? dn.slice(0, sep).trim() : fromSlug(slug);
}
