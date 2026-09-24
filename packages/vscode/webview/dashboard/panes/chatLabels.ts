// Two display formatters lifted VERBATIM out of ChatPane.svelte, which was at
// 2476/2477 when the repo/branch pills needed an import line and a mount line.
// Extraction came first, as the ratchet prescribes; the cap did NOT move.
//
// Both are pure string-in/string-out, so they are testable with no render —
// which is the gift the extraction buys: `fmtHistoryDate`'s real job is the
// unparseable date, and nothing in a rendered pane ever showed that case.

/** A model id as the composer shows it: `provider/model` loses its provider,
 *  a bare id is left alone. */
export function prettyModel(v: string | undefined): string {
  if (!v) return '';
  const parts = v.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : v;
}

/** A history row's timestamp in the user's locale. An absent or unparseable
 *  value is '' so the caller's `.filter(Boolean).join(' · ')` drops the whole
 *  segment rather than printing "Invalid Date" next to a folder name. */
export function fmtHistoryDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
}
