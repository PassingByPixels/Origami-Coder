// How the stream MARKS a speaker and a moment — the letter-disc palette, the
// per-slug tone, the initial and the clock — as a PURE leaf.
//
// EXTRACTED from CollabStream.svelte, which sat 2 lines under its architecture
// cap with the follow rule and the flow rail still to wire in. The ratchet's
// remedy is extraction, not a raise, and these four are the file's only logic
// that never touches the DOM. Mirrors collabKinds.ts's own split out of the
// same component.
//
// Nothing here decides WHAT is drawn — only how a slug and a timestamp are
// turned into the two marks the transcript repeats on every row.

/**
 * The letter-disc fallback's palette. Theme VARS only: five accents defined in
 * all five themes, so a disc is legible in every one of them. (In some themes
 * two of these resolve to the same hue — that is the theme's choice, and a
 * duplicate colour is a far smaller problem than a hard-coded one that
 * disappears entirely on a light background.)
 */
export const DISC_TONES = ['--og-accent', '--og-accent-2', '--og-chat', '--og-success', '--og-warning'];

/**
 * A STABLE per-slug tone: the same agent is the same colour in every collab,
 * every session, with no state to keep. djb2-ish over the slug, so two agents
 * differing by one character land on different tones rather than neighbouring
 * ones.
 */
export function toneOf(slug: string): string {
  let h = 5381;
  for (let i = 0; i < slug.length; i++) h = ((h * 33) ^ slug.charCodeAt(i)) >>> 0;
  return DISC_TONES[h % DISC_TONES.length];
}

/** The disc's letter. A name that is blank, or starts with something with no
 *  upper case, still gets a mark rather than an empty circle. */
export const initialOf = (name: string): string => (name.trim()[0] ?? '?').toUpperCase();

/** `createdAt` is an ISO string by contract; a numeric epoch is tolerated
 *  rather than printed raw, and anything unparseable renders as nothing at all
 *  — never as a fabricated date. */
export function fmtTime(v: unknown): string {
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v ?? ''));
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}
